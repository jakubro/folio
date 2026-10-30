/** Headless Chromium run of copying a document or one block as markdown, as the page shows it. */

import assert from "node:assert/strict"
import { test } from "node:test"
import type { Page } from "playwright"
import { base, context, open, sourced, write } from "./harness.ts"

const RUNS = Array.from({ length: 120 }, (_, i) => `${i + 1},${(i * 37) % 120}`)

const REPORT = [
  "---",
  "title: Report",
  "tags: [a, b]",
  "---",
  "",
  "# Report",
  "",
  "Intro with {value: sales.csv#0.total} sold.",
  "",
  "{include: parts/intro.md#shared}",
  "",
  "- one",
  "- two",
  "",
  "| Name | Score |",
  "|:---|---:|",
  "| ada | 3 |",
  "| bob | 12 |",
  "| cy | 7 |",
  "",
  "> quoted line",
  "> second line",
  "",
  "> [!TIP]",
  "> Tip body.",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "Footnote ref[^1].",
  "",
  "[^1]: The note.",
  "",
  "```sql query",
  "select name, total from 'sales.csv' order by total desc",
  "```",
  "",
  "{table: runs.csv}",
  "",
  "```vega-lite",
  '{"data": {"url": "sales.csv"}, "mark": "bar", "encoding": {"x": {"field": "name", "type": "nominal"}, "y": {"field": "total", "type": "quantitative"}}}',
  "```",
  "",
  "```mermaid",
  "graph LR",
  "  A --> B",
  "```",
  "",
  "```python",
  "print(1)",
  "```",
  "",
  "---",
  "",
  "## Second",
  "",
  "Under second.",
  "",
  "### Third",
  "",
  "Under third.",
  "",
  "## Fourth",
  "",
  "Last.",
  "",
].join("\n")

const SALES = "| name | total |\n| --- | --- |\n| south | 9 |\n| north | 5 |"

async function report(search = ""): Promise<Page> {
  write({
    "copies/report.md": REPORT,
    "copies/sales.csv": "name,total\nnorth,5\nsouth,9\n",
    "copies/runs.csv": `run,n\n${RUNS.join("\n")}\n`,
    "copies/parts/intro.md": "# Intro\n\n## Shared\n\nShared paragraph.\n\n## Other\n\nNot this.\n",
    "copies/flow.mmd": "graph TD\n  Up --> Down\n",
  })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await open(`copies/report.md${search}`)
  await sourced(page)
  await page.waitForSelector(".embed-chart .chart svg")
  await page.waitForSelector('[data-embed="query"] .query-result table')
  await page.waitForSelector('[data-embed="table"] table')
  await page.waitForFunction(
    () => document.querySelector('[data-embed="value"]')?.textContent === "5",
  )
  return page
}

async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText())
}

async function copyBlock(page: Page, selector: string): Promise<string> {
  await page.hover(selector)
  await page.waitForSelector(".block-copy:not([hidden])")
  await page.click(".block-copy")
  return clipboard(page)
}

test("Copy a document, Included text, Table embed, Value embed, Query, Chart and diagram, Frontmatter, folio's additions: a document copies as the page shows it", async () => {
  const page = await report()
  await page.click(".copy-document")
  const copied = await clipboard(page)
  const runs = [
    "| run | n |",
    "| --- | --- |",
    ...RUNS.map((row) => `| ${row.replace(",", " | ")} |`),
  ]
  const expected = REPORT.replace("{value: sales.csv#0.total}", "5")
    .replace("{include: parts/intro.md#shared}", "## Shared\n\nShared paragraph.")
    .replace("```sql query\nselect name, total from 'sales.csv' order by total desc\n```", SALES)
    .replace("{table: runs.csv}", runs.join("\n"))
    .trimEnd()

  assert.equal(copied.replace(/\n{3,}/g, "\n\n"), expected)
  assert.match(await page.locator(".copy-document").innerHTML(), /M20 6L9 17l-5-5/)
  assert.doesNotMatch(copied, /Linked from|Used by/)
  await page.close()
})

test("Table changed in the view: a copy holds the table as the view shows it, folded rows included", async () => {
  const first = await report()
  const id = (selector: string) =>
    first.$eval(selector, (block) => (block as HTMLElement).dataset.folioId as string)
  const scores = await id(".markdown-body > table:not(.frontmatter)")
  const runs = await id('.markdown-body > [data-embed="table"]')
  await first.close()

  const views = {
    [`copies/report.md#^${scores}`]: {
      filter: "a",
      columns: {},
      hidden: ["Score"],
      expanded: false,
    },
    [`copies/report.md#^${runs}/0`]: {
      sort: { column: "n", descending: true },
      filter: "",
      columns: {},
      hidden: [],
      expanded: false,
    },
  }
  const page = await report(`?view=${Buffer.from(JSON.stringify(views)).toString("base64url")}`)
  await page.waitForSelector(".markdown-body > table:not(.frontmatter) caption.table-status")

  assert.equal(
    await copyBlock(page, ".markdown-body > table:not(.frontmatter) td"),
    "| Name |\n| :-- |\n| ada |",
  )

  const sorted = [...RUNS]
    .map((row) => row.split(","))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([run, n]) => `| ${run} | ${n} |`)
  const table = await copyBlock(page, '.markdown-body > [data-embed="table"] td')
  assert.equal(table, ["| run | n |", "| --- | --- |", ...sorted].join("\n"))
  assert.equal(table.split("\n").length, 122, "folded rows are in the copy")

  await page.click(".copy-document")
  const document = await clipboard(page)
  assert.ok(document.includes("| Name |\n| :-- |\n| ada |\n"), document)
  assert.ok(document.includes(sorted.slice(0, 3).join("\n")), "the embed as its view sorts it")
  await page.close()
})

test("Copy a block, Heading, Quote, Alert, Code and rule: each block copies its own markdown, a heading its section", async () => {
  const page = await report()
  const copied: Record<string, string> = {}

  for (const [name, selector] of [
    ["paragraph", '.markdown-body > p:has([data-embed="value"])'],
    ["list", ".markdown-body > ul"],
    ["quote", ".markdown-body > blockquote:not(.markdown-alert)"],
    ["alert", ".markdown-body > blockquote.markdown-alert"],
    ["math", ".markdown-body > .katex-display, .markdown-body > :has(> .katex-display)"],
    ["footnote", ".markdown-body > section.footnotes li"],
    ["second", ".markdown-body > h2#second"],
    ["third", ".markdown-body > h3#third"],
    ["query", '.markdown-body > [data-embed="query"] td'],
  ]) {
    copied[name] = await copyBlock(page, selector)
  }

  assert.deepEqual(copied, {
    paragraph: "Intro with 5 sold.",
    list: "- one\n- two",
    quote: "quoted line\nsecond line",
    alert: "Tip body.",
    math: "$$\nx^2\n$$",
    footnote: "[^1]: The note.",
    second: "## Second\n\nUnder second.\n\n### Third\n\nUnder third.",
    third: "### Third\n\nUnder third.",
    query: SALES,
  })

  write({ "copies/report.md": REPORT.replace("Under second.", "Under the second, reworded.") })
  await page.waitForSelector(".markdown-body > p:text('Under the second, reworded.')")
  await sourced(page)
  assert.equal(
    await copyBlock(page, ".markdown-body > ul"),
    "- one\n- two",
    "a kept block after a save",
  )
  assert.equal(
    await copyBlock(page, ".markdown-body > h2#second"),
    "## Second\n\nUnder the second, reworded.\n\n### Third\n\nUnder third.",
  )
  write({ "copies/report.md": REPORT })

  const placed = await page.evaluate(() => {
    const at = (selector: string) => document.querySelector(selector)?.getBoundingClientRect()
    const [info, copy] = [at(".block-provenance"), at(".block-copy")]
    return { below: (copy?.top ?? 0) > (info?.top ?? 0), aligned: copy?.left === info?.left }
  })
  assert.deepEqual(placed, { below: true, aligned: true })

  for (const selector of [
    ".markdown-body > pre:has(code.language-python)",
    ".markdown-body > hr",
    ".markdown-body > .mermaid",
    ".markdown-body > .embed-chart",
  ]) {
    await page.hover(selector)
    await page.waitForTimeout(100)
    assert.equal(await page.locator(".block-copy").isHidden(), true, selector)
  }

  await page.close()
})

test("Diagram file, Not a document: a diagram file copies its source; a listing, a data page and a view have no document copy", async () => {
  await report().then((page) => page.close())
  const page = await context.newPage()
  await page.goto(`${base}/copies/flow.mmd`)
  await page.waitForSelector(".mermaid svg")
  await page.click(".copy-document")
  assert.equal(await clipboard(page), "graph TD\n  Up --> Down")

  for (const address of ["copies/", "copies/sales.csv", "?health"]) {
    await page.goto(`${base}/${address}`)
    await page.waitForSelector(".markdown-body > *")
    assert.equal(await page.locator(".copy-document").isHidden(), true, address)
  }

  await page.close()
})

test("Byte order mark, Nested tables: a file starting with a byte order mark copies block by block, and a table in a list or quote copies as a table", async () => {
  write({
    "copies/marked.md": "﻿First paragraph.\n\nSecond paragraph.\n",
    "copies/nested.md": [
      "# Nested",
      "",
      "- {table: sales.csv}",
      "",
      "> ```sql query",
      "> select name, total from 'sales.csv' order by total desc",
      "> ```",
    ].join("\n"),
    "copies/sales.csv": "name,total\nnorth,5\nsouth,9\n",
    "copies/marked-table.md": "\uFEFF{table: sales.csv}\n",
    "copies/alerted.md": "> [!NOTE]\n> {table: sales.csv}\n",
    "copies/escaped.md": "\\{table: sales.csv}\n",
  })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const SALES_TABLE = "| name | total |\n| --- | --- |\n| north | 5 |\n| south | 9 |"

  for (const [file, block] of [
    ["copies/marked-table.md", '.markdown-body > [data-embed="table"]'],
    ["copies/alerted.md", ".markdown-body > blockquote"],
    ["copies/escaped.md", '.markdown-body > [data-embed="table"]'],
  ]) {
    const page = await open(file)
    await sourced(page)
    await page.waitForSelector('[data-embed="table"] table')
    assert.equal(await copyBlock(page, block), SALES_TABLE, file)
    await page.close()
  }

  const marked = await open("copies/marked.md")
  await sourced(marked)
  assert.equal(await copyBlock(marked, ".markdown-body > p:nth-of-type(1)"), "First paragraph.")
  assert.equal(await copyBlock(marked, ".markdown-body > p:nth-of-type(2)"), "Second paragraph.")
  await marked.close()

  const nested = await open("copies/nested.md")
  await sourced(nested)
  await nested.waitForSelector('[data-embed="table"] table')
  await nested.waitForSelector('[data-embed="query"] .query-result table')
  await nested.click(".copy-document")
  assert.equal(
    (await clipboard(nested)).replace(/\n{3,}/g, "\n\n"),
    [
      "# Nested",
      "",
      "- | name | total |",
      "  | --- | --- |",
      "  | north | 5 |",
      "  | south | 9 |",
      "",
      ...SALES.split("\n").map((line) => `> ${line}`),
    ].join("\n"),
  )
  await nested.close()
})

test("Unreferenced footnote, Copy during a save: the footnotes copy only the notes the page shows, and a copy while a save redraws holds what the page still shows", async () => {
  write({
    "copies/notes.md": [
      "# Notes",
      "",
      "First[^a] and second[^b].",
      "",
      "[^a]: Note a.",
      "",
      "[^c]: Unused note[^c].",
      "",
      "[^b]: Note b, see[^d].",
      "",
      "[^d]: Note d.",
      "",
      "[^e]: Unused, see[^f].",
      "",
      "[^f]: Seen from an unused note only.",
      "",
      "[^a]: Note a again.",
    ].join("\n"),
    "copies/redraw.md": "# Redraw\n\nAlpha paragraph.\n\nOmega paragraph.\n",
  })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })

  const notes = await open("copies/notes.md")
  await sourced(notes)
  assert.equal(
    await copyBlock(notes, ".markdown-body > section.footnotes li"),
    "[^a]: Note a.\n\n[^b]: Note b, see[^d].\n\n[^d]: Note d.",
  )
  await notes.close()

  const page = await open("copies/redraw.md")
  await sourced(page)
  let release = () => {}
  let hit = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = new Promise<void>((resolve) => {
    hit = resolve
  })
  await page.route(/\?asset=\/chunk-/, async (route) => {
    hit()
    await gate
    await route.continue()
  })
  write({
    "copies/redraw.md":
      "# Redraw\n\n```python\nprint(1)\n```\n\nAlpha paragraph.\n\nOmega paragraph.\n",
  })
  await held

  const block = await copyBlock(page, ".markdown-body > p:text('Omega paragraph.')")
  await page.click(".copy-document")
  const document = await clipboard(page)
  release()
  await page.waitForSelector(".markdown-body > pre code.language-python")
  await page.unroute(/\?asset=\/chunk-/)
  await page.close()
  assert.equal(block, "Omega paragraph.")
  assert.equal(document, "# Redraw\n\nAlpha paragraph.\n\nOmega paragraph.")
})
