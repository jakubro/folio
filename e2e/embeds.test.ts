/** Headless Chromium run of folio's documented behaviour: embedded data, queries, view addresses and snapshots. */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  base,
  browser,
  caption,
  cells,
  context,
  LEDGER,
  landed,
  open,
  openData,
  output,
  panel,
  root,
  snapshotOf,
  sourced,
  write,
  writeData,
} from "./harness.ts"

test("Table, Part of a file, Value in a sentence, Missing data: a document embeds data where it names it", async () => {
  await writeData()
  write({
    "store/data/analysis.json":
      '{"overall":{"accuracy":0.62691131,"n":327},"arms":[{"arm":"A0","acc":0.61},{"arm":"A1","acc":0.66}]}',
    "store/report.md": [
      "# Report",
      "",
      "Accuracy was {value: data/analysis.json#overall.accuracy | .1%} over {value: /store/data/analysis.json#overall.n} questions, Oslo {value: visits.csv#0.visits}.",
      "",
      "{table: visits.csv}",
      "",
      "{table: data/analysis.json#arms}",
      "",
      "{table: shop.sqlite#orders}",
      "",
      "{table: data/absent.csv}",
      "",
      "{value: data/analysis.json#overall.missing} and after.",
      "",
      "Code stays: `{value: visits.csv#0.visits}`.",
      "",
      "## End",
    ].join("\n"),
  })
  const page = await open("store/report.md")
  await page.waitForSelector(".embed-table table")
  await page.waitForFunction(
    () => !document.querySelector(".embed-value:not(.embed-missing):empty"),
  )

  assert.equal(
    await page.$eval(".markdown-body p", (p) => p.textContent),
    "Accuracy was 62.7% over 327 questions, Oslo 1204.",
  )
  const tables = await page.$$eval(".embed-table table", (found) =>
    found.map((table) =>
      [...table.querySelectorAll("tr")].map((row) =>
        [...row.cells].map((cell) => cell.textContent),
      ),
    ),
  )
  assert.deepEqual(tables[0], [
    ["city", "visits"],
    ["Oslo", "1204"],
    ["Lima", "87"],
    ["Rome", "9"],
  ])
  assert.deepEqual(tables[1], [
    ["arm", "acc"],
    ["A0", "0.61"],
    ["A1", "0.66"],
  ])
  assert.equal(tables[2].length, 13)
  assert.match(
    await page.$eval(".embed-table.embed-missing", (e) => e.textContent ?? ""),
    /^No data file at data\/absent\.csv\.$/,
  )
  assert.match(
    await page.$eval(".embed-value.embed-missing", (e) => e.textContent ?? ""),
    /Nothing at overall\.missing/,
  )
  assert.equal(
    await page.$eval("p code", (code) => code.textContent),
    "{value: visits.csv#0.visits}",
  )
  assert.ok(await page.isVisible("#end"))

  await page.hover(".embed-table table")
  await page.click(".markdown-body .embed-table table >> nth=0 >> th >> nth=1")
  assert.deepEqual(
    await page.$$eval(".embed-table >> nth=0 >> tbody td:first-child", (cells) =>
      cells.map((cell) => cell.textContent),
    ),
    ["Rome", "Lima", "Oslo"],
  )
  await page.close()
})

test("Chart, Weight: a Vega-Lite fence draws from the data, and only a page with a chart loads chart code", async () => {
  await writeData()
  write({
    "store/plain-embed.md": "# Plain\n\n{table: visits.csv}\n",
    "store/chart.md": [
      "# Chart",
      "",
      "```vega-lite",
      "data:",
      "  url: visits.csv",
      "mark: bar",
      "encoding:",
      "  x: {field: city, type: nominal}",
      "  y: {field: visits, type: quantitative}",
      "```",
    ].join("\n"),
  })
  const page = await context.newPage()
  const bodies: Promise<number>[] = []
  const scriptBytes = async () => (await Promise.all(bodies)).reduce((sum, n) => sum + n, 0)
  page.on("response", (response) => {
    if (/\?asset=.*\.js$/.test(response.url()) && response.status() === 200) {
      bodies.push(response.body().then((body) => body.length))
    }
  })

  await page.goto(`${base}/store/plain-embed.md`)
  await page.waitForSelector(".embed-table table")
  const plain = await scriptBytes()

  await page.goto(`${base}/store/chart.md`)
  await page.waitForSelector(".embed-chart .chart svg")
  const withChart = (await scriptBytes()) - plain

  assert.ok(withChart > 500_000, `the chart page loaded ${withChart} more bytes`)
  assert.equal(
    await page.$$eval(".embed-chart .chart svg .mark-rect path", (bars) => bars.length),
    3,
  )
  assert.equal(await page.isVisible(".embed-chart pre"), false)
  assert.match(
    await page.$eval(".embed-chart .chart svg", (svg) => svg.textContent ?? ""),
    /Oslo.*Lima.*Rome|Lima.*Oslo.*Rome/s,
  )
  await page.close()
})

test("Query in a document, Across files, One query several shapes, Shared query, .sql as a page, Dependencies: queries over the folder's data", async () => {
  await writeData()
  write({
    "store/queries/busy.sql": "select city from 'visits.csv' where visits > 50 order by city\n",
    "store/queries/visits.csv": "city,visits\nOslo,1204\nLima,87\nRome,9\n",
    "store/query.md": [
      "# Query",
      "",
      "```sql query joined",
      "select v.city, o.item from 'visits.csv' v join 'shop.sqlite#orders' o on o.id = length(v.city) order by 1",
      "```",
      "",
      "```sql query top",
      "select city, visits from 'visits.csv' order by visits desc",
      "```",
      "",
      "Top: {value: #top#0.city} with {value: #top#0.visits}.",
      "",
      "{table: #top}",
      "",
      "```vega-lite",
      '{"data": {"url": "#top"}, "mark": "bar", "encoding": {"x": {"field": "city", "type": "nominal"}, "y": {"field": "visits", "type": "quantitative"}}}',
      "```",
      "",
      "{table: queries/busy.sql}",
    ].join("\n"),
    "store/other.md": "# Other\n\n{table: queries/busy.sql}\n",
  })
  const page = await open("store/query.md")
  await page.waitForSelector(".embed-chart .chart svg")
  await page.waitForFunction(() => document.querySelectorAll(".embed table").length === 4)

  const tables = await page.$$eval(".markdown-body .embed table", (found) =>
    found.map((table) =>
      [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")].map((row) =>
        [...row.cells].map((cell) => cell.textContent),
      ),
    ),
  )
  assert.deepEqual(tables[0], [
    ["Lima", "item 4"],
    ["Oslo", "item 4"],
    ["Rome", "item 4"],
  ])
  assert.deepEqual(tables[1], [
    ["Oslo", "1204"],
    ["Lima", "87"],
    ["Rome", "9"],
  ])
  assert.deepEqual(tables[2], tables[1])
  assert.deepEqual(tables[3], [["Lima"], ["Oslo"]])
  assert.equal(await page.$eval(".markdown-body > p", (p) => p.textContent), "Top: Oslo with 1204.")
  assert.equal(await page.$$eval(".embed-chart svg .mark-rect path", (bars) => bars.length), 3)
  assert.equal(await page.isVisible(".embed-query pre"), false)
  await page.click(".embed-query summary >> nth=0")
  assert.match(
    await page.$eval(".embed-query pre", (pre) => pre.textContent ?? ""),
    /^select v\.city/,
  )

  const model = await (await fetch(`${base}/store/query.md?model`)).json()
  assert.deepEqual(model.data, [
    "store/queries/busy.sql",
    "store/queries/visits.csv",
    "store/shop.sqlite",
    "store/visits.csv",
  ])

  const other = await open("store/other.md")
  await other.waitForSelector(".embed table")
  assert.deepEqual(
    await other.$$eval(".embed tbody td", (cells) => cells.map((cell) => cell.textContent)),
    ["Lima", "Oslo"],
  )
  write({
    "store/queries/busy.sql": "select city from 'visits.csv' where visits > 5000 order by city\n",
  })
  for (const shown of [page, other]) {
    await shown.reload()
    await shown.waitForSelector(".embed table")
  }
  assert.deepEqual(
    await other.$$eval(".embed tbody td", (cells) => cells.map((cell) => cell.textContent)),
    [],
  )
  await other.close()

  await page.goto(`${base}/store/queries/busy.sql`)
  await page.waitForSelector(".markdown-body table")
  assert.match(
    await page.$eval(".markdown-body pre", (pre) => pre.textContent ?? ""),
    /visits > 5000/,
  )
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^SQL · \d+ bytes · 0 rows$/,
  )
  await page.close()
})

test("Bad query, Inside the folder, Reads only: a failing, slow, huge, outside or writing query says so in place", async () => {
  await writeData()
  write({
    "store/bad.md": [
      "# Bad",
      "",
      "```sql query",
      "selec * from 'visits.csv'",
      "```",
      "",
      "```sql query",
      "select sum(hash(a.range + b.range)) from range(1000000) a, range(1000000) b",
      "```",
      "",
      "```sql query",
      "select * from range(3000000)",
      "```",
      "",
      "```sql query",
      "select * from '../../outside.csv'",
      "```",
      "",
      "```sql query",
      "select * from read_csv('https://example.com/a.csv')",
      "```",
      "",
      "```sql query",
      "copy (select 1) to 'written.csv'",
      "```",
      "",
      "## After",
    ].join("\n"),
  })
  const page = await context.newPage()
  await page.goto(`${base}/store/bad.md`)
  await page.waitForSelector("#after")
  assert.equal((await page.$$eval(".query-result", (results) => results.length)) < 6, true)

  await page.waitForFunction(() => document.querySelectorAll(".query-result").length === 6, null, {
    timeout: 30000,
  })
  const results = await page.$$eval(".embed-query > .query-result", (found) =>
    found.map((result) => result.textContent),
  )
  assert.match(results[0] ?? "", /^syntax error at or near "selec"$/)
  assert.equal(results[1], "The query ran longer than 10 s and was stopped.")
  assert.match(results[2] ?? "", /^The first 10000 rows of a longer result\./)
  assert.equal(results[3], "../../outside.csv is outside the served folder.")
  assert.equal(
    results[4],
    "Only the served folder's files can be read, not https://example.com/a.csv.",
  )
  assert.equal(
    results[5],
    "Only one SELECT statement runs in a query; PIVOT and statements that change anything do not.",
  )
  assert.equal(fs.existsSync(path.join(root, "store/written.csv")), false)
  await page.close()
})

test("Data changes, View kept, Breaks and recovers: an embed redraws when its data changes, alone, keeping its table's view", async () => {
  await writeData()
  write({
    "store/live/scores.csv": "name,score\nada,3\nbob,12\ncyd,7\n",
    "store/live/page.md": [
      "# Live",
      "",
      "Before the data.",
      "",
      "{table: scores.csv}",
      "",
      "Best is {value: scores.csv#0.name}.",
      "",
      "```sql query",
      "select count(*) as n from 'scores.csv'",
      "```",
      "",
      "```vega-lite",
      '{"data": {"url": "scores.csv"}, "mark": "bar", "encoding": {"x": {"field": "name", "type": "nominal"}, "y": {"field": "score", "type": "quantitative"}}}',
      "```",
      "",
      "After the data.",
    ].join("\n"),
  })
  const page = await open("store/live/page.md")
  await page.waitForSelector(".embed-chart .chart svg")
  await page.waitForSelector(".embed-query table")
  await page.evaluate(() => {
    for (const block of document.querySelectorAll(".markdown-body > *")) {
      ;(block as HTMLElement & { kept?: boolean }).kept = true
    }
  })
  await page.click(".embed-table table th >> nth=1")
  await panel(page, 0)
  await page.fill('.table-panel input[aria-label="Filter rows"]', "b")
  await page.keyboard.press("Escape")
  assert.deepEqual(await cells(page, 0, 0), ["bob"])

  write({ "store/live/scores.csv": "name,score\nzed,1\nbob,12\ncyd,7\nbea,30\n" })
  await page.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "zed")
  await page.waitForFunction(() => document.querySelector(".embed-query td")?.textContent === "4")
  await page.waitForFunction(
    () => document.querySelectorAll(".embed-chart svg .mark-rect path").length === 4,
  )

  assert.deepEqual(await cells(page, 0, 0), ["bob", "bea"])
  assert.match((await caption(page, 0)) ?? "", /^2 of 4 rows · sorted by score$/)
  assert.equal(
    await page.evaluate(() =>
      [...document.querySelectorAll(".markdown-body > *")].every(
        (block) => (block as HTMLElement & { kept?: boolean }).kept,
      ),
    ),
    true,
  )

  write({ "store/live/scores.csv": Buffer.from("name,score\nad\xff,3\nbob,4\n", "latin1") })
  await page.waitForSelector(".embed-query.embed-missing")
  write({ "store/live/scores.csv": "name,score\nada,3\n" })
  await page.waitForFunction(() => document.querySelector(".embed-query td")?.textContent === "1")
  await page.waitForFunction(() => document.querySelectorAll(".embed-missing").length === 0)
  assert.equal(await page.$eval(".embed-value", (value) => value.textContent), "ada")
  await page.close()
})

test("Query changes, Nothing open: a shared query's edit updates every page using it; data nobody shows runs nothing", async () => {
  await writeData()
  write({
    "store/live/count.sql": "select count(*) as n from 'scores.csv'\n",
    "store/live/scores.csv": "name,score\nada,3\nbob,12\n",
    "store/live/unread.csv": "a\n1\n",
    "store/live/one.md": "# One\n\n{value: count.sql#0.n}\n",
    "store/live/two.md": "# Two\n\n{table: count.sql}\n",
  })
  const one = await open("store/live/one.md")
  const two = await open("store/live/two.md")
  await one.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "2")
  await two.waitForSelector(".embed-table td")

  write({ "store/live/count.sql": "select count(*) * 10 as n from 'scores.csv'\n" })
  await one.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "20")
  await two.waitForFunction(() => document.querySelector(".embed-table td")?.textContent === "20")

  await new Promise((resolve) => setTimeout(resolve, 300))
  const before = output.length
  write({ "store/live/unread.csv": "a\n1\n2\n" })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.doesNotMatch(output.slice(before), /embed/)
  await one.close()
  await two.close()
})

test("Growing file, Reading position: appended rows follow without a blank moment, and the text being read stays put", async () => {
  await writeData()
  const rows = (n: number) =>
    `n,v\n${Array.from({ length: n }, (_, i) => `${i},${i * 2}`).join("\n")}\n`
  write({
    "store/live/grow.csv": rows(3),
    "store/live/grow.md": [
      "# Grow",
      "",
      "{table: grow.csv}",
      "",
      ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the reading.`).flatMap(
        (line) => [line, ""],
      ),
    ].join("\n"),
  })
  const page = await open("store/live/grow.md")
  await page.waitForSelector(".embed-table td")
  await page.evaluate(() => {
    const table = document.querySelector(".embed-table") as HTMLElement
    ;(window as { blank?: boolean }).blank = false
    new MutationObserver(() => {
      if (!table.querySelector("td")) {
        ;(window as { blank?: boolean }).blank = true
      }
    }).observe(table, { childList: true, subtree: true })
    document.querySelector(".markdown-body p:nth-of-type(40)")?.scrollIntoView()
  })
  const reading = () =>
    page.evaluate(
      () =>
        document.querySelector(".markdown-body p:nth-of-type(40)")?.getBoundingClientRect().top ??
        0,
    )
  const at = await reading()

  for (let n = 4; n <= 12; n++) {
    fs.writeFileSync(path.join(root, "store/live/grow.csv"), rows(n))
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  await page.waitForFunction(() => document.querySelectorAll(".embed-table tbody tr").length === 12)
  assert.equal(await page.evaluate(() => (window as { blank?: boolean }).blank), false)
  assert.ok(
    Math.abs((await reading()) - at) <= 1,
    `the paragraph moved from ${at} to ${await reading()}`,
  )
  await page.close()
})

test("Copy a view, With an anchor, Back and forward, Stale view: a page's table views live in its address", async () => {
  write({ "tables/views.md": `${LEDGER}\n\n## Last\n\n${"The end.\n\n".repeat(60)}` })
  const page = await open("tables/views.md")
  await sourced(page)

  await page.click(".markdown-body table >> nth=1 >> th >> nth=1")
  await panel(page, 1)
  await page.fill('.table-panel input[aria-label="Filter rows"]', "p")
  await page.click('.table-panel label:has-text("Note") input')
  await page.keyboard.press("Escape")
  await page.click('.markdown-body button:has-text("Show all 300 rows")')
  await page.waitForFunction(() => location.search.startsWith("?view="))
  const address = page.url()

  const copy = await context.newPage()
  await copy.goto(address)
  await landed(copy)
  assert.deepEqual(await cells(copy, 1, 0), ["apple", "pear"])
  assert.equal(await caption(copy, 1), "2 of 4 rows · sorted by Count · 1 hidden column")
  assert.equal((await cells(copy, 4, 0)).length, 300)

  await copy.close()

  const anchored = await context.newPage()
  await anchored.goto(`${address}#last`)
  await landed(anchored)
  assert.deepEqual(await cells(anchored, 1, 0), ["apple", "pear"])
  assert.ok(
    Math.abs(await anchored.$eval("#last", (h) => h.getBoundingClientRect().top - 44)) < 20,
    "the page lands on the heading",
  )
  await anchored.close()

  await page.click(".markdown-body table >> nth=1 >> th >> nth=0")
  await page.click(".markdown-body table >> nth=1 >> th >> nth=0")
  await page.waitForFunction(() => document.querySelector("table:nth-of-type(2) th.descending"))
  assert.deepEqual(await cells(page, 1, 0), ["pear", "apple"])
  assert.equal(await caption(page, 1), "2 of 4 rows · sorted by Item, descending · 1 hidden column")
  await page.goBack()
  await page.waitForFunction(() => !document.querySelector("table:nth-of-type(2) th.descending"))
  assert.equal(await caption(page, 1), "2 of 4 rows · sorted by Item · 1 hidden column")
  await page.goBack()
  await page.waitForFunction((before) => location.href === before, address)
  assert.equal(await caption(page, 1), "2 of 4 rows · sorted by Count · 1 hidden column")
  await page.goForward()
  await page.waitForFunction(
    () =>
      document.querySelector(".markdown-body table:nth-of-type(2) th.sorted")?.textContent ===
      "Item",
  )
  await page.close()

  write({
    "tables/views.md": `${LEDGER.replace("| Item | Count | Note |", "| Item | Amount | Note |")}\n\n## Last\n\n${"The end.\n\n".repeat(60)}`,
  })
  const stale = await context.newPage()
  await stale.goto(address)
  await landed(stale)
  await sourced(stale)
  assert.deepEqual(await cells(stale, 1, 0), ["pear", "apple"])
  assert.equal(await caption(stale, 1), "2 of 4 rows · 1 hidden column")
  await stale.close()
})

test("Stale view, Copy a view: a data page keeps its view through a new column, and a malformed address shows tables as written", async () => {
  await writeData()
  write({ "store/views.csv": "city,visits\nOslo,1204\nLima,87\nRome,9\n" })
  const page = await openData("store/views.csv")
  await page.click(".markdown-body th >> nth=1")
  await page.waitForFunction(() => location.search.startsWith("?view="))
  const address = page.url()
  await page.close()

  write({ "store/views.csv": "city,visits,country\nOslo,1204,NO\nLima,87,PE\nRome,9,IT\n" })
  const later = await context.newPage()
  await later.goto(address)
  await later.waitForSelector(".markdown-body th.sorted")
  assert.deepEqual(await cells(later, 0, 0), ["Rome", "Lima", "Oslo"])

  const errors: string[] = []
  later.on("pageerror", (error) => errors.push(error.message))
  const malformed = Buffer.from(
    JSON.stringify({ "~@0": { hidden: "city", sort: 3, columns: [1] } }),
  ).toString("base64url")
  await later.goto(`${base}/store/views.csv?view=${malformed}#visits`)
  await later.waitForSelector(".markdown-body tbody td")
  assert.deepEqual(await cells(later, 0, 0), ["Oslo", "Lima", "Rome"])
  assert.deepEqual(errors, [])
  await later.close()
})

test("Freeze, Snapshot offline, Snapshot is frozen: a page downloads as one HTML file that works with no network", async () => {
  await writeData()
  write({
    "store/frozen/scores.csv": "name,score\nada,3\nbob,12\ncyd,7\n",
    "store/frozen/dot.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
    "store/frozen/page.md": [
      "# Frozen",
      "",
      "Best is {value: scores.csv#1.name}.",
      "",
      "{table: scores.csv}",
      "",
      "```vega-lite",
      '{"data": {"url": "scores.csv"}, "mark": "bar", "encoding": {"x": {"field": "name", "type": "nominal"}, "y": {"field": "score", "type": "quantitative"}}}',
      "```",
      "",
      "```mermaid",
      "graph LR",
      "  A --> B",
      "```",
      "",
      "![dot](dot.svg)",
      "",
      "$x^2$",
    ].join("\n"),
  })
  const before = snapshotOf(path.join(root, "store/frozen"))
  const page = await open("store/frozen/page.md")
  await page.waitForSelector(".embed-chart .chart svg")
  await page.waitForSelector(".mermaid svg")
  await page.click(".embed-table th >> nth=1")
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button[title="Freeze this page into one HTML file"]'),
  ])
  const saved = path.join(os.tmpdir(), `folio-frozen-${process.pid}.html`)
  await download.saveAs(saved)
  assert.equal(download.suggestedFilename(), "page.html")
  assert.deepEqual(snapshotOf(path.join(root, "store/frozen")), before)
  write({ "store/frozen/scores.csv": "name,score\nzed,1\nyan,2\n" })
  await page.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "yan")
  await page.close()

  const offline = await browser.newContext({ offline: true })
  const requests: string[] = []
  offline.on("request", (request) => {
    if (!request.url().startsWith("file:") && !request.url().startsWith("data:")) {
      requests.push(request.url())
    }
  })
  const frozen = await offline.newPage()
  await frozen.goto(`file://${saved}`)
  await frozen.waitForSelector(".embed-chart .chart svg")

  assert.equal(await frozen.$eval(".embed-value", (value) => value.textContent), "bob")
  assert.equal(await frozen.$$eval(".embed-chart svg .mark-rect path", (bars) => bars.length), 3)
  assert.ok(await frozen.$(".mermaid svg"))
  assert.ok(await frozen.$(".katex"))
  assert.match(
    await frozen.$eval(".markdown-body img", (img) => (img as HTMLImageElement).src),
    /^data:image\/svg\+xml/,
  )
  assert.equal(
    await frozen.$eval(".markdown-body img", (img) => (img as HTMLImageElement).naturalWidth),
    8,
  )
  assert.deepEqual(await cells(frozen, 0, 0), ["ada", "cyd", "bob"])
  await frozen.click(".embed-table th >> nth=1")
  assert.deepEqual(await cells(frozen, 0, 0), ["bob", "cyd", "ada"])
  await frozen.hover(".embed-table table")
  await frozen.click(".table-control")
  await frozen.fill('.table-panel input[aria-label="Filter rows"]', "y")
  assert.deepEqual(await cells(frozen, 0, 0), ["cyd"])
  assert.equal(
    await frozen.evaluate(() => getComputedStyle(document.body).fontFamily.includes("Arimo")),
    true,
  )
  assert.deepEqual(requests, [])
  await offline.close()
  fs.rmSync(saved)
})

test("Missing data, Table: an embed inside a list or quote draws, and a chart that cannot draw says why in place", async () => {
  await writeData()
  write({
    "store/nested.md": [
      "# Nested",
      "",
      "- {table: visits.csv}",
      "",
      "> Oslo had {value: visits.csv#0.visits}.",
      "",
      "- ```sql query",
      "  select count(*) as n from 'visits.csv'",
      "  ```",
      "",
      "```vega-lite",
      '{"data": {"url": "absent.csv"}, "mark": "bar"}',
      "```",
    ].join("\n"),
  })
  const page = await open("store/nested.md")
  await page.waitForSelector("li .embed-table table")
  await page.waitForSelector("li .embed-query table")
  await page.waitForSelector(".embed-chart .chart-reason")

  assert.equal(await page.$$eval("li .embed-table tbody tr", (rows) => rows.length), 3)
  assert.equal(await page.$eval("blockquote .embed-value", (value) => value.textContent), "1204")
  assert.equal(await page.$eval("li .embed-query td", (cell) => cell.textContent), "3")
  assert.equal(
    await page.$eval(".embed-chart .chart-reason", (reason) => reason.textContent),
    "No data file at absent.csv.",
  )
  assert.equal(await page.isVisible(".embed-chart .chart-reason"), true)
  await page.close()
})

test("Bad query: a capped result says so wherever it shows, not only below its fence", async () => {
  await writeData()
  write({
    "store/capped.md": [
      "# Capped",
      "",
      "```sql query many",
      "select range as n from range(20000)",
      "```",
      "",
      "{table: #many}",
      "",
      "```vega-lite",
      '{"data": {"url": "#many"}, "mark": "tick", "encoding": {"x": {"field": "n", "type": "quantitative"}}}',
      "```",
    ].join("\n"),
  })
  const page = await open("store/capped.md")
  await page.waitForSelector(".embed-chart .chart svg")
  await page.waitForSelector(".embed-table table")

  assert.equal(
    await page.$eval(".embed-table .data-info", (note) => note.textContent),
    "The first 10000 rows of a longer result.",
  )
  assert.equal(
    await page.$eval(".embed-chart .data-info", (note) => note.textContent),
    "Drawn from the first rows of a longer result.",
  )
  await page.close()
})

test("Breaks and recovers: an embed of a file not there yet draws once the file is created, from the root or through a query", async () => {
  await writeData()
  write({
    "store/later/page.md": [
      "# Later",
      "",
      "{table: /store/later-data/rooted.csv}",
      "",
      "{value: ../later-queries/count.sql#0.n}",
    ].join("\n"),
    "store/later-queries/count.sql": "select count(*) as n from '../later-data/queried.csv'\n",
    "store/later-data/keep.txt": "a folder that exists before its data does",
  })
  const page = await open("store/later/page.md")
  await page.waitForFunction(() => document.querySelectorAll(".embed-missing").length === 2)

  write({ "store/later-data/rooted.csv": "a\n1\n2\n" })
  await page.waitForSelector(".embed-table table")
  write({ "store/later-data/queried.csv": "a\n1\n2\n3\n" })
  await page.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "3")
  await page.close()
})

test("Missing data: a chart description that refers to itself says so in place, and the page draws on", async () => {
  await writeData()
  write({
    "store/selfchart.md":
      "# Self\n\n```vega-lite\ndata: &d\n  url: visits.csv\n  again: *d\nmark: bar\n```\n\n## After\n",
  })
  const page = await open("store/selfchart.md")
  await page.waitForSelector(".embed-chart .chart-reason")

  assert.equal(
    await page.$eval(".embed-chart .chart-reason", (reason) => reason.textContent),
    "The chart description refers to itself at data.again.",
  )
  assert.ok(await page.isVisible("#after"))
  await page.close()
})

test("Data changes: markup written to look like an embed is left alone, and the page settles", async () => {
  await writeData()
  write({
    "store/forged.md":
      '# Forged\n\n<span class="embed embed-value" data-embed="value" data-ref="visits.csv#0.visits">x</span> and <div class="embed">y</div>\n',
  })
  const page = await context.newPage()
  const asked: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("?embed")) {
      asked.push(request.url())
    }
  })
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (String(frame.payload).includes('"subscribe"')) {
        asked.push("subscribe")
      }
    }),
  )
  await page.goto(`${base}/store/forged.md`)
  await landed(page)
  await page.waitForTimeout(1500)

  assert.ok(asked.filter((entry) => entry === "subscribe").length <= 3, `${asked.length} requests`)
  assert.deepEqual(
    asked.filter((entry) => entry !== "subscribe"),
    [],
  )
  assert.match(await page.$eval(".markdown-body", (body) => body.textContent ?? ""), /x and\s*y/)
  await page.close()
})

test("One save, one read: each embed asks for its query once per save", async () => {
  write({
    "once/rows.csv": "n\n1\n2\n",
    "once/report.md": [
      "# Report",
      "",
      "```sql query counted",
      "select count(*) as n from 'rows.csv'",
      "```",
      "",
      "Counted: {value: #counted#0.n}.",
      "",
    ].join("\n"),
  })
  const page = await open("once/report.md")
  await page.waitForTimeout(1000)
  const asked: string[] = []
  page.on("response", async (response) => {
    if (response.url().includes("?embed")) {
      const reference = decodeURIComponent(response.url().split("?embed=")[1])
      // A file caught mid-write may be read at two versions; each version is read once.
      asked.push(`${reference} at ${(await response.json()).version}`)
    }
  })
  const once = async (save: () => void, value: string) => {
    asked.length = 0
    save()
    await page.waitForFunction(
      (wanted) => document.querySelector(".embed-value")?.textContent === wanted,
      value,
    )
    await page.waitForTimeout(1500)
    assert.deepEqual(
      asked.filter((reference, index) => asked.indexOf(reference) !== index),
      [],
      `asked: ${asked.join(", ")}`,
    )
  }

  await once(() => write({ "once/rows.csv": "n\n1\n2\n3\n" }), "3")
  await once(
    () =>
      write({
        "once/report.md": fs
          .readFileSync(path.join(root, "once/report.md"), "utf8")
          .replace("from 'rows.csv'", "from 'rows.csv' where n > 1"),
      }),
    "2",
  )
  await page.close()
})

test("Nested file: a JSON list of 150,000 items opens as a tree, a thousand items at a time", async () => {
  await writeData()
  write({
    "store/long.json": JSON.stringify(
      Array.from({ length: 150_000 }, (_, i) => ({ id: i, tags: ["a"] })),
    ),
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${base}/store/long.json`)
  await page.waitForSelector(".data-page > .data-tree > summary")

  assert.equal(
    await page.$eval(".data-page > .data-tree > summary", (summary) => summary.textContent),
    "[150000]",
  )
  assert.equal(
    await page.$$eval(".data-page > .data-tree > .data-tree", (items) => items.length),
    1000,
  )
  await page.click(".data-page > .data-tree > .data-more")
  assert.equal(
    await page.$$eval(".data-page > .data-tree > .data-tree", (items) => items.length),
    2000,
  )
  assert.equal(
    await page.$eval(".data-page > .data-tree > .data-more", (more) => more.textContent),
    "Show 1,000 more of 150,000",
  )
  await page.click(".data-page > .data-tree > .data-tree >> nth=1500 >> summary")
  assert.equal(
    await page.$eval(
      ".data-page > .data-tree > .data-tree >> nth=1500",
      (item) => item.textContent,
    ),
    "1500: {2}id: 1500tags: [1]",
  )
  assert.deepEqual(errors, [])
  await page.close()
})

test("Filter, Sort: columns named constructor, toString and __proto__ sort and filter like any other", async () => {
  write({
    "tables/protos.md":
      "# Protos\n\n| constructor | toString | \\_\\_proto\\_\\_ |\n|---|---|---|\n| b | 2 | y |\n| a | 1 | x |\n",
  })
  const page = await open("tables/protos.md")
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  await page.click(".markdown-body table th >> nth=0")
  assert.deepEqual(await cells(page, 0, 0), ["a", "b"])
  await panel(page, 0)
  await page.fill('.table-panel input[aria-label="Filter __proto__"]', "y")
  assert.deepEqual(await cells(page, 0, 0), ["b"])
  await page.fill('.table-panel input[aria-label="Filter toString"]', "2")
  assert.deepEqual(await cells(page, 0, 0), ["b"])
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => location.search.startsWith("?view="))

  const copy = await context.newPage()
  await copy.goto(page.url())
  await landed(copy)
  assert.deepEqual(await cells(copy, 0, 0), ["b"])
  assert.deepEqual(errors, [])
  await copy.close()
  await page.close()
})

test("Snapshot offline: a snapshot carries only images, never another file's text, and makes no request", async () => {
  await writeData()
  write({
    "store/leak/secret.md": "TOP SECRET TEXT",
    "store/leak/dot.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    "store/leak/page.md": [
      "# Leak",
      "",
      '<img src="secret.md?raw" alt="disguised">',
      "",
      '<img src="https://example.com/remote.png" alt="remote">',
      "",
      '<span style="color: red; background-image: url(https://example.com/bg.png)">styled</span>',
      "",
      "![dot](dot.svg)",
      "",
      '<img src="fake.png" alt="fake">',
      "",
      '<picture><source srcset="https://example.com/wide.png"><img src="dot.svg" alt="pictured"></picture>',
      "",
      "```mermaid",
      '%%{init: {"themeCSS": ".node rect { fill: url(https://example.com/node.svg#p); }"}}%%',
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "```vega-lite",
      JSON.stringify({
        data: {
          values: [
            { x: 1, src: "dot.svg" },
            { x: 2, src: "https://example.com/mark.png" },
          ],
        },
        layer: [
          {
            mark: { type: "image", width: 8, height: 8 },
            encoding: { x: { field: "x" }, url: { field: "src" } },
          },
          {
            mark: "bar",
            encoding: {
              x: { field: "x" },
              color: { value: "url(https://example.com/paint.svg#p)" },
            },
          },
        ],
      }),
      "```",
    ].join("\n"),
    "store/leak/fake.png": "TOP SECRET TEXT",
  })
  const page = await open("store/leak/page.md")
  await page.waitForSelector(".mermaid svg")
  await page.waitForSelector(".chart svg image")
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button[title="Freeze this page into one HTML file"]'),
  ])
  const saved = path.join(os.tmpdir(), `folio-leak-${process.pid}.html`)
  await download.saveAs(saved)
  await page.close()
  const html = fs.readFileSync(saved, "utf8")

  assert.doesNotMatch(html, /TOP SECRET TEXT|VE9QIFNFQ1JFVCBURVhU/)
  // The chart's description stays in the page as text, where an address requests nothing.
  assert.doesNotMatch(
    html.replace(/<code class="language-vega-lite">[\s\S]*?<\/code>/, ""),
    /example\.com/,
  )
  assert.doesNotMatch(html, /url\(\)/)

  const offline = await browser.newContext({ offline: true })
  const requests: string[] = []
  offline.on("request", (request) => {
    if (request.url() !== `file://${saved}` && !request.url().startsWith("data:")) {
      requests.push(request.url())
    }
  })
  const frozen = await offline.newPage()
  await frozen.goto(`file://${saved}`)
  await frozen.waitForTimeout(500)

  assert.deepEqual(
    await frozen.$$eval(".frozen-image", (images) => images.map((image) => image.textContent)),
    ["[disguised]", "[remote]", "[fake]"],
  )
  assert.deepEqual(
    await frozen.$$eval(".markdown-body img", (images) =>
      images.map((img) => (img as HTMLImageElement).src.slice(0, 19)),
    ),
    ["data:image/svg+xml;", "data:image/svg+xml;"],
  )
  assert.deepEqual(
    await frozen.$$eval(".chart svg image", (images) =>
      images.map((image) => image.getAttribute("href")?.slice(0, 19)),
    ),
    ["data:image/svg+xml;"],
  )
  assert.equal(await frozen.$$eval("picture source", (sources) => sources.length), 0)
  assert.equal(
    await frozen.$eval("span[style]", (span) => getComputedStyle(span).color),
    "rgb(255, 0, 0)",
  )
  assert.deepEqual(requests, [])
  await offline.close()
  fs.rmSync(saved)
})

test("Pattern, Live: a query over every file a pattern matches follows files added and removed", async () => {
  write({
    "patterned/page.md": [
      "# Stations",
      "",
      "{value: #all#0.n}",
      "",
      "```sql query all",
      "select count(*) as n from 'stations/*/roster.csv'",
      "```",
    ].join("\n"),
    "patterned/stations/a/roster.csv": "name\none\ntwo\n",
  })
  const page = await open("patterned/page.md")
  await page.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "2")

  write({ "patterned/stations/b/roster.csv": "name\nthree\n" })
  await page.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "3")
  fs.rmSync(path.join(root, "patterned/stations/a"), { recursive: true })
  await page.waitForFunction(() => document.querySelector(".embed-value")?.textContent === "1")
  await page.close()
})
