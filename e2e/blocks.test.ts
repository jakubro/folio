/** Headless Chromium run of Folio's documented behaviour: block sources, block links, backlinks and includes. */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Page } from "playwright"
import {
  base,
  CLI,
  context,
  ENV,
  freePort,
  landed,
  open,
  output,
  root,
  until,
  visible,
  waitFor,
  waitText,
  write,
  writeIn,
} from "./harness.ts"

test("Own block, Included block, Nested include, Lines move, Same file twice: every block knows its source file and lines", async () => {
  write({
    "sources/page.md":
      "# Page\n\nOwn paragraph.\n\n{include: parts/part.md}\n\nAfter.\n\n{include: parts/part.md}",
    "sources/parts/part.md": "## Part\n\nPart text.\n\n{include: leaf.md}",
    "sources/parts/leaf.md": "- leaf item",
  })
  const page = await open("sources/page.md")
  const sources = () =>
    page.$$eval(".markdown-body > *", (blocks) =>
      blocks.map((block) => {
        const { folioSource, folioLines } = (block as HTMLElement).dataset
        return `${block.textContent?.trim()} @ ${folioSource}:${folioLines}`
      }),
    )

  assert.deepEqual(await sources(), [
    "Page @ sources/page.md:1-1",
    "Own paragraph. @ sources/page.md:3-3",
    "Part @ sources/parts/part.md:1-1",
    "Part text. @ sources/parts/part.md:3-3",
    "leaf item @ sources/parts/leaf.md:1-1",
    "After. @ sources/page.md:7-7",
    "Part @ sources/parts/part.md:1-1",
    "Part text. @ sources/parts/part.md:3-3",
    "leaf item @ sources/parts/leaf.md:1-1",
  ])

  const kept = await page.$("p[data-folio-source='sources/parts/part.md']")
  write({ "sources/parts/part.md": "Added.\n\n## Part\n\nPart text.\n\n{include: leaf.md}" })
  await waitText(page, "Added.")

  assert.deepEqual((await sources()).slice(2, 6), [
    "Added. @ sources/parts/part.md:1-1",
    "Part @ sources/parts/part.md:3-3",
    "Part text. @ sources/parts/part.md:5-5",
    "leaf item @ sources/parts/leaf.md:1-1",
  ])
  assert.equal(await kept?.evaluate((block) => block.isConnected), true)
  await page.close()
})

test("Own block, Included block, Nested include: every block reports the file holding its first line", async () => {
  write({
    "firstline/page.md":
      "See {include: word.md} here.\n\n{include: item.md}\n- outer\n\n<details>\n\nInside text.\n\n</details>\n\nNote[^1].\n\n[^1]: The note.\n",
    "firstline/word.md": "folio",
    "firstline/item.md": "- item\n",
    "firstline/flow.mmd": "graph TD\n  A --> B\n",
  })
  const page = await open("firstline/page.md")
  const sources = () =>
    page.$$eval(".markdown-body > *", (blocks) =>
      blocks.map((block) => {
        const { folioId, folioSource, folioLines } = (block as HTMLElement).dataset
        return [block.tagName, folioSource, folioLines, /^[0-9a-f]{8}$/.test(folioId ?? "")]
      }),
    )
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body > [data-folio-id]").length === 5,
  )

  assert.deepEqual(await sources(), [
    ["P", "firstline/page.md", "1-1", true],
    ["UL", "firstline/item.md", "1-1", true],
    ["DETAILS", "firstline/page.md", "6-10", true],
    ["P", "firstline/page.md", "12-12", true],
    ["SECTION", "firstline/page.md", "14-14", true],
  ])

  const diagram = await open("firstline/flow.mmd")
  await diagram.waitForSelector(".markdown-body > [data-folio-id]")
  assert.equal(
    await diagram.$eval(".markdown-body > *", (block) => (block as HTMLElement).dataset.folioLines),
    "1-2",
  )
  await diagram.close()
  await page.close()
})

test("Read a block, Hear a redraw, Survive an update, Follow a link: other tools attach through the output contract", async () => {
  write({
    "contract/page.md":
      "# Contract\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n[Next](next.md)",
    "contract/next.md": "# Next",
  })
  const page = await open("contract/page.md")
  await page.evaluate(() => {
    const heard: object[] = []
    const ids = (blocks: Element[]) => blocks.map((block) => block.textContent?.trim())
    ;(window as { heard?: object[] }).heard = heard
    document.addEventListener("folio:redraw", (event) => {
      const { page, cause, added, changed, removed } = (event as CustomEvent).detail
      heard.push({ page, cause, added: ids(added), changed: ids(changed), removed: ids(removed) })
    })
    const third = [...document.querySelectorAll("[data-folio-id]")].find(
      (block) => block.textContent === "Third paragraph.",
    )
    third?.append(Object.assign(document.createElement("button"), { className: "patched" }))
  })
  const read = await page.$eval("[data-folio-id]:nth-child(2)", (block) => ({
    ...(block as HTMLElement).dataset,
  }))

  assert.match(read.folioId ?? "", /^[0-9a-f]{8}$/)
  assert.deepEqual([read.folioSource, read.folioLines], ["contract/page.md", "3-3"])

  write({
    "contract/page.md":
      "# Contract\n\nFirst paragraph, edited.\n\nThird paragraph.\n\nA new one.\n\n[Next](next.md)",
  })
  await page.waitForFunction(() => (window as { heard?: object[] }).heard?.length === 1)

  assert.deepEqual(await page.evaluate(() => (window as { heard?: object[] }).heard), [
    {
      page: "contract/page.md",
      cause: "update",
      added: ["A new one."],
      changed: ["First paragraph, edited."],
      removed: ["Second paragraph."],
    },
  ])
  assert.equal(await page.locator(".markdown-body .patched").count(), 1)

  await page.click('.markdown-body a[href="next.md"]')
  await page.waitForFunction(() => (window as { heard?: object[] }).heard?.length === 2)
  const followed = await page.evaluate(
    () => (window as { heard?: { page: string; cause: string; added: string[] }[] }).heard?.[1],
  )

  assert.deepEqual(
    [followed?.page, followed?.cause, followed?.added],
    ["contract/next.md", "load", ["Next"]],
  )
  await page.close()
})

test("Hear a redraw: an update drawn before its block ids are parsed is announced once they are", async () => {
  write({ "early/page.md": "# Early\n\nFirst paragraph.\n\nSecond paragraph." })
  const page = await open("early/page.md")
  await page.evaluate(() => {
    const heard: object[] = []
    const texts = (blocks: Element[]) => blocks.map((block) => block.textContent?.trim())
    ;(window as { heard?: object[] }).heard = heard
    document.addEventListener("folio:redraw", (event) => {
      const { added, changed, removed } = (event as CustomEvent).detail
      heard.push({
        cause: (event as CustomEvent).detail.cause,
        added: texts(added),
        changed: texts(changed),
        removed: texts(removed),
      })
    })
  })
  // Until released, every answer is made to look as the server sends a page still parsing.
  let disguising = true
  await page.route("**/early/page.md?page", async (route) => {
    if (!disguising) {
      return route.continue()
    }

    const response = await route.fetch()
    const content = await response.json()
    await route.fulfill({
      response,
      json: { ...content, blocks: [], version: `${content.version}-partial` },
    })
  })

  write({ "early/page.md": "# Early\n\nFirst paragraph, edited.\n\nA new one." })
  await waitText(page, "A new one.")
  await page.waitForTimeout(300)
  assert.deepEqual(await page.evaluate(() => (window as { heard?: object[] }).heard), [])

  disguising = false
  await page.waitForFunction(() => (window as { heard?: object[] }).heard?.length)
  await page.waitForTimeout(300)

  assert.deepEqual(await page.evaluate(() => (window as { heard?: object[] }).heard), [
    {
      cause: "update",
      added: ["A new one."],
      changed: ["First paragraph, edited."],
      removed: ["Second paragraph."],
    },
  ])
  await page.close()
})

test("Hear a redraw: while ids parse, twins stay apart, a load waits, and a block moved to another file is reported", async () => {
  type Heard = { cause: string; added: string[]; changed: string[]; removed: string[] }
  const page = await context.newPage()
  await page.addInitScript(() => {
    const heard: object[] = []
    const ids = (blocks: HTMLElement[]) =>
      blocks.map((block) => `${block.dataset.folioSource}#${block.dataset.folioId}`)
    ;(window as { heard?: object[] }).heard = heard
    document.addEventListener("folio:redraw", (event) => {
      const { cause, added, changed, removed } = (event as CustomEvent).detail
      heard.push({ cause, added: ids(added), changed: ids(changed), removed: ids(removed) })
    })
  })
  const heard = async () =>
    (await page.evaluate(() => (window as { heard?: object[] }).heard)) as Heard[]
  let disguising = true
  // Until released, every answer looks as the server sends a page still parsing.
  await page.route("**/held/*.md?page", async (route) => {
    if (!disguising) {
      return route.continue()
    }

    const response = await route.fetch()
    const content = await response.json()
    await route.fulfill({
      response,
      json: { ...content, blocks: [], version: `${content.version}-partial` },
    })
  })
  // Lets real answers through until an event arrives, then disguises again; returns what was heard.
  const settle = async (): Promise<Heard[]> => {
    const seen = (await heard()).length
    disguising = false
    await page.waitForFunction(
      (n) => ((window as { heard?: object[] }).heard?.length ?? 0) > n,
      seen,
    )
    await page.waitForTimeout(300)
    disguising = true
    return (await heard()).slice(seen)
  }
  const idOf = async (file: string): Promise<string> => {
    const served = await (await context.request.get(`${base}/held/${file}?page`)).json()
    const block = served.blocks.find(
      (found: { source: string; kind: string }) =>
        found.source === `held/${file}` && found.kind === "paragraph",
    )
    return served.version.endsWith("-partial") ? idOf(file) : `held/${file}#${block?.id}`
  }

  write({
    "held/page.md": "# Held\n\nSame words.\n\n{include: part.md}",
    "held/part.md": "Same words.",
  })
  const own = await idOf("page.md")
  await page.goto(`${base}/held/page.md`)
  await page.waitForSelector(".markdown-body > *")
  await page.waitForTimeout(300)
  assert.deepEqual(await heard(), [], "a load drawn while parsing was announced at once")
  await page.evaluate(() =>
    document
      .querySelector(".markdown-body")
      ?.append(Object.assign(document.createElement("p"), { className: "tool-note" })),
  )

  const loaded = await settle()
  assert.deepEqual([loaded[0].cause, loaded[0].added.length], ["load", 3])
  assert.equal(
    await page.locator(".markdown-body > .tool-note").count(),
    1,
    "ids arriving removed a tool's node",
  )

  write({ "held/page.md": "# Held\n\n{include: part.md}" })
  await page.waitForFunction(() => document.querySelectorAll(".markdown-body > p").length === 1)
  const deleted = await settle()
  assert.deepEqual(deleted, [{ cause: "update", added: [], changed: [], removed: [own] }])

  write({
    "held/page.md": "# Held\n\nMoved words.\n\n{include: part.md}",
    "held/part.md": "Other.",
  })
  await waitText(page, "Moved words.")
  await settle()
  write({
    "held/part.md": "Moved words.\n\nOther.",
    "held/page.md": "# Held\n\n{include: part.md}",
  })
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".markdown-body > p")].every(
      (p) => p.getAttribute("data-folio-source") === "held/part.md",
    ),
  )
  const moved = (await settle()).flatMap((event) => event.changed)
  assert.ok(
    moved.some((id) => id.startsWith("held/part.md#")),
    `the block moved to another file went unreported: ${JSON.stringify(moved)}`,
  )
  await page.close()
})

test("Hear a redraw: identical blocks from two files are told apart by file and id", async () => {
  write({
    "twins/page.md": "# Twins\n\nSame words.\n\n{include: part.md}",
    "twins/part.md": "Same words.",
  })
  const page = await open("twins/page.md")
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body > [data-folio-id]").length === 3,
  )
  const ids = await page.$$eval(".markdown-body > p", (blocks) =>
    blocks.map(
      (block) =>
        `${(block as HTMLElement).dataset.folioSource}#${(block as HTMLElement).dataset.folioId}`,
    ),
  )
  await page.evaluate(() => {
    const heard: string[][] = []
    ;(window as { heard?: string[][] }).heard = heard
    document.addEventListener("folio:redraw", (event) => {
      const { removed } = (event as CustomEvent).detail as { removed: HTMLElement[] }
      heard.push(removed.map((block) => `${block.dataset.folioSource}#${block.dataset.folioId}`))
    })
  })

  write({ "twins/page.md": "# Twins\n\n{include: part.md}" })
  await page.waitForFunction(() => (window as { heard?: string[][] }).heard?.length)

  assert.deepEqual(await page.evaluate(() => (window as { heard?: string[][] }).heard), [[ids[0]]])
  assert.deepEqual(
    await page.$$eval(".markdown-body > p", (blocks) =>
      blocks.map(
        (block) =>
          `${(block as HTMLElement).dataset.folioSource}#${(block as HTMLElement).dataset.folioId}`,
      ),
    ),
    [ids[1]],
  )
  await page.close()
})

test("Block gone, Get a link: the gone notice clears on any navigation, and a modified click on the mark opens a tab", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler ${i + 1}.`).join("\n\n")
  write({ "vanished/doc.md": `# Doc\n\n${filler}\n\n## Later\n\nKept paragraph.\n\n${filler}` })
  const page = await context.newPage()
  await page.goto(`${base}/vanished/doc.md#^00000000`)
  await page.waitForSelector(".markdown-body > *")
  const notice = () => page.isVisible(".block-gone")

  assert.equal(await notice(), true)
  await page.locator(".markdown-body p", { hasText: "Kept paragraph." }).hover()
  await page.click(".block-link")
  assert.equal(await notice(), false, "a mark click left the notice")

  await page.goto(`${base}/vanished/doc.md#^00000000`)
  await page.waitForSelector(".markdown-body > *")
  await page.hover(".markdown-body h2")
  await page.click(".markdown-body h2 .heading-link")
  assert.equal(await notice(), false, "a heading mark click left the notice")

  await page.locator(".markdown-body p", { hasText: "Kept paragraph." }).hover()
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.click(".block-link", { modifiers: ["ControlOrMeta"] }),
  ])
  await tab.waitForURL(/#\^[0-9a-f]{8}$/)
  assert.match(page.url(), /#later$/)
  await tab.close()
  await page.close()
})

test("Block gone, Read before: a link to a block read and since removed shows the gone notice", async () => {
  write({ "readgone/doc.md": "# Doc\n\nThe valve closes at noon.\n\nKept paragraph.\n" })
  const page = await open("readgone/doc.md")
  const id = await page
    .locator(".markdown-body p", { hasText: "valve" })
    .getAttribute("data-folio-id")
  await waitFor(async () => {
    const { blocks } = await (await fetch(`${base}/readgone/doc.md?read`)).json()
    return blocks.some((block: { id: string; read: unknown }) => block.id === id && block.read)
  })

  write({ "readgone/doc.md": "# Doc\n\nKept paragraph.\n" })
  const fresh = await context.newPage()
  await fresh.goto(`${base}/readgone/doc.md#^${id}`)
  await fresh.waitForSelector(".read-mark.mark-removed")
  assert.equal(await fresh.isVisible(".block-gone"), true)
  assert.equal(await fresh.locator(".landed").count(), 0)
  await Promise.all([fresh.close(), page.close()])
})

test("Get a link, Follow it, Block moved, Block reworded, Block gone, Heading links: a link can point at any block and survives edits", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n")
  const target = "The pump stops when the tank is full."
  write({
    "anchors/doc.md": `# Doc\n\n${filler}\n\n## Target section\n\n${target}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${filler}`,
  })
  const page = await open("anchors/doc.md")
  const bar = await page.$eval(".bar", (element) => element.getBoundingClientRect().bottom)
  const paragraph = page.locator(".markdown-body p", { hasText: target })

  await paragraph.hover()
  await page.click(".block-link")
  const link = page.url()
  const id = await paragraph.getAttribute("data-folio-id")

  assert.equal(new URL(link).hash, `#^${id}`)
  assert.equal(await page.locator(".markdown-body .landed").count(), 1)
  await page.locator(".markdown-body table").hover()
  assert.equal(
    await page.$eval(".block-link", (mark) => (mark as HTMLAnchorElement).hash),
    `#^${await page.locator(".markdown-body table").getAttribute("data-folio-id")}`,
  )
  assert.equal(
    await page
      .locator(".markdown-body h2")
      .hover()
      .then(() => page.isVisible(".block-link")),
    false,
  )

  const landed = async () => {
    const fresh = await context.newPage()
    await fresh.goto(link)
    await fresh.waitForSelector(".markdown-body > *")
    await fresh.waitForTimeout(200)
    const found = await fresh.evaluate((text) => {
      const block = [...document.querySelectorAll(".markdown-body [data-folio-id]")].find((b) =>
        b.textContent?.includes(text),
      )
      return {
        top: block ? Math.round(block.getBoundingClientRect().top) : null,
        marked: block?.classList.contains("landed") ?? false,
        gone: !(document.querySelector(".block-gone") as HTMLElement).hidden,
        scrolled: scrollY > 0,
      }
    }, "pump")
    await fresh.close()
    return found
  }
  const below = bar + 12

  assert.deepEqual(await landed(), { top: below, marked: true, gone: false, scrolled: true })

  write({
    "anchors/doc.md": `# Doc\n\n${filler}\n\n## Target section\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${target}\n\n${filler}`,
  })
  await waitText(page, "Doc")
  assert.deepEqual(
    await landed(),
    { top: below, marked: true, gone: false, scrolled: true },
    "moved",
  )

  write({
    "anchors/doc.md": `# Doc\n\n${filler}\n\nThe pump halts once the tank is full.\n\n${filler}`,
  })
  assert.deepEqual(
    await landed(),
    { top: below, marked: true, gone: false, scrolled: true },
    "reworded",
  )

  write({ "anchors/doc.md": `# Doc\n\n${filler}` })
  assert.deepEqual(
    await landed(),
    { top: null, marked: false, gone: true, scrolled: false },
    "gone",
  )

  const heading = await context.newPage()
  write({ "anchors/doc.md": `# Doc\n\n${filler}\n\n## Target section\n\n${filler}` })
  await heading.goto(`${base}/anchors/doc.md#target-section`)
  await heading.waitForSelector(".markdown-body > *")
  await heading.waitForTimeout(200)
  assert.equal(
    await heading.$eval("#target-section", (h) => Math.round(h.getBoundingClientRect().top)),
    below,
  )
  assert.equal(await heading.isVisible(".block-gone"), false)
  await heading.close()
  await page.close()
})

test("From a lower line, Past a narrow table, Far right, Left margin, Down a margin, Heading, On the block: a block's controls show anywhere level with it", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `Word ${i} of a paragraph that wraps.`).join(
    " ",
  )
  write({
    "level/doc.md": `# Level\n\n${long}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Section\n\nUnder the section.\n`,
  })
  const page = await open("level/doc.md")
  await page.setViewportSize({ width: 2200, height: 900 })
  const boxOf = (selector: string) =>
    page.$eval(selector, (element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect()
      return { left, right, top, bottom, middle: (top + bottom) / 2 }
    })
  const idOf = (selector: string) =>
    page.$eval(selector, (block) => `#^${(block as HTMLElement).dataset.folioId}`)
  const linked = () =>
    page.$eval(".block-link", (mark) =>
      (mark as HTMLAnchorElement).hidden ? null : (mark as HTMLAnchorElement).hash,
    )
  const offered = () => page.isVisible(".block-provenance")
  const main = await boxOf("main")
  const paragraph = await boxOf(".markdown-body > p >> nth=0")
  const table = await boxOf(".markdown-body > table")
  const heading = await boxOf(".markdown-body > h2")
  const last = await boxOf('.markdown-body > p:has-text("Under the section.")')
  const third = paragraph.top + 50

  assert.ok(paragraph.bottom - paragraph.top > 60, "the paragraph has a third line")
  assert.ok(table.right + 40 < paragraph.right, "the table is narrower than the page")

  await page.mouse.move(paragraph.left + 10, paragraph.top + 5)
  assert.equal(await linked(), await idOf(".markdown-body > p >> nth=0"), "on the block")

  await page.mouse.move(paragraph.left + 10, third)
  await page.mouse.move(paragraph.right + 60, third, { steps: 10 })
  assert.equal(await linked(), await idOf(".markdown-body > p >> nth=0"), "from a lower line")
  const why = await boxOf(".block-provenance")
  await page.mouse.move(why.left + 12, why.middle, { steps: 10 })
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line")
  assert.match(
    (await page.textContent(".provenance-panel .provenance-line")) ?? "",
    /^level\/doc\.md lines 3-3, /,
  )
  await page.keyboard.press("Escape")

  await page.mouse.move(table.right + 40, table.middle)
  assert.equal(await linked(), await idOf(".markdown-body > table"), "past a narrow table")

  await page.mouse.move(main.right - 5, paragraph.top + 5)
  assert.equal(await linked(), await idOf(".markdown-body > p >> nth=0"), "far right")

  for (const [box, selector] of [
    [paragraph, ".markdown-body > p >> nth=0"],
    [table, ".markdown-body > table"],
    [last, '.markdown-body > p:has-text("Under the section.")'],
  ] as const) {
    await page.mouse.move(main.right - 5, box.middle, { steps: 5 })
    assert.equal(await linked(), await idOf(selector), `down a margin: ${selector}`)
  }

  await page.mouse.move(main.left + 5, third)
  assert.equal(await linked(), await idOf(".markdown-body > p >> nth=0"), "left margin")

  for (const x of [main.left + 5, main.right - 5]) {
    await page.mouse.move(x, heading.middle)
    assert.deepEqual(
      await page.$eval(".markdown-body > h2", (h2) =>
        [".fold-toggle", ".heading-link"].map(
          (control) => getComputedStyle(h2.querySelector(control) as Element).opacity,
        ),
      ),
      ["1", "1"],
      `heading at x ${x}`,
    )
    assert.equal(await offered(), true)
    assert.equal(await linked(), null)
  }

  await page.mouse.move(main.right - 5, last.bottom + 40)
  assert.equal(await offered(), false, "below every block")

  await page.mouse.move(paragraph.left + 10, paragraph.top + 5)
  await page.keyboard.press("Alt+ArrowLeft")
  await page.waitForFunction(
    (left) =>
      (document.querySelector(".markdown-body") as Element).getBoundingClientRect().left !== left,
    paragraph.left,
  )
  await page.mouse.move(paragraph.left + 12, paragraph.top + 6)
  assert.deepEqual(
    await page.evaluate(() => [
      Math.round(
        (document.querySelector(".block-link") as HTMLElement).getBoundingClientRect().right,
      ),
      Math.round(
        (document.querySelector(".markdown-body") as Element).getBoundingClientRect().left,
      ),
    ]),
    await page.evaluate(() => {
      const left = Math.round(
        (document.querySelector(".markdown-body") as Element).getBoundingClientRect().left,
      )
      return [left, left]
    }),
    "the mark follows the page when it moves under a resting pointer",
  )
  await page.keyboard.press("Alt+ArrowLeft")
  await page.waitForSelector(".tree .current")
  await page.close()
})

test("h1, h2, h3, h4 to h6, Two lines, Warning, Other blocks: a heading's buttons start at the top of its first line", async () => {
  const wrapping =
    "A heading long enough to wrap onto a second line of the page, and then a few more words"
  write({
    "slots/rates.csv": "arm,pct\nA,0.816\n",
    "slots/doc.md": `# One\n\nText.\n\n## Two\n\nText.\n\n### Three\n\nText.\n\n#### Four\n\nText.\n\n## ${wrapping}\n\nText.\n\n## Rate <data value="rates.csv#0.pct">81%</data> now\n\nPara <data value="rates.csv#0.pct">81%</data> too.\n`,
  })
  const page = await open("slots/doc.md")
  const near = (px: number) => Math.round(px) || 0
  await page.waitForFunction(
    () => document.querySelectorAll(".problem-flag:not([hidden])").length === 2,
  )
  const boxOf = (selector: string) =>
    page.$eval(selector, (element) => {
      const { top, bottom } = element.getBoundingClientRect()
      const rule = bottom - Number.parseFloat(getComputedStyle(element).borderBottomWidth)
      return { top, bottom, rule }
    })
  const slots = async (selector: string) => {
    await page.hover(selector)
    const block = await boxOf(selector)
    const why = await boxOf(".block-provenance")
    const copy = await boxOf(".block-copy")
    return {
      why: near(why.top - block.top),
      copy: near(copy.top - why.bottom),
      clear: copy.bottom <= block.rule,
      crossing: near(copy.bottom - block.rule),
    }
  }

  for (const level of ["h1", "h2"]) {
    const { why, copy, clear } = await slots(`.markdown-body > ${level} >> nth=0`)
    assert.deepEqual({ why, copy, clear }, { why: 0, copy: 0, clear: true }, level)
  }

  const three = await slots(".markdown-body > h3")
  assert.deepEqual([three.why, three.copy], [0, 0], "h3")
  assert.ok(three.crossing <= 7, `h3 crosses its rule by ${three.crossing} px`)

  const four = await slots(".markdown-body > h4")
  assert.deepEqual([four.why, four.copy], [0, 0], "h4")

  const long = `.markdown-body > h2:has-text("${wrapping}")`
  const lines = await boxOf(long)
  assert.ok(lines.bottom - lines.top > 60, "the heading wraps")
  assert.deepEqual((({ why, copy }) => ({ why, copy }))(await slots(long)), { why: 0, copy: 0 })

  const signed = async (selector: string) => {
    await page.hover(selector)
    const block = await boxOf(selector)
    const why = await boxOf(".block-provenance")
    const sign = await page.evaluate((selector) => {
      const { folioId } = (document.querySelector(selector) as HTMLElement).dataset
      return [...document.querySelectorAll<HTMLElement>(".problem-flag")]
        .find((flag) => flag.dataset.folioId === folioId)
        ?.getBoundingClientRect().top
    }, selector)
    return {
      sign: sign === undefined ? "no sign" : near(sign - why.top),
      why: near(why.top - block.top),
    }
  }
  assert.deepEqual(await signed(".markdown-body > h2:last-of-type"), { sign: 0, why: 0 })
  const para = await signed(".markdown-body > p:last-of-type")
  assert.ok(
    para.sign === 0 && para.why > 0,
    "a paragraph's sign stays in its info button's place, below the clock",
  )

  await page.hover(".markdown-body > p >> nth=0")
  const paragraph = await boxOf(".markdown-body > p >> nth=0")
  const clock = await boxOf(".block-history")
  const why = await boxOf(".block-provenance")
  const copy = await boxOf(".block-copy")
  assert.deepEqual(
    [clock.top - paragraph.top, why.top - paragraph.top - (copy.top - why.top)].map(near),
    [0, 0],
    "other blocks",
  )
  await page.close()
})

test("Open, Few versions, No history, Absent, The page, A version, New tab, One at a time, Close: a block's clock opens its latest versions in a popup", async () => {
  // Folio may or may not keep a new file's first text; a first save changing only another block hides which.
  const start = async (file: string, text: string, later: string[]) => {
    write({ [file]: `# Past\n\n${text}\n\nSteady text.\n` })
    const page = await open(file)

    for (const [index, next] of [text, ...later].entries()) {
      write({ [file]: `# Past\n\n${next}\n\nSteady text, saved ${index}.\n` })
      await waitText(page, `Steady text, saved ${index}.`)
    }

    return page
  }
  const page = await start(
    "past/five.md",
    "The pump runs 1 hour.",
    [2, 3, 4, 5].map((hours) => `The pump runs ${hours} hours.`),
  )
  const paragraph = ".markdown-body > p >> nth=0"
  const clock = async () => {
    await page.hover(paragraph, { position: { x: 5, y: 5 } })
    await page.click(".block-history")
  }
  const shown = () =>
    page.$eval(".provenance-panel", (panel) =>
      (panel as HTMLElement).hidden
        ? null
        : {
            title: panel.querySelector(".mark-panel-title")?.textContent,
            texts: [...panel.querySelectorAll(".history-block li")].map(
              (item) => item.querySelector("pre, p")?.textContent,
            ),
            added: [...panel.querySelectorAll(".history-block li ins")].map(
              (ins) => ins.textContent,
            ),
            all: [...panel.querySelectorAll("a")].at(-1)?.textContent,
          },
    )

  await clock()
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  assert.deepEqual(await shown(), {
    title: "This block's past versions",
    texts: ["The pump runs 5 hours.", "The pump runs 4 hours.", "The pump runs 3 hours."],
    added: ["5", "4", "3"],
    all: "All 5 versions",
  })
  assert.equal(new URL(page.url()).search, "", "open: the page stays")

  await clock()
  assert.equal(await shown(), null, "close: the clock again")
  await clock()
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  await page.keyboard.press("Escape")
  assert.equal(await shown(), null, "close: Escape")
  await clock()
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  await page.click(".provenance-panel .mark-panel-close")
  assert.equal(await shown(), null, "close: its button")

  await page.hover(paragraph, { position: { x: 5, y: 5 } })
  await page.click(".block-provenance")
  await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line")
  await clock()
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  assert.equal(await page.locator(".mark-panel:not([hidden])").count(), 1)
  assert.equal(await page.locator(".provenance-panel .provenance-line").count(), 0)
  await page.hover(paragraph, { position: { x: 5, y: 5 } })
  await page.click(".block-provenance")
  await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line")
  assert.equal(await page.locator(".provenance-panel .history-block").count(), 0, "one at a time")
  await page.keyboard.press("Escape")

  const id = await page.getAttribute(paragraph, "data-folio-id")
  for (const button of ["left", "middle"] as const) {
    await page.hover(paragraph, { position: { x: 5, y: 5 } })
    const [tab] = await Promise.all([
      context.waitForEvent("page"),
      page.click(".block-history", {
        button,
        modifiers: button === "left" ? ["ControlOrMeta"] : [],
      }),
    ])
    // A tab a click opens starts at about:blank, whose load can be the one waited for.
    await tab.waitForURL((url) => url.href !== "about:blank")
    await tab.waitForLoadState()
    assert.equal(
      decodeURIComponent(new URL(tab.url()).search),
      `?history&block=${id}`,
      `new tab: ${button}`,
    )
    await tab.close()
  }
  assert.equal(await shown(), null, "a click for a new tab opens no popup")

  await clock()
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  await Promise.all([
    page.waitForURL(/\?history&at=/),
    page.click(".provenance-panel .history-block li >> nth=1 >> a"),
  ])
  await page.waitForSelector(".history-banner")
  assert.match(
    (await page.textContent(".markdown-body")) ?? "",
    /The pump runs 4 hours\./,
    "a version",
  )
  await page.goBack()
  await page.waitForSelector(paragraph)
  await clock()
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  await Promise.all([page.waitForURL(/\?history&block=/), page.click("text=All 5 versions")])
  await page.waitForSelector(".history-block li")
  assert.equal(await page.locator(".history-block li").count(), 5, "the page")
  await page.close()

  const two = await start("past/two.md", "The gate opens at six.", ["The gate opens at seven."])
  await two.hover(".markdown-body > p >> nth=0")
  await two.click(".block-history")
  await two.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  assert.deepEqual(
    await two.$$eval(".provenance-panel .history-block li pre", (found) =>
      found.map((pre) => pre.textContent),
    ),
    ["The gate opens at seven.", "The gate opens at six."],
  )
  assert.equal(await two.textContent(".provenance-panel p:last-child a"), "All 2 versions")
  await two.close()

  const gone = await start("past/gone.md", "The valve leaks.", [])
  write({ "past/gone.md": "# Past\n\nSteady text, removed.\n" })
  await waitText(gone, "Steady text, removed.")
  write({ "past/gone.md": "# Past\n\nThe valve leaks.\n\nSteady text, back.\n" })
  await waitText(gone, "Steady text, back.")
  await gone.hover(".markdown-body > p >> nth=0")
  await gone.click(".block-history")
  await gone.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  assert.deepEqual(
    await gone.$$eval(".provenance-panel .history-block li", (found) =>
      found.slice(0, 2).map((item) => item.querySelector("pre, p")?.textContent),
    ),
    ["The valve leaks.", "Not in the document."],
    "absent",
  )

  await gone.keyboard.press("Escape")
  await gone.route(/[?&]block-history=/, (route) => route.fulfill({ json: { versions: [] } }))
  await gone.hover(".markdown-body > p >> nth=0")
  await gone.click(".block-history")
  await gone.waitForSelector(".provenance-panel:not([hidden]) .markdown-body p")
  assert.deepEqual(
    await gone.$eval(".provenance-panel .markdown-body", (body) => body.textContent),
    "No history for this block.",
    "no history",
  )
  await gone.close()
})

test("a block's buttons stay under a pointer that does not move while a save and its ids redraw the page", async () => {
  write({ "past/resting.md": "# Resting\n\nThe pump runs at noon.\n\nA second paragraph.\n" })
  const page = await open("past/resting.md")
  await page.waitForSelector(".markdown-body > p[data-folio-id]")
  await page.hover(".markdown-body > p >> nth=0", { position: { x: 5, y: 5 } })
  await page.waitForSelector(".block-history:not([hidden])")
  await page.evaluate(() => {
    document.addEventListener("folio:redraw", () => {
      ;(window as unknown as { redraws: number }).redraws =
        ((window as unknown as { redraws?: number }).redraws ?? 0) + 1
    })
  })

  write({
    "past/resting.md": "# Resting\n\nThe pump runs at noon.\n\nA second paragraph, saved.\n",
  })
  await waitText(page, "A second paragraph, saved.")
  await page.waitForFunction(
    () =>
      ((window as unknown as { redraws?: number }).redraws ?? 0) > 0 &&
      [...document.querySelectorAll(".markdown-body > p")].every(
        (p) => (p as HTMLElement).dataset.folioId,
      ),
  )
  await page.waitForTimeout(200)
  assert.deepEqual(
    await page.$$eval(".block-link, .block-history, .block-provenance, .block-copy", (found) =>
      found.map((button) => (button as HTMLElement).hidden),
    ),
    [false, false, false, false],
  )

  const first = await page.$eval(".markdown-body > p", (p) => (p as HTMLElement).dataset.folioId)
  await page.hover(".block-copy")
  const redrawn = await page.evaluate(() => (window as unknown as { redraws: number }).redraws)
  write({
    "past/resting.md": "# Resting\n\nThe pump runs at noon.\n\nA second paragraph, saved again.\n",
  })
  await waitText(page, "A second paragraph, saved again.")
  await page.waitForFunction(
    (before) => (window as unknown as { redraws: number }).redraws > before,
    redrawn,
  )
  await page.waitForTimeout(200)
  assert.deepEqual(
    await page.$$eval(".block-history, .block-copy", (found) =>
      found.map((button) => (button as HTMLElement).hidden),
    ),
    [false, false],
  )
  assert.equal(
    new URL(
      await page.$eval(".block-history", (a) => (a as HTMLAnchorElement).href),
    ).searchParams.get("block"),
    first,
  )
  await page.close()
})

test("See incoming links, Into a section, Follow back, New link, No links: a page shows what links to it", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler ${i + 1}.`).join("\n\n")
  write({
    "backlinks/target.md": "# Target\n\n## Retry policy\n\nRetries back off.",
    "backlinks/a.md": `# A\n\n${filler}\n\nRead [the target](target.md) before starting.\n\n${filler}`,
    "backlinks/sub/b.md": "- Mind the [retries](../target.md#retry-policy) here.",
    "backlinks/lonely.md": "# Lonely",
  })
  const page = await open("backlinks/target.md")
  const listed = () =>
    page.$$eval(".backlinks li", (items) =>
      items.map((item) => ({
        source: item.querySelector("a")?.textContent,
        part: item.querySelector(".backlink-part")?.textContent ?? null,
        context: item.querySelector(".backlink-context")?.textContent,
      })),
    )
  await page.waitForSelector(".backlinks li")

  assert.deepEqual(await listed(), [
    { source: "A", part: null, context: "Read the target before starting." },
    { source: "backlinks/sub/b.md", part: " → Retry policy", context: "Mind the retries here." },
  ])
  assert.deepEqual(
    await page.$$eval(".outline-backlinks a", (links) => links.map((link) => link.textContent)),
    ["A", "b.md"],
  )

  write({ "backlinks/c.md": "A [new link](target.md) appears." })
  await page.waitForFunction(() => document.querySelectorAll(".backlinks li").length === 3)
  assert.deepEqual((await listed())[1], {
    source: "backlinks/c.md",
    part: null,
    context: "A new link appears.",
  })

  await page.click('.backlinks a[href^="/backlinks/a.md"]')
  await page.waitForURL(/\/backlinks\/a\.md#\^/)
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body .landed")?.textContent?.startsWith("Read the target"),
  )
  assert.ok((await page.evaluate(() => scrollY)) > 0)
  assert.equal(await page.isVisible(".backlinks"), false)

  const lonely = await open("backlinks/lonely.md")
  await lonely.waitForTimeout(300)
  assert.equal(await lonely.isVisible(".backlinks"), false)
  assert.equal(await lonely.isVisible(".outline-backlinks"), false)
  await lonely.close()
  await page.close()
})

test("Beside the button, No room below, Size, At once, Scrolling, Warning sign, Outside: the ⓘ and the clock open at once in a pop-up beside their button", async () => {
  const table = (run: number) =>
    [
      "| Station | Notes | Run |",
      "|---|---|---|",
      ...Array.from(
        { length: 40 },
        (_, i) => `| Station ${i + 1} | ${"Wind and rain gauged at dawn. ".repeat(4)} | ${run} |`,
      ),
    ].join("\n")
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} reads the gauges.`)
  const doc = (run: number) =>
    `# Pop-ups\n\nRate <data value="rates.csv#0.pct">81%</data> today.\n\n${paragraphs.join("\n\n")}\n\n${table(run)}\n\nRun ${run}.\n`
  write({ "popup/rates.csv": "arm,pct\nA,0.816\n", "popup/doc.md": doc(1) })
  const page = await open("popup/doc.md")

  for (const run of [2, 3]) {
    write({ "popup/doc.md": doc(run) })
    await waitText(page, `Run ${run}.`)
  }

  const box = (selector: string) =>
    page.$eval(selector, (element) => element.getBoundingClientRect().toJSON() as DOMRect)
  const popup = () =>
    page.$eval(".provenance-panel", async (panel) => {
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const { top, bottom, left, right, width, height } = panel.getBoundingClientRect()
      const middle = document.elementFromPoint(left + width / 2, top + height / 2)
      return {
        top,
        bottom,
        left,
        right,
        width,
        height,
        over: panel.contains(middle),
        scrolls: panel.scrollHeight > panel.clientHeight,
      }
    })
  const click = async (block: string, button: string) => {
    await page.hover(block, { position: { x: 5, y: 5 } })
    const at = await box(button)
    await page.click(button)
    return at
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= 1

  const paragraph = ".markdown-body > p >> nth=3"
  const why = await click(paragraph, ".block-provenance")
  await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line")
  const beside = await popup()
  assert.ok(
    beside.right <= why.left && why.left - beside.right <= 8 && near(beside.top, why.top),
    `beside: ${JSON.stringify({ beside, why })}`,
  )
  assert.ok(beside.over && beside.width <= 600, JSON.stringify(beside))

  const before = await box(paragraph)
  await page.mouse.wheel(0, 100)
  await page.waitForTimeout(300)
  const moved = await popup()
  const after = await box(paragraph)
  assert.ok(
    after.top < before.top && near(moved.top - beside.top, after.top - before.top),
    `scrolling: ${JSON.stringify({ before: before.top, after: after.top, beside, moved })}`,
  )
  await page.click(".markdown-body h1", { position: { x: 5, y: 5 } })
  assert.ok(await page.isVisible(".provenance-panel"), "outside: a click elsewhere leaves it open")
  await page.keyboard.press("Escape")

  const last = `.markdown-body > p >> nth=${paragraphs.length}`
  await page.$eval(last, (element) =>
    scrollBy(0, element.getBoundingClientRect().top - (innerHeight - 40)),
  )
  await page.waitForTimeout(300)
  const clock = await click(last, ".block-history")
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  const above = await popup()
  assert.ok(
    near(above.bottom, clock.bottom) &&
      above.bottom <= (await page.evaluate(() => innerHeight)) &&
      above.right <= clock.left,
    `no room below: ${JSON.stringify({ above, clock })}`,
  )
  await page.keyboard.press("Escape")

  await click(".markdown-body table", ".block-history")
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  const size = await popup()
  const half = (await page.evaluate(() => innerHeight)) / 2
  assert.ok(size.width <= 600 && size.height <= half + 1 && size.scrolls, JSON.stringify(size))
  await page.keyboard.press("Escape")

  await page.route(
    (url) => url.searchParams.has("block-history"),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    },
  )
  const waited = ".markdown-body > p >> nth=5"
  const asked = await click(waited, ".block-history")
  const askedFrom = (await box(waited)).top
  await page.waitForSelector(".provenance-panel:not([hidden]) .panel-waiting .spinner", {
    timeout: 500,
  })
  assert.equal(
    await page.textContent(".provenance-panel .panel-waiting"),
    "Reading this block's past versions",
  )
  await page.evaluate(() => scrollBy(0, 2000))
  await page.waitForSelector(".provenance-panel:not([hidden]) .history-block")
  assert.equal(await page.locator(".provenance-panel .panel-waiting").count(), 0)
  await page.evaluate(() => scrollBy(0, -2000))
  const answered = await popup()
  assert.ok(
    near(answered.top - (await box(waited)).top, asked.top - askedFrom),
    `scrolled while waiting: ${JSON.stringify({ answered, asked, askedFrom })}`,
  )
  await page.unrouteAll()
  await page.keyboard.press("Escape")

  await page.route(
    (url) => url.searchParams.has("provenance"),
    (route) => route.abort(),
  )
  await click(waited, ".block-provenance")
  await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line")
  assert.equal(await page.locator(".provenance-panel .panel-waiting").count(), 0, "failed ask")
  await page.unrouteAll()
  await page.keyboard.press("Escape")

  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForSelector(".problem-flag:not([hidden])")
  await page.waitForTimeout(300)
  const flag = await box(".problem-flag")
  await page.click(".problem-flag")
  await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line")
  const warned = await popup()
  assert.ok(
    warned.right <= flag.left && near(warned.top, flag.top),
    `warning sign: ${JSON.stringify({ warned, flag })}`,
  )
  await page.close()
})

test("One h1, Path on hover, No h1, Several h1s, Markup, An included h1, Renamed: Linked from names a document by its title", async () => {
  write({
    "titled/target.md": "# Target\n\nBody.",
    "titled/plan.md": "# The **north** station\n\nSee [the target](target.md).",
    "titled/notes/plain.md": "See [the target](../target.md) too.",
    "titled/twice.md": "# One\n\n# Two\n\nSee [the target](target.md).",
    "titled/included.md": "{include: parts/top.md}\n\nSee [the target](target.md).",
    "titled/parts/top.md": "# Brought in",
  })
  const page = await open("titled/target.md")
  const names = (selector: string) =>
    page.$$eval(selector, (links) =>
      links.map((link) => [link.textContent, (link as HTMLElement).title]),
    )
  await page.waitForFunction(() => document.querySelectorAll(".backlinks li").length === 4)

  assert.deepEqual(await names(".backlinks li > a"), [
    ["titled/included.md", "titled/included.md"],
    ["titled/notes/plain.md", "titled/notes/plain.md"],
    ["The north station", "titled/plan.md"],
    ["titled/twice.md", "titled/twice.md"],
  ])
  assert.deepEqual(await names(".outline-backlinks a"), [
    ["included.md", "titled/included.md"],
    ["plain.md", "titled/notes/plain.md"],
    ["The north station", "titled/plan.md"],
    ["twice.md", "titled/twice.md"],
  ])
  assert.deepEqual(
    await page.$$eval(".backlinks li", (items) =>
      items.map((item) => item.querySelector(".backlink-file")?.textContent ?? null),
    ),
    [null, null, " plan.md", null],
  )

  write({ "titled/plan.md": "# South station\n\nSee [the target](target.md)." })
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".backlinks li > a, .outline-backlinks a")].every(
      (link) => link.textContent !== "The north station",
    ),
  )
  assert.deepEqual((await names(".backlinks li > a"))[2], ["South station", "titled/plan.md"])
  assert.deepEqual((await names(".outline-backlinks a"))[2], ["South station", "titled/plan.md"])

  fs.renameSync(path.join(root, "titled/plan.md"), path.join(root, "titled/south.md"))
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".backlinks .backlink-file")].some(
      (file) => file.textContent === " south.md",
    ),
  )
  assert.deepEqual(
    await page.$$eval(".backlinks li", (items) =>
      items.map((item) => [
        item.querySelector("a")?.textContent,
        item.querySelector(".backlink-file")?.textContent ?? null,
      ]),
    ),
    [
      ["titled/included.md", null],
      ["titled/notes/plain.md", null],
      ["South station", " south.md"],
      ["titled/twice.md", null],
    ],
  )
  await page.close()
})

test("File name, A part, Both themes, No h1, The rest: Linked from shows the file name and part small and faint", async () => {
  write({
    "faint/target.md": "# Target\n\n## Section\n\nBody.",
    "faint/plan.md": "# Plan\n\nSee [the section](target.md#section).",
    "faint/plain.md": "See [the target](target.md) too.",
  })
  const page = await open("faint/target.md")
  await page.waitForFunction(() => document.querySelectorAll(".backlinks li").length === 2)
  const looks = () =>
    page.$eval(".backlinks", (list) => {
      const luminance = (colour: string) => {
        const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((channel) => {
          const c = Number(channel) / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const background = luminance(getComputedStyle(document.body).backgroundColor)
      const contrast = (element: Element | null) => {
        const own = luminance(getComputedStyle(element as Element).color)
        return (Math.max(own, background) + 0.05) / (Math.min(own, background) + 0.05)
      }
      const size = (element: Element | null) => getComputedStyle(element as Element).fontSize
      const planned = [...list.querySelectorAll("li")].find((item) =>
        item.querySelector(".backlink-file"),
      ) as Element
      const plain = [...list.querySelectorAll("li")].find(
        (item) => !item.querySelector(".backlink-file"),
      ) as Element

      return {
        title: [planned.querySelector("a")?.textContent, size(planned.querySelector("a"))],
        file: [
          planned.querySelector(".backlink-file")?.textContent,
          size(planned.querySelector(".backlink-file")),
        ],
        part: [
          planned.querySelector(".backlink-part")?.textContent,
          size(planned.querySelector(".backlink-part")),
        ],
        fainter:
          contrast(planned.querySelector(".backlink-file")) <
            contrast(planned.querySelector(".backlink-context")) &&
          contrast(planned.querySelector(".backlink-part")) <
            contrast(planned.querySelector(".backlink-context")),
        plain: [plain.querySelector("a")?.textContent, plain.querySelector(".backlink-file")],
      }
    })
  const expected = {
    title: ["Plan", "16px"],
    file: [" plan.md", "12px"],
    part: [" → Section", "12px"],
    fainter: true,
    plain: ["faint/plain.md", null],
  }

  assert.deepEqual(await looks(), expected, "light")
  await page.click('button[title="Switch theme"]')
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
  assert.deepEqual(await looks(), expected, "dark")
  await page.click('button[title="Switch theme"]')
  await page.close()
})

test("Into a section, Follow back: outline entries land on the linking block, and parts from included files read as text", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler ${i + 1}.`).join("\n\n")
  write({
    "backlinks2/target.md": "# Target\n\n{include: shared.md}",
    "backlinks2/shared.md": "## Shared notes\n\nShared paragraph.",
  })
  const served = async (): Promise<{
    version: string
    blocks: { id: string; kind: string; source: string }[]
  }> => {
    const content = await (await context.request.get(`${base}/backlinks2/target.md?page`)).json()
    return content.version.endsWith("-partial") ? served() : content
  }
  const shared = (await served()).blocks.find(
    (block) => block.kind === "paragraph" && block.source === "backlinks2/shared.md",
  )?.id
  write({
    "backlinks2/from.md": `# From\n\n${filler}\n\nSee [the notes](target.md#shared-notes) and [the paragraph](target.md#^${shared}).\n\n${filler}`,
  })
  const page = await open("backlinks2/target.md")
  await page.waitForSelector(".backlinks li")

  assert.deepEqual(
    await page.$$eval(".backlinks .backlink-part", (parts) =>
      parts.map((part) => part.textContent),
    ),
    [" → Shared notes", " → Shared paragraph."],
  )

  await page.click(".outline-backlinks a")
  await page.waitForURL(/\/backlinks2\/from\.md#\^[0-9a-f]{8}$/)
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body .landed")?.textContent?.startsWith("See the notes"),
  )
  await page.close()
})

test("A section, A block, Live, Gone, Whole file: a document can include a section or a block of another", async () => {
  const design = (policy: string) =>
    `# Design\n\nIntro.\n\n## ${policy}\n\nRetries back off.\n\n### Limits\n\nThree tries.\n\n## Storage\n\nKept on disk.`
  write({ "parts/design.md": design("Retry policy"), "parts/whole.md": "Whole file." })
  const parsed = async (): Promise<{
    version: string
    blocks: { lines: number[]; id: string }[]
  }> => {
    const served = await (await context.request.get(`${base}/parts/design.md?page`)).json()
    return served.version.endsWith("-partial") ? parsed() : served
  }
  const storage = (await parsed()).blocks.find((block) => block.lines[0] === 15)?.id
  write({
    "parts/page.md": `# Page\n\n{include: design.md#retry-policy}\n\nBetween.\n\n{include: design.md#^${storage}}\n\n{include: whole.md}`,
  })
  const page = await open("parts/page.md")
  const shown = () =>
    page.$$eval(".markdown-body > *", (blocks) => blocks.map((block) => block.textContent?.trim()))

  assert.deepEqual(await shown(), [
    "Page",
    "Retry policy",
    "Retries back off.",
    "Limits",
    "Three tries.",
    "Between.",
    "Kept on disk.",
    "Whole file.",
  ])

  write({
    "parts/design.md": design("Retry policy").replace(
      "Retries back off.",
      "Retries back off, twice.",
    ),
  })
  await waitText(page, "twice")
  assert.equal((await shown())[2], "Retries back off, twice.")

  write({ "parts/design.md": design("Retry rules") })
  await page.waitForSelector(".markdown-body .include-missing")
  assert.equal(
    await page.$eval(".markdown-body .include-missing", (marker) => marker.textContent),
    "{include: design.md#retry-policy}",
  )
  assert.ok(await page.isVisible(".markdown-body .include-missing"))
  assert.deepEqual((await shown()).slice(-2), ["Kept on disk.", "Whole file."])
  await page.close()
})

test("A section, A block, Gone: parts stay apart from what follows, and a document includes a section of itself", async () => {
  write({
    "parts3/notes.md": "# Notes\n\n## Last\n\nLast words.\n",
    "parts3/page.md":
      "# Page\n\n{include: notes.md#last}\nAfter the include.\n\n{include: page.md#later}\n\n## Later\n\nLater text.\n\n## Loop\n\n{include: page.md#loop}\n",
  })
  const page = await open("parts3/page.md")
  await page.waitForSelector(".markdown-body .include-missing")

  assert.deepEqual(
    await page.$$eval(".markdown-body > *", (blocks) =>
      blocks.map((block) => block.textContent?.trim()),
    ),
    [
      "Page",
      "Last",
      "Last words.",
      "After the include.",
      "Later",
      "Later text.",
      "Later",
      "Later text.",
      "Loop",
      "{include: page.md#loop}",
    ],
  )
  await page.close()
})

test("Headings, Many changes: the outline and folds follow an update; a rewrite shows as a fresh load", async () => {
  const sections = (names: string[]) =>
    names.map((name) => `## ${name}\n\n${name} text.`).join("\n\n")
  write({ "redraw/sections.md": sections(["Alpha", "Beta", "Gamma"]) })
  const page = await open("redraw/sections.md")
  const outlined = () => page.$$eval(".outline a", (links) => links.map((a) => a.textContent))
  await page.$eval("#beta > .fold-toggle", (control) => (control as HTMLElement).click())
  assert.equal(await visible(page, "Beta text."), false)

  write({ "redraw/sections.md": sections(["Alpha renamed", "Beta", "Delta"]) })
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".outline a")].some((a) => a.textContent === "Delta"),
  )
  assert.deepEqual(await outlined(), ["Alpha renamed", "Beta", "Delta"])
  assert.equal(await visible(page, "Beta text."), false)
  assert.equal(await visible(page, "Delta text."), true)
  assert.equal(
    await page.locator(".markdown-body :is(h1, h2, h3, h4, h5, h6) > .fold-toggle").count(),
    3,
  )

  const rewrite = `# Rewritten\n\n${Array.from({ length: 30 }, (_, i) => `Line ${i + 1}.`).join("\n\n")}\n\n## Beta\n\nBeta again.\n\n| a | b |\n|---|---|\n| 1 | 2 |`
  write({ "redraw/sections.md": rewrite })
  await waitText(page, "Beta again.")
  const fresh = await open("redraw/sections.md")
  const shape = (p: Page) =>
    p.$$eval(".markdown-body > :not(.fold), .markdown-body .fold > *", (blocks) =>
      blocks.map((block) => [block.tagName, block.textContent]),
    )

  assert.deepEqual(await shape(page), await shape(fresh))
  assert.deepEqual(
    await outlined(),
    await fresh.$$eval(".outline a", (a) => a.map((l) => l.textContent)),
  )
  await page.close()
  await fresh.close()
})

test("Start, Unopened change, Blocks, Identity through edits, Pruned folders: Folio keeps a model of the whole folder", async () => {
  const doc = (paragraph: string) =>
    `# Pumps\n\n${paragraph}\n\n- intake\n- outlet\n\n| a |\n|---|\n| 1 |\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n\n> quoted`
  write({
    "model/pumps.md": doc("The north pump runs at night and stops at dawn."),
    "model/.drafts/hidden.md": "# Hidden",
    "model/node_modules/pkg/README.md": "# Package",
  })
  const page = await context.newPage()
  const inspect = async (urlPath: string) => {
    const response = await page.goto(`${base}/${urlPath}?model`)
    return response?.status() === 200 ? JSON.parse(await page.innerText("body")) : undefined
  }
  const blocksOf = async () =>
    ((await inspect("model/pumps.md"))?.blocks ?? []) as {
      id: string
      kind: string
      text: string
    }[]
  await until(() => output.includes("documents in"))
  await waitFor(async () => (await blocksOf()).length > 0)
  const before = await blocksOf()

  assert.equal((await inspect(""))?.ready, true)
  assert.deepEqual(
    before.map((block) => block.kind),
    ["heading", "paragraph", "list", "table", "diagram", "quote"],
  )

  write({
    "model/pumps.md": `> quoted\n\n${doc("The north pump runs at night and halts at sunrise.").replace("\n\n> quoted", "")}`,
  })
  await waitFor(async () => (await blocksOf())[0]?.kind === "quote")
  const after = await blocksOf()

  assert.deepEqual(
    after.map((block) => block.id),
    [before[5].id, ...before.slice(0, 5).map((block) => block.id)],
  )
  assert.match(after[2].text, /halts at sunrise/)
  assert.equal(await inspect("model/.drafts/hidden.md"), undefined)
  assert.equal(await inspect("model/node_modules/pkg/README.md"), undefined)
  await page.close()
})

test("Survive a publish: a tab open while Folio restarts on a new build reloads into it and keeps drawing", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-dist-"))
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-publish-")))
  const publishPort = await freePort()
  const serve = async () => {
    let said = ""
    const child = spawn(
      process.execPath,
      [path.join(dist, "cli.js"), folder, "--port", String(publishPort)],
      {
        env: ENV,
      },
    )
    child.stdout?.on("data", (chunk) => {
      said += chunk
    })
    await until(() => said.includes("serving"))
    return child
  }
  fs.cpSync(path.dirname(CLI), dist, { recursive: true })
  writeIn(folder, { "page.md": "# Page\n\nWords.\n\nMore words." })
  let running = await serve()
  const page = await context.newPage()

  try {
    await page.goto(`http://localhost:${publishPort}/page.md`)
    await landed(page)

    running.kill()
    await new Promise((resolve) => running.once("exit", resolve))
    // A new build names its chunks afresh, so every chunk the open tab's script knows is gone.
    for (const name of fs.readdirSync(dist)) {
      const file = path.join(dist, name)

      if (name === "page.js" || /^chunk-.*\.js$/.test(name)) {
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("chunk-", "chunk-next"))
      }

      if (name.startsWith("chunk-")) {
        fs.renameSync(file, path.join(dist, name.replace("chunk-", "chunk-next")))
      }
    }
    running = await serve()

    writeIn(folder, { "page.md": "# Page\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nMore words." })
    await page.waitForSelector(".mermaid svg[aria-roledescription]", { timeout: 20_000 })
  } finally {
    running.kill()
    await page.close()
    fs.rmSync(dist, { recursive: true, force: true })
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("Survive a publish: a tab whose first update socket already reaches a new build reloads into it", async () => {
  const page = await context.newPage()
  let connections = 0
  let loads = 0
  page.on("load", () => loads++)
  await page.routeWebSocket(/\?events$/, (socket) => {
    const server = socket.connectToServer()
    const first = ++connections === 1
    server.onMessage((message) => {
      const hello = typeof message === "string" && JSON.parse(message).type === "hello"
      socket.send(
        first && hello ? JSON.stringify({ type: "hello", build: "a-newer-build" }) : message,
      )
    })
  })
  await page.goto(`${base}/notes/other.md`)
  await waitFor(async () => loads >= 2 && connections >= 2)
  await page.waitForSelector(".markdown-body > *")
  await page.waitForTimeout(500)

  assert.deepEqual({ loads, connections }, { loads: 2, connections: 2 })
  await page.close()
})
