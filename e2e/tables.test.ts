/** Headless Chromium run of folio's documented behaviour: table views and data files opened as pages. */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { DuckDBInstance } from "@duckdb/node-api"
import type { Page } from "playwright"
import {
  base,
  caption,
  cells,
  context,
  frameOf,
  keepFrame,
  LEDGER,
  open,
  openData,
  panel,
  pathOf,
  root,
  snapshotOf,
  sourced,
  waitFor,
  waitText,
  write,
  writeData,
} from "./harness.ts"

test("Loose tables: extra cells, uneven rows, no header line and missing edge pipes show in full", async () => {
  const cases = [
    "|foo|\n|---|\n|baz|bar|",
    "|h|\n|-|\n|a|\n|b|c|d|\n|e|f|",
    "|a|b|\n|1|2|",
    "|a|\n|1|2|",
    "|a|b\n|1|2",
    "a|b|\n1|2|",
    "|a|b\n|-|-\n|1|2",
    "pick x | y\n\npick x | y\nor a | b",
    "Before.\n\n|a|b|\n\nAfter.",
    "`|a|` x\n`|b|` y",
    "```\n|a|b|\n|1|2|\n```",
    "| Name | Value |\n|---|---|\n| a | 1 |",
    "|a|\n|---|---|\n|1|2|",
  ]
  write({ "cards/tables.md": cases.map((body, i) => `## Case ${i}\n\n${body}\n`).join("\n") })
  const page = await open("cards/tables.md")
  const blocks = await page.evaluate(() => {
    const cells = (row: Element) => [...row.children].map((cell) => cell.textContent)
    const sections: unknown[][] = []

    for (const block of document.querySelectorAll(".markdown-body > *")) {
      if (block.tagName === "H2") {
        sections.push([])
      } else if (block.tagName === "TABLE") {
        sections.at(-1)?.push({
          head: [...block.querySelectorAll("thead tr")].map(cells),
          body: [...block.querySelectorAll("tbody tr")].map(cells),
        })
      } else {
        sections.at(-1)?.push(`${block.tagName}: ${block.textContent}`)
      }
    }

    return sections
  })
  const ab12 = {
    head: [],
    body: [
      ["a", "b"],
      ["1", "2"],
    ],
  }

  assert.deepEqual(blocks, [
    [{ head: [["foo", ""]], body: [["baz", "bar"]] }],
    [
      {
        head: [["h", "", ""]],
        body: [
          ["a", "", ""],
          ["b", "c", "d"],
          ["e", "f", ""],
        ],
      },
    ],
    [ab12],
    [
      {
        head: [],
        body: [
          ["a", ""],
          ["1", "2"],
        ],
      },
    ],
    [ab12],
    [ab12],
    [{ head: [["a", "b"]], body: [["1", "2"]] }],
    ["P: pick x | y", "P: pick x | y\nor a | b"],
    ["P: Before.", "P: |a|b|", "P: After."],
    ["P: |a| x\n|b| y"],
    ["PRE: |a|b|\n|1|2|\n"],
    [{ head: [["Name", "Value"]], body: [["a", "1"]] }],
    [{ head: [["a", ""]], body: [["1", "2"]] }],
  ])
  await page.close()
})

test("Sort, Small tables: a header click sorts numbers as numbers, again in reverse, then as written", async () => {
  write({ "tables/ledger.md": LEDGER })
  const page = await open("tables/ledger.md")
  const small = await page.$eval(".markdown-body table", (table) => ({
    html: table.innerHTML,
    height: table.getBoundingClientRect().height,
  }))

  assert.deepEqual(await cells(page, 1, 1), ["10", "9", "100", ""])
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1")
  assert.deepEqual(await cells(page, 1, 1), ["9", "10", "100", ""])
  assert.equal(await caption(page, 1), "4 rows · sorted by Count")
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1")
  assert.deepEqual(await cells(page, 1, 1), ["100", "10", "9", ""])
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1")
  assert.deepEqual(await cells(page, 1, 1), ["10", "9", "100", ""])
  assert.equal(await caption(page, 1), null)
  assert.deepEqual(
    await page.$eval(".markdown-body table", (table) => ({
      html: table.innerHTML,
      height: table.getBoundingClientRect().height,
    })),
    small,
  )
  await page.close()
})

test("Keyboard: a header sorts on Enter with its order announced; the filter button follows the headers and shows on focus", async () => {
  write({ "tables/ledger.md": LEDGER })
  const page = await open("tables/ledger.md")
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement
      return element.matches("th") ? `th:${element.textContent}` : element.className
    })

  await page.focus(".markdown-body table >> nth=1 >> th >> nth=1")
  await page.keyboard.press("Enter")
  assert.deepEqual(await cells(page, 1, 1), ["9", "10", "100", ""])
  assert.equal(
    await page.getAttribute(".markdown-body table >> nth=1 >> th >> nth=1", "aria-sort"),
    "ascending",
  )
  await page.keyboard.press(" ")
  assert.equal(
    await page.getAttribute(".markdown-body table >> nth=1 >> th >> nth=1", "aria-sort"),
    "descending",
  )
  assert.ok(await page.isVisible(".table-control"))

  const last = await page.$$eval(".markdown-body table >> nth=1 >> th", (cells) => cells.length)
  for (let index = 2; index < last; index++) {
    await page.keyboard.press("Tab")
  }
  assert.equal(await focused(), "th:Note")
  await page.keyboard.press("Tab")
  assert.equal(await focused(), "icon-button table-control")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".table-panel:not([hidden])")
  await page.keyboard.type("r")
  await page.keyboard.press("Escape")
  assert.match((await caption(page, 1)) ?? "", /^\d of 4 rows/)
  assert.equal(await focused(), "th:Item")

  await page.focus(".markdown-body table >> nth=1 >> th >> nth=-1")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Shift+Tab")
  assert.equal(await focused(), "th:Note")
  await page.close()
})

test("Keyboard, Hidden last column: the filter button follows the last header shown, the column comes back, and Tab leaves the panel past the table", async () => {
  write({
    "tables/keys.md": [
      "# Keys",
      "",
      "| Item | Count | Note |",
      "|---|---|---|",
      "| pear | 10 | ripe |",
      "| fig | 9 | dried |",
      "",
      "[After the table](#keys)",
    ].join("\n"),
  })
  const page = await open("tables/keys.md")
  await sourced(page)
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement
      return element.matches("th")
        ? `th:${element.textContent}`
        : element.matches("input[type=checkbox]")
          ? `box:${element.parentElement?.textContent}`
          : element.textContent || element.className
    })

  await panel(page, 0)
  await page.click('.table-panel li:nth-child(3) input[type="checkbox"]')
  await page.keyboard.press("Escape")
  assert.equal(await page.isVisible(".markdown-body th >> nth=2"), false)

  await page.focus(".markdown-body th >> nth=0")
  await page.keyboard.press("Tab")
  assert.equal(await focused(), "th:Count")
  await page.keyboard.press("Tab")
  assert.equal(await focused(), "icon-button table-control")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".table-panel:not([hidden])")

  for (let step = 0; step < 20 && (await focused()) !== "box:Note"; step++) {
    await page.keyboard.press("Tab")
  }
  await page.keyboard.press(" ")
  assert.equal(await focused(), "box:Note")
  assert.equal(await page.isVisible(".markdown-body th >> nth=2"), true)

  for (let step = 0; step < 20 && (await focused()) !== "Show as written"; step++) {
    await page.keyboard.press("Tab")
  }
  await page.keyboard.press("Tab")
  assert.equal(await focused(), "After the table")
  assert.equal(await page.isVisible(".table-panel"), false)
  await page.close()
})

test("Filter, Hide columns: the table's filter and a column's narrow the rows with a count; a column hides and returns", async () => {
  write({ "tables/ledger.md": LEDGER })
  const page = await open("tables/ledger.md")

  await panel(page, 1)
  await page.fill('.table-panel input[aria-label="Filter rows"]', "r")
  assert.deepEqual(await cells(page, 1, 0), ["pear", "apple", "fig"])
  assert.equal(await caption(page, 1), "3 of 4 rows")
  await page.fill('.table-panel input[aria-label="Filter Note"]', "e")
  assert.deepEqual(await cells(page, 1, 0), ["pear", "apple", "fig"])
  await page.fill('.table-panel input[aria-label="Filter Note"]', "rip")
  assert.deepEqual(await cells(page, 1, 0), ["pear"])
  assert.equal(await caption(page, 1), "1 of 4 rows")
  await page.fill('.table-panel input[aria-label="Filter rows"]', "")
  await page.fill('.table-panel input[aria-label="Filter Note"]', "")

  const shown = () =>
    page.$$eval(".markdown-body table >> nth=1 >> th", (heads) =>
      heads.filter((th) => getComputedStyle(th).display !== "none").map((th) => th.textContent),
    )
  await page.click('.table-panel label:has-text("Count") input')
  assert.deepEqual(await shown(), ["Item", "Note"])
  assert.equal(await caption(page, 1), "4 rows · 1 hidden column")
  await page.click('.table-panel label:has-text("Count") input')
  assert.deepEqual(await shown(), ["Item", "Count", "Note"])
  assert.equal(await caption(page, 1), null)
  await page.close()
})

test("Long table: the first rows of a long table show, with a way to show the rest", async () => {
  write({ "tables/ledger.md": LEDGER })
  const page = await open("tables/ledger.md")

  assert.equal((await cells(page, 4, 0)).length, 50)
  assert.equal((await cells(page, 4, 0))[49], "run-50")
  await page.click('.markdown-body button:has-text("Show all 300 rows")')
  assert.equal((await cells(page, 4, 0)).length, 300)
  await page.click('.markdown-body button:has-text("Show the first 50 rows")')
  assert.equal((await cells(page, 4, 0)).length, 50)
  await page.close()
})

test("Every table: a loose table and one with no header row sort, filter and fold through the panel", async () => {
  write({ "tables/ledger.md": LEDGER })
  const page = await open("tables/ledger.md")

  assert.deepEqual(await cells(page, 2, 0), ["loose", "other"])
  await panel(page, 2)
  await page.click('.table-panel button[aria-label="Sort by Column 2"]')
  assert.deepEqual(await cells(page, 2, 0), ["other", "loose"])
  await page.fill('.table-panel input[aria-label="Filter rows"]', "extra")
  assert.deepEqual(await cells(page, 2, 0), ["other"])
  await page.keyboard.press("Escape")

  await panel(page, 3)
  await page.click('.table-panel button[aria-label="Sort by 5"]')
  assert.deepEqual(await cells(page, 3, 0), ["6", "7"])
  await page.close()
})

test("File untouched, Edits: a sorted, filtered table keeps its view through saves; the file and other tabs see it as written", async () => {
  write({ "tables/ledger.md": LEDGER })
  const page = await open("tables/ledger.md")

  await sourced(page)
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1")
  await panel(page, 1)
  await page.click('.table-panel label:has-text("Note") input')
  await page.fill('.table-panel input[aria-label="Filter rows"]', "p")
  await page.keyboard.press("Escape")
  assert.deepEqual(await cells(page, 1, 0), ["apple", "pear"])

  const other = await open("tables/ledger.md")
  assert.deepEqual(await cells(other, 1, 0), ["pear", "apple", "fig", "kiwi"])
  assert.equal(fs.readFileSync(path.join(root, "tables/ledger.md"), "utf8"), LEDGER)
  await other.close()

  write({ "tables/ledger.md": LEDGER.replace("Above the tables.", "Above the tables, edited.") })
  await waitText(page, "edited")
  assert.deepEqual(await cells(page, 1, 0), ["apple", "pear"])

  write({
    "tables/ledger.md": LEDGER.replace("Above the tables.", "Above the tables, edited.").replace(
      "| fig | 100 | dried |",
      "| plum | 1 | soft |\n| fig | 100 | dried |",
    ),
  })
  await waitFor(async () => (await cells(page, 1, 0)).join() === "plum,apple,pear")
  assert.equal(await caption(page, 1), "3 of 5 rows · sorted by Count · 1 hidden column")
  await page.close()
})

test("Tabular file, Nested file, Database: data files open as tables, trees and lists of tables", async () => {
  await writeData()
  const page = await openData("store/visits.csv")

  assert.equal(await page.$eval(".markdown-body h1", (h) => h.textContent), "visits.csv")
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^CSV · \d+ bytes · 3 rows$/,
  )
  assert.deepEqual(
    await page.$$eval(".markdown-body th", (cells) => cells.map((cell) => cell.textContent)),
    ["city", "visits"],
  )
  assert.deepEqual(
    await page.$$eval(".markdown-body tbody td", (cells) => cells.map((cell) => cell.textContent)),
    ["Oslo", "1204", "Lima", "87", "Rome", "9"],
  )

  for (const [file, first] of [
    ["store/visits.jsonl", "Oslo"],
    ["store/visits.parquet", "0"],
    ["store/visits.tsv", "Oslo"],
  ]) {
    await page.goto(`${base}/${file}`)
    await page.waitForSelector(".markdown-body tbody td")
    assert.equal(
      await page.$eval(".markdown-body tbody td", (cell) => cell.textContent),
      first,
      file,
    )
  }

  await page.goto(`${base}/store/kit.json`)
  await page.waitForSelector(".data-tree")
  assert.equal(await page.$eval(".data-tree > summary", (s) => s.textContent), "{2}")
  assert.equal(await page.$eval(".data-tree", (d) => (d as HTMLDetailsElement).open), true)
  await page.click(".data-tree > summary")
  assert.equal(await page.$eval(".data-tree", (d) => (d as HTMLDetailsElement).open), false)

  await page.goto(`${base}/store/people.yaml`)
  await page.waitForSelector(".markdown-body tbody td")
  assert.deepEqual(
    await page.$$eval(".markdown-body tbody td", (cells) => cells.map((cell) => cell.textContent)),
    ["ada", "36", "bob", ""],
  )
  await page.click('.data-switch:has-text("Tree")')
  assert.equal(await page.isVisible(".markdown-body table"), false)
  assert.equal(await page.isVisible(".data-tree"), true)

  await page.goto(`${base}/store/shop.sqlite`)
  await page.waitForSelector(".markdown-body h2")
  assert.deepEqual(
    await page.$$eval(".markdown-body h2", (headings) => headings.map((h) => h.textContent)),
    ["orders"],
  )
  assert.match(
    await page.$eval(".markdown-body h2 + .data-info", (p) => p.textContent ?? ""),
    /^12 rows · id INTEGER, item TEXT · Open the whole table$/,
  )
  assert.equal(await page.$$eval(".markdown-body tbody tr", (rows) => rows.length), 10)
  await page.click('a:has-text("Open the whole table")')
  await page.waitForSelector(".markdown-body h1:has-text('orders')")
  assert.equal(await page.$$eval(".markdown-body tbody tr", (rows) => rows.length), 12)
  assert.equal(new URL(page.url()).search, "?table=orders")

  await page.goto(`${base}/store/shop.duckdb`)
  await page.waitForSelector(".markdown-body h2")
  assert.deepEqual(
    await page.$$eval(".markdown-body h2", (headings) => headings.map((h) => h.textContent)),
    ["stock"],
  )
  await page.close()
})

test("Large file, Broken file: a large file shows its start and says so; a malformed one says what is wrong", async () => {
  await writeData()
  const item = `{"key": "${"x".repeat(1000)}"},`
  write({ "store/huge.json": `[${item.repeat(21 * 1024)}{}]` })

  const page = await openData("store/huge.json")
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^JSON · 21 MB · too large to show whole; showing its start$/,
  )
  assert.ok(
    (await page.$eval(".markdown-body pre", (pre) => pre.textContent ?? "")).startsWith(`[${item}`),
  )

  await page.goto(`${base}/store/many.parquet`)
  await page.waitForSelector(".markdown-body tbody td")
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^PARQUET · .+ · 6,000 rows$/,
  )

  await page.goto(`${base}/store/broken.csv`)
  await page.waitForSelector(".data-error")
  const error = await page.$eval(".data-error", (p) => p.textContent ?? "")
  assert.match(error, /store\/broken\.csv/)
  assert.match(error, /\n\n1 row could not be read and is left out\.$/)
  assert.deepEqual(
    await page.$$eval(".markdown-body tbody td", (cells) => cells.map((cell) => cell.textContent)),
    ["Oslo", "1204", "Rome", "9"],
  )
  await page.close()
})

test("Growing file: rows appended to an open data file appear as they arrive", async () => {
  await writeData()
  const page = await openData("store/visits.csv")

  fs.appendFileSync(path.join(root, "store/visits.csv"), "Kyiv,44\n")
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body")?.textContent?.includes("Kyiv"),
  )
  fs.appendFileSync(path.join(root, "store/visits.csv"), "Baku,5\n")
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body")?.textContent?.includes("Baku"),
  )
  assert.match(await page.$eval(".data-info", (p) => p.textContent ?? ""), /5 rows$/)
  await page.close()
})

test("Largest first, Smallest first, Text, As written, Every reader, A small file, Live: a data page's sort orders the whole file", async () => {
  const head = Array.from({ length: 5000 }, (_, i) => ({ ms: 1000 + i, name: `m-${i}` }))
  const tail = Array.from({ length: 1000 }, (_, i) => ({ ms: i * 7, name: `a-${i}` }))
  const lines = (records: { ms: number; name: string }[]) =>
    records.map((record) => `${JSON.stringify(record)}\n`).join("")
  write({
    "big/rows.jsonl": lines([...head, ...tail]),
    "big/rows.csv": `ms,name\n${[...head, ...tail].map(({ ms, name }) => `${ms},${name}`).join("\n")}\n`,
    "big/rows.tsv": `ms\tname\n${[...head, ...tail].map(({ ms, name }) => `${ms}\t${name}`).join("\n")}\n`,
    "big/small.csv": "ms,name\n5,b\n50,a\n7,c\n",
  })
  const sqlite = new DatabaseSync(path.join(root, "big/rows.sqlite"))
  sqlite.exec(
    `begin; create table spread (ms integer, name text); ${[...head, ...tail].map(({ ms, name }) => `insert into spread values (${ms}, '${name}');`).join(" ")} commit;`,
  )
  sqlite.close()
  const duck = await DuckDBInstance.create(path.join(root, "big/rows.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    `create table spread as select * from read_json('${path.join(root, "big/rows.jsonl")}')`,
  )
  await connection.run(`copy spread to '${path.join(root, "big/rows.parquet")}' (format parquet)`)
  connection.closeSync()
  duck.closeSync()

  const page = await openData("big/rows.jsonl")
  const first = async (column: number, count = 3) => (await cells(page, 0, column)).slice(0, count)
  const sorted = async (column: number, wanted: string[]) => {
    await waitFor(
      async () => JSON.stringify(await first(column, wanted.length)) === JSON.stringify(wanted),
    )
  }

  assert.deepEqual(await first(0), ["1000", "1001", "1002"])
  await page.click(".markdown-body th >> nth=0")
  await sorted(0, ["0", "7", "14"])
  await page.click(".markdown-body th >> nth=0")
  await sorted(0, ["6993", "6986", "6979"])
  await page.click(".markdown-body th >> nth=0")
  await sorted(0, ["1000", "1001", "1002"])
  await page.click(".markdown-body th >> nth=1")
  await waitFor(async () => (await first(1, 1))[0] === "a-0")

  for (const [name, table] of [
    ["big/rows.csv", ""],
    ["big/rows.tsv", ""],
    ["big/rows.parquet", ""],
    ["big/rows.sqlite", "?table=spread"],
    ["big/rows.duckdb", "?table=spread"],
  ]) {
    await page.goto(`${base}/${name}${table}`)
    await page.waitForSelector(".markdown-body tbody td")
    await page.click(".markdown-body th >> nth=0")
    await page.click(".markdown-body th >> nth=0")
    await sorted(0, ["6993", "6986", "6979"])
  }

  await page.goto(`${base}/big/rows.sqlite`)
  await page.waitForSelector(".markdown-body tbody td")
  await page.click(".markdown-body th >> nth=0")
  await sorted(0, ["0", "7", "14"])

  await page.goto(`${base}/big/small.csv`)
  await page.waitForSelector(".markdown-body tbody td")
  await page.click(".markdown-body th >> nth=0")
  assert.deepEqual(await first(0), ["5", "7", "50"])

  await page.goto(`${base}/big/rows.jsonl`)
  await page.waitForSelector(".markdown-body tbody td")
  await page.click(".markdown-body th >> nth=0")
  await page.click(".markdown-body th >> nth=0")
  await sorted(0, ["6993", "6986", "6979"])
  fs.appendFileSync(path.join(root, "big/rows.jsonl"), lines([{ ms: 9000, name: "z-0" }]))
  await sorted(0, ["9000", "6993", "6986"])
  await page.close()
})

test("Filter, sort, undo: undoing a sort typed after a text filter brings back the file's own order", async () => {
  write({
    "undo/rows.jsonl": Array.from(
      { length: 6000 },
      (_, i) => `${JSON.stringify({ n: (i * 7) % 6000, name: `r-${i}` })}\n`,
    ).join(""),
  })
  const page = await openData("undo/rows.jsonl")
  const names = async () => (await cells(page, 0, 1)).slice(0, 3)

  assert.deepEqual(await names(), ["r-0", "r-1", "r-2"])
  await panel(page, 0)
  await page.fill('.table-panel input[aria-label="Filter rows"]', "r-59")
  await waitFor(async () => (await names())[0] === "r-59")
  await page.click(".markdown-body th >> nth=0")
  await waitFor(async () => (await cells(page, 0, 0))[0] === "413")
  await page.click(".markdown-body th >> nth=0")
  await page.click(".markdown-body th >> nth=0")
  await panel(page, 0)
  await page.fill('.table-panel input[aria-label="Filter rows"]', "")
  await waitFor(async () => JSON.stringify(await names()) === '["r-0","r-1","r-2"]')
  await page.close()
})

test("Linked, Tree toggle: a link to a data file opens it inside folio; the tree lists data files only when asked", async () => {
  await writeData()
  const page = await open("store/index.md")

  assert.deepEqual(await treeNames(page, "store"), ["index.md"])
  await keepFrame(page)
  await page.click('a[href="visits.csv"]')
  await page.waitForSelector(".markdown-body tbody td")
  assert.equal((await frameOf(page)).kept, true)
  assert.equal(await pathOf(page), "store/visits.csv")

  await page.hover(".tree")
  await page.click(".tree-data")
  await waitFor(async () => (await treeNames(page, "store")).includes("visits.csv"))
  assert.ok((await treeNames(page, "store")).includes("shop.sqlite"))
  await page.click(".tree-data")
  await waitFor(async () => !(await treeNames(page, "store")).includes("visits.csv"))
  assert.deepEqual(await treeNames(page, "store"), ["index.md"])
  await page.close()
})

test("Records under a key, Records by key, Sections stay a tree, A nested cell, Cell width, Open a record, Sideways, Mixed records, Uniform records, Embeds, Theme: nested and mixed records read on a data page", async () => {
  const sentence = "A long remark about the pump that keeps going for many words. ".repeat(4)
  const incidents = Array.from({ length: 50 }, (_, i) => ({
    id: `I-${String(i).padStart(2, "0")}`,
    kind: ["drift", "gap", "spike"][i % 3],
    gauge: `tide.level_${i}`,
    since: "2026-03-01 onward",
    size: i * 3,
    cause: "a gauge reset",
    test: "count by day",
    remedy: "drop the reset days",
    owner: "harbour",
  }))
  const scores = Object.fromEntries(
    Array.from({ length: 54 }, (_, i) => [
      `p${i % 2}|calm|B${i % 6}`.concat(`|${i}`),
      {
        n: 100 + i,
        early: 0.5,
        late: 0.6,
        gap: -0.1,
        only_early: i,
        only_late: 2,
        shared: 40,
        missed: 3,
      },
    ]),
  )
  const checks = Array.from({ length: 22 }, (_, i) => ({
    id: `u-${String(i).padStart(3, "0")}`,
    checks: [
      {
        method: "manual",
        result: "fail",
        basis: null,
        cause: "counts the opening dial reading",
      },
      { method: "logged", result: "pass", basis: "trend", cause: "the window is right" },
    ],
    remarks: i % 2 ? null : "checked twice",
  }))
  const kinds = ["arrival", "departure", "inspection", "delay", "note"]
  const voyages = Array.from({ length: 46 }, (_, i) => ({
    voyage: "v-1",
    kind: kinds[i % 5],
    [`${kinds[i % 5]}_field`]: `value ${i}`,
    [`${kinds[i % 5]}_more`]: { at: i, by: kinds[i % 5] },
  }))
  const lines = (records: object[]) =>
    records.map((record) => `${JSON.stringify(record)}\n`).join("")
  write({
    "records/ledger.yaml": JSON.stringify({
      season: 7,
      shares: { north: 0.4, south: 0.6 },
      port: "harbour",
      incidents,
    }),
    "records/scores.json": JSON.stringify({ tallies: scores, meta: { season: 1 } }),
    "records/sections.json": JSON.stringify({
      server: { port: 80, hosts: ["a"] },
      logging: { level: "info" },
      features: { beta: true, gamma: false },
    }),
    "records/checks.jsonl": lines(checks),
    "records/voyages.jsonl": lines(voyages),
    "records/uniform.jsonl": lines(
      Array.from({ length: 30 }, (_, i) => ({ id: i, name: `n${i}`, size: i * 2 })),
    ),
    "records/embed.md": "# Embed\n\n{table: checks.jsonl}\n",
  })
  const duck = await DuckDBInstance.create()
  const connection = await duck.connect()
  await connection.run(
    `copy (select {'kind': 'pump', 'spare': null, 'size': 3} as part, [1, 2, 3] as levels, map {'north': 1, 'south': 2} as sites, '${sentence}' as words, '${"k".repeat(40)}' as code, ${Array.from({ length: 8 }, (_, i) => `'${sentence}' as wide_${i}`).join(", ")} from range(3)) to '${path.join(root, "records/shapes.parquet")}' (format parquet)`,
  )
  connection.closeSync()
  duck.closeSync()

  const page = await openData("records/ledger.yaml")
  const pressed = () =>
    page.$$eval(".data-switch[aria-pressed='true']", (buttons) =>
      buttons.map((b) => b.textContent).filter((label) => label !== "Statistics"),
    )
  await page.waitForSelector(".data-tree table")

  assert.equal(await page.$$eval(".data-tree table > tbody > tr", (rows) => rows.length), 50)
  assert.equal(await page.$eval(".data-tree table th", (th) => th.textContent), "id")
  assert.ok((await page.$eval(".data-page", (p) => p.textContent ?? "")).includes("season: 7"))

  await page.goto(`${base}/records/scores.json`)
  await page.waitForSelector(".data-tree table")
  assert.deepEqual(
    await page.$eval(".data-tree table > tbody > tr", (row) =>
      [...(row as HTMLTableRowElement).cells].slice(0, 2).map((cell) => cell.textContent),
    ),
    ["p0|calm|B0|0", "100"],
  )
  assert.equal(await page.$eval(".data-tree table th", (th) => th.textContent), "")

  await page.goto(`${base}/records/sections.json`)
  await page.waitForSelector(".data-tree")
  assert.equal(await page.$$eval(".data-page table", (tables) => tables.length), 0)

  await page.goto(`${base}/records/checks.jsonl`)
  await page.waitForSelector(".data-page table")
  assert.deepEqual(await pressed(), ["Table"])
  const nested = await page.$eval(
    ".data-page table > tbody > tr > td:nth-child(2) .data-cell",
    (cell) => ({
      text: cell.textContent ?? "",
      height: (cell as HTMLElement).offsetHeight,
      lines: Number.parseFloat(getComputedStyle(cell).lineHeight),
    }),
  )
  assert.match(nested.text, /^2\{method manual result fail cause/)
  assert.doesNotMatch(nested.text, /["']|basis null/)
  assert.ok(nested.height <= 3 * nested.lines + 1, `${nested.height} > 3 lines`)

  await page.click(".data-page table > tbody > tr >> nth=0")
  const opened = ".data-page table > tbody > tr.data-record"
  await page.waitForSelector(opened)
  assert.deepEqual(
    await page.$$eval(`${opened} > td > .data-record-body > dl > dt`, (names) =>
      names.map((n) => n.textContent),
    ),
    ["id", "checks", "remarks"],
  )
  assert.equal(await page.$$eval(`${opened} table > tbody > tr`, (rows) => rows.length), 2)
  await page.click(`${opened} table > tbody > tr >> nth=0`)
  await page.waitForSelector(`${opened} tr.data-record`)
  assert.equal(
    await page.$eval(`${opened} tr.data-record .data-empty`, (empty) => empty.textContent),
    "Empty: basis",
  )
  await page.click(".data-page table > tbody > tr >> nth=0")
  assert.equal(await page.$$eval(opened, (rows) => rows.length), 0)
  await page.click(".data-page table > tbody > tr >> nth=1")
  await page.waitForSelector(opened)
  assert.ok(
    (await page.$eval(`${opened} .data-empty`, (empty) => empty.textContent))?.includes("remarks"),
  )

  await page.goto(`${base}/records/shapes.parquet`)
  await page.waitForSelector(".data-page table")
  const cell = (column: number) =>
    page.$eval(`.data-page table > tbody > tr > td:nth-child(${column}) .data-cell`, (shown) => ({
      text: shown.textContent ?? "",
      width: (shown as HTMLElement).offsetWidth,
      height: (shown as HTMLElement).offsetHeight,
      em: Number.parseFloat(getComputedStyle(shown).fontSize),
      line: Number.parseFloat(getComputedStyle(shown).lineHeight),
    }))
  assert.equal((await cell(1)).text.trim(), "kind pump size 3")
  assert.equal((await cell(2)).text.trim(), "31, 2, 3")
  assert.equal((await cell(3)).text.trim(), "north 1 south 2")
  const words = await cell(4)
  const code = await cell(5)
  assert.ok(words.width <= 28 * words.em + 1, `${words.width} px past 28 em`)
  assert.ok(words.width >= 20 * words.em * 0.5, `${words.width} px, a word to a line`)
  assert.ok(code.height <= code.line + 1, "the id broke over lines")

  const scrolled = await page.$eval(".data-page table", (table) => {
    table.scrollLeft = 600
    return table.scrollLeft
  })
  assert.ok(scrolled > 0, "the table does not scroll sideways")
  await page.click(".data-page table > tbody > tr >> nth=0", { position: { x: 650, y: 10 } })
  await page.waitForSelector(opened)
  const fits = await page.$eval(opened, (record) => {
    const table = record.closest("table") as HTMLTableElement
    const body = (record.querySelector(".data-record-body") as HTMLElement).getBoundingClientRect()
    const shown = table.getBoundingClientRect()
    return [Math.round(body.left - shown.left), Math.round(shown.right - body.right)]
  })
  assert.ok(
    fits[0] >= 0 && fits[0] <= 2 && fits[1] >= 0,
    `record at ${fits} from the table's edges`,
  )

  await page.goto(`${base}/records/voyages.jsonl`)
  await page.waitForSelector(".data-page table")
  assert.deepEqual(await pressed(), ["Records"])
  assert.match(
    await page.$eval(".data-shared", (shared) => shared.textContent ?? ""),
    /^Every record: voyage v-1/,
  )
  assert.equal(
    await page.$$eval(".data-page table.data-list > tbody > tr", (rows) => rows.length),
    46,
  )
  const first = await page.$eval(
    ".data-page table.data-list > tbody > tr",
    (row) => row.textContent ?? "",
  )
  assert.ok(
    first.includes("arrival_field") &&
      !first.includes("inspection_field") &&
      !first.includes("voyage"),
  )
  await page.click('.data-switch:has-text("Table")')
  assert.deepEqual(await pressed(), ["Table"])
  assert.ok(await page.isVisible(".data-page table:not(.data-list)"))
  await page.click('.data-switch:has-text("Tree")')
  assert.ok(await page.isVisible(".data-page > .data-tree"))

  await page.goto(`${base}/records/uniform.jsonl`)
  await page.waitForSelector(".data-page table")
  assert.deepEqual(await pressed(), ["Table"])

  await page.goto(`${base}/records/embed.md`)
  await page.waitForSelector(".embed-table table")
  const embedded = await page.$eval(
    ".embed-table table > tbody > tr > td:nth-child(2)",
    (td) => td.textContent ?? "",
  )
  assert.match(embedded, /method manual/)
  assert.doesNotMatch(embedded, /"/)

  await page.goto(`${base}/records/checks.jsonl`)
  await page.waitForSelector(".data-page table")
  await page.click('button[title="Switch theme"]')
  await page.click(".data-page table > tbody > tr >> nth=0")
  await page.waitForSelector(opened)
  assert.deepEqual(
    await page.evaluate(() => [
      getComputedStyle(document.querySelector(".data-page .data-k") as Element).color,
      getComputedStyle(document.querySelector(".data-record-body") as Element).borderLeftColor,
    ]),
    ["rgb(154, 154, 154)", "rgb(68, 147, 248)"],
  )
  await page.click('button[title="Switch theme"]')
  await page.close()
})

test("Two sections, Three lines, A long nested list, Long text in a document, A database's table: records read right in two-section documents, long lists and a document's tables", async () => {
  const paragraph =
    "The pump at the north end runs until dawn, then rests while the tide turns. ".repeat(10)
  write({
    "sections/two.json": JSON.stringify({
      server: { host: "a", port: 80 },
      logging: { level: "info", file: "x" },
    }),
    "sections/notes.csv": `id,words\n${[1, 2, 3].map((id) => `${id},"${paragraph}${id}"`).join("\n")}\n`,
    "sections/ledger.yaml": JSON.stringify({
      season: 7,
      incidents: Array.from({ length: 6000 }, (_, i) => ({ id: i, kind: ["drift", "gap"][i % 2] })),
    }),
    "sections/read.md":
      "# Read\n\n{table: notes.csv}\n\n```sql query\nselect id, words from 'notes.csv'\n```\n",
  })
  const duck = await DuckDBInstance.create(path.join(root, "sections/store.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    "create table logs as select {'notes': repeat('x', 50000), 'n': 1} as payload from range(2)",
  )
  connection.closeSync()
  duck.closeSync()

  const page = await openData("sections/two.json")
  await page.waitForSelector(".data-page .data-tree")
  assert.equal(await page.$$eval(".data-page table", (tables) => tables.length), 0)

  await page.goto(`${base}/sections/notes.csv`)
  await page.waitForSelector(".data-page table")
  const cut = await page.$eval(
    ".data-page table > tbody > tr > td:nth-child(2) .data-cell",
    (cell) => ({
      height: (cell as HTMLElement).offsetHeight,
      full: (cell as HTMLElement).scrollHeight,
      line: Number.parseFloat(getComputedStyle(cell).lineHeight),
    }),
  )
  assert.ok(cut.full > cut.height, "the paragraph is not cut")
  assert.ok(
    Math.abs(cut.height - 3 * cut.line) < 1,
    `a cell ${cut.height} px tall under ${cut.line} px lines`,
  )

  await page.goto(`${base}/sections/ledger.yaml`)
  await page.waitForSelector(".data-tree table")
  const rows = () => page.$$eval(".data-tree table > tbody > tr", (all) => all.length)
  assert.equal(await rows(), 5000)
  assert.equal(
    await page.textContent(".data-tree .data-more-rows"),
    "5,000 of 6,000 records shown Show 1,000 more",
  )
  await page.click(".data-tree .data-more-rows button")
  await page.waitForFunction(
    () => document.querySelectorAll(".data-tree table > tbody > tr").length === 6000,
  )
  assert.equal(await page.isVisible(".data-tree .data-more-rows"), false)

  await page.goto(`${base}/sections/read.md`)
  await page.waitForSelector(".embed-table table")
  await page.waitForSelector(".query-result table")

  for (const table of [".embed-table table", ".query-result table"]) {
    await page.click(`${table} > tbody > tr >> nth=0`)
    await page.waitForSelector(`${table} tr.data-record`)
    assert.equal(
      await page.$eval(`${table} tr.data-record .data-text`, (text) => text.textContent),
      `${paragraph}1`,
    )
  }

  await page.goto(`${base}/sections/store.duckdb`)
  await page.waitForSelector(".data-page table")
  const payload = await page.$eval(
    ".data-page table > tbody > tr > td .data-cell",
    (cell) => cell.textContent ?? "",
  )
  assert.match(payload, /^notes x+ n 1/)
  await page.close()
})

test("Numbers and dates, Few values, One value, Free text, Gaps, Hover, Off, The panel, A field, Filter by a value, Filter by a range, As a query, Whole file, A document of keys, Theme: every column shows its spread, and the side panel lists the fields", async () => {
  const day = (n: number) =>
    new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10)
  const runs = Array.from({ length: 6000 }, (_, i) => ({
    ms: Math.round(10 * Math.exp(i / 650)),
    at: day(Math.floor(i / 24)),
    kind: [
      "read",
      "read",
      "read",
      "read",
      "write",
      "write",
      "write",
      "scan",
      "scan",
      i % 20 < 10 ? "sort" : "join",
    ][i % 10],
    port: "harbour",
    note: `note ${i}`,
    tag: `t${i % 300}`,
    spare: i % 2 ? null : i,
    db: i < 5000 ? "alpha" : i % 2 ? "beta" : "gamma",
    ...(i < 5000 && { extra: `x${i % 7}` }),
  }))
  const crew = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `c-${i}`,
      shift: ["day", "night"][i % 2],
      hours: 6 + (i % 5),
    }))
  write({
    "stats/runs.jsonl": runs.map((run) => `${JSON.stringify(run)}\n`).join(""),
    "stats/crew.json": JSON.stringify(crew(30)),
    "stats/ledger.yaml": JSON.stringify({
      season: 7,
      owners: crew(3),
      log: Array.from({ length: 60 }, (_, i) => `entry ${i}`),
      port: "harbour",
      incidents: crew(30),
    }),
  })
  const sqlite = new DatabaseSync(path.join(root, "stats/crew.sqlite"))
  sqlite.exec(
    `begin; create table crew (id text, shift text, hours integer); ${crew(30)
      .map(({ id, shift, hours }) => `insert into crew values ('${id}', '${shift}', ${hours});`)
      .join(" ")} commit;`,
  )
  sqlite.close()

  const page = await openData("stats/runs.jsonl")
  const column = (name: string) => Object.keys(runs[0]).indexOf(name)
  const strip = (name: string) =>
    page.$eval(
      `.data-page table > thead > tr.data-stats > td:nth-child(${column(name) + 1})`,
      (cell) => cell.textContent ?? "",
    )
  const ends = (name: string) =>
    page.$eval(
      `.data-page table > thead > tr.data-stats > td:nth-child(${column(name) + 1}) .data-ends`,
      (shown) => shown.textContent ?? "",
    )
  const bins = (name: string) =>
    page.$$eval(
      `.data-page table > thead > tr.data-stats > td:nth-child(${column(name) + 1}) .data-chart title`,
      (titles) => titles.map((title) => title.textContent ?? ""),
    )
  const field = (name: string) =>
    page.locator(".outline .data-field", {
      has: page.locator(".data-field-name", { hasText: new RegExp(`^${name}$`) }),
    })
  const filtered = () => page.$eval(".data-filter", (bar) => bar.textContent ?? "").catch(() => "")
  const panelHead = () => page.$eval(".outline .data-panel-head", (head) => head.textContent ?? "")
  await page.waitForSelector(".data-page table > thead > tr.data-stats .data-chart")

  const spread = await bins("ms")
  assert.equal(spread.length, 20)
  assert.ok(
    spread.every((title) => /^\d[\d,]* · \S+ to \S+$/.test(title)),
    spread[0],
  )
  const counts = spread.map((title) => Number(title.split(" · ")[0].replaceAll(",", "")))
  assert.ok(
    Math.min(...counts) >= 150 && Math.max(...counts) < 1800,
    `a long tail on a linear scale: ${counts}`,
  )
  assert.equal(
    counts.reduce((sum, n) => sum + n, 0),
    6000,
  )
  assert.equal(await ends("ms"), "10101.91K")
  assert.equal(await ends("at"), "2026-01-012026-09-07")
  assert.equal(await strip("kind"), "read40%write30%scan20%2 more")
  assert.equal(await strip("port"), "all harbour")
  assert.equal(await strip("note"), "all 6,000 distinct")
  assert.equal(await strip("tag"), "300 distinct")
  assert.match(await strip("spare"), /50% missing$/)
  assert.equal(await strip("db"), "alpha83%beta8%gamma8%")

  await page.click('.data-switch:has-text("Statistics")')
  assert.equal(await page.isVisible(".data-page tr.data-stats"), false)
  await page.click('.data-switch:has-text("Statistics")')
  assert.equal(await page.isVisible(".data-page tr.data-stats"), true)

  assert.equal(await panelHead(), "6,000 records · 9 fields")
  assert.deepEqual(
    await page.$$eval(".outline .data-field-name", (names) => names.map((n) => n.textContent)),
    ["ms", "at", "kind", "port", "note", "tag", "spare", "db", "extra"],
  )
  assert.equal(await field("ms").locator("svg.data-chart").count(), 1)
  assert.equal(await field("kind").locator(".data-field-count").textContent(), "5")
  assert.deepEqual(
    await page.$$eval(".outline .data-field:has(.data-meter) .data-field-name", (names) =>
      names.map((n) => n.textContent),
    ),
    ["spare", "extra"],
  )

  await field("kind").click()
  assert.deepEqual(
    await page.$$eval(".outline .data-field-detail .data-top-line", (lines) =>
      lines.map((line) => line.textContent),
    ),
    ["read2,400", "write1,800", "scan1,200", "join300", "sort300"],
  )
  await page.waitForSelector(".data-page table > thead > tr > th.data-flash")
  assert.equal(await page.$eval("th.data-flash", (th) => th.textContent), "kind")
  await field("kind").click()
  await field("ms").click()
  assert.equal(
    await page.$eval(".outline .data-field-detail svg.data-chart", (svg) =>
      svg.getAttribute("width"),
    ),
    "196",
  )
  await page.click('.outline .data-field-detail button:has-text("Largest first")')
  await waitFor(async () => (await cells(page, 0, 0))[0] === "101907")
  await page.click('.outline .data-field-detail button:has-text("Smallest first")')
  await waitFor(async () => (await cells(page, 0, 0))[0] === "10")
  await field("ms").click()

  await field("kind").click()
  await page.click('.outline .data-field-detail .data-top-line:has-text("write")')
  await waitFor(async () => (await filtered()) === "kind = write · 1,800 of 6,000 records Clear")
  assert.match(await page.evaluate(() => location.search), /filter=/)
  await page.waitForSelector(".outline .data-panel-filter")
  assert.equal(await panelHead(), "1,800 records · 9 fields")
  assert.equal(await strip("kind"), "all write")
  assert.ok((await cells(page, 0, column("kind"))).every((kind) => kind === "write"))
  const query = await page.$eval(
    ".outline .data-panel-query code",
    (code) => code.textContent ?? "",
  )
  assert.equal(query, "select *\nfrom '/stats/runs.jsonl'\nwhere kind = 'write'")
  assert.equal(await page.locator(".outline .data-panel-query .code-copy").count(), 1)

  await page.goBack()
  await waitFor(async () => (await filtered()) === "")
  await waitFor(async () => (await panelHead()) === "6,000 records · 9 fields")

  await page.click(
    `.data-page tr.data-stats > td:nth-child(${column("db") + 1}) .data-top-line:has-text("beta")`,
  )
  await waitFor(async () => (await filtered()) === "db = beta · 500 of 6,000 records Clear")
  assert.equal(
    await page.isVisible(`.data-page table > thead > tr > th:nth-child(${column("extra") + 1})`),
    false,
  )
  assert.equal(
    await page.isVisible(`.data-page table > tbody > tr > td:nth-child(${column("extra") + 1})`),
    false,
  )
  assert.equal(await panelHead(), "500 records · 7 fields")
  assert.equal(
    await page.$eval(".outline .data-panel-empties summary", (summary) => summary.textContent),
    "2 fields empty in every record counted",
  )
  await page.click('.data-filter .data-switch:has-text("Clear")')
  await waitFor(async () => (await filtered()) === "")

  await page.waitForSelector(
    `.data-page tr.data-stats > td:nth-child(${column("at") + 1}) .data-pick`,
  )
  const range = await page.$eval(
    `.data-page tr.data-stats > td:nth-child(${column("at") + 1}) .data-pick title`,
    (title) => title.textContent ?? "",
  )
  const [inRange, label] = range.split(" · ")
  await page.click(
    `.data-page tr.data-stats > td:nth-child(${column("at") + 1}) .data-pick >> nth=0`,
  )
  await waitFor(
    async () => (await filtered()) === `at ${label} · ${inRange} of 6,000 records Clear`,
  )
  const [from, to] = label.split(" to ")
  assert.ok(
    (await cells(page, 0, column("at"))).every((at) => at >= from && at <= to),
    `the dates kept lie from ${from} to ${to}`,
  )

  write({ "stats/query.md": `# Query\n\n\`\`\`sql query\n${query}\n\`\`\`\n` })
  await page.goto(`${base}/stats/query.md`)
  await page.waitForSelector(".query-result table")
  assert.equal(await page.$$eval(".query-result table > tbody > tr", (rows) => rows.length), 1800)

  await page.goto(`${base}/stats/crew.sqlite?table=crew`)
  await page.waitForSelector(".data-page tr.data-stats .data-top-line")
  assert.equal(await panelHead(), "30 records · 3 fields")
  assert.match(
    await page.$eval(".outline .data-panel-query code", (code) => code.textContent ?? ""),
    /^select \*\nfrom '\/stats\/crew\.sqlite#crew'$/,
  )

  await page.goto(`${base}/stats/crew.json`)
  await page.click('.data-page tr.data-stats > td:nth-child(2) .data-top-line:has-text("night")')
  await waitFor(async () => (await filtered()) === "shift = night · 15 of 30 records Clear")
  await page.waitForSelector(".outline .data-panel-filter")
  const listed = await page.$eval(
    ".outline .data-panel-query code",
    (code) => code.textContent ?? "",
  )
  assert.equal(listed, `select *\nfrom '/stats/crew.json'\nwhere "shift" = 'night'`)
  write({ "stats/listed.md": `# Listed\n\n\`\`\`sql query\n${listed}\n\`\`\`\n` })
  await page.goto(`${base}/stats/listed.md`)
  await page.waitForSelector(".query-result table")
  assert.equal(await page.$$eval(".query-result table > tbody > tr", (rows) => rows.length), 15)

  await page.goto(`${base}/stats/ledger.yaml`)
  await page.waitForSelector(".outline .data-panel")
  assert.deepEqual(
    await page.$$eval(".outline .data-field-name", (names) => names.map((n) => n.textContent)),
    ["season", "owners", "log", "port", "incidents"],
  )
  const placed = () =>
    page.$eval(".data-page > .data-tree > [data-key='incidents']", (place) => {
      const top = place.getBoundingClientRect().top
      return (
        top >= (document.querySelector(".bar") as Element).getBoundingClientRect().bottom &&
        top < innerHeight / 2
      )
    })
  assert.equal(await placed(), false)
  await page.click('.outline .data-field:has-text("incidents")')
  await waitFor(placed)
  assert.equal(
    await page.$$eval("[data-key='incidents'] table tr.data-stats", (rows) => rows.length),
    1,
  )
  assert.equal(
    await page.$$eval("[data-key='owners'] table tr.data-stats", (rows) => rows.length),
    0,
  )

  await page.goto(`${base}/stats/runs.jsonl`)
  await page.waitForSelector(".data-page tr.data-stats .data-bar")
  const bar = () =>
    page
      .$eval(".data-page tr.data-stats .data-bar", (mark) => getComputedStyle(mark).fill)
      .catch(() => "")
  assert.equal(await bar(), "rgb(9, 105, 218)")
  await page.click('button[title="Switch theme"]')
  await waitFor(async () => (await bar()) === "rgb(68, 147, 248)")
  await page.click('button[title="Switch theme"]')
  await page.close()
})

test("Sort under a filter, Mixed records in a document, The top whole-number bar, The top bar of a range, A search in Records under a filter, A YAML list, A malformed CSV, Few missing, Sort from the panel: column statistics stay right in each case", async () => {
  const kinds = Array.from({ length: 6000 }, (_, i) => ({
    kind: i % 2 ? "a" : "b",
    n: (i * 7) % 6000,
    extra: i % 2 ? `x${i}` : null,
  }))
  const lines = (records: object[]) =>
    records.map((record) => `${JSON.stringify(record)}\n`).join("")
  write({
    "spread/kinds.jsonl": lines(kinds),
    "spread/mixed.json": JSON.stringify({
      items: Array.from({ length: 30 }, (_, i) => ({ [`f${i}`]: i })),
    }),
    "spread/digits.jsonl": lines(
      Array.from({ length: 1000 }, (_, i) => ({
        group: i < 500 ? "a" : "b",
        digit: i < 500 ? i % 6 : i % 10,
      })),
    ),
    "spread/people.yaml": JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, team: i % 3 ? "x" : "y" })),
    ),
    "spread/broken.csv": Buffer.from(
      `city,visits\n${Array.from({ length: 300 }, (_, i) => `${i === 150 ? "L\xffma" : `c${i}`},${i}`).join("\n")}\n`,
      "latin1",
    ),
    "spread/gaps.csv": `id,v\n${Array.from({ length: 1000 }, (_, i) => `${i},${i === 500 ? "" : i}`).join("\n")}\n`,
    "spread/voyages.jsonl": lines(
      Array.from({ length: 50 }, (_, i) => ({ n: i, [`k${i % 5}`]: i })),
    ),
    "spread/twenty.jsonl": lines(Array.from({ length: 1000 }, (_, i) => ({ v: i % 21 }))),
    "spread/sparse.jsonl": lines(
      Array.from({ length: 1000 }, (_, i) => ({
        a: i % 2 ? null : "v",
        kind: i % 2 ? "x" : "y",
        note: `note ${i}`,
      })),
    ),
  })
  const filtered = (file: string, picked: object) =>
    `${base}/${file}?filter=${encodeURIComponent(JSON.stringify(picked))}`
  const page = await context.newPage()
  const bar = () => page.$eval(".data-filter", (shown) => shown.textContent ?? "").catch(() => "")

  await page.goto(
    filtered("spread/kinds.jsonl", { filter: { field: "kind", eq: "b" }, label: "kind = b" }),
  )
  await page.waitForSelector(".data-page tbody td.data-gone", { state: "attached" })
  await page.click(".markdown-body th >> nth=1")
  await page.click(".markdown-body th >> nth=1")
  const largest = String(Math.max(...kinds.filter(({ kind }) => kind === "b").map(({ n }) => n)))
  await waitFor(async () => (await cells(page, 0, 1))[0] === largest)
  assert.deepEqual(
    await page.$$eval(".data-page table > tbody > tr:not([hidden])", (rows) =>
      rows.map((row) => (row as HTMLTableRowElement).cells[2].classList.contains("data-gone")),
    ),
    Array.from({ length: 200 }, () => true),
  )

  await page.goto(`${base}/spread/mixed.json`)
  await page.waitForSelector(".data-tree table")
  assert.equal(await page.locator(".data-tree tr.data-stats").count(), 0)

  await page.goto(
    filtered("spread/digits.jsonl", { filter: { field: "group", eq: "a" }, label: "group = a" }),
  )
  await page.waitForSelector(".data-page tr.data-stats > td:nth-child(2) .data-pick")
  await page.click(".data-page tr.data-stats > td:nth-child(2) .data-pick >> nth=-1")
  await waitFor(async () => (await bar()) === "digit = 5 · 133 of 1,000 records Clear")

  await page.goto(`${base}/spread/twenty.jsonl`)
  await page.waitForSelector(".data-page tr.data-stats > td:nth-child(1) .data-pick")
  await page.click(".data-page tr.data-stats > td:nth-child(1) .data-pick >> nth=-1")
  await waitFor(async () => (await bar()) === "v 19 to 20 · 94 of 1,000 records Clear")

  await page.goto(
    filtered("spread/sparse.jsonl", { filter: { field: "kind", eq: "x" }, label: "kind = x" }),
  )
  await page.waitForSelector(".data-page tbody td.data-gone", { state: "attached" })
  await page.click('.data-switch:has-text("Records")')
  await page.hover(".data-page table.data-list")
  await page.click(".table-control")
  await page.fill('.table-panel input[aria-label="Filter rows"]', "note 1")
  const listed = ".data-page table.data-list > tbody > tr:not([data-follows])"
  await waitFor(async () => (await page.$$eval(listed, (found) => found.length)) === 56)
  assert.equal(await page.$$eval(`${listed} > td.data-gone`, (gone) => gone.length), 0)
  await page.keyboard.press("Escape")

  await page.goto(
    filtered("spread/people.yaml", { filter: { field: "team", eq: "y" }, label: "team = y" }),
  )
  await page.waitForSelector(".outline .data-panel-query code")
  assert.equal(
    await page.textContent(".outline .data-panel-query code"),
    "select *\nfrom '/spread/people.yaml'\nwhere \"team\" = 'y'",
  )

  await page.goto(`${base}/spread/broken.csv`)
  await page.waitForSelector(".outline .data-panel-error")
  assert.match(
    (await page.textContent(".outline .data-panel-head")) ?? "",
    /^2 fields · cannot count$/,
  )
  assert.ok(((await page.textContent(".outline .data-panel-error")) ?? "").length > 0)
  assert.deepEqual(
    await page.$$eval(".data-page tr.data-stats > td", (strips) =>
      strips.map((strip) => strip.textContent),
    ),
    ["cannot count", "cannot count"],
  )

  await page.goto(`${base}/spread/gaps.csv`)
  await page.waitForSelector(".data-page tr.data-stats > td:nth-child(2) .data-chart")
  assert.match(
    (await page.textContent(".data-page tr.data-stats > td:nth-child(2)")) ?? "",
    /<1% missing$/,
  )

  await page.goto(`${base}/spread/voyages.jsonl`)
  await page.waitForSelector(".data-page table.data-list")
  await page.click(".outline .data-field:has(.data-field-name:text-is('n'))")
  await page.click('.outline .data-field-detail button:has-text("Largest first")')
  await waitFor(
    async () =>
      (await page.textContent(".data-page table:not(.data-list) > tbody > tr > td")) === "49",
  )
  assert.deepEqual(
    await page.$$eval(".data-switch[aria-pressed='true']", (buttons) =>
      buttons.map((b) => b.textContent).filter((label) => label !== "Statistics"),
    ),
    ["Table"],
  )
  await page.close()
})

test("Open, More, Sort, Filter, Open a record, A small file, Every reader, Live: a data page of any size opens on a page of its rows and loads more", async () => {
  const records = Array.from({ length: 6000 }, (_, i) => ({
    n: i,
    size: (i * 7919) % 6000,
    kind: ["read", "write", "scan"][i % 3],
    note: `note ${i}`,
  }))
  const lines = (rows: object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("")
  const delimited = (by: string) =>
    `n${by}size${by}kind${by}note\n${records.map((r) => [r.n, r.size, r.kind, r.note].join(by)).join("\n")}\n`
  write({
    "paged/rows.jsonl": lines(records),
    "paged/rows.csv": delimited(","),
    "paged/rows.tsv": delimited("\t"),
    "paged/small.csv": `n,kind\n${Array.from({ length: 150 }, (_, i) => `${i},k${i % 4}`).join("\n")}\n`,
  })
  const sqlite = new DatabaseSync(path.join(root, "paged/rows.sqlite"))
  sqlite.exec(
    `begin; create table spread (n integer, size integer, kind text, note text); ${records.map(({ n, size, kind, note }) => `insert into spread values (${n}, ${size}, '${kind}', '${note}');`).join(" ")} commit;`,
  )
  sqlite.close()
  const duck = await DuckDBInstance.create(path.join(root, "paged/rows.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    `create table spread as select * from read_json('${path.join(root, "paged/rows.jsonl")}')`,
  )
  await connection.run(`copy spread to '${path.join(root, "paged/rows.parquet")}' (format parquet)`)
  connection.closeSync()
  duck.closeSync()

  const page = await openData("paged/rows.jsonl")
  const rows = (selector = ".data-page > table:not(.data-list)") =>
    page.$$eval(`${selector} > tbody > tr:not([data-follows])`, (found) => found.length)
  const bar = () =>
    page
      .$eval(".data-more-rows", (shown) => ((shown as HTMLElement).hidden ? "" : shown.textContent))
      .catch(() => "")
  const more = async (count: number, selector?: string) => {
    await page.click(".data-more-rows button")
    await waitFor(async () => (await rows(selector)) === count)
  }
  await page.waitForSelector(".data-page > table > tbody > tr")

  assert.equal(await rows(), 200)
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^JSONL · .+ · 6,000 rows$/,
  )
  assert.equal(await bar(), "200 of 6,000 shown Show 200 more")

  await page.click(".data-page > table > tbody > tr >> nth=3")
  await page.waitForSelector(".data-page > table > tbody > tr.data-record")
  await more(400)
  assert.equal(await bar(), "400 of 6,000 shown Show 200 more")
  assert.equal(
    await page.$$eval(".data-page > table > tbody > tr.data-record", (open) => open.length),
    1,
  )
  assert.deepEqual((await cells(page, 0, 0)).slice(200, 202), ["199", "200"])

  await page.click('.data-switch:has-text("Records")')
  assert.equal(await rows(".data-page table.data-list"), 400)
  await page.click(".data-page table.data-list > tbody > tr >> nth=2")
  await page.waitForSelector(".data-page table.data-list > tbody > tr.data-record")
  await more(600, ".data-page table.data-list")
  assert.equal(
    await page.$$eval(".data-page table.data-list > tbody > tr.data-record", (open) => open.length),
    1,
  )
  await page.click('.data-switch:has-text("Tree")')
  assert.equal(
    await page.$$eval(".data-page > .data-tree > .data-tree", (items) => items.length),
    600,
  )
  await page.click('.data-switch:has-text("Table")')
  await waitFor(async () => (await rows()) === 600)

  await page.click(".data-page > table > thead > tr:first-child > th >> nth=1")
  await waitFor(
    async () => JSON.stringify((await cells(page, 0, 1)).slice(0, 3)) === '["0","1","2"]',
  )
  assert.equal(await rows(), 200)
  await more(400)
  assert.deepEqual((await cells(page, 0, 1)).slice(199, 202), ["199", "200", "201"])
  await page.click(".data-page > table > thead > tr:first-child > th >> nth=1")
  await waitFor(async () => (await cells(page, 0, 1))[0] === "5999")

  await panel(page, 0)
  await page.fill('.table-panel input[data-key="all"]', "NOTE 59")
  await waitFor(async () => (await rows()) === 111)
  assert.ok((await cells(page, 0, 3)).every((note) => note.startsWith("note 59")))
  assert.equal(await bar(), "")
  await page.fill('.table-panel input[data-key="all"]', "")
  await waitFor(async () => (await rows()) === 200)
  await page.keyboard.press("Escape")

  await page.click('.data-page tr.data-stats > td:nth-child(3) .data-top-line:has-text("write")')
  await waitFor(async () => (await bar()) === "200 of 2,000 shown Show 200 more")
  await more(400)
  assert.ok((await cells(page, 0, 2)).every((kind) => kind === "write"))

  for (const [name, table] of [
    ["paged/rows.csv", ""],
    ["paged/rows.tsv", ""],
    ["paged/rows.parquet", ""],
    ["paged/rows.sqlite", "?table=spread"],
    ["paged/rows.duckdb", "?table=spread"],
  ]) {
    await page.goto(`${base}/${name}${table}`)
    await page.waitForSelector(".data-page > table > tbody > tr")
    assert.equal(await rows(), 200, name)
    assert.equal(await bar(), "200 of 6,000 shown Show 200 more", name)
    await more(400)
    await page.click(".data-page > table > thead > tr:first-child > th >> nth=0")
    await page.click(".data-page > table > thead > tr:first-child > th >> nth=0")
    await waitFor(async () => (await cells(page, 0, 0))[0] === "5999")
  }

  await page.goto(`${base}/paged/small.csv`)
  await page.waitForSelector(".data-page > table > tbody > tr")
  assert.equal(await rows(), 150)
  assert.equal(await bar(), "")

  await page.goto(`${base}/paged/rows.jsonl`)
  await page.waitForSelector(".data-more-rows")
  fs.appendFileSync(
    path.join(root, "paged/rows.jsonl"),
    lines([{ n: 6000, size: 6000, kind: "read", note: "note 6000" }]),
  )
  await waitFor(async () => (await bar()) === "200 of 6,001 shown Show 200 more")
  await page.close()
})

test("More during a sort, Records' own filter, A time typed as shown, Every record, Open while rows arrive, A very large text file: a paged data page loads every row once, in order", async () => {
  const records = Array.from({ length: 6000 }, (_, i) => ({
    n: (i * 7919) % 6000,
    word: i % 150 === 0 ? "needle" : "hay",
    batch: i < 200 ? "early" : `late ${i}`,
    at: `2024-01-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
    detail: { a: i },
  }))
  write({
    "ordered/rows.jsonl": records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "ordered/huge.csv": `n,word\n${records.map(({ n, word }) => `${n},${word}`).join("\n")}\n`,
  })
  const page = await context.newPage()
  const table = ".data-page > table:not(.data-list)"
  const list = ".data-page table.data-list"
  const rows = (selector: string) =>
    page.$$eval(
      `${selector} > tbody > tr:not([data-follows]):not([hidden])`,
      (found) => found.length,
    )
  const shown = (selector: string) =>
    page.$$eval(`${selector} > tbody > tr:not([data-follows]):not([hidden])`, (found) =>
      found.map((row) => (row as HTMLTableRowElement).cells[0].textContent),
    )
  const filter = async (selector: string, text: string) => {
    await page.hover(selector)
    await page.click(".table-control")
    await page.fill('.table-panel input[aria-label="Filter rows"]', text)
  }

  await page.route(
    (url) => url.pathname.endsWith("/ordered/rows.jsonl") && url.searchParams.has("sort"),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      await route.continue()
    },
  )
  await page.goto(`${base}/ordered/rows.jsonl`)
  await page.waitForSelector(`${table} > tbody > tr`)
  await page.click(`${table} > thead > tr:first-child > th >> nth=0`)
  await page.click(".data-more-rows button")
  await waitFor(async () => (await rows(table)) === 400)
  await page.waitForTimeout(1000)
  assert.deepEqual(
    await shown(table),
    Array.from({ length: 400 }, (_, n) => String(n)),
  )
  await page.unrouteAll()

  await page.goto(`${base}/ordered/rows.jsonl`)
  await page.waitForSelector(`${table} > tbody > tr`)
  await filter(table, "T10:00")
  await waitFor(async () => (await caption(page, 0)) === "250 of 6000 rows")

  await page.goto(`${base}/ordered/rows.jsonl`)
  await page.waitForSelector(`${table} > tbody > tr`)
  await page.click('.data-switch:has-text("Records")')
  await page.waitForSelector(`${list} > tbody > tr`)
  assert.equal(await page.locator(".data-page .data-shared").count(), 0)
  await filter(list, "needle")
  await waitFor(async () => (await rows(list)) === 40)

  const target = records.slice(0, 200).find(({ n }) => n >= 5600) as (typeof records)[0]
  const place = records.indexOf(target)
  await page.goto(`${base}/ordered/rows.jsonl`)
  await page.waitForSelector(`${table} > tbody > tr`)
  await page.click('.data-switch:has-text("Records")')
  await page.click(`${list} > tbody > tr >> nth=${place}`)
  await page.waitForSelector(`${list} > tbody > tr.data-record`)
  await page.click('.data-switch:has-text("Tree")')
  await page.click(
    `.data-page > .data-tree > .data-tree >> nth=${place} >> details.data-tree > summary:text-is("detail: {1}")`,
  )
  await page.click(".outline .data-field:has(.data-field-name:text-is('n'))")
  await page.click('.outline .data-field-detail button:has-text("Largest first")')
  await waitFor(async () => (await shown(table))[0] === "5999")
  await page.click(".data-more-rows button")
  await waitFor(async () => (await rows(table)) === 400)
  await page.click('.data-switch:has-text("Tree")')
  const opened = await page.$$eval(
    ".data-page > .data-tree details.data-tree[open] > summary",
    (summaries) =>
      summaries
        .filter((summary) => summary.textContent === "detail: {1}")
        .map((summary) =>
          [
            ...(summary
              .closest(".data-page > .data-tree > .data-tree")
              ?.querySelectorAll(":scope > .data-leaf") ?? []),
          ]
            .map((leaf) => leaf.textContent)
            .join("|"),
        ),
  )
  assert.equal(opened.length, 1)
  assert.ok(opened[0].split("|").includes(`n: ${target.n}`), opened[0])
  await page.click('.data-switch:has-text("Records")')
  await waitFor(async () => (await page.locator(`${list} > tbody > tr.open`).count()) === 1)
  assert.match(
    (await page.textContent(`${list} > tbody > tr.open`)) ?? "",
    new RegExp(`n ${target.n}\\b`),
  )

  let first = true
  await page.route(
    (url) => url.pathname.endsWith("/ordered/huge.csv") && url.search === "?data",
    async (route) => {
      if (!first) {
        return route.continue()
      }

      first = false
      const answer = await (await route.fetch()).json()
      answer.counting = true
      answer.grid.partial = true
      delete answer.grid.total
      delete answer.count
      await route.fulfill({ json: answer })
    },
  )
  await page.goto(`${base}/ordered/huge.csv`)
  await page.waitForSelector(`${table} > tbody > tr`)
  assert.match(
    (await page.textContent(".data-page > .data-info")) ?? "",
    /showing its first 200 rows · still counting$/,
  )
  await waitFor(async () =>
    /6,000 rows$/.test((await page.textContent(".data-page > .data-info")) ?? ""),
  )
  await page.close()
})

test("A view first drawn after another's search, Records after a Table sort, More between two sorts: each view of a paged page shows its own rows, every one once", async () => {
  const lines = (records: object[]) =>
    records.map((record) => `${JSON.stringify(record)}\n`).join("")
  write({
    "between/rows.jsonl": lines(
      Array.from({ length: 6000 }, (_, n) => ({ n, word: n % 150 === 0 ? "needle" : "hay" })),
    ),
    "between/mixed.jsonl": lines(
      Array.from({ length: 6000 }, (_, n) => ({
        n,
        word: n % 150 === 0 ? "needle" : "hay",
        [`k${n % 5}`]: n,
      })),
    ),
  })
  const page = await context.newPage()
  const listed = ".data-page table.data-list > tbody > tr:not([data-follows])"
  const tabled = ".data-page > table:not(.data-list) > tbody > tr:not([data-follows]):not([hidden])"
  const count = (selector: string) => page.$$eval(selector, (found) => found.length)
  const firstOf = (selector: string) =>
    page.$eval(selector, (row) => row.textContent ?? "").catch(() => "")

  await page.goto(`${base}/between/mixed.jsonl`)
  await page.waitForSelector(listed)
  await page.hover(".data-page table.data-list")
  await page.click(".table-control")
  await page.fill('.table-panel input[aria-label="Filter rows"]', "needle")
  await waitFor(async () => (await count(listed)) === 40)
  await page.keyboard.press("Escape")
  await page.click('.data-switch:has-text("Table")')
  await waitFor(async () => (await count(tabled)) === 200)
  assert.equal(
    await page.$eval(tabled, (row) => (row as HTMLTableRowElement).cells[0].textContent),
    "0",
  )

  await page.goto(`${base}/between/rows.jsonl`)
  await page.waitForSelector(".data-page > table > tbody > tr")
  await page.click(".data-page > table > thead > tr:first-child > th >> nth=0")
  await page.click(".data-page > table > thead > tr:first-child > th >> nth=0")
  await waitFor(async () => (await cells(page, 0, 0))[0] === "5999")
  await page.click('.data-switch:has-text("Records")')
  await waitFor(async () => (await firstOf(listed)).includes("needle"))
  await page.click(".data-more-rows button")
  await waitFor(async () => (await count(listed)) === 400)

  await page.goto(`${base}/between/rows.jsonl`)
  await page.waitForSelector(".data-page > table > tbody > tr")
  await page.route(/between\/rows\.jsonl\?data/, async (route) => {
    const asked = new URL(route.request().url()).searchParams
    const wait = asked.has("offset") ? 2000 : asked.has("sort") ? 800 : 0
    await new Promise((resolve) => setTimeout(resolve, wait))
    await route.continue().catch(() => {})
  })
  await page.click(".data-page > table > thead > tr:first-child > th >> nth=0")
  await page.click(".data-more-rows button")
  await page.click(".data-page > table > thead > tr:first-child > th >> nth=0")
  await waitFor(async () => (await count(tabled)) === 400)
  assert.deepEqual((await cells(page, 0, 0)).slice(198, 203), [
    "5801",
    "5800",
    "5799",
    "5798",
    "5797",
  ])
  await page.unrouteAll()
  await page.close()
})

test("The view chosen, Compare, Rows loaded, Open records, A growing file, A fresh visit: a data page keeps its view through a theme switch and a live change", async () => {
  const records = (count: number, changed: (n: number) => boolean = () => false) =>
    Array.from({ length: count }, (_, n) => ({
      n,
      kind: n === 0 && changed(n) ? "write" : ["read", "write", "scan"][n % 3],
      note: changed(n) ? `note ${n} changed` : `note ${n}`,
    }))
  const lines = (rows: object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("")
  write({ "kept/rows.jsonl": lines(records(1000)), "kept/log.jsonl": lines(records(50)) })
  const page = await openData("kept/rows.jsonl")
  const chosen = () =>
    page.$eval('.data-switch[aria-pressed="true"]:not(:has-text("Statistics"))', (choice) =>
      (choice as HTMLElement).innerText.trim(),
    )
  const rows = (selector = ".data-page > table:not(.data-list)") =>
    page.$$eval(`${selector} > tbody > tr:not([data-follows])`, (found) => found.length)
  const bar = () =>
    page
      .$eval(".data-more-rows", (shown) => ((shown as HTMLElement).hidden ? "" : shown.textContent))
      .catch(() => "")
  const switchTheme = async () => {
    const was = await page.evaluate(() => document.documentElement.dataset.theme)
    await page.click('button[title="Switch theme"]')
    await page.waitForFunction((t) => document.documentElement.dataset.theme !== t, was)
    await page.waitForTimeout(500)
  }
  const save = (changed: (n: number) => boolean) =>
    write({ "kept/rows.jsonl": lines(records(1000, changed)) })
  await page.waitForSelector(".data-page > table > tbody > tr")

  await page.click('.data-switch:has-text("Tree")')
  await switchTheme()
  assert.equal(await chosen(), "Tree")
  assert.equal(
    await page.$$eval(".data-page > .data-tree:not([hidden])", (trees) => trees.length),
    1,
  )

  await page.click('.outline .data-field:has(.data-field-name:text-is("kind"))')
  await page.click('.outline .data-compare-by:has-text("Compare every field by kind")')
  await page.waitForSelector(".data-compare")
  await switchTheme()
  assert.equal(await chosen(), "Compare")
  assert.equal(await page.$$eval(".data-compare:not([hidden])", (shown) => shown.length), 1)
  save((n) => n === 0)
  await waitFor(async () =>
    (
      await page.$$eval(".data-compare-table > thead th", (cells) =>
        cells.map((cell) => (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      )
    ).includes("write 334 records"),
  )
  assert.equal(await chosen(), "Compare")

  await page.click('.data-switch:has-text("Table")')
  for (const count of [400, 600]) {
    await page.click(".data-more-rows button")
    await waitFor(async () => (await rows()) === count)
  }
  save((n) => n === 0 || n === 450)
  await waitFor(
    async () =>
      (
        await page.$$eval(
          ".data-page > table:not(.data-list) > tbody > tr:not([data-follows])",
          (found) => found.map((row) => (row as HTMLTableRowElement).cells[2]?.textContent),
        )
      )[450] === "note 450 changed",
  )
  assert.equal(await rows(), 600)
  assert.equal(await bar(), "600 of 1,000 shown Show 200 more")
  assert.equal(await chosen(), "Table")

  await page.click('.data-switch:has-text("Records")')
  await page.click(".data-page table.data-list > tbody > tr >> nth=2")
  await page.waitForSelector(".data-page table.data-list > tbody > tr.data-record")
  save((n) => n === 0 || n === 450 || n === 5)
  await waitFor(async () =>
    page.$$eval(".data-page table.data-list > tbody > tr", (found) =>
      found.some((row) => row.textContent?.includes("note 5 changed")),
    ),
  )
  assert.equal(await chosen(), "Records")
  assert.deepEqual(
    await page.$$eval(".data-page table.data-list > tbody > tr.data-record", (open) =>
      open.map((row) => row.previousElementSibling?.textContent?.includes("note 2")),
    ),
    [true],
  )

  await page.goto(`${base}/kept/rows.jsonl`)
  await page.waitForSelector(".data-page > table > tbody > tr")
  assert.equal(await chosen(), "Table")
  assert.equal(await rows(), 200)
  assert.equal(await bar(), "200 of 1,000 shown Show 200 more")

  await page.goto(`${base}/kept/log.jsonl`)
  await page.waitForSelector(".data-page > table > tbody > tr")
  await page.waitForTimeout(300)
  await page.click('.data-switch:has-text("Records")')
  for (const count of [51, 52, 53]) {
    fs.appendFileSync(
      path.join(root, "kept/log.jsonl"),
      lines([{ n: count - 1, kind: "read", note: "late" }]),
    )
    await waitFor(async () => (await rows(".data-page table.data-list")) === count)
    assert.equal(await chosen(), "Records")
  }

  const nested = (count: number) =>
    lines(records(count).map((record) => ({ ...record, meta: { from: "log" } })))
  write({ "kept/nested.jsonl": nested(20) })
  await page.goto(`${base}/kept/nested.jsonl`)
  await page.waitForSelector(".data-page .data-switch")
  await page.waitForTimeout(300)
  await page.click('.data-switch:has-text("Tree")')
  await page.click(".data-page > .data-tree > .data-tree >> nth=3 >> details.data-tree >> summary")
  write({ "kept/nested.jsonl": nested(21) })
  await waitFor(
    async () =>
      (await page.$$eval(".data-page > .data-tree > .data-tree", (items) => items.length)) === 21,
  )
  assert.equal(await chosen(), "Tree")
  assert.deepEqual(
    await page.$$eval(".data-page > .data-tree > .data-tree details.data-tree[open]", (open) =>
      open.map((branch) => (branch.parentElement as HTMLElement).dataset.key),
    ),
    ["3"],
  )
  await page.close()
})

test("A JSON list, A document of keys, A record's width, A sort after a save, Searched rows in the tree, Folded, Every match, A table's own view, Records after a Table sort, Two saves before a sort lands, Every row, A view left to ask again, An empty save, Two saves while comparing, Scrolled down Compare, A save that does not read, A comparison asked during a save, After a link: a live change keeps a data page as its reader left it in every case", async () => {
  const records = (count: number, writes: number[] = [], notes: number[] = []) =>
    Array.from({ length: count }, (_, n) => ({
      n,
      kind: writes.includes(n) ? "write" : ["read", "write", "scan"][n % 3],
      note: notes.includes(n) ? `note ${n} changed` : `note ${n}`,
    }))
  const lines = (rows: object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("")
  const doc = (extra: number) =>
    JSON.stringify({ settings: { theme: { dark: true } }, items: { a: 1, b: 2 }, extra })
  write({
    "after/rows.jsonl": lines(records(1000)),
    "after/list.json": JSON.stringify(records(30)),
    "after/doc.json": doc(1),
    "after/three.jsonl": lines(records(300)),
    "after/index.md": "# Index\n\n[rows](rows.jsonl)\n",
  })
  const page = await openData("after/rows.jsonl")
  const chosen = () =>
    page.$eval('.data-switch[aria-pressed="true"]:not(:has-text("Statistics"))', (choice) =>
      (choice as HTMLElement).innerText.trim(),
    )
  const rows = () =>
    page.$$eval(
      ".data-page > table:not(.data-list) > tbody > tr:not([data-follows])",
      (found) => found.length,
    )
  const shown = async () => (await cells(page, 0, 0)).length
  const bar = () =>
    page
      .$eval(".data-more-rows", (more) => ((more as HTMLElement).hidden ? "" : more.textContent))
      .catch(() => "")
  const saved = async (files: Record<string, string>) => {
    await page.$eval(".data-page", (article) => {
      ;(article as HTMLElement).dataset.before = ""
    })
    write(files)
    await page.waitForSelector(".data-page:not([data-before])")
    await page.waitForTimeout(300)
  }
  const items = () =>
    page.$$eval(".data-page > .data-tree > .data-tree", (found) =>
      found.map((item) => ({
        note: item.textContent?.includes('"note 9'),
        open: (item as HTMLDetailsElement).open,
      })),
    )
  const fresh = async (name: string) => {
    await page.goto(`${base}/after/${name}`)
    await page.waitForSelector(".data-page .data-switch")
    await page.waitForTimeout(300)
  }
  const compareByKind = async () => {
    await page.click('.outline .data-field:has(.data-field-name:text-is("kind"))')
    await page.click('.outline .data-compare-by:has-text("Compare every field by kind")')
  }
  const heads = () =>
    page.$$eval(".data-compare:not([hidden]) .data-compare-table > thead th", (cells) =>
      cells.map((cell) => (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    )
  await page.waitForSelector(".data-page > table > tbody > tr")

  await page.click(".data-page > table > tbody > tr >> nth=1")
  await saved({ "after/rows.jsonl": lines(records(1000, [], [500])) })
  assert.deepEqual(
    await page.$$eval(".data-page > table:not(.data-list) .data-record-body", (bodies) =>
      bodies.map(
        (body) =>
          (body as HTMLElement).style.width ===
          `${(body.closest("table") as HTMLTableElement).clientWidth - 2}px`,
      ),
    ),
    [true],
  )

  await page.click(".data-more-rows button")
  await waitFor(async () => (await rows()) === 400)
  await saved({ "after/rows.jsonl": lines(records(1000, [], [501])) })
  assert.equal(await rows(), 400)
  await page.click(".data-page > table > thead > tr:first-child > th >> nth=1")
  await waitFor(async () => (await cells(page, 0, 1)).slice(0, 3).join() === "read,read,read")
  assert.equal(await rows(), 200)

  await fresh("rows.jsonl")
  await panel(page, 0)
  await page.fill('.table-panel input[data-key="all"]', "note 9")
  await waitFor(async () => (await rows()) === 111)
  await page.keyboard.press("Escape")
  await page.click('.data-switch:has-text("Tree")')
  await page.click(".data-page > .data-tree > .data-tree >> nth=0 >> summary")
  await saved({ "after/rows.jsonl": lines(records(1000, [], [5])) })
  assert.equal(await chosen(), "Tree")
  await waitFor(async () => {
    const searched = await items()
    return searched.length === 111 && searched.slice(1).every(({ note }) => note)
  })
  assert.deepEqual(
    (await items()).map(({ open }) => open),
    Array.from({ length: 111 }, (_, i) => i !== 0),
  )

  await fresh("rows.jsonl")
  await panel(page, 0)
  await page.fill('.table-panel input[data-key="all"]', "note 9")
  await waitFor(async () => (await rows()) === 111)
  await page.keyboard.press("Escape")
  await saved({ "after/rows.jsonl": lines(records(1000, [], [6])) })
  await waitFor(async () => (await rows()) === 111)
  await panel(page, 0)
  await page.fill('.table-panel input[data-key="all"]', "")
  await waitFor(async () => (await rows()) === 200)
  await page.keyboard.press("Escape")
  assert.equal(await bar(), "200 of 1,000 shown Show 200 more")

  await fresh("rows.jsonl")
  const note = page
    .locator(".data-page > table:not(.data-list) > thead > tr:first-child > th")
    .nth(2)
  await note.click()
  await note.click()
  await waitFor(async () => (await cells(page, 0, 2))[0] === "note 999")
  await page.click('.data-switch:has-text("Records")')
  const listed = ".data-page table.data-list > tbody > tr"
  await waitFor(async () =>
    page.$eval(listed, (row) => /note 0(?!\d)/.test(row.textContent ?? "")).catch(() => false),
  )
  await page.click(`${listed} >> nth=0`)
  await page.waitForSelector(`${listed}.data-record`)
  await saved({ "after/rows.jsonl": lines(records(1000, [], [8])) })
  await waitFor(async () =>
    page
      .$$eval(listed, (found) =>
        found
          .slice(0, 2)
          .map(
            (row) => row.className === "data-record" || /note 0(?!\d)/.test(row.textContent ?? ""),
          ),
      )
      .then((first) => first.join() === "true,true"),
  )
  await page.click('.data-switch:has-text("Table")')
  await waitFor(async () => (await cells(page, 0, 2))[0] === "note 999")
  assert.equal(await note.getAttribute("aria-sort"), "descending")

  await fresh("rows.jsonl")
  await note.click()
  await note.click()
  await waitFor(async () => (await cells(page, 0, 2))[0] === "note 999")
  await page.click(".data-more-rows button")
  await waitFor(async () => (await rows()) === 400)
  await page.route(/sort=/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue().catch(() => {})
  })
  await saved({ "after/rows.jsonl": lines(records(1000, [], [9])) })
  await saved({ "after/rows.jsonl": lines(records(1000, [], [10])) })
  await page.waitForTimeout(4000)
  assert.equal(await rows(), 400)
  assert.equal((await cells(page, 0, 2))[0], "note 999")
  await page.unroute(/sort=/)

  await fresh("three.jsonl")
  await page.click(".data-more-rows button")
  await waitFor(async () => (await shown()) === 300)
  await saved({ "after/three.jsonl": lines(records(300, [], [5])) })
  assert.equal(await shown(), 300)

  await fresh("rows.jsonl")
  await page.click('.data-switch:has-text("Records")')
  await page.hover(".data-page table.data-list")
  await page.click(".table-control")
  await page.fill('.table-panel input[aria-label="Filter rows"]', "note 9")
  await waitFor(async () => (await page.$$eval(listed, (found) => found.length)) === 111)
  await page.keyboard.press("Escape")
  await saved({ "after/rows.jsonl": lines(records(1000, [], [11])) })
  await page.click('.data-switch:has-text("Table")')
  await waitFor(async () => (await rows()) === 200)
  assert.equal((await cells(page, 0, 0))[0], "0")

  await fresh("rows.jsonl")
  for (const count of [400, 600]) {
    await page.click(".data-more-rows button")
    await waitFor(async () => (await rows()) === count)
  }
  await saved({ "after/rows.jsonl": "" })
  await saved({ "after/rows.jsonl": lines(records(1000, [], [12])) })
  await waitFor(async () => (await rows()) === 600)

  await fresh("rows.jsonl")
  await page.route(/compare=/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue().catch(() => {})
  })
  await compareByKind()
  await page.waitForSelector(".data-compare")
  await saved({ "after/rows.jsonl": lines(records(1000, [0])) })
  await saved({ "after/rows.jsonl": lines(records(1000, [0, 3])) })
  await waitFor(async () => (await heads()).includes("write 335 records"))
  await page.waitForTimeout(2000)
  assert.ok((await heads()).includes("write 335 records"))
  await page.click('.data-switch:has-text("Table")')
  assert.equal(await page.$$eval(".data-compare:not([hidden])", (shown) => shown.length), 0)
  await page.unroute(/compare=/)

  await fresh("rows.jsonl")
  await page.setViewportSize({ width: 900, height: 300 })
  await compareByKind()
  await page.waitForSelector(".data-compare-table")
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(300)
  const scrolled = await page.evaluate(() => scrollY)
  assert.ok(scrolled > 100, String(scrolled))
  await saved({ "after/rows.jsonl": lines(records(1000)) })
  await page.waitForTimeout(1000)
  assert.equal(await page.evaluate(() => scrollY), scrolled)
  await page.setViewportSize({ width: 1400, height: 800 })
  await page.route(/compare=/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue().catch(() => {})
  })

  await fresh("rows.jsonl")
  await compareByKind()
  await saved({ "after/rows.jsonl": lines(records(1000)) })
  await waitFor(async () => (await chosen().catch(() => "")) === "Compare")
  assert.ok((await heads()).includes("write 333 records"))
  await page.unroute(/compare=/)

  await fresh("list.json")
  await page.click('.data-switch:has-text("Records")')
  await page.click(".data-page table.data-list > tbody > tr >> nth=2")
  await page.waitForSelector(".data-page table.data-list > tbody > tr.data-record")
  await saved({ "after/list.json": JSON.stringify(records(30, [], [5])) })
  assert.equal(await chosen(), "Records")
  assert.deepEqual(
    await page.$$eval(".data-page table.data-list > tbody > tr.data-record", (open) =>
      open.map((row) => row.previousElementSibling?.textContent?.includes("note 2")),
    ),
    [true],
  )

  await page.goto(`${base}/after/doc.json`)
  await page.waitForSelector(".data-page > .data-tree")
  await page.waitForTimeout(300)
  const branch = (key: string) => `.data-page > .data-tree > details.data-tree[data-key="${key}"]`
  await page.click(`${branch("settings")} > details.data-tree > summary`)
  await page.click(`${branch("items")} > summary`)
  await saved({ "after/doc.json": doc(2) })
  const kept = () =>
    page.$$eval(`${branch("settings")} > details.data-tree, ${branch("items")}`, (found) =>
      found.map((details) => (details as HTMLDetailsElement).open),
    )
  assert.deepEqual(await kept(), [true, false])
  await saved({ "after/doc.json": "{" })
  await saved({ "after/doc.json": doc(3) })
  assert.deepEqual(await kept(), [true, false])
  await page.click(".data-page > details.data-tree > summary")
  await saved({ "after/doc.json": doc(4) })
  assert.equal(
    await page.$eval(".data-page > details.data-tree", (root) => (root as HTMLDetailsElement).open),
    false,
  )

  await page.goto(`${base}/after/index.md`)
  await page.waitForSelector(".markdown-body a")
  await page.waitForTimeout(300)
  const counts: string[] = []
  page.on("request", (request) => {
    if (/after\/rows\.jsonl\?data.*&stats/.test(request.url())) {
      counts.push(request.url())
    }
  })
  await page.click('.markdown-body a:has-text("rows")')
  await page.waitForSelector(".data-page > table > tbody > tr")
  await page.waitForTimeout(1500)
  assert.equal(counts.length, 1)
  await page.close()
})

test("What sets them apart, Fixed by the filter, Follow a finding, Few records, Compare by a field, As a query, Theme: a filter shows what sets its records apart, and every field compares by another", async () => {
  const records = Array.from({ length: 6000 }, (_, i) => {
    const outcome = i % 10 < 3 ? "late" : "on time"
    return {
      outcome,
      logged: i % 50 === 0 ? (outcome === "late" ? "on time" : "late") : outcome,
      flagged: outcome === "late" ? i % 5 < 2 : i % 20 === 3,
      delay: outcome === "late" ? 20 + (i % 61) : i % 4 === 0 ? 25 + (i % 40) : 0,
      size: (outcome === "late" ? i % 20 < 9 : i % 25 < 16) ? "small" : "large",
      berth: `B${i % 6}`,
      berth_name: `berth ${i % 6}`,
      wait: (i % 6) * 10 + (i % 97),
      note: `note ${i}`,
    }
  })
  write({ "compared/runs.jsonl": records.map((record) => `${JSON.stringify(record)}\n`).join("") })
  const filtered = (field: string, eq: string) =>
    `${base}/compared/runs.jsonl?filter=${encodeURIComponent(JSON.stringify({ filter: { field, eq }, label: `${field} = ${eq}` }))}`
  const page = await context.newPage()
  const text = (selector: string) =>
    page.$eval(selector, (found) => (found as HTMLElement).innerText)

  await page.goto(filtered("outcome", "late"))
  await page.waitForSelector(".data-findings")
  assert.equal(
    await page.$eval(".data-findings-title", (title) => title.firstChild?.textContent),
    "What sets the 1,800 records where outcome = late apart from the other 4,200",
  )
  assert.deepEqual(
    await page.$$eval(".data-legend .data-swatch", (marks) => marks.map((mark) => mark.className)),
    ["data-swatch data-here", "data-swatch data-elsewhere"],
  )
  const findings = await page.$$eval(".data-finding", (lines) =>
    lines.map((line) => (line as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
  )
  assert.ok(findings.length >= 3 && findings.length <= 6, findings.join(" | "))
  assert.ok(findings.includes("delay median 50 here, 0 elsewhere"), findings.join(" | "))
  assert.ok(
    findings.some((finding) => /^flagged true \d+% here, [\d.]+% elsewhere$/.test(finding)),
    findings.join(" | "),
  )
  assert.equal(
    await page.$$eval(".data-finding svg.data-mirrored", (charts) => charts.length > 0),
    true,
  )
  assert.equal(await page.$$eval(".data-finding .data-paired", (bars) => bars.length > 0), true)
  assert.equal(
    await text(".data-findings .data-findings-note"),
    "Fixed by the filter, so left out: logged",
  )
  assert.ok(!findings.some((finding) => finding.startsWith("logged")))

  await page.click('.data-finding:has-text("flagged")')
  await waitFor(async () =>
    (await page.$eval(".data-filter", (bar) => bar.textContent ?? "").catch(() => "")).startsWith(
      "flagged = true · ",
    ),
  )
  assert.match(await page.evaluate(() => location.search), /flagged/)

  await page.goto(filtered("note", "note 7"))
  await waitFor(async () =>
    (await page.$eval(".data-filter", (bar) => bar.textContent ?? "").catch(() => "")).includes(
      "1 of 6,000 records",
    ),
  )
  await page.waitForTimeout(500)
  assert.equal(await page.$$eval(".data-findings", (cards) => cards.length), 0)

  await page.goto(`${base}/compared/runs.jsonl`)
  await page.waitForSelector(".outline .data-field")
  await page.click('.outline .data-field:has(.data-field-name:text-is("berth"))')
  await page.click('.outline .data-compare-by:has-text("Compare every field by berth")')
  await page.waitForSelector(".data-compare")
  assert.deepEqual(
    await page.$$eval(".data-compare-table > thead th", (cells) =>
      cells.map((cell) => (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    ),
    ["berth", ...["B0", "B1", "B2", "B3", "B4", "B5"].map((berth) => `${berth} 1,000 records`)],
  )
  assert.equal(
    await text('.data-switch[aria-pressed="true"]:not(:has-text("Statistics"))'),
    "Compare",
  )
  assert.equal(
    await text(".data-compare > .data-findings-note"),
    "Fixed by berth, so left out: berth_name",
  )
  const rows = await page.$$eval(".data-compare-table > tbody > tr", (lines) =>
    lines.map((line) =>
      [...(line as HTMLTableRowElement).cells].map((cell) =>
        (cell as HTMLElement).innerText.split("\n")[0].trim(),
      ),
    ),
  )
  const wait = rows.find(([label]) => label === "wait median")
  assert.ok(wait, JSON.stringify(rows))

  const query = await text(".data-compare pre code")
  assert.match(query, /^select berth, count\(\*\) as records,/)
  assert.equal(await page.locator(".data-compare pre .code-copy").count(), 1)
  write({ "compared/query.md": `# Query\n\n\`\`\`sql query\n${query}\n\`\`\`\n` })
  await page.goto(`${base}/compared/query.md`)
  await page.waitForSelector(".query-result table")
  const result = await page.$$eval(".query-result table > tbody > tr", (lines) =>
    lines.map((line) =>
      [...(line as HTMLTableRowElement).cells].map((cell) => cell.textContent ?? ""),
    ),
  )
  const header = await page.$$eval(".query-result table > thead th", (cells) =>
    cells.map((cell) => cell.textContent ?? ""),
  )
  assert.deepEqual(
    result.map((row) => [row[0], row[1]]),
    ["B0", "B1", "B2", "B3", "B4", "B5"].map((berth) => [berth, "1000"]),
  )
  assert.deepEqual(
    result.map((row) => row[header.indexOf("median wait")]),
    wait?.slice(1),
  )

  await page.goto(filtered("outcome", "late"))
  await page.waitForSelector(".data-findings")
  const swatch = () =>
    page.$eval(
      ".data-findings .data-swatch.data-here",
      (mark) => getComputedStyle(mark).backgroundColor,
    )
  assert.equal(await swatch(), "rgb(9, 105, 218)")
  await page.click('button[title="Switch theme"]')
  await waitFor(async () => (await swatch().catch(() => "")) === "rgb(68, 147, 248)")
  await page.click('button[title="Switch theme"]')
  await page.close()
})

test("A number of few values, Alike fields, A rare value: a comparison groups by a number and names what it leaves out", async () => {
  write({
    "grouped/runs.jsonl": Array.from({ length: 6000 }, (_, i) => {
      const outcome = i % 10 < 3 ? "late" : "on time"
      return `${JSON.stringify({
        level: 1 + (i % 5),
        shift: ["early", "day", "night"][i % 3],
        crew: `c${i % 4}`,
        load: (i % 5) * 10 + (i % 7),
        outcome,
        cause:
          outcome === "late" && i % 3 === 0
            ? "rare x"
            : ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => `common ${c}`)[i % 8],
      })}\n`
    }).join(""),
  })
  const page = await openData("grouped/runs.jsonl")
  await page.waitForSelector(".outline .data-field:has(.data-field-name:text-is('level'))")
  await page.click(".outline .data-field:has(.data-field-name:text-is('level'))")
  await page.click('.outline .data-field-detail button:has-text("Compare every field by level")')
  await page.waitForSelector(".data-compare-table")
  assert.deepEqual(
    await page.$$eval(".data-compare-table thead th", (cells) =>
      cells.slice(1).map((cell) => cell.firstChild?.textContent),
    ),
    ["1", "2", "3", "4", "5"],
  )
  assert.ok(
    (
      await page.$$eval(".data-compare > .data-findings-note", (notes) =>
        notes.map((note) => note.textContent),
      )
    ).includes("Spread alike by level, so left out: shift, crew"),
  )

  await page.goto(
    `${base}/grouped/runs.jsonl?filter=${encodeURIComponent(JSON.stringify({ filter: { field: "outcome", eq: "late" }, label: "outcome = late" }))}`,
  )
  await page.waitForSelector(".data-findings .data-finding")
  assert.ok(
    await page.isVisible(
      '.data-findings .data-finding:has(code:text-is("cause")):has-text("rare x")',
    ),
  )
  await page.close()
})

test("Toggle position, Table control position, Toggle hidden, Pointer back, Keyboard, Backgrounds: controls sit clear of their block's edge", async () => {
  const wide = `| ${Array.from({ length: 12 }, (_, i) => `column number ${i}`).join(" | ")} |`
  write({
    "edges/tables.md": [
      "# Edges",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      `${wide}\n|${"---|".repeat(12)}\n|${" x |".repeat(12)}`,
    ].join("\n\n"),
    "edges/n.csv": "n\n1\n",
  })
  const page = await open("edges/tables.md")
  const placed = (table: number) =>
    page.evaluate((at) => {
      const control = (
        document.querySelector(".table-control") as HTMLElement
      ).getBoundingClientRect()
      const box = document.querySelectorAll(".markdown-body table")[at].getBoundingClientRect()
      return control.top - box.top
    }, table)
  const toggle = () =>
    page.$eval(".tree-data", (button) => {
      const style = getComputedStyle(button)
      const box = button.getBoundingClientRect()
      const tree = (document.querySelector(".tree") as Element).getBoundingClientRect()
      const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return [
        box.top - tree.top,
        style.opacity,
        under === button || button.contains(under),
        button.getAttribute("aria-pressed"),
      ]
    })
  const away = () => page.mouse.move(700, 400)
  const seen: Record<string, unknown> = {}

  await page.focus(".markdown-body table >> nth=0 >> th >> nth=0")
  await away()
  seen.headerFocused = await page.isVisible(".table-control")
  await page.click(".markdown-body table >> nth=0 >> th >> nth=1")
  await away()
  seen.headerClicked = await page.isVisible(".table-control")
  await page.hover(".markdown-body table >> nth=0")
  seen.narrow = await placed(0)
  await page.hover(".markdown-body table >> nth=1")
  seen.wide = await placed(1)
  seen.controlBackground = await page.$eval(
    ".table-control",
    (control) => getComputedStyle(control).backgroundColor,
  )

  await page.hover(".tree")
  seen.pointed = await toggle()
  await away()
  seen.away = await toggle()
  await page.hover(".tree")
  await page.click(".tree-data")
  await waitFor(async () => (await treeNames(page, "edges")).includes("n.csv"))
  await away()
  seen.awayShown = [...(await toggle()), (await treeNames(page, "edges")).includes("n.csv")]
  await page.hover(".tree")
  seen.back = await toggle()
  seen.toggleBackground = await page.$eval(
    ".tree-data",
    (button) => getComputedStyle(button).backgroundColor,
  )
  await page.click(".tree-data")
  await waitFor(async () => !(await treeNames(page, "edges")).includes("n.csv"))
  await away()
  await page.evaluate(() => {
    const focusable = [
      ...document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]"),
    ].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    const at = focusable.indexOf(document.querySelector(".tree-data") as HTMLElement)
    focusable[at + 1].dataset.next = ""
  })
  await page.focus("[data-next]")
  await page.keyboard.press("Shift+Tab")
  seen.keyboard = [await page.evaluate(() => document.activeElement?.className), await toggle()]
  await page.click('button[title="Switch theme"]')
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
  await page.hover(".markdown-body table >> nth=0")
  await page.hover(".tree")
  seen.dark = await page.evaluate(() =>
    [".table-control", ".tree-data"].map(
      (selector) => getComputedStyle(document.querySelector(selector) as Element).backgroundColor,
    ),
  )
  await page.click('button[title="Switch theme"]')
  await page.close()

  assert.deepEqual(seen, {
    headerFocused: true,
    headerClicked: false,
    narrow: 1,
    wide: 1,
    controlBackground: "rgb(255, 255, 255)",
    pointed: [9, "1", true, "false"],
    away: [9, "0", false, "false"],
    awayShown: [9, "0", false, "true", true],
    back: [9, "1", true, "true"],
    toggleBackground: "rgb(255, 255, 255)",
    keyboard: ["icon-button tree-data", [9, "1", true, "false"]],
    dark: ["rgb(26, 26, 26)", "rgb(26, 26, 26)"],
  })
})

test("Folder untouched: opening every kind of data file writes nothing into the folder", async () => {
  await writeData()
  const before = snapshotOf(path.join(root, "store"))
  const page = await openData("store/visits.csv")

  for (const file of [
    "store/shop.sqlite",
    "store/shop.duckdb",
    "store/visits.parquet",
    "store/kit.json",
    "store/people.yaml",
    "store/visits.jsonl",
    "store/shop.sqlite?table=orders",
  ]) {
    await page.goto(`${base}/${file}`)
    await page.waitForSelector(".markdown-body h1")
  }

  assert.deepEqual(snapshotOf(path.join(root, "store")), before)
  await page.close()
})

test("Merged cells: rows a cell spans down sort together, and a merged header narrows as its columns hide", async () => {
  write({
    "spans/table.md": [
      "# Spans",
      "",
      '<table><thead><tr><th colspan="2">Who</th><th>Score</th></tr></thead><tbody>',
      '<tr><td rowspan="2">Red</td><td>b</td><td>2</td></tr>',
      "<tr><td>c</td><td>9</td></tr>",
      "<tr><td>Blue</td><td>a</td><td>5</td></tr>",
      "</tbody></table>",
    ].join("\n"),
  })

  const page = await open("spans/table.md")
  await page.click("th:text-is('Score')")
  await page.click("th:text-is('Score')")
  assert.deepEqual(await cells(page, 0, 0), ["Blue", "Red", "c"], "Red's two rows stay together")
  await panel(page, 0)
  await page.uncheck(".table-panel label:has-text('Who') >> nth=1 >> input")
  assert.deepEqual(
    await page.$eval("th:text-is('Who')", (cell) => [
      (cell as HTMLTableCellElement).colSpan,
      (cell as HTMLElement).hidden,
    ]),
    [1, false],
    "the merged header spans the one column still shown",
  )
  assert.deepEqual(
    await page.$$eval(".markdown-body td", (all) =>
      all.flatMap((cell) => ((cell as HTMLElement).hidden ? [cell.textContent] : [])),
    ),
    ["a", "b", "c"],
  )
  await page.close()
})

test("Rarer inputs: merged cells, a save under the filter panel, long lists, chart links and long view addresses", async () => {
  write({
    "rare/merged.md": [
      "# Merged",
      "",
      '<table><thead><tr><th colspan="2">Name</th><th>Score</th></tr></thead><tbody>',
      "<tr><td>b</td><td>x</td><td>2</td></tr>",
      '<tr><td colspan="2">a</td><td>10</td></tr>',
      "<tr><td>c</td><td>y</td><td>1</td></tr>",
      "</tbody></table>",
    ].join("\n"),
    "rare/save.md": "# Save\n\n| City | Visits |\n|---|---|\n| Oslo | 3 |\n| Lima | 4 |\n",
    "rare/big.json": JSON.stringify(Array.from({ length: 6000 }, (_, id) => ({ id }))),
    "rare/chart.md": [
      "# Chart",
      "",
      "```vega-lite",
      '{"data": {"values": [{"a": 1, "u": "javascript:alert(1)"}]}, "mark": "bar",',
      ' "encoding": {"x": {"field": "a", "type": "quantitative"}, "href": {"field": "u"}}}',
      "```",
    ].join("\n"),
  })

  const merged = await open("rare/merged.md")
  await merged.click("th:text-is('Score')")
  assert.deepEqual(await cells(merged, 0, 0), ["c", "b", "a"], "sorted by the score column")
  await panel(merged, 0)
  await merged.uncheck(".table-panel label:has-text('Score') input")
  assert.deepEqual(
    await merged.$$eval(".markdown-body td", (all) =>
      all.flatMap((cell) => ((cell as HTMLElement).hidden ? [cell.textContent] : [])),
    ),
    ["1", "2", "10"],
    "only the score column hides",
  )
  await merged.close()

  const save = await open("rare/save.md")
  await panel(save, 0)
  const field = await save.$(".table-panel input[data-key='all']")
  await save.keyboard.type("o")
  assert.equal(
    await save.evaluate((held) => document.activeElement === held, field),
    true,
    "typing keeps the field it types into",
  )
  write({
    "rare/save.md":
      "# Save\n\n| City | Visits |\n|---|---|\n| Oslo | 3 |\n| Lima | 4 |\n| Rome | 5 |\n",
  })
  await save.waitForFunction(
    () => document.querySelectorAll(".markdown-body tbody tr").length === 3,
  )
  assert.equal(await save.isVisible(".table-panel"), true, "the panel stays open")
  assert.equal(
    await save.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value),
    "o",
    "the filter keeps focus and text",
  )
  await save.close()

  const big = await context.newPage()
  await big.goto(`${base}/rare/big.json`)
  await big.click(".data-switch:text-is('Table')")
  await big.waitForSelector(".markdown-body tbody tr")
  assert.equal(await big.locator(".markdown-body tbody tr").count(), 5000)
  assert.match((await big.textContent(".markdown-body")) ?? "", /The first 5,000 of 6,000 records/)
  await big.close()

  const errors: string[] = []
  const chart = await context.newPage()
  chart.on("pageerror", (error) => errors.push(error.message))
  await chart.goto(`${base}/rare/chart.md`)
  await chart.waitForSelector(".embed-chart .chart svg")
  await chart.waitForTimeout(500)
  assert.deepEqual(errors, [], "a link the chart refuses throws nothing")
  await chart.close()

  const view = Buffer.from(
    JSON.stringify({ "rare/save.md~@0": { filter: "x".repeat(21_000) } }),
  ).toString("base64url")
  assert.equal((await fetch(`${base}/rare/save.md?view=${view}`)).status, 200)
})

async function treeNames(page: Page, folder: string): Promise<string[]> {
  return page.$$eval(`.tree li[data-path="${folder}"] > ul > li`, (items) =>
    items.map((item) => item.textContent ?? ""),
  )
}

const PIN_TOP = 48
const BORDER_DARKNESS = 765 - 209 - 217 - 224
const RUNS = Array.from({ length: 120 }, (_, i) => `| run-${i + 1} | ${(i * 7) % 120} |`)

function pinnedAt(top: number): boolean {
  return top > PIN_TOP - 0.01 && top < PIN_TOP + 1
}

function pinOf(page: Page, table: number) {
  return page.evaluate((at) => {
    const element = document.querySelectorAll<HTMLTableElement>(".markdown-body table")[at]
    const head = (element.tHead as HTMLTableSectionElement).getBoundingClientRect()
    const rows = [...element.tBodies[0].rows].filter((row) => !row.hidden)
    const cell = element.tHead?.rows[0].cells[0] as HTMLElement
    return {
      top: head.top,
      bottom: head.bottom,
      last: (rows.at(-1) as HTMLTableRowElement).getBoundingClientRect().bottom,
      transform: getComputedStyle(element.tHead as Element).transform,
      background: (() => {
        const canvas = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D
        canvas.fillStyle = getComputedStyle(cell).backgroundColor
        canvas.fillRect(0, 0, 1, 1)
        return [...canvas.getImageData(0, 0, 1, 1).data].join(",")
      })(),
      gap: ((layer) => `${layer.content} ${layer.opacity} ${layer.height}`)(
        getComputedStyle(element.tHead as Element, "::before"),
      ),
    }
  }, table)
}

function covered(page: Page, table: number): Promise<boolean[]> {
  return page.evaluate(
    ([at, line]) =>
      [
        ...(document.querySelectorAll<HTMLTableElement>(".markdown-body table")[at].tHead?.rows[0]
          .cells ?? []),
      ].map((cell) => {
        const box = cell.getBoundingClientRect()
        return !!document.elementFromPoint(box.left + box.width / 2, line + 5)?.closest("thead")
      }),
    [table, PIN_TOP],
  )
}

async function gapText(page: Page, table: number): Promise<number> {
  const box = await page.evaluate((at) => {
    const found = document.querySelectorAll(".markdown-body table")[at].getBoundingClientRect()
    return { x: found.left + 2, width: found.width - 4 }
  }, table)
  const pixels = await pixelsOf(page, {
    x: box.x,
    y: 44,
    width: box.width,
    height: PIN_TOP + 4 - 44,
  })

  return pixels.filter(([r, g, b]) => r + g + b < 600).length
}

async function edgesAtButton(page: Page, table: number) {
  const cell = await page.evaluate((at) => {
    const table = document.querySelectorAll(".markdown-body table")[at]
    const box = (table.querySelector("thead th") as HTMLElement).getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, table)
  await page.mouse.move(cell.x, cell.y)
  await page.waitForSelector(".table-control:not([hidden])")
  const box = await page.evaluate((at) => {
    const control = (
      document.querySelector(".table-control") as HTMLElement
    ).getBoundingClientRect()
    const table = document.querySelectorAll(".markdown-body table")[at]
    const head = (table.querySelector("thead") as HTMLElement).getBoundingClientRect()
    return {
      x: Math.floor(control.left) + 2,
      top: Math.floor(head.top) - 2,
      height: Math.ceil(head.height) + 4,
      control: [control.top, control.bottom],
    }
  }, table)
  const column = await pixelsOf(page, { x: box.x, y: box.top, width: 1, height: box.height })
  const lines = column.flatMap(([r, g, b], row) => {
    const darkness = 765 - r - g - b
    return darkness > BORDER_DARKNESS * 0.8 && darkness < BORDER_DARKNESS * 2 ? [box.top + row] : []
  })

  return { lines, control: box.control }
}

async function pixelsOf(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<number[][]> {
  const shot = await page.screenshot({ clip })

  return page.evaluate(async (encoded) => {
    const image = new Image()
    image.src = `data:image/png;base64,${encoded}`
    await image.decode()
    const canvas = document.createElement("canvas")
    ;[canvas.width, canvas.height] = [image.width, image.height]
    const context = canvas.getContext("2d") as CanvasRenderingContext2D
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, image.width, image.height).data
    return Array.from({ length: data.length / 4 }, (_, i) => [
      data[i * 4],
      data[i * 4 + 1],
      data[i * 4 + 2],
    ])
  }, shot.toString("base64"))
}

async function scrollPast(page: Page, table: number, past: number): Promise<void> {
  await page.evaluate(
    ([at, by, line]) => {
      const box = document.querySelectorAll(".markdown-body table")[at].getBoundingClientRect()
      scrollTo(0, Math.round(scrollY + box.top - line + by))
    },
    [table, past, PIN_TOP],
  )
  await page.waitForTimeout(150)
}

test("Pinned, Covers the rows, Leaves with its table, Back up, Sideways, No header, Layout: a long table's header stays just below the toolbar while its rows pass beneath", async () => {
  const wide = Array.from({ length: 30 }, (_, i) => `column ${i}`)
  write({
    "pinned/long.md": [
      "---\ntitle: Pinned\n---",
      "# Pinned",
      "Above.",
      `| Run | Value | Power |\n|---|---|---|\n${RUNS.map((row, i) => `${row} $x^{${i}}$ |`).join("\n")}`,
      Array.from({ length: 60 }, (_, i) => `| loose ${i} | ${i} |`).join("\n"),
      `| ${wide.join(" | ")} |\n|${"---|".repeat(30)}\n${Array.from({ length: 60 }, (_, r) => `| ${wide.map((_, c) => `r${r}c${c}`).join(" | ")} |`).join("\n")}`,
      "<table><tr><td><table><thead><tr><th>Inner</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table></td></tr></table>",
      "Words fill the page. ".repeat(600),
    ].join("\n\n"),
  })
  const page = await open("pinned/long.md")
  const tables = await page.$$eval(".markdown-body table", (found) =>
    found.map((table) => [table.className, !!(table as HTMLTableElement).tHead]),
  )
  assert.deepEqual(tables, [
    ["frontmatter", false],
    ["viewed", true],
    ["", false],
    ["", true],
    ["", false],
    ["", true],
  ])

  const resting = await pinOf(page, 1)
  assert.equal(resting.transform, "none")
  assert.ok(resting.top > PIN_TOP, `${resting.top}`)
  assert.equal(resting.background, "0,0,0,0")

  await scrollPast(page, 1, 400)
  const pinned = await pinOf(page, 1)
  assert.ok(pinnedAt(pinned.top), `pinned at ${pinned.top}`)
  assert.equal(pinned.background, "255,255,255,255")
  assert.equal(pinned.gap, '"" 1 6px')
  assert.deepEqual(
    await covered(page, 1),
    [true, true, true],
    "the header covers the rows, math too",
  )
  const leaks: string[] = []

  for (let past = 380; past <= 440; past++) {
    await page.evaluate(
      ([line, by]) => {
        const box = document.querySelectorAll(".markdown-body table")[1].getBoundingClientRect()
        scrollTo(0, Math.round(scrollY + box.top - line + by))
      },
      [PIN_TOP, past],
    )
    await page.waitForTimeout(30)
    const dark = await gapText(page, 1)

    if (dark > 0) {
      leaks.push(`${past}: ${dark}`)
    }
  }

  assert.deepEqual(leaks, [], "no row shows between the toolbar and the header's text")
  await page.emulateMedia({ media: "print" })
  assert.equal((await pinOf(page, 1)).transform, "none", "printed, the header stays in place")
  await page.emulateMedia({ media: "screen" })
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))
  assert.equal((await pinOf(page, 1)).background, "26,26,26,255")
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))

  await page.evaluate((line) => {
    const rows = [
      ...document.querySelectorAll<HTMLTableElement>(".markdown-body table")[1].tBodies[0].rows,
    ].filter((row) => !row.hidden)
    scrollTo(0, scrollY + (rows.at(-1) as HTMLElement).getBoundingClientRect().bottom - line + 10)
  }, PIN_TOP)
  await page.waitForTimeout(150)
  const leaving = await pinOf(page, 1)
  assert.ok(Math.abs(leaving.bottom - leaving.last) < 0.6, `${leaving.bottom} ${leaving.last}`)
  assert.ok(leaving.top < PIN_TOP)

  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(150)
  assert.deepEqual(await pinOf(page, 1), resting)
  assert.equal(
    await page.$eval(
      ".markdown-body table >> nth=2",
      (table) => table.getAnimations({ subtree: true }).length,
    ),
    0,
  )
  assert.equal(
    await page.$eval(
      ".markdown-body table >> nth=5",
      (table) => table.getAnimations({ subtree: true }).length,
    ),
    0,
    "a table inside another does not pin",
  )

  const aligned = () =>
    page.evaluate(() => {
      const table = document.querySelectorAll<HTMLTableElement>(".markdown-body table")[3]
      const head = table.tHead as HTMLTableSectionElement
      const row = [...table.tBodies[0].rows].find(
        (one) => one.getBoundingClientRect().top > head.getBoundingClientRect().bottom,
      ) as HTMLTableRowElement
      return [5, 29].map((column) => {
        const [above, below] = [head.rows[0].cells[column], row.cells[column]].map((cell) =>
          cell.getBoundingClientRect(),
        )
        return Math.abs(above.left - below.left) + Math.abs(above.right - below.right)
      })
    })
  await page.evaluate(() => {
    const box = document.querySelectorAll(".markdown-body table")[3].getBoundingClientRect()
    scrollTo(0, Math.round(scrollY + box.top - 300))
  })
  await page.waitForTimeout(150)
  const atRest = await edgesAtButton(page, 3)
  await scrollPast(page, 3, 300)
  const pinnedEdges = await edgesAtButton(page, 3)
  assert.equal(atRest.lines.length, 2, JSON.stringify(atRest))
  assert.deepEqual(
    pinnedEdges.lines.map((row) => row - pinnedEdges.lines[0]),
    atRest.lines.map((row) => row - atRest.lines[0]),
    "pinned, the header is as tall as at rest",
  )
  assert.ok(
    pinnedEdges.control[0] >= pinnedEdges.lines[0] + 1 &&
      pinnedEdges.control[1] <= pinnedEdges.lines[1],
    `the button ${pinnedEdges.control} sits between the header's edges ${pinnedEdges.lines}`,
  )
  await page.$eval(".markdown-body", (body) => {
    body.style.paddingTop = "0.5px"
  })
  await scrollPast(page, 3, 300)
  const shifted = await edgesAtButton(page, 3)
  assert.deepEqual(
    shifted.lines.map((row) => row - shifted.lines[0]),
    atRest.lines.map((row) => row - atRest.lines[0]),
    "as sharp after the page above it grows by half a pixel",
  )
  await page.$eval(".markdown-body", (body) => {
    body.style.paddingTop = ""
  })
  await page.$eval(".markdown-body table >> nth=3", (table) => {
    table.scrollLeft = 600
  })
  await page.waitForTimeout(150)
  assert.ok(pinnedAt((await pinOf(page, 3)).top))
  assert.deepEqual(await aligned(), [0, 0])

  const toggles = ["Show or hide the file tree", "Show or hide the outline", "Full width"]

  for (const toggle of toggles) {
    await page.click(`button[title="${toggle}"]`)
    await page.waitForTimeout(200)
    await scrollPast(page, 3, 300)
    assert.ok(pinnedAt((await pinOf(page, 3)).top), toggle)
    assert.deepEqual(await aligned(), [0, 0], toggle)
  }

  // Each tab of the suite starts from the layout chosen last, so the next test gets it back.
  for (const toggle of toggles) {
    await page.click(`button[title="${toggle}"]`)
  }

  await page.close()
})

test("Sort from the pinned header, Sort and filter button, A folded table: a pinned header sorts, keeps its button beside it, and stays with all the rows", async () => {
  write({ "pinned/ledger.md": `${LEDGER}\n\n${"Words fill the page. ".repeat(800)}\n` })
  const page = await open("pinned/ledger.md")
  await scrollPast(page, 4, 600)
  const value = await page.$eval(".markdown-body table >> nth=4", (table) => {
    const cell = (table as HTMLTableElement).tHead?.rows[0].cells[1] as HTMLElement
    const box = cell.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
  assert.ok(Math.abs(value.y - PIN_TOP - 14) < 8, `${value.y}`)

  await page.mouse.click(value.x, value.y)
  const ascending = (await cells(page, 4, 1)).map(Number)
  assert.deepEqual(ascending.slice(0, 3), [0, 1, 2])
  assert.ok(
    await page.$eval(".markdown-body table >> nth=4 >> th >> nth=1", (th) =>
      th.classList.contains("sorted"),
    ),
  )
  await page.mouse.click(value.x, value.y)
  assert.deepEqual((await cells(page, 4, 1)).map(Number).slice(0, 3), [299, 298, 297])
  assert.ok(pinnedAt((await pinOf(page, 4)).top), "still pinned after sorting")

  await page.mouse.move(value.x, value.y + 2)
  await page.waitForSelector(".table-control:not([hidden])")
  const beside = await page.evaluate(() => {
    const control = (
      document.querySelector(".table-control") as HTMLElement
    ).getBoundingClientRect()
    const table = document.querySelectorAll(".markdown-body table")[4]
    const head = (table as HTMLTableElement).tHead?.getBoundingClientRect() as DOMRect
    return {
      top: control.top - head.top,
      left: control.left - table.getBoundingClientRect().right,
    }
  })
  assert.ok(Math.abs(beside.top - 1) < 1, `control ${beside.top} below the header's top`)
  assert.ok(beside.left >= -40 && beside.left <= 2, `control ${beside.left} from the table's edge`)
  // Clicked where it shows: a locator click first scrolls its unmoved place into view.
  const button = await page.$eval(".table-control", (control) => {
    const box = control.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
  await page.mouse.click(button.x, button.y)
  await page.waitForSelector(".table-panel:not([hidden])")
  const shown = await page.$eval(".table-panel", (panel) => panel.getBoundingClientRect().top)
  assert.ok(Math.abs(shown - PIN_TOP - 1) < 1, `panel opens at ${shown}, beside the pinned button`)
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(200)
  const moved = await page.evaluate(() =>
    [".table-panel", ".table-control"].map(
      (selector) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect().top,
    ),
  )
  assert.ok(Math.abs(moved[0] - moved[1]) < 1, `panel at ${moved[0]}, its button at ${moved[1]}`)
  assert.ok(Math.abs(moved[1] - PIN_TOP - 1) < 1, `button at ${moved[1]}`)
  await page.keyboard.press("Escape")

  await page.click('.markdown-body button:has-text("Show all 300 rows")')
  await scrollPast(page, 4, 5000)
  assert.ok(pinnedAt((await pinOf(page, 4)).top), "pinned among all the rows")
  await page.evaluate((line) => {
    const table = document.querySelectorAll<HTMLTableElement>(".markdown-body table")[4]
    const last = [...table.tBodies[0].rows].at(-1) as HTMLElement
    scrollTo(0, scrollY + last.getBoundingClientRect().bottom - line + 10)
  }, PIN_TOP)
  await page.waitForTimeout(150)
  const end = await pinOf(page, 4)
  assert.ok(Math.abs(end.bottom - end.last) < 0.6, `${end.bottom} ${end.last}`)
  await page.close()
})

test("Every table with a header, Compare, A frozen page: data pages, embeds, query results, a value's history and compared versions pin their headers; a frozen page pins to its top edge", async () => {
  const csv = `name,score\n${Array.from({ length: 90 }, (_, i) => `n${i},${i}`).join("\n")}\n`
  write({
    "pinned/many.csv": csv,
    "pinned/embeds.md": `# Embeds\n\n{table: many.csv}\n\n${"Words. ".repeat(400)}\n`,
    "pinned/query.md": `# Query\n\n\`\`\`sql query\nselect * from 'many.csv'\n\`\`\`\n\n${"Words. ".repeat(400)}\n`,
    "pinned/log.md": `# Log\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join("\n\n")}\n`,
  })
  const header = async (page: Page, selector: string) => {
    await page.waitForSelector(`${selector} thead`)
    await page.waitForTimeout(300)
    const index = await page.$$eval(
      ".markdown-body table",
      (found, wanted) => found.indexOf(document.querySelector(wanted) as HTMLTableElement),
      selector,
    )
    await scrollPast(page, index, 300)
    assert.ok((await covered(page, index)).every(Boolean), `${selector} covers its rows`)
    return (await pinOf(page, index)).top
  }

  for (const [address, selector] of [
    ["pinned/many.csv", ".markdown-body table"],
    ["pinned/embeds.md", ".embed-table table"],
    ["pinned/query.md", ".markdown-body table"],
  ]) {
    const page = await context.newPage()
    await page.goto(`${base}/${address}`)
    assert.ok(pinnedAt(await header(page, selector)), address)

    if (address === "pinned/embeds.md") {
      await page.goto(`${base}/pinned/embeds.md?history&embed=many.csv`)
      assert.ok(pinnedAt(await header(page, ".history-timeline table")), "value history")
    }

    await page.close()
  }

  const versions = async () =>
    (await (await fetch(`${base}/pinned/log.md?versions`)).json()).versions.length
  await waitFor(async () => (await versions()) >= 1)
  write({
    "pinned/log.md": `# Log\n\nChanged.\n\n${Array.from({ length: 79 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n")}\n`,
  })
  await waitFor(async () => (await versions()) >= 2)
  const compare = await context.newPage()
  await compare.goto(`${base}/pinned/log.md?history`)
  await compare.waitForSelector(".history-timeline li")
  await compare.check(".history-timeline li:nth-child(1) input")
  await compare.check(".history-timeline li:nth-child(2) input")
  await compare.click(".history-compare")
  assert.ok(pinnedAt(await header(compare, ".history-compare-table")), "compare")
  await compare.close()

  const page = await open("pinned/embeds.md")
  await page.waitForSelector(".embed-table table thead")
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button[title="Freeze this page into one HTML file"]'),
  ])
  const saved = path.join(path.dirname(root), `folio-pinned-${process.pid}.html`)
  await download.saveAs(saved)
  await page.close()
  const frozen = await context.newPage()
  await frozen.goto(`file://${saved}`)
  await frozen.waitForSelector(".markdown-body table thead")
  await frozen.waitForTimeout(300)
  await frozen.evaluate(() => {
    const box = document.querySelector(".markdown-body table")?.getBoundingClientRect() as DOMRect
    scrollTo(0, scrollY + box.top + 300)
  })
  await frozen.waitForTimeout(150)
  assert.ok(Math.abs((await pinOf(frozen, 0)).top) < 0.6, "a frozen page pins to the top edge")
  await frozen.close()
  fs.rmSync(saved)
})
