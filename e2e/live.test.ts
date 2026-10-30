/** Headless Chromium run of folio's documented behaviour: live updates, many tabs, sleep and partial redraws. */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import {
  base,
  context,
  FILES,
  frameOf,
  keepFrame,
  landed,
  mark,
  marked,
  open,
  root,
  waitText,
  write,
} from "./harness.ts"

test("Update on save, No update elsewhere: only the page's own files update it, in place", async () => {
  const page = await open("notes/guide.md")
  await page.evaluate(() => scrollTo(0, 400))
  const y = await page.evaluate(() => scrollY)

  await mark(page)
  write({ "notes/other.md": "# Other, saved" })
  await page.waitForTimeout(600)
  assert.ok(await marked(page), "an unrelated save re-rendered the page")

  write({ "notes/parts/cell.md": "- cell saved" })
  await page.waitForFunction(
    () => document.querySelector(".markdown-body td li")?.textContent === "cell saved",
  )
  assert.equal(await page.evaluate(() => scrollY), y)

  const temporary = path.join(root, "notes/.guide.md.swp")
  fs.writeFileSync(temporary, `${FILES["notes/guide.md"]}\n\nSaved by rename.`)
  fs.renameSync(temporary, path.join(root, "notes/guide.md"))
  await waitText(page, "Saved by rename.")

  const image = await page.$eval("img[alt=logo]", (i) => i.getAttribute("src"))
  write({ "media/logo.svg": FILES["media/logo.svg"].replace("<rect", '<rect fill="teal"') })
  await page.waitForFunction(
    (src) => document.querySelector("img[alt=logo]")?.getAttribute("src") !== src,
    image,
  )
  const updated = await page.$eval("img[alt=logo]", (i) => i.getAttribute("src"))
  write({ "notes/parts/cell.md": "- cell saved again" })
  await page.waitForFunction(
    () => document.querySelector(".markdown-body td li")?.textContent === "cell saved again",
  )
  assert.equal(await page.$eval("img[alt=logo]", (i) => i.getAttribute("src")), updated)
  await page.close()
})

test("Tree changes: added, renamed and removed files show in the tree and listings without reloading pages", async () => {
  const page = await open("notes/guide.md")
  const listing = await context.newPage()
  await listing.goto(`${base}/notes/`)
  await listing.waitForSelector(".listing li")
  await mark(page)

  write({ "notes/added.md": "# Added" })
  await page.waitForSelector('.tree li[data-path="notes/added.md"]')
  await listing.waitForFunction(() => document.body.innerText.includes("added.md"))
  fs.renameSync(path.join(root, "notes/added.md"), path.join(root, "notes/renamed.md"))
  await page.waitForSelector('.tree li[data-path="notes/renamed.md"]')
  fs.unlinkSync(path.join(root, "notes/renamed.md"))
  await page.waitForFunction(() => !document.querySelector('.tree li[data-path^="notes/renamed"]'))

  assert.ok(await marked(page), "a tree change re-rendered the page")
  await Promise.all([page.close(), listing.close()])
})

test("Suspend: a suspended tab holds still until resumed, then catches up; other tabs update", async () => {
  const held = await open("notes/other.md")
  const live = await open("notes/other.md")

  await held.click('button[title="Suspend live updates in this tab"]')
  write({ "notes/other.md": "# Other\n\nwhile suspended" })
  await waitText(live, "while suspended")
  await held.waitForTimeout(400)
  assert.ok(!(await held.evaluate(() => document.body.innerText.includes("while suspended"))))

  await held.click('button[title="Resume live updates in this tab"]')
  await waitText(held, "while suspended")
  await Promise.all([held.close(), live.close()])
})

test("Many tabs: pages keep loading with more tabs open than the browser's six connections per host", async () => {
  const tabs = []

  for (let i = 0; i < 8; i++) {
    tabs.push(await open("notes/other.md"))
  }

  const page = await open("notes/guide.md")
  await page.click('.markdown-body a[href="other.md"]')
  await page.waitForURL(`${base}/notes/other.md`, { timeout: 5000 })
  await page.waitForSelector(".markdown-body h1", { timeout: 5000 })

  write({ "notes/other.md": "# Other\n\nwith many tabs" })
  await Promise.all([page, ...tabs].map((tab) => waitText(tab, "with many tabs")))
  await Promise.all([page, ...tabs].map((tab) => tab.close()))
})

test("Sleep: a tab whose connection went silent reconnects and still updates", async () => {
  const page = await context.newPage()
  await page.addInitScript(() => {
    const Native = window.WebSocket
    const opened: number[] = []
    ;(window as { opened?: number[] }).opened = opened
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        opened.push(Date.now())
      }
    }
  })
  await page.clock.install()
  await page.goto(`${base}/notes/other.md`)
  await page.waitForSelector(".markdown-body h1")
  // Reading the page on screen talks to the server; that settles before the silence starts.
  await page.clock.runFor(2_000)
  await page.waitForTimeout(500)
  await page.clock.runFor(70_000)
  await page.waitForFunction(() => ((window as { opened?: number[] }).opened ?? []).length >= 2)

  write({ "notes/other.md": "# Other\n\nafter sleep" })
  await page.clock.runFor(2_000)
  await waitText(page, "after sleep")
  await page.close()
})

test("Whole workspace: a large folder opens, browses and updates as quickly as a small one", async () => {
  const many: Record<string, string> = {}

  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < 50; j++) {
      many[`big/pkg-${i}/node_modules/dep-${j}/README.md`] = "x"
    }

    many[`big/pkg-${i}/src/module.ts`] = "x"
    many[`big/pkg-${i}/docs/readme.md`] = "# readme"
  }

  write(many)
  const page = await context.newPage()
  let started = Date.now()
  await page.goto(`${base}/big/pkg-7/docs/readme.md`)
  await page.waitForSelector(".tree .current")
  const opened = Date.now() - started

  started = Date.now()
  await page.click('.tree li[data-path="big/pkg-8"] > .tree-row')
  await page.waitForSelector('.tree li[data-path="big/pkg-8/docs"]')
  const browsed = Date.now() - started

  await page.waitForTimeout(300)
  started = Date.now()
  write({ "big/pkg-7/docs/readme.md": "# readme\n\nsaved" })
  await waitText(page, "saved")
  const updated = Date.now() - started

  assert.ok(opened < 3000, `opened in ${opened} ms`)
  assert.ok(browsed < 1000, `expanded a folder in ${browsed} ms`)
  assert.ok(updated < 1000, `updated in ${updated} ms`)
  await page.close()
})

test("Plain page, Diagram page, Link to a richer page, Content arrives later: a page loads only the renderers it uses", async () => {
  write({
    "renderers/plain.md": "# Plain\n\nWords only, and a [page with a diagram](diagram.md).\n",
    "renderers/diagram.md": "# Diagram\n\n```mermaid\ngraph LR\n  A --> B\n```\n",
  })
  const page = await context.newPage()
  const bodies: Promise<number>[] = []
  const scriptBytes = async () => (await Promise.all(bodies)).reduce((sum, n) => sum + n, 0)
  page.on("response", (response) => {
    if (/\?asset=.*\.js$/.test(response.url())) {
      bodies.push(response.body().then((body) => body.length))
    }
  })
  await page.goto(`${base}/renderers/plain.md`)
  await landed(page)
  const plain = await scriptBytes()

  assert.ok(plain < 1_000_000, `a plain page loaded ${plain} bytes of script`)

  await keepFrame(page)
  await page.click('a[href="diagram.md"]')
  await page.waitForSelector(".mermaid svg[aria-roledescription]")

  assert.equal((await frameOf(page)).kept, true)
  assert.ok((await scriptBytes()) > plain + 1_000_000, "the diagram renderer loaded on the way")
  await page.close()

  const later = await open("renderers/plain.md")
  write({ "renderers/plain.md": "# Plain\n\n```mermaid\ngraph LR\n  C --> D\n```\n" })
  await later.waitForSelector(".mermaid svg[aria-roledescription]")
  assert.match(await later.$eval(".mermaid svg", (svg) => svg.textContent ?? ""), /C.*D/s)
  await later.close()
})

test("One paragraph, Diagrams elsewhere, Changed diagram, Additions survive, Reading position: an update redraws only the blocks that changed", async () => {
  const diagram = (edge: string) => `\`\`\`mermaid\ngraph LR\n  ${edge}\n\`\`\``
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`)
  const doc = (first: string, second: string) =>
    ["# Doc", first, diagram("A --> B"), ...paragraphs, diagram(second), "Last."].join("\n\n")
  write({ "redraw/doc.md": doc("First.", "C --> D") })
  const page = await open("redraw/doc.md")
  await page.waitForFunction(
    () => document.querySelectorAll(".mermaid svg[aria-roledescription]").length === 2,
  )
  await page.evaluate(() => {
    for (const [index, block] of document.querySelectorAll(".markdown-body > *").entries()) {
      ;(block as HTMLElement).dataset.block = String(index)
    }

    const patched = Object.assign(document.createElement("button"), { className: "patched" })
    ;[...document.querySelectorAll(".markdown-body > p")]
      .find((p) => p.textContent === "Paragraph 30.")
      ?.append(patched)
    const record = window as { removed?: string[] }
    record.removed = []
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node instanceof HTMLElement) {
            record.removed?.push(node.dataset.block ?? node.tagName)
          }
        }
      }
    }).observe(document.querySelector(".markdown-body") as Node, { childList: true })
  })
  const reading = () =>
    page.$$eval(
      ".markdown-body > p",
      (ps) => ps.find((p) => p.textContent === "Paragraph 20.")?.getBoundingClientRect().top,
    )
  await page.evaluate(() =>
    [...document.querySelectorAll(".markdown-body > p")]
      .find((p) => p.textContent === "Paragraph 20.")
      ?.scrollIntoView(),
  )
  const before = await reading()

  write({ "redraw/doc.md": doc(`First, edited.\n\n${"Longer above. ".repeat(80)}`, "C --> D") })
  await waitText(page, "First, edited.")
  const after = await page.evaluate(() => ({
    removed: (window as { removed?: string[] }).removed,
    unmarked: [...document.querySelectorAll(".markdown-body > *")]
      .filter((block) => !(block as HTMLElement).dataset.block)
      .map((block) => block.textContent?.slice(0, 14)),
    patched: document.querySelectorAll(".markdown-body .patched").length,
  }))

  assert.deepEqual(after, {
    removed: ["1"],
    unmarked: ["First, edited.", "Longer above. "],
    patched: 1,
  })
  assert.ok(Math.abs(((await reading()) ?? 0) - (before ?? 0)) <= 1, "the block read moved")

  const first = await page.$eval(".mermaid", (figure) => (figure as HTMLElement).dataset.block)
  write({ "redraw/doc.md": doc(`First, edited.\n\n${"Longer above. ".repeat(80)}`, "C --> E") })
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".mermaid .nodeLabel")].some(
      (label) => label.textContent === "E",
    ),
  )
  assert.deepEqual(
    await page.$$eval(".mermaid", (figures) =>
      figures.map((figure) => (figure as HTMLElement).dataset.block ?? null),
    ),
    [first, null],
  )
  assert.equal(await page.locator(".markdown-body .patched").count(), 1)
  await page.close()
})
