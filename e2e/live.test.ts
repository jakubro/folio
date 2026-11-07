/** Headless Chromium run of Folio's documented behaviour: live updates, many tabs, sleep and partial redraws. */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Page } from "playwright"
import {
  base,
  caption,
  cells,
  context,
  FILES,
  frameOf,
  keepFrame,
  landed,
  mark,
  marked,
  open,
  panel,
  root,
  serveFolder,
  waitFor,
  waitText,
  write,
  writeIn,
} from "./harness.ts"

const READ_AT = 390

/** The window top of what a selector finds with exactly this text; "code line" finds a line of code. */
function topOf(page: Page, selector: string, text: string): Promise<number | null> {
  return page.evaluate(
    ([found, wanted]) => {
      if (found === "code line") {
        const code = document.querySelector(".markdown-body pre code")
        const all = code?.textContent ?? ""
        const at = all.split("\n").indexOf(wanted)
        const walker = code ? document.createTreeWalker(code, NodeFilter.SHOW_TEXT) : undefined
        let left = all.split("\n").slice(0, at).join("\n").length + (at > 0 ? 1 : 0)

        for (let node = walker?.nextNode() as Text | null; at >= 0 && node; ) {
          if (left < node.length) {
            const range = document.createRange()
            range.setStart(node, left)
            range.setEnd(node, left + 1)
            return range.getBoundingClientRect().top
          }

          left -= node.length
          node = walker?.nextNode() as Text | null
        }

        return null
      }

      const element = [...document.querySelectorAll(found)].find(
        (candidate) => candidate.textContent?.trim() === wanted,
      )
      return element?.checkVisibility() ? element.getBoundingClientRect().top : null
    },
    [selector, text],
  )
}

async function readAt(page: Page, selector: string, text: string, at = READ_AT): Promise<void> {
  await page.mouse.move(700, 400)
  await page.mouse.wheel(0, 1)
  await page.waitForTimeout(50)
  const top = await topOf(page, selector, text)
  assert.ok(top !== null, `no ${selector} reads ${text}`)
  await page.evaluate((by) => scrollBy(0, by), top - at)
  await page.waitForTimeout(100)
  assert.ok(Math.abs(((await topOf(page, selector, text)) ?? 0) - at) < 1, `${text} reached ${at}`)
}

async function stays(page: Page, selector: string, text: string, at: number, what: string) {
  const top = await topOf(page, selector, text)
  assert.ok(top !== null && Math.abs(top - at) < 1, `${what}: ${text} moved from ${at} to ${top}`)
}

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

test("Above, The row being read, Below, A folded section, Inside an opened section: a live update never moves the row being read", async () => {
  const rows = (name: string, count: number, edits: Record<number, string> = {}) =>
    Array.from(
      { length: count },
      (_, i) => `| ${name}-${i + 1} | ${edits[i + 1] ?? `${name} ${i + 1}`} |`,
    )
  const doc = (o: {
    intro?: string
    notes?: string
    edits?: Record<number, string>
    extra?: string[]
    after?: string
    spares?: Record<number, string>
  }) =>
    [
      "# Long",
      o.intro ?? "Intro.",
      "## Notes",
      o.notes ?? "Some notes.",
      "## Table",
      ["| Row | Value |", "|---|---|", ...rows("row", 90, o.edits), ...(o.extra ?? [])].join("\n"),
      o.after ?? "After the table.",
      "## Spares",
      "<details>\n<summary>More rows</summary>",
      ["| Spare | Value |", "|---|---|", ...rows("spare", 90, o.spares)].join("\n"),
      "</details>",
      "End.",
    ].join("\n\n")
  const row = ".markdown-body td:first-child"
  write({ "reading/long.md": doc({}) })
  const page = await open("reading/long.md")

  await readAt(page, row, "row-40")
  write({ "reading/long.md": doc({ intro: "Intro, edited above." }) })
  await waitText(page, "edited above")
  await stays(page, row, "row-40", READ_AT, "a paragraph above")

  write({
    "reading/long.md": doc({ intro: "Intro, edited above.", edits: { 40: "read and edited" } }),
  })
  await waitText(page, "read and edited")
  await stays(page, row, "row-40", READ_AT, "the row being read")

  const more = { intro: "Intro, edited above.", edits: { 40: "read and edited" } }
  write({ "reading/long.md": doc({ ...more, extra: ["| row-91 | added at the end |"] }) })
  await waitText(page, "added at the end")
  await stays(page, row, "row-40", READ_AT, "a row added at the end")

  write({
    "reading/long.md": doc({
      ...more,
      extra: ["| row-91 | added at the end |"],
      after: "After, edited below.",
    }),
  })
  await waitText(page, "edited below")
  await stays(page, row, "row-40", READ_AT, "a paragraph below")

  const done = { ...more, extra: ["| row-91 | added at the end |"], after: "After, edited below." }
  await page.$eval("h2#notes .fold-toggle", (control) => (control as HTMLElement).click())
  await readAt(page, row, "row-40")
  write({ "reading/long.md": doc({ ...done, notes: "Notes edited while folded." }) })
  await waitText(page, "edited while folded")
  await stays(page, row, "row-40", READ_AT, "a block inside a folded section")
  assert.equal(await page.$eval("h2#notes", (h) => h.classList.contains("folded")), true)

  await page.$eval(".markdown-body details", (details) => {
    ;(details as HTMLDetailsElement).open = true
  })
  await readAt(page, row, "spare-40")
  write({
    "reading/long.md": doc({
      ...done,
      notes: "Notes edited while folded.",
      spares: { 12: "spare edited" },
    }),
  })
  await waitText(page, "spare edited")
  assert.equal(
    await page.$eval(".markdown-body details", (d) => (d as HTMLDetailsElement).open),
    true,
  )
  await stays(page, row, "spare-40", READ_AT, "a cell inside an opened details")
  await page.close()
})

test("A table's view: Show all, a sort and a filter stay through a live update, and so does the row being read", async () => {
  const doc = (edited = "", added: string[] = []) =>
    [
      "# Weights",
      [
        "| Item | Weight |",
        "|---|---|",
        ...Array.from(
          { length: 150 },
          (_, i) =>
            `| item-${i + 1} | ${i === 2 ? `${(i * 37) % 150}${edited}` : (i * 37) % 150} |`,
        ),
        ...added,
      ].join("\n"),
      "Below.",
    ].join("\n\n")
  write({ "reading/weights.md": doc() })
  const page = await open("reading/weights.md")

  await page.$eval('.markdown-body button:has-text("Show all 150 rows")', (b) =>
    (b as HTMLElement).click(),
  )
  await page.evaluate(() =>
    (document.querySelectorAll(".markdown-body th")[1] as HTMLElement).click(),
  )
  await panel(page, 0)
  await page.fill('.table-panel input[aria-label="Filter rows"]', "1")
  await page.keyboard.press("Escape")
  const view = { caption: await caption(page, 0), rows: await cells(page, 0, 0) }
  const read = view.rows[Math.floor(view.rows.length / 2)]
  await readAt(page, ".markdown-body td:first-child", read)

  write({ "reading/weights.md": doc(" kg") })
  await waitText(page, " kg")
  assert.deepEqual({ caption: await caption(page, 0), rows: await cells(page, 0, 0) }, view)
  await stays(
    page,
    ".markdown-body td:first-child",
    read,
    READ_AT,
    "a cell edited in a viewed table",
  )

  write({ "reading/weights.md": doc(" kg", ["| item-151 | 999 |"]) })
  await waitText(page, "item-151")
  assert.deepEqual(await cells(page, 0, 0), [...view.rows, "item-151"])
  await stays(page, ".markdown-body td:first-child", read, READ_AT, "a row added below in a view")
  await page.close()
})

test("Not a table, The block being read goes, The page's end: paragraphs, list items and lines of code stay", async () => {
  const doc = (o: {
    paragraphs?: Record<number, string | null>
    items?: Record<number, string>
    code?: string[]
    codeEnd?: string[]
    end?: string
  }) =>
    [
      "# Prose",
      ...Array.from({ length: 40 }, (_, i) =>
        o.paragraphs?.[i + 1] === null ? "" : (o.paragraphs?.[i + 1] ?? `Paragraph ${i + 1}.`),
      ).filter(Boolean),
      Array.from({ length: 40 }, (_, i) => `- ${o.items?.[i + 1] ?? `Item ${i + 1}`}`).join("\n"),
      [
        "```text",
        ...(o.code ?? []),
        ...Array.from({ length: 40 }, (_, i) => `line ${i + 1}`),
        ...(o.codeEnd ?? []),
        "```",
      ].join("\n"),
      ...Array.from({ length: 30 }, (_, i) => `After the code ${i + 1}.`),
      ...(o.end ? [o.end] : []),
    ].join("\n\n")
  write({ "reading/prose.md": doc({}) })
  const page = await open("reading/prose.md")
  const p = ".markdown-body > p"
  const li = ".markdown-body li"

  await readAt(page, p, "Paragraph 20.", 60)
  write({ "reading/prose.md": doc({ paragraphs: { 5: "Paragraph 5, edited above." } }) })
  await waitText(page, "edited above")
  await stays(page, p, "Paragraph 20.", 60, "a paragraph above")
  const grown = `Paragraph 20, read and edited ${"and grown ".repeat(80)}.`
  write({
    "reading/prose.md": doc({ paragraphs: { 5: "Paragraph 5, edited above.", 20: grown } }),
  })
  await waitText(page, "read and edited")
  await stays(page, p, grown, 60, "the paragraph being read")
  const before = (await topOf(page, p, "Paragraph 19.")) ?? 0
  write({ "reading/prose.md": doc({ paragraphs: { 5: "Paragraph 5, edited above.", 20: null } }) })
  await waitFor(async () => (await topOf(page, p, grown)) === null)
  await page.waitForTimeout(100)
  await stays(page, p, "Paragraph 19.", before, "the nearest block once the one read went")

  const shown = { paragraphs: { 5: "Paragraph 5, edited above.", 20: null } }
  await readAt(page, li, "Item 20", 60)
  write({
    "reading/prose.md": doc({
      ...shown,
      items: { 5: "Item 5 edited", 20: "Item 20 edited", 30: `Item 30 ${"grown ".repeat(120)}` },
    }),
  })
  await waitText(page, "Item 30 grown")
  await stays(page, li, "Item 20 edited", 60, "list items above, at and below")

  const items = { 5: "Item 5 edited", 20: "Item 20 edited", 30: `Item 30 ${"grown ".repeat(120)}` }
  await readAt(page, "code line", "line 20", 60)
  write({ "reading/prose.md": doc({ ...shown, items, code: ["a line added above"] }) })
  await waitText(page, "a line added above")
  await stays(page, "code line", "line 20", 60, "a line of code added above")
  write({
    "reading/prose.md": doc({
      ...shown,
      items,
      code: ["a line added above"],
      codeEnd: ["below 1", "below 2", "below 3"],
    }),
  })
  await waitText(page, "below 3")
  await stays(page, "code line", "line 20", 60, "lines of code added below")

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(100)
  const end = await page.evaluate(() => scrollY)
  write({
    "reading/prose.md": doc({
      ...shown,
      items,
      code: ["a line added above"],
      codeEnd: ["below 1", "below 2", "below 3"],
      end: "Text added at the end.",
    }),
  })
  await waitText(page, "Text added at the end.")
  assert.equal(
    await page.evaluate(() => scrollY),
    end,
    "the page does not follow text added at its end",
  )
  await page.close()
})

test("Every page: a data page, a folder listing and health keep what is read through a live change", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-reading-")))
  writeIn(folder, {
    "reading/data/records.csv": [
      "name,value",
      ...Array.from({ length: 400 }, (_, i) => `rec-${i + 1},${i}`),
    ].join("\n"),
    ...Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`reading/many/file-${i + 20}.md`, `# File ${i + 20}`]),
    ),
    ...Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `reading/broken/doc-${i + 20}.md`,
        `# Doc ${i + 20}\n\n[gone](missing-${i + 20}.md)`,
      ]),
    ),
  })

  const served = await serveFolder(folder)

  try {
    const data = await context.newPage()
    await data.goto(`${served.base}/reading/data/records.csv`)
    await data.waitForSelector(".markdown-body table td")
    await data.$eval(".data-more-rows button", (more) => (more as HTMLElement).click())
    await waitFor(async () => (await topOf(data, ".markdown-body td", "rec-300")) !== null)
    await readAt(data, ".markdown-body td", "rec-300")
    writeIn(folder, {
      "reading/data/records.csv": [
        "name,value",
        "rec-0,first",
        ...Array.from({ length: 400 }, (_, i) => `rec-${i + 1},${i}`),
      ].join("\n"),
    })
    await waitFor(async () => (await topOf(data, ".markdown-body td", "rec-0")) !== null)
    await data.waitForTimeout(200)
    await stays(data, ".markdown-body td", "rec-300", READ_AT, "a data page")
    await data.close()

    const listing = await context.newPage()
    await listing.goto(`${served.base}/reading/many/`)
    await listing.waitForSelector(".markdown-body li")
    await readAt(listing, ".markdown-body li", "file-60.md")
    writeIn(folder, {
      "reading/many/file-10.md": "# File 10",
      "reading/many/file-11.md": "# File 11",
    })
    await waitFor(async () => (await topOf(listing, ".markdown-body li", "file-10.md")) !== null)
    await listing.waitForTimeout(200)
    await stays(listing, ".markdown-body li", "file-60.md", READ_AT, "a folder listing")
    await listing.close()

    const health = await context.newPage()
    await health.goto(`${served.base}/?health`)
    await health.waitForFunction(() =>
      document.querySelector(".markdown-body .health-link")?.textContent?.includes("doc-59"),
    )
    await health.evaluate(() => {
      for (const details of document.querySelectorAll("details")) {
        ;(details as HTMLDetailsElement).open = true
      }
    })
    const entry = ".markdown-body .health-link li"
    const named = await health.$$eval(entry, (entries) =>
      entries.map((e) => e.textContent?.trim() ?? ""),
    )
    const read = named.find((text) => text.includes("doc-45")) as string
    await readAt(health, entry, read)
    writeIn(folder, {
      "reading/broken/doc-21.md": "# Doc 21\n\n[gone](missing-21.md) and [again](missing-again.md)",
    })
    await health.waitForFunction(() =>
      document.querySelector(".markdown-body .health-link")?.textContent?.includes("missing-again"),
    )
    await health.waitForTimeout(200)
    await stays(health, entry, read, READ_AT, "health")
    await health.close()
  } finally {
    served.stop()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("A sorted data page, Repeated code lines, A row edited as one is added above, An embed's data, A health kind added above: what is read stays in each", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-reading-more-")))
  const records = (changed = "") =>
    [
      "name,value",
      ...Array.from({ length: 400 }, (_, i) =>
        i === 4 && changed ? `rec-5,${changed}` : `rec-${i + 1},${(i * 37) % 400}`,
      ),
    ].join("\n")
  const code = (added: string[] = []) =>
    [
      "# Code",
      [
        "```text",
        ...added,
        ...Array.from({ length: 40 }, (_, i) => [`step ${i + 1}`, ""]).flat(),
        "```",
      ].join("\n"),
      ...Array.from({ length: 30 }, (_, i) => `After ${i + 1}.`),
    ].join("\n\n")
  const rows = (inserted = false, edited = false) =>
    [
      "# Rows",
      [
        "| Row | Value |",
        "|---|---|",
        ...Array.from({ length: 60 }, (_, i) => [
          ...(inserted && i === 10 ? ["| inserted | above |"] : []),
          `| row-${i + 1} | ${edited && i === 29 ? "read and edited" : `value ${i + 1}`} |`,
        ]).flat(),
      ].join("\n"),
      ...Array.from({ length: 30 }, (_, i) => `After ${i + 1}.`),
    ].join("\n\n")
  const embedded = (extra: string[] = []) =>
    ["name,n", ...extra, ...Array.from({ length: 60 }, (_, i) => `e-${i + 1},${i}`)].join("\n")
  writeIn(folder, {
    "reading/records.csv": records(),
    "reading/code.md": code(),
    "reading/rows.md": rows(),
    "reading/embedded.csv": embedded(),
    "reading/embeds.md": [
      "# Embeds",
      ...Array.from({ length: 10 }, (_, i) => `Before ${i + 1}.`),
      "{table: embedded.csv}",
      ...Array.from({ length: 30 }, (_, i) => `After ${i + 1}.`),
    ].join("\n\n"),
    ...Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [
        `reading/broken/doc-${i + 20}.md`,
        `# Doc ${i + 20}\n\n{include: missing-${i + 20}.md}`,
      ]),
    ),
  })
  const served = await serveFolder(folder)
  const page = async (urlPath: string) => {
    const opened = await context.newPage()
    await opened.goto(`${served.base}/${urlPath}`)
    await opened.waitForSelector(".markdown-body > *")
    await opened.waitForTimeout(500)
    return opened
  }

  try {
    const data = await page("reading/records.csv")
    await data.$eval(".data-more-rows button", (more) => (more as HTMLElement).click())
    await waitFor(async () => (await topOf(data, ".markdown-body td", "rec-300")) !== null)
    await data.evaluate(() =>
      (
        [...document.querySelectorAll(".markdown-body table thead th")].find((cell) =>
          cell.textContent?.includes("value"),
        ) as HTMLElement
      ).click(),
    )
    await waitFor(async () =>
      data.evaluate(
        () =>
          document.querySelector(".markdown-body table tbody tr td:nth-child(2)")?.textContent ===
          "0",
      ),
    )
    await data.waitForTimeout(300)
    const sorted = await data.$$eval(".markdown-body table tbody tr td:first-child", (cells) =>
      cells.map((cell) => cell.textContent ?? ""),
    )
    const readRecord = sorted[150]
    await readAt(data, ".markdown-body td", readRecord, 60)
    writeIn(folder, { "reading/records.csv": records("0.5") })
    await waitFor(async () => (await topOf(data, ".markdown-body td", "0.5")) !== null)
    await data.waitForTimeout(500)
    await stays(data, ".markdown-body td", readRecord, 60, "a sorted data page")
    await data.close()

    const lines = await page("reading/code.md")
    await readAt(lines, "code line", "step 20", 20)
    writeIn(folder, { "reading/code.md": code(["a line added above"]) })
    await waitText(lines, "a line added above")
    await stays(lines, "code line", "step 20", 20, "a blank line of code")
    await lines.close()

    const table = await page("reading/rows.md")
    await readAt(table, ".markdown-body td:first-child", "row-30", 40)
    writeIn(folder, { "reading/rows.md": rows(true, true) })
    await waitText(table, "read and edited")
    await stays(
      table,
      ".markdown-body td:first-child",
      "row-30",
      40,
      "a row edited as one is added",
    )
    await table.close()

    const embeds = await page("reading/embeds.md")
    await embeds.waitForSelector(".embed-table table td")
    await readAt(embeds, ".markdown-body td", "e-30", 40)
    writeIn(folder, { "reading/embedded.csv": embedded(["e-new-1,100", "e-new-2,101"]) })
    await waitFor(async () => (await topOf(embeds, ".markdown-body td", "e-new-1")) !== null)
    await embeds.waitForTimeout(300)
    await stays(embeds, ".markdown-body td", "e-30", 40, "a row of an embed")
    await embeds.close()

    const health = await page("?health")
    const entry = ".markdown-body .health-include li"
    await health.waitForFunction(() =>
      document.querySelector(".markdown-body .health-include")?.textContent?.includes("doc-49"),
    )
    await health.evaluate(() => {
      for (const details of document.querySelectorAll("details")) {
        ;(details as HTMLDetailsElement).open = true
      }
    })
    const named = await health.$$eval(entry, (entries) =>
      entries.map((found) => found.textContent?.trim() ?? ""),
    )
    const read = named.find((text) => text.includes("doc-40")) as string
    await readAt(health, entry, read, 60)
    writeIn(folder, {
      "reading/broken/doc-21.md":
        "# Doc 21\n\n{include: missing-21.md}\n\n{include: also-gone.md}\n\n[gone](nowhere.md)",
    })
    await health.waitForFunction(() =>
      document.querySelector(".markdown-body .health-link")?.textContent?.includes("nowhere"),
    )
    await health.waitForTimeout(300)
    await stays(health, entry, read, 60, "health, a kind added above")
    await health.close()
  } finally {
    served.stop()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("Rows sharing a link, An item sharing a link goes, An item over a nested list, A rewritten paragraph: what is read stays in each", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-reading-keys-")))
  const after = Array.from({ length: 30 }, (_, i) => `After ${i + 1}.`)
  const linked = (n: number) => (n % 10 === 0 ? `[spec](spec.md) ${n}` : `${n}`)
  const rows = (edited = false) =>
    [
      "# Rows",
      [
        "| Row | Value |",
        "|---|---|",
        ...Array.from(
          { length: 90 },
          (_, i) =>
            `| row-${i + 1} | ${edited && i === 39 ? "[spec](spec.md) edited" : linked(i + 1)} |`,
        ),
      ].join("\n"),
      ...after,
    ].join("\n\n")
  const items = (gone = false) =>
    [
      "# Items",
      Array.from({ length: 80 }, (_, i) =>
        gone && i === 39 ? "" : `- Item ${i + 1}${(i + 1) % 10 === 0 ? " [spec](spec.md)" : ""}`,
      )
        .filter(Boolean)
        .join("\n"),
      ...after,
    ].join("\n\n")
  const pair = (moved = false, gone = false) =>
    [
      "# Pair",
      [
        "| Row | Value |",
        "|---|---|",
        ...Array.from({ length: 90 }, (_, i) =>
          i === 39
            ? `| row-40 | ${moved ? "[spec](other.md)" : "[spec](spec.md)"} |`
            : `| row-${i + 1} | ${i === 79 ? "[spec](spec.md)" : i + 1} |`,
        ),
      ].join("\n"),
      Array.from({ length: 80 }, (_, i) =>
        gone && i === 39 ? "" : `- Item ${i + 1}${i === 39 || i === 69 ? " [spec](spec.md)" : ""}`,
      )
        .filter(Boolean)
        .join("\n"),
      ...after,
    ].join("\n\n")
  const words = "The parent item's own words run on long enough to wrap across several lines. "
  const nested = (grown = false) =>
    [
      "# Nested",
      ...Array.from({ length: 20 }, (_, i) => `Before ${i + 1}.`),
      [
        `- ${words.repeat(4)}${grown ? words.repeat(4) : ""}`,
        "  - child a",
        "  - child b",
        "- Another item",
      ].join("\n"),
      ...after,
    ].join("\n\n")
  const tall = "A paragraph long enough to fill several lines of the page as it is read. "
  const prose = (rewritten = false) =>
    [
      "# Prose",
      ...Array.from({ length: 20 }, (_, i) => `Before ${i + 1}.`),
      rewritten
        ? "Entirely other words now stand here, written over what was read before. ".repeat(8)
        : tall.repeat(6),
      ...after,
    ].join("\n\n")
  writeIn(folder, {
    "keys/spec.md": "# Spec",
    "keys/rows.md": rows(),
    "keys/items.md": items(),
    "keys/nested.md": nested(),
    "keys/prose.md": prose(),
    "keys/pair.md": pair(),
  })
  const served = await serveFolder(folder)
  const page = async (urlPath: string) => {
    const opened = await context.newPage()
    await opened.goto(`${served.base}/${urlPath}`)
    await opened.waitForSelector(".markdown-body > *")
    await opened.waitForTimeout(500)
    return opened
  }
  const firstTop = (opened: Page, selector: string) =>
    opened.$eval(selector, (found) => found.getBoundingClientRect().top)

  try {
    const table = await page("keys/rows.md")
    await readAt(table, ".markdown-body td:first-child", "row-40", 40)
    writeIn(folder, { "keys/rows.md": rows(true) })
    await waitText(table, "spec edited")
    await table.waitForTimeout(300)
    await stays(table, ".markdown-body td:first-child", "row-40", 40, "a row sharing its link")
    await table.close()

    const list = await page("keys/items.md")
    await readAt(list, ".markdown-body li", "Item 40 spec", 40)
    const before = (await topOf(list, ".markdown-body li", "Item 39")) as number
    writeIn(folder, { "keys/items.md": items(true) })
    await waitFor(async () => (await topOf(list, ".markdown-body li", "Item 40 spec")) === null)
    await list.waitForTimeout(300)
    await stays(list, ".markdown-body li", "Item 39", before, "the item before one gone")
    await list.close()

    const paired = await page("keys/pair.md")
    await readAt(paired, ".markdown-body td:first-child", "row-40", 40)
    writeIn(folder, { "keys/pair.md": pair(true) })
    await waitFor(async () =>
      paired.$$eval('.markdown-body a[href="other.md"]', (found) => found.length === 1),
    )
    await paired.waitForTimeout(300)
    await stays(
      paired,
      ".markdown-body td:first-child",
      "row-40",
      40,
      "a row whose link one other row shared",
    )
    await readAt(paired, ".markdown-body li", "Item 40 spec", 40)
    const above = (await topOf(paired, ".markdown-body li", "Item 39")) as number
    writeIn(folder, { "keys/pair.md": pair(true, true) })
    await waitFor(async () => (await topOf(paired, ".markdown-body li", "Item 40 spec")) === null)
    await paired.waitForTimeout(300)
    await stays(
      paired,
      ".markdown-body li",
      "Item 39",
      above,
      "the item before one gone whose link one other shared",
    )
    await paired.close()

    const parent = await page("keys/nested.md")
    const item = ".markdown-body > ul > li"
    await parent.mouse.move(700, 400)
    await parent.mouse.wheel(0, 1)
    await parent.evaluate((by) => scrollBy(0, by), (await firstTop(parent, item)) - 20)
    await parent.waitForTimeout(100)
    const held = await firstTop(parent, item)
    writeIn(folder, { "keys/nested.md": nested(true) })
    await waitFor(async () =>
      parent.$eval(item, (found) => (found.textContent?.match(/own words/g) ?? []).length === 8),
    )
    await parent.waitForTimeout(300)
    assert.ok(
      Math.abs((await firstTop(parent, item)) - held) < 1,
      `an item over a nested list moved from ${held} to ${await firstTop(parent, item)}`,
    )
    await parent.close()

    const rewritten = await page("keys/prose.md")
    const read = ".markdown-body > p:nth-of-type(21)"
    const press = (title: string) =>
      rewritten.$eval(`button[title="${title}"]`, (button) => (button as HTMLElement).click())
    await rewritten.mouse.move(700, 400)
    await rewritten.mouse.wheel(0, 1)
    await rewritten.evaluate((by) => scrollBy(0, by), (await firstTop(rewritten, read)) + 20)
    await rewritten.waitForTimeout(100)
    const top = await firstTop(rewritten, read)
    // Held while the file is parsed, so the page meets the rewritten paragraph with its new id.
    await press("Suspend live updates in this tab")
    writeIn(folder, { "keys/prose.md": prose(true) })
    await rewritten.waitForTimeout(1500)
    await press("Resume live updates in this tab")
    await waitText(rewritten, "Entirely other words")
    await rewritten.waitForTimeout(500)
    assert.ok(
      Math.abs((await firstTop(rewritten, read)) - top) < 1,
      `a rewritten paragraph moved from ${top} to ${await firstTop(rewritten, read)}`,
    )
    await rewritten.close()
  } finally {
    served.stop()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
