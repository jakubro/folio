import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, mock, test } from "node:test"
import { DuckDBInstance } from "@duckdb/node-api"
import { numberOf } from "../src/client/tableviews.ts"
import { type Comparison, Data } from "../src/server/data.ts"

const slow = new Data(
  fs.realpathSync(os.tmpdir()),
  fs.mkdtempSync(path.join(os.tmpdir(), "folio-slow-")),
  300,
)

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-data-")))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "folio-data-scratch-"))
const data = new Data(root, scratch)
const file = (name: string) => path.join(root, name)

before(async () => {
  for (const [name, content] of Object.entries({
    "rows.csv": "city,visits\nOslo,1204\nLima,87\n",
    "rows.tsv": "city\tvisits\nOslo\t1204\n",
    "rows.jsonl": '{"city":"Oslo","visits":1204,"tags":["a"]}\n{"city":"Lima","visits":87}\n',
    "ragged.csv": "city,visits\nOslo,1204\nLima,87,extra,cells\nRome\n",
    "semicolons.csv": 'city;visits;note\nOslo;1204;"a;b"\nLima;87;c\n',
    "anchors.yaml": `base: &base {image: app, restart: always}\nservices:\n${Array.from({ length: 150 }, (_, i) => `  s${i}: {<<: *base, port: ${i}}`).join("\n")}\n`,
    "broken.jsonl": '{"city":"Oslo"}\n{"city":\n{"city":"Rome"}\n',
    "tree.json": '{"name":"kit","parts":[{"id":1},{"id":2}],"big":12345678901234567890}',
    "broken.json": '{"name": "kit", "parts": [1, 2,',
    "docs.yaml": "name: first\n---\nname: second\n",
    "not-a-database.db": "plain text",
    "queries/total.sql": "select sum(visits) as total from '../rows.csv'",
    "queries/twice.sql": "select total * 2 as twice from 'total.sql'",
    "queries/loop.sql": "select * from 'loop.sql'",
    "report.md":
      "{table: rows.csv}\n\n{value: queries/twice.sql#0.twice}\n\n```sql query\nselect * from 'rows.jsonl' join 'docs.yaml' on true\n```\n\n```vega-lite\ndata: {url: tree.json#parts}\n```\n",
    "keys.json": '{"model|clean|A2.A0": {"acc": 0.5}, "list": [10, 20]}',
  })) {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true })
    fs.writeFileSync(file(name), content)
  }

  const sqlite = new DatabaseSync(file("shop.sqlite"))
  sqlite.exec(
    "pragma journal_mode = wal; create table orders (id integer, item text); insert into orders values (1, 'pen'), (2, 'ink'); create view cheap as select * from orders where id = 1;",
  )
  sqlite.close()

  const duck = await DuckDBInstance.create(file("shop.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    "create table stock as select range as id, 'item ' || range as item from range(25)",
  )
  await connection.run(
    `copy (select range as n, range * 2 as twice from range(6000)) to '${file("many.parquet")}' (format parquet)`,
  )
  connection.closeSync()
  duck.closeSync()
})

after(async () => {
  await data.close()
  await slow.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(scratch, { recursive: true, force: true })
})

test("tabular files read as their columns and rows, numbers as numbers", async () => {
  const csv = await data.page(file("rows.csv"), "v1")
  const tsv = await data.page(file("rows.tsv"), "v1")
  const jsonl = await data.page(file("rows.jsonl"), "v1")

  assert.equal(csv.format, "csv")
  assert.deepEqual(
    csv.grid?.columns.map(({ name }) => name),
    ["city", "visits"],
  )
  assert.deepEqual(csv.grid?.rows, [
    ["Oslo", 1204],
    ["Lima", 87],
  ])
  assert.equal(csv.grid?.total, 2)
  assert.equal(csv.grid?.partial, false)
  assert.equal(csv.size, 30)
  assert.deepEqual(tsv.grid?.rows, [["Oslo", 1204]])
  assert.deepEqual(jsonl.grid?.rows, [
    ["Oslo", 1204, '["a"]'],
    ["Lima", 87, null],
  ])
})

test("a long file shows a page of its first 200 rows, counts them all, and pages on from where asked", async () => {
  const page = await data.page(file("many.parquet"), "v1")
  const last = await data.page(file("many.parquet"), "v1", undefined, { offset: 5900 })
  const asked = await data.page(file("many.parquet"), "v1", undefined, { rows: 5000 })

  assert.equal(page.format, "parquet")
  assert.equal(page.grid?.rows.length, 200)
  assert.equal(page.grid?.partial, true)
  assert.equal(page.grid?.total, 6000)
  assert.equal(page.count, 6000)
  assert.deepEqual(page.grid?.rows[199], [199, 398])
  assert.equal(last.grid?.rows.length, 100)
  assert.deepEqual(last.grid?.rows[0], [5900, 11800])
  assert.equal(last.grid?.partial, false)
  assert.equal(asked.grid?.rows.length, 5000)
})

test("a malformed tabular file names all of what is wrong, the rows left out, and the rows that read", async () => {
  fs.writeFileSync(
    file("broken.csv"),
    Buffer.from("city,visits\nOslo,1204\nL\xffma,87\nRome,9\n", "latin1"),
  )
  const csv = await data.page(file("broken.csv"), "v1")
  const jsonl = await data.page(file("broken.jsonl"), "v1")

  assert.match(csv.error ?? "", /not utf-8 encoded\.\n[\s\S]*broken\.csv/)
  assert.match(csv.error ?? "", /\n\n1 row could not be read and is left out\.$/)
  assert.doesNotMatch(csv.error ?? "", new RegExp(root))
  assert.deepEqual(csv.grid?.rows, [
    ["Oslo", 1204],
    ["Rome", 9],
  ])
  assert.ok(jsonl.error)
})

test("a delimited file keeps its uneven rows and is split on the delimiter its header uses", async () => {
  const ragged = await data.page(file("ragged.csv"), "v1")
  const semicolons = await data.page(file("semicolons.csv"), "v1")

  assert.equal(ragged.error, undefined)
  assert.deepEqual(ragged.grid?.rows, [
    ["Oslo", 1204, null, null],
    ["Lima", 87, "extra", "cells"],
    ["Rome", null, null, null],
  ])
  assert.deepEqual(
    semicolons.grid?.columns.map(({ name }) => name),
    ["city", "visits", "note"],
  )
  assert.deepEqual(semicolons.grid?.rows, [
    ["Oslo", 1204, "a;b"],
    ["Lima", 87, "c"],
  ])
})

test("a broken file longer than the page keeps its first rows and counts every row it left out", async () => {
  let rows = "city,visits\n"

  for (let i = 0; i < 6000; i++) {
    rows += `c${i},${i}\n`
  }

  fs.writeFileSync(
    file("long-broken.csv"),
    Buffer.concat([Buffer.from(rows), Buffer.from("L\xffma,87\nR\xffme,9\nlast,1\n", "latin1")]),
  )
  const page = await data.page(file("long-broken.csv"), "v1")
  fs.rmSync(file("long-broken.csv"))

  assert.match(page.error ?? "", /\n\n2 rows could not be read and are left out\.$/)
  assert.equal(page.grid?.rows.length, 200)
  assert.equal(page.grid?.partial, true)
  assert.equal(page.grid?.total, 6001)
  assert.deepEqual(page.grid?.rows[0], ["c0", 0])
})

test("a CSV's delimiter is read past a comment line, or from a spreadsheet's sep= line", async () => {
  fs.writeFileSync(file("commented.csv"), "# exported; by hand; checked\ncity,visits\nOslo,1\n")
  fs.writeFileSync(file("named.csv"), "sep=;\ncity;visits\nOslo;1\n")
  const commented = await data.page(file("commented.csv"), "v1")
  const named = await data.page(file("named.csv"), "v1")
  fs.rmSync(file("commented.csv"))
  fs.rmSync(file("named.csv"))

  for (const page of [commented, named]) {
    assert.equal(page.error, undefined)
    assert.deepEqual(
      page.grid?.columns.map(({ name }) => name),
      ["city", "visits"],
    )
    assert.deepEqual(page.grid?.rows, [["Oslo", 1]])
  }
})

test("YAML that reuses anchors freely reads whole, with merge keys merged", async () => {
  const page = await data.page(file("anchors.yaml"), "v1")
  const services = (page.value as { services: Record<string, unknown> }).services

  assert.equal(page.error, undefined)
  assert.equal(Object.keys(services).length, 150)
  assert.deepEqual(services.s149, { image: "app", restart: "always", port: 149 })
})

test("nested files read as their values; a malformed one names its error beside its text", async () => {
  const json = await data.page(file("tree.json"), "v1")
  const yaml = await data.page(file("docs.yaml"), "v1")
  const broken = await data.page(file("broken.json"), "v1")

  assert.deepEqual(json.value, {
    name: "kit",
    parts: [{ id: 1 }, { id: 2 }],
    big: 12345678901234567000,
  })
  assert.deepEqual(yaml.value, [{ name: "first" }, { name: "second" }])
  assert.match(broken.error ?? "", /JSON/)
  assert.equal(broken.text, '{"name": "kit", "parts": [1, 2,')
})

test("a nested file too large to read whole shows its start", async () => {
  const name = "huge.json"
  const item = `{"key": "${"x".repeat(1000)}"},`
  fs.writeFileSync(file(name), `[${item.repeat(21 * 1024)}{}]`)

  const page = await data.page(file(name), "v1")

  assert.equal(page.value, undefined)
  assert.equal(page.text?.length, 64 * 1024)
  assert.ok(page.text?.startsWith(`[${item}`))
  assert.ok(page.size > 20 * 1024 * 1024)
})

test("a SQLite database lists its tables and views with their first rows, writing nothing beside it", async () => {
  const before = fs.readdirSync(root).sort()
  const page = await data.page(file("shop.sqlite"), "v1")
  const one = await data.page(file("shop.sqlite"), "v1", "orders")
  const missing = await data.page(file("shop.sqlite"), "v1", "absent")

  assert.equal(page.format, "sqlite")
  assert.deepEqual(
    page.tables?.map(({ name, total, columns }) => [name, total, columns.map((c) => c.name)]),
    [
      ["cheap", 1, ["id", "item"]],
      ["orders", 2, ["id", "item"]],
    ],
  )
  assert.deepEqual(one.grid?.rows, [
    [1, "pen"],
    [2, "ink"],
  ])
  assert.equal(one.table, "orders")
  assert.equal(missing.error, "No table named absent in this database.")
  assert.deepEqual(fs.readdirSync(root).sort(), before)
})

test("a DuckDB database lists its tables, the first ten rows of each, and opens one whole", async () => {
  const page = await data.page(file("shop.duckdb"), "v1")
  const one = await data.page(file("shop.duckdb"), "v1", "stock")

  assert.equal(page.format, "duckdb")
  assert.equal(page.tables?.[0].name, "stock")
  assert.equal(page.tables?.[0].total, 25)
  assert.equal(page.tables?.[0].first.rows.length, 10)
  assert.equal(page.tables?.[0].first.partial, true)
  assert.equal(one.grid?.rows.length, 25)
  assert.deepEqual(one.grid?.rows[24], [24, "item 24"])
})

test("a sort orders a whole file or table of every reader, as many rows as asked", async () => {
  const folder = await spread("sorted")

  for (const [name, table] of [
    ["many.csv"],
    ["many.tsv"],
    ["many.jsonl"],
    ["many.parquet"],
    ["many.duckdb", "spread"],
    ["many.sqlite", "spread"],
  ]) {
    const largest = await data.page(path.join(folder, name), "v1", table, {
      order: { column: 0, descending: true },
      rows: 5000,
    })
    const smallest = await data.page(path.join(folder, name), "v1", table, {
      order: { column: 0, descending: false },
      rows: 3,
    })

    assert.equal(largest.grid?.rows.length, 5000, name)
    assert.deepEqual(
      largest.grid?.rows.slice(0, 3).map((row) => row[0]),
      [6006, 6005, 6004],
      name,
    )
    assert.equal(largest.grid?.rows[4999][0], 1007, name)
    assert.deepEqual(
      smallest.grid?.rows.map((row) => row[0]),
      [0, 1, 2],
      name,
    )
  }
})

test("a page of every reader pages on from where asked and finds text in the whole file, sorted or not", async () => {
  const folder = await spread("paged")
  const words = Array.from({ length: 6007 }, (_, i) => `w${i}`)
  const ones = words.filter((word) => word.includes("1")).length

  for (const [name, table] of [
    ["many.csv"],
    ["many.tsv"],
    ["many.jsonl"],
    ["many.parquet"],
    ["many.duckdb", "spread"],
    ["many.sqlite", "spread"],
  ]) {
    const page = (read: Parameters<Data["page"]>[3]) =>
      data.page(path.join(folder, name), "v1", table, read)
    const second = await page({ offset: 200 })
    const sorted = await page({ order: { column: 0, descending: true }, offset: 200 })
    const found = await page({ search: { text: "W12", columns: [], hidden: [] } })
    const column = await page({ search: { text: "", columns: [[0, "600"]], hidden: [] } })
    const shown = await page({ search: { text: "1", columns: [], hidden: [0] }, rows: 5000 })

    assert.equal(second.grid?.rows.length, 200, name)
    assert.deepEqual(second.grid?.rows[0], [(200 * 7919) % 6007, "w200"], name)
    assert.equal(second.grid?.total, 6007, name)
    assert.equal(sorted.grid?.rows[0][0], 5806, name)
    assert.equal(found.grid?.total, 111, name)
    assert.equal(found.count, 6007, name)
    assert.ok(
      found.grid?.rows.every(([, word]) => String(word).startsWith("w12")),
      name,
    )
    assert.equal(column.grid?.total, 13, name)
    assert.equal(shown.grid?.total, ones, name)
    assert.equal(shown.grid?.partial, false, name)
  }
})

test("a sort of repeated values pages through every row once, in that column's order, in every reader", async () => {
  const folder = file("repeated")
  fs.mkdirSync(folder, { recursive: true })
  const rows = Array.from({ length: 6000 }, (_, i) => ({ id: i, kind: ["b", "c", "a"][i % 3] }))
  fs.writeFileSync(
    path.join(folder, "rows.csv"),
    `id,kind\n${rows.map(({ id, kind }) => `${id},${kind}`).join("\n")}\n`,
  )
  fs.writeFileSync(
    path.join(folder, "rows.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  )
  const duck = await DuckDBInstance.create(path.join(folder, "rows.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    `create table spread as select * from read_json('${path.join(folder, "rows.jsonl")}')`,
  )
  await connection.run(`copy spread to '${path.join(folder, "rows.parquet")}' (format parquet)`)
  connection.closeSync()
  duck.closeSync()
  const sqlite = new DatabaseSync(path.join(folder, "rows.sqlite"))
  sqlite.exec(
    `begin; create table spread (id integer, kind text); ${rows.map(({ id, kind }) => `insert into spread values (${id}, '${kind}');`).join(" ")} commit;`,
  )
  sqlite.close()

  for (const [name, table] of [
    ["rows.csv"],
    ["rows.jsonl"],
    ["rows.parquet"],
    ["rows.duckdb", "spread"],
    ["rows.sqlite", "spread"],
  ]) {
    const seen: [number, string][] = []

    for (let offset = 0; offset < 6000; offset += 200) {
      const page = await data.page(path.join(folder, name), "v1", table, {
        order: { column: 1, descending: false },
        offset,
      })
      seen.push(...((page.grid?.rows ?? []) as [number, string][]))
    }

    assert.equal(new Set(seen.map(([id]) => id)).size, 6000, name)
    assert.deepEqual(
      seen.map(([, kind]) => kind),
      [...seen.map(([, kind]) => kind)].sort(),
      name,
    )
  }
})

test("a search finds a time as its cell shows it, and a nested value by its JSON, in a file of any size", async () => {
  const folder = file("shown")
  fs.mkdirSync(folder, { recursive: true })
  const duck = await DuckDBInstance.create()
  const connection = await duck.connect()
  await connection.run(
    `copy (select range as id, timestamp '2024-01-01 08:00:00' + to_hours(range % 6) as at, timestamptz '2024-01-01 09:00:00+00' + to_hours(range % 6) as zoned, {'tag': 'k' || (range % 9)} as meta from range(6000)) to '${path.join(folder, "times.parquet")}' (format parquet)`,
  )
  connection.closeSync()
  duck.closeSync()
  const found = async (text: string) =>
    (
      await data.page(path.join(folder, "times.parquet"), "v1", undefined, {
        search: { text, columns: [], hidden: [] },
      })
    ).grid?.total

  assert.equal(await found("T10:00"), 2000)
  assert.equal(await found("2024-01-01T09:00:00.000Z"), 2000)
  assert.equal(await found('"tag":"k3"'), 667)
})

test("a text file whose copy is slow shows its first rows and is counted once copied, however long the copy", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-large-")))
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "folio-large-scratch-"))
  const waiting = new Data(folder, scratch(), 10_000, 0)
  const limited = new Data(folder, scratch(), 100)
  const big = path.join(folder, "big.csv")
  const out = fs.openSync(big, "w")
  fs.writeSync(out, "id,word,size\n")

  for (let at = 0; at < 1_500_000; at += 100_000) {
    fs.writeSync(
      out,
      Array.from(
        { length: 100_000 },
        (_, i) => `${at + i},w${(at + i) % 97},${(at + i) * 3}\n`,
      ).join(""),
    )
  }

  fs.closeSync(out)

  try {
    const first = await waiting.page(big, "v1")

    assert.equal(first.error, undefined)
    assert.equal(first.counting, true)
    assert.equal(first.grid?.rows.length, 200)
    assert.deepEqual(first.grid?.rows[0], [0, "w0", 0])

    for (let tries = 0; tries < 100 && (await waiting.page(big, "v1")).counting; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    assert.equal((await waiting.page(big, "v1")).grid?.total, 1_500_000)

    const later = await limited.page(big, "v1", undefined, { offset: 200 })
    assert.equal(later.error, undefined)
    assert.equal(later.grid?.total, 1_500_000)
    assert.deepEqual(later.grid?.rows[0], [200, "w6", 600])
  } finally {
    await waiting.close()
    await limited.close()
  }
})

test("a sort pages through a file holding a column named as its row numbers are", async () => {
  const folder = file("ranked")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(
    path.join(folder, "rows.csv"),
    `FOLIO_ROW,kind\n${Array.from({ length: 300 }, (_, i) => `${i},${i % 3}`).join("\n")}\n`,
  )
  const page = await data.page(path.join(folder, "rows.csv"), "v1", undefined, {
    order: { column: 1, descending: false },
  })

  assert.equal(page.error, undefined)
  assert.deepEqual(
    page.grid?.rows.slice(0, 3).map((row) => row[0]),
    [0, 3, 6],
  )
})

test("a page waiting on a copy reads it though the file changes while it is made", async () => {
  const folder = file("held")
  fs.mkdirSync(folder, { recursive: true })
  const big = path.join(folder, "big.csv")
  const out = fs.openSync(big, "w")
  fs.writeSync(out, "id,word\n")

  for (let at = 0; at < 400_000; at += 100_000) {
    fs.writeSync(
      out,
      Array.from({ length: 100_000 }, (_, i) => `${at + i},w${(at + i) % 97}\n`).join(""),
    )
  }

  fs.closeSync(out)

  const waiting = data.page(big, "v1", undefined, { offset: 200 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  fs.appendFileSync(big, "400000,w0\n")
  const newer = data.page(big, "v2", undefined, { offset: 200 })
  const [first, second] = await Promise.all([waiting, newer])

  assert.equal(first.error, undefined)
  assert.deepEqual(first.grid?.rows[0], [200, "w6"])
  assert.equal(second.grid?.total, 400_001)
})

test("a JSON Lines line finished while its page reads the file shows once the page reads it again", async () => {
  const folder = file("finished")
  fs.mkdirSync(folder, { recursive: true })
  const log = path.join(folder, "log.jsonl")
  fs.writeFileSync(
    log,
    `${Array.from({ length: 300 }, (_, i) => JSON.stringify({ n: i })).join("\n")}\n{"n": 3`,
  )
  const close = fs.closeSync
  let finished = false
  mock.method(fs, "closeSync", (handle: number) => {
    close.call(fs, handle)

    // The line is finished just after the page measured the file, before it copied it.
    if (!finished) {
      finished = true
      fs.appendFileSync(log, "00}\n")
    }
  })

  try {
    const during = await data.page(log, "v1", undefined, { offset: 0 })
    mock.restoreAll()
    const after = await data.page(log, "v2", undefined, { offset: 0 })

    assert.equal(during.grid?.total, 300)
    assert.equal(after.grid?.total, 301)
  } finally {
    mock.restoreAll()
  }
})

test("a sort puts blanks last both ways and orders text without regard to case", async () => {
  fs.mkdirSync(file("sorted"), { recursive: true })
  fs.writeFileSync(file("sorted/words.csv"), "word,n\nbeta,1\n,2\nAlpha,3\n  ,4\ngamma,5\nDelta,\n")
  const sorted = async (column: number, descending: boolean) =>
    (
      await data.page(file("sorted/words.csv"), "v1", undefined, {
        order: { column, descending },
        rows: 10,
      })
    ).grid?.rows.map((row) => row[column])

  assert.deepEqual(await sorted(0, false), ["Alpha", "beta", "Delta", "gamma", "  ", null])
  assert.deepEqual((await sorted(0, true))?.slice(0, 4), ["gamma", "Delta", "beta", "Alpha"])
  assert.deepEqual(await sorted(1, true), [5, 4, 3, 2, 1, null])
  assert.match(
    (
      await data.page(file("sorted/words.csv"), "v1", undefined, {
        order: { column: 7, descending: false },
        rows: 10,
      })
    ).error ?? "",
    /no column 8 to sort by/,
  )
})

test("a SQLite table sorts a column of whole numbers too large for a double", async () => {
  const folder = file("bigints")
  fs.mkdirSync(folder, { recursive: true })
  const sqlite = new DatabaseSync(path.join(folder, "big.sqlite"))
  sqlite.exec(
    `begin; create table big (n integer); ${Array.from({ length: 6000 }, (_, i) => `insert into big values (${9007199254740993n + BigInt((i * 7) % 6000)});`).join(" ")} commit;`,
  )
  sqlite.close()

  for (const descending of [false, true]) {
    const page = await data.page(path.join(folder, "big.sqlite"), "v1", "big", {
      order: { column: 0, descending },
      rows: 5000,
    })

    assert.equal(page.error, undefined)
    assert.deepEqual(
      page.grid?.rows.slice(0, 2).map((row) => String(row[0])),
      descending
        ? ["9007199254746992", "9007199254746991"]
        : ["9007199254740993", "9007199254740994"],
    )
  }
})

test("text written as a number sorts by its value before other text in every reader, both ways", async () => {
  const folder = file("written")
  const amounts = ["950", "1,200", "$30", "n/a"]
  const rows = Array.from({ length: 6000 }, (_, i) => ({ id: i, amount: amounts[i % 4] }))
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(
    path.join(folder, "amounts.csv"),
    `id,amount\n${rows.map(({ id, amount }) => `${id},"${amount}"`).join("\n")}\n`,
  )
  fs.writeFileSync(
    path.join(folder, "amounts.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  )
  const sqlite = new DatabaseSync(path.join(folder, "amounts.sqlite"))
  sqlite.exec(
    `begin; create table amounts (id integer, amount text); ${rows.map(({ id, amount }) => `insert into amounts values (${id}, '${amount}');`).join(" ")} commit;`,
  )
  sqlite.close()
  const duck = await DuckDBInstance.create(path.join(folder, "amounts.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    `create table amounts as select * from read_json('${path.join(folder, "amounts.jsonl")}')`,
  )
  connection.closeSync()
  duck.closeSync()

  for (const [name, table] of [
    ["amounts.csv"],
    ["amounts.jsonl"],
    ["amounts.sqlite", "amounts"],
    ["amounts.duckdb", "amounts"],
  ]) {
    const order = async (descending: boolean) =>
      (
        await data.page(path.join(folder, name), "v1", table, {
          order: { column: 1, descending },
          rows: 5000,
        })
      ).grid?.rows
        .map((row) => row[1])
        .filter((amount, index, all) => amount !== all[index - 1])

    assert.deepEqual(await order(false), ["$30", "950", "1,200", "n/a"], name)
    assert.deepEqual(await order(true), ["n/a", "1,200", "950", "$30"], name)
  }
})

test("the server reads every text as a number exactly when the page does", async () => {
  let seed = 20261029
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  const pieces = [
    ..."0123456789,,  _..-+$%eEa\t",
    "\u2212",
    "\u20ac",
    "\u00a0",
    "\u202f",
    "1,234",
    "12,345",
    "1 000",
    "999",
  ]
  const texts = new Set<string>()

  while (texts.size < 4000) {
    const length = 1 + Math.floor(random() * 8)
    const text = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join("")

    // A cell blank to the page but not to the engine's trim sorts apart for another reason.
    if (text.trim() !== "" || text.trim() === text.replaceAll(" ", "")) {
      texts.add(text)
    }
  }

  fs.writeFileSync(
    file("written/texts.jsonl"),
    [...texts].map((text) => `${JSON.stringify({ text })}\n`).join(""),
  )
  const sorted = (
    await data.page(file("written/texts.jsonl"), "v1", undefined, {
      order: { column: 0, descending: false },
      rows: 5000,
    })
  ).grid?.rows.map((row) => String(row[0] ?? "")) as string[]
  const numbers = sorted.flatMap((text) => {
    const number = numberOf(text)
    return number === undefined ? [] : [number]
  })

  assert.equal(sorted.length, texts.size)
  assert.ok(numbers.length > 100, `${numbers.length} numbers`)
  assert.ok(
    sorted.slice(0, numbers.length).every((text) => numberOf(text) !== undefined),
    "every number sorts before every other text",
  )
  assert.deepEqual(
    numbers,
    [...numbers].sort((a, b) => a - b),
  )
})

test("a .db file that is no database says so", async () => {
  const page = await data.page(file("not-a-database.db"), "v1")

  assert.equal(page.format, "sqlite")
  assert.ok(page.error)
})

test("an embed reads a file's rows, a part of its value, or a database table", async () => {
  assert.deepEqual((await data.embed(file("rows.csv"), "v1", "")).grid?.rows, [
    ["Oslo", 1204],
    ["Lima", 87],
  ])
  assert.equal((await data.embed(file("rows.csv"), "v1", "1.visits")).value, 87)
  assert.deepEqual((await data.embed(file("tree.json"), "v1", "parts.1")).value, { id: 2 })
  assert.equal((await data.embed(file("keys.json"), "v1", "model|clean|A2.A0.acc")).value, 0.5)
  assert.equal((await data.embed(file("keys.json"), "v1", "list.1")).value, 20)
  assert.equal((await data.embed(file("docs.yaml"), "v1", "1.name")).value, "second")
  assert.equal((await data.embed(file("shop.sqlite"), "v1", "orders")).grid?.rows.length, 2)
  assert.equal((await data.embed(file("shop.duckdb"), "v1", "stock")).grid?.rows.length, 25)
})

test("an embed of a part that is not there, or of a whole database, says why", async () => {
  assert.equal((await data.embed(file("tree.json"), "v1", "parts.7")).error, "Nothing at parts.7.")
  assert.equal((await data.embed(file("rows.csv"), "v1", "0.absent")).error, "Nothing at 0.absent.")
  assert.equal(
    (await data.embed(file("shop.sqlite"), "v1", "")).error,
    "Name one of the database's tables after a #.",
  )
  assert.equal(
    (await data.embed(file("shop.duckdb"), "v1", "absent")).error,
    "No table named absent in this database.",
  )
})

test("a query joins files of different formats, each resolved against the query's folder", async () => {
  const { grid, files } = await data.query(
    "select r.city, d.name from 'rows.csv' r join 'docs.yaml' d on r.visits > 100 order by 2",
    root,
  )

  assert.deepEqual(grid.rows, [
    ["Oslo", "first"],
    ["Oslo", "second"],
  ])
  assert.deepEqual(files.sort(), ["docs.yaml", "rows.csv"])
})

test("a query reads database tables, JSON Lines, Parquet and other queries by name", async () => {
  const run = async (sql: string, folder = root) => (await data.query(sql, folder)).grid.rows

  assert.deepEqual(await run("select count(*) from 'shop.sqlite#orders'"), [[2]])
  assert.deepEqual(await run("select max(id) from 'shop.duckdb#stock'"), [[24]])
  assert.deepEqual(await run("select sum(visits) from read_json('rows.jsonl')"), [[1291]])
  assert.deepEqual(await run("select count(*) from 'many.parquet'"), [[6000]])
  assert.deepEqual(await run("select * from 'queries/twice.sql'"), [[2582]])
  assert.deepEqual(await run("select * from 'twice.sql'", file("queries")), [[2582]])
})

test("a query that is not one SELECT, or reads outside the folder, is refused before it runs", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "folio-outside-"))
  fs.writeFileSync(path.join(outside, "secret.csv"), "a\n1\n")
  fs.symlinkSync(path.join(outside, "secret.csv"), file("escape.csv"))
  const refusal = async (sql: string) => {
    try {
      await data.query(sql, root)
      return "ran"
    } catch (error) {
      return (error as Error).message
    }
  }
  const before = fs.readdirSync(root).sort()

  for (const sql of [
    "copy (select 1) to 'written.csv'",
    "attach 'new.duckdb'",
    "select 1; select 2",
    "create table t as select 1",
  ]) {
    assert.equal(
      await refusal(sql),
      "Only one SELECT statement runs in a query; PIVOT and statements that change anything do not.",
      sql,
    )
  }

  assert.equal(
    await refusal("select * from 'escape.csv'"),
    "escape.csv is outside the served folder.",
  )
  assert.equal(
    await refusal(`select * from '../${path.basename(outside)}/secret.csv'`),
    `../${path.basename(outside)}/secret.csv is outside the served folder.`,
  )
  assert.equal(
    await refusal("select * from read_csv('https://example.com/a.csv')"),
    "Only the served folder's files can be read, not https://example.com/a.csv.",
  )
  assert.equal(await refusal("select * from query('select 1')"), "A query may not call query.")
  assert.equal(await refusal("select * from 'absent.csv'"), "No data file at absent.csv.")
  assert.equal(
    await refusal("select * from 'queries/loop.sql'"),
    "loop.sql uses itself, or queries nest too deep.",
  )
  assert.deepEqual(fs.readdirSync(root).sort(), before)
  fs.rmSync(file("escape.csv"))
})

test("a query names many files by a pattern, each match confined, stacked by name with its path", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "folio-outside-"))
  fs.writeFileSync(path.join(outside, "roster.yaml"), "- {name: secret}\n")

  for (const [name, content] of Object.entries({
    "stations/a/logs/roster.yaml": "- {name: one, lane: x}\n",
    "stations/b/logs/roster.yaml": "- {name: two, size: 3}\n",
    "stations/b/logs/other.yaml": "- {name: no}\n",
    "stations/.hidden/logs/roster.yaml": "- {name: hidden}\n",
    "deep/one/t.csv": "n\n1\n",
    "deep/one/two/t.csv": "n\n2\n",
  })) {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true })
    fs.writeFileSync(file(name), content)
  }

  fs.mkdirSync(file("stations/out/logs"), { recursive: true })
  fs.symlinkSync(path.join(outside, "roster.yaml"), file("stations/out/logs/roster.yaml"))
  const run = async (sql: string, folder = root) => (await data.query(sql, folder)).grid

  try {
    const rosters = await run(
      "select filename, name, lane, size from 'stations/*/logs/roster.yaml' order by filename",
    )
    assert.deepEqual(rosters.rows, [
      ["stations/a/logs/roster.yaml", "one", "x", null],
      ["stations/b/logs/roster.yaml", "two", null, 3],
    ])
    assert.deepEqual(
      (await run("select filename, n from '**/t.csv' order by n", file("deep"))).rows,
      [
        ["deep/one/t.csv", 1],
        ["deep/one/two/t.csv", 2],
      ],
    )
    assert.deepEqual((await run("select sum(n) from read_csv('deep/*/t.csv')")).rows, [[1]])
    assert.deepEqual((await run("select count(*) from 'nowhere/*.csv'")).rows, [[0]])

    const { files, dirs = [] } = await data.queryReads(
      file("report.md"),
      "select * from 'stations/*/logs/roster.yaml'",
    )
    assert.deepEqual(files.sort(), ["stations/a/logs/roster.yaml", "stations/b/logs/roster.yaml"])
    assert.ok(
      dirs.includes(file("stations")),
      "a new station's folder is watched through stations/",
    )

    fs.mkdirSync(file("stations/c/logs"), { recursive: true })
    fs.writeFileSync(file("stations/c/logs/roster.yaml"), "- {name: three}\n")
    assert.deepEqual(
      (await run("select name from 'stations/*/logs/roster.yaml' order by name")).rows,
      [["one"], ["three"], ["two"]],
    )
    assert.notEqual(
      (await data.queryReads(file("report.md"), "select * from 'stations/*/logs/roster.yaml'"))
        .files.length,
      files.length,
    )
  } finally {
    fs.rmSync(file("stations"), { recursive: true, force: true })
    fs.rmSync(file("deep"), { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("a reader stacks a pattern's matches by name, and a pattern matching nothing yet still names where to listen", async () => {
  fs.mkdirSync(file("swapped"), { recursive: true })
  fs.writeFileSync(file("swapped/a.csv"), "x,y\n1,2\n")
  fs.writeFileSync(file("swapped/b.csv"), "y,x\n4,3\n")

  try {
    assert.deepEqual(
      (await data.query("select x, y from read_csv('swapped/*.csv') order by x", root)).grid.rows,
      [
        [1, 2],
        [3, 4],
      ],
    )

    const empty = await data.queryReads(file("report.md"), "select * from read_csv('later/*.csv')")
    assert.deepEqual(empty.files, [])
    assert.deepEqual(empty.dirs, [root])
    const absent = await data.queryReads(file("report.md"), "select * from 'later/deep/*.csv'")
    assert.deepEqual(absent.dirs, [root])
  } finally {
    fs.rmSync(file("swapped"), { recursive: true, force: true })
  }
})

test("a query is stopped once it runs too long, and a long result keeps its first rows", async () => {
  await assert.rejects(
    slow.query(
      "select sum(hash(a.range + b.range)) from range(200000) a, range(200000) b",
      os.tmpdir(),
    ),
    { message: "The query ran longer than 0.3 s and was stopped." },
  )

  const { grid } = await data.query("select * from range(3000000)", root)
  assert.equal(grid.rows.length, 5000)
  assert.equal(grid.partial, true)
})

test("a .sql file's page shows its text and its result; an embed runs it", async () => {
  const page = await data.page(file("queries/total.sql"), "v1")

  assert.equal(page.format, "sql")
  assert.equal(page.text, "select sum(visits) as total from '../rows.csv'")
  assert.deepEqual(page.grid?.rows, [[1291]])
  assert.equal((await data.embed(file("queries/twice.sql"), "v1", "0.twice")).value, 2582)
})

test("a document's dependencies are every data file its embeds, charts and queries read", async () => {
  assert.deepEqual(await data.dependencies(file("report.md")), [
    "docs.yaml",
    "queries/total.sql",
    "queries/twice.sql",
    "rows.csv",
    "rows.jsonl",
    "tree.json",
  ])
})

test("a query refused part-way through binding its files neither crashes nor leaves work running", async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", listener)

  await assert.rejects(
    data.query("select * from 'shop.sqlite' a join 'absent.csv' b on true", root),
    {
      message: "No data file at absent.csv.",
    },
  )
  await assert.rejects(data.query("select * from 'shop.sqlite', query('select 1')", root), {
    message: "A query may not call query.",
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  process.off("unhandledRejection", listener)

  assert.deepEqual(unhandled, [])
})

test("copying a large SQLite table for a query yields to other work and stops at the time limit", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-big-")))
  const big = new DatabaseSync(path.join(folder, "big.sqlite"))
  big.exec(
    "create table big (x integer, label text); with recursive c(x) as (select 1 union all select x + 1 from c where x < 1500000) insert into big select x, 'row ' || x from c;",
  )
  big.close()
  const limited = new Data(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-big-scratch-")),
    300,
  )
  let ticks = 0
  const ticker = setInterval(() => ticks++, 20)

  try {
    await assert.rejects(limited.query("select count(*) from 'big.sqlite#big'", folder), {
      message: "The query ran longer than 0.3 s and was stopped.",
    })
  } finally {
    clearInterval(ticker)
    await limited.close()
  }

  assert.ok(ticks >= 5, `other work ran ${ticks} times during the copy`)
  fs.rmSync(folder, { recursive: true, force: true })
})

test("eight slow queries at once all stop at the time limit, and the engine answers afterwards", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-burst-")))
  const burst = new Data(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-burst-scratch-")),
    1000,
  )
  const slowSql = "select sum(hash(a.range + b.range)) from range(1000000) a, range(1000000) b"
  const started = Date.now()
  const settled = Promise.allSettled(Array.from({ length: 8 }, () => burst.query(slowSql, folder)))
  const outcome = await Promise.race([
    settled,
    new Promise<"wedged">((resolve) => setTimeout(() => resolve("wedged"), 15_000)),
  ])

  assert.notEqual(outcome, "wedged", "the engine wedged")
  assert.ok(Date.now() - started < 5000, `the burst took ${Date.now() - started} ms`)
  for (const result of outcome as PromiseSettledResult<unknown>[]) {
    assert.equal(result.status, "rejected")
    assert.equal(
      (result as PromiseRejectedResult).reason.message,
      "The query ran longer than 1 s and was stopped.",
    )
  }

  assert.deepEqual((await burst.query("select 42", folder)).grid.rows, [[42]])
  await burst.close()
})

test("a slow database read stops at the time limit, and a query queued behind it gets its own time", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-stalled-")))
  const duck = await DuckDBInstance.create(path.join(folder, "slow.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    "create view slow as select sum(hash(a.range + b.range)) as s from range(1000000) a, range(1000000) b",
  )
  connection.closeSync()
  duck.closeSync()
  const stalled = new Data(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-stalled-scratch-")),
    1000,
  )
  const listing = stalled.page(path.join(folder, "slow.duckdb"), "v1")
  const table = stalled.page(path.join(folder, "slow.duckdb"), "v1", "slow")
  const embedding = stalled.embed(path.join(folder, "slow.duckdb"), "v1", "slow")
  const queued = stalled.query("select 42", folder)
  const outcome = await Promise.race([
    Promise.allSettled([listing, table, embedding, queued]),
    new Promise<"wedged">((resolve) => setTimeout(() => resolve("wedged"), 15_000)),
  ])

  assert.notEqual(outcome, "wedged", "the engine wedged")
  const stopped = "The read ran longer than 1 s and was stopped."
  assert.equal((await listing).tables?.[0].error, stopped)
  assert.equal((await table).error, stopped)
  assert.equal((await embedding).error, stopped)
  assert.deepEqual((await queued).grid.rows, [[42]])
  await stalled.close()
  fs.rmSync(folder, { recursive: true, force: true })
})

test("a query of very long values stays within a gigabyte or two, cut short in the engine", async () => {
  const before = process.memoryUsage().rss
  let peak = before
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 10)
  const { grid } = await data
    .query("select repeat('a', 3000000) as long from range(3000)", root)
    .finally(() => clearInterval(sampler))

  assert.ok(peak - before < 2e9, `memory grew by ${Math.round((peak - before) / 1e6)} MB`)
  assert.equal(grid.partial, true)
  assert.equal(grid.rows[0][0], `${"a".repeat(20_000)}\u2026`)
})

test("a SQLite view that never finishes is stopped at the limit, and the server works meanwhile", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-endless-")))
  const db = new DatabaseSync(path.join(folder, "endless.sqlite"))
  db.exec(
    "create table a (n integer); insert into a values (1); create table t (n integer); create view endless as with recursive r(i) as (select 1 union all select i + 1 from r) select count(*) as c from r;",
  )
  db.close()
  const limited = new Data(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-endless-scratch-")),
    1000,
  )
  let ticks = 0
  const ticker = setInterval(() => ticks++, 50)
  const started = Date.now()
  const [listing, embedded, queried] = await Promise.all([
    limited.page(path.join(folder, "endless.sqlite"), "v1"),
    limited.embed(path.join(folder, "endless.sqlite"), "v1", "endless"),
    limited.embedQuery("select * from 'endless.sqlite#endless'", folder, "v1", ""),
  ]).finally(() => clearInterval(ticker))

  assert.ok(Date.now() - started < 5000, `the reads took ${Date.now() - started} ms`)
  assert.ok(ticks >= 10, `other work ran ${ticks} times`)
  assert.deepEqual(
    listing.tables?.map(({ name, error }) => [name, error]),
    [
      ["a", undefined],
      ["endless", "The read ran longer than 1 s and was stopped."],
      ["t", "Not read: The read ran longer than 1 s and was stopped."],
    ],
  )
  assert.equal(embedded.error, "The read ran longer than 1 s and was stopped.")
  assert.equal(queried.error, "The query ran longer than 1 s and was stopped.")
  assert.deepEqual(
    (await limited.page(path.join(folder, "endless.sqlite"), "v1", "a")).grid?.rows,
    [[1]],
  )
  await limited.close()
  fs.rmSync(folder, { recursive: true, force: true })
})

test("an integer too large for a double stays exact in a query, from a SQLite table or written in it", async () => {
  const db = new DatabaseSync(file("large.sqlite"))
  db.exec("create table t (n integer); insert into t values (1), (9007199254740993);")
  db.close()
  const { grid } = await data.query(
    "select typeof(n) as kind, n + 1 as next, n = 9007199254740993 as same from 'large.sqlite#t' where n > 1",
    root,
  )
  fs.rmSync(file("large.sqlite"))

  assert.deepEqual(grid.rows, [["BIGINT", "9007199254740994", true]])
  assert.deepEqual((await data.query("select 9007199254740993 as written", root)).grid.rows, [
    ["9007199254740993"],
  ])
})

test("a large YAML file is read without holding up other work, and one past 2 MB shows its start", async () => {
  const entry = (i: number) =>
    `- id: ${i}\n  name: item ${i}\n  tags: [a, b, c]\n  nested: {x: 1, y: two}\n`
  const lines = (bytes: number) => {
    let text = ""

    for (let i = 0; text.length < bytes; i++) {
      text += entry(i)
    }

    return text
  }
  fs.writeFileSync(file("large.yaml"), lines(1.8 * 1024 * 1024))
  fs.writeFileSync(file("larger.yaml"), lines(2.2 * 1024 * 1024))
  let ticks = 0
  const ticker = setInterval(() => ticks++, 20)

  try {
    const read = await data.page(file("large.yaml"), "v1")
    assert.ok(Array.isArray(read.value))
    assert.ok(ticks >= 10, `other work ran ${ticks} times while it parsed`)
  } finally {
    clearInterval(ticker)
  }

  const larger = await data.page(file("larger.yaml"), "v1")
  assert.equal(larger.value, undefined)
  assert.ok(larger.text?.startsWith("- id: 0\n"))
})

test("ten embeds of one large YAML file all read, through one parse", async () => {
  let text = ""

  for (let i = 0; text.length < 1.9 * 1024 * 1024; i++) {
    text += `- id: ${i}\n  name: item ${i}\n  tags: [a, b, c]\n  nested: {x: 1, y: two}\n`
  }

  fs.writeFileSync(file("shared.yaml"), text)
  const embeds = await Promise.all(
    Array.from({ length: 10 }, () => data.embed(file("shared.yaml"), "v1", "")),
  )
  fs.rmSync(file("shared.yaml"))

  assert.deepEqual(
    embeds.map(({ error }) => error),
    Array(10).fill(undefined),
  )
  assert.ok(embeds.every(({ value }) => Array.isArray(value) && value.length > 20_000))
})

test("YAML whose aliases expand past 20 MB is refused, in the page, an embed and a query", async () => {
  const items = Array.from({ length: 1000 }, () => "x".repeat(1000)).join(", ")
  const refs = Array.from({ length: 30 }, () => "*a").join(", ")
  fs.writeFileSync(file("expanding.yaml"), `a: &a [${items}]\nb: [${refs}]\n`)
  let ticks = 0
  const ticker = setInterval(() => ticks++, 20)
  const [page, embedded, queried] = await Promise.all([
    data.page(file("expanding.yaml"), "v1"),
    data.embed(file("expanding.yaml"), "v1", "a"),
    data.embedQuery("select count(*) from 'expanding.yaml'", root, "v1", ""),
  ]).finally(() => clearInterval(ticker))
  fs.rmSync(file("expanding.yaml"))

  for (const error of [page.error, embedded.error, queried.error]) {
    assert.equal(error, "The file expands to more than 20 MB.")
  }
  assert.ok(ticks >= 1, `other work ran ${ticks} times`)
})

test("databases show exact large integers, every schema's tables, and a broken table without blanking the rest", async () => {
  const lite = new DatabaseSync(file("mixed.sqlite"))
  lite.exec(
    "create table big (x integer); insert into big values (9007199254740993); create table fine (a text); insert into fine values ('ok'); create table gone (a); create view broken as select * from gone; drop table gone;",
  )
  lite.close()
  const duck = await DuckDBInstance.create(file("mixed.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    "create schema other; create table other.t as select 1 as n; create table main.gone as select 1 as n; create view main.broken as select * from main.gone; drop table main.gone; create table main.fine as select 'ok' as a;",
  )
  connection.closeSync()
  duck.closeSync()

  const sqlitePage = await data.page(file("mixed.sqlite"), "v1")
  const byName = new Map(sqlitePage.tables?.map((table) => [table.name, table]))

  assert.equal(sqlitePage.error, undefined)
  assert.deepEqual(byName.get("big")?.first.rows, [["9007199254740993"]])
  assert.deepEqual(byName.get("fine")?.first.rows, [["ok"]])
  assert.match(byName.get("broken")?.error ?? "", /gone/)

  const duckPage = await data.page(file("mixed.duckdb"), "v1")
  const duckNames = new Map(duckPage.tables?.map((table) => [table.name, table]))

  assert.equal(duckPage.error, undefined)
  assert.deepEqual(duckNames.get("other.t")?.first.rows, [[1]])
  assert.deepEqual(duckNames.get("fine")?.first.rows, [["ok"]])
  assert.match(duckNames.get("broken")?.error ?? "", /gone/i)
  assert.deepEqual((await data.page(file("mixed.duckdb"), "v1", "other.t")).grid?.rows, [[1]])
  assert.deepEqual((await data.query("select n from 'mixed.duckdb#other.t'", root)).grid.rows, [
    [1],
  ])
})

test("an engine that failed to start is started again on the next request", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-retry-")))
  const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-retry-scratch-")), "state")
  fs.writeFileSync(scratch, "a file where the engine's folder should go")
  const retried = new Data(folder, scratch)

  await assert.rejects(retried.query("select 1", folder))
  fs.rmSync(scratch)
  assert.deepEqual((await retried.query("select 1 as n", folder)).grid.rows, [[1]])
  await retried.close()
})

test("an engine whose settings fail after it was created is closed, and the next request starts afresh", async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api")
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-closed-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-closed-scratch-"))
  const created: { closed: boolean }[] = []
  const real = DuckDBInstance.create.bind(DuckDBInstance)
  const create = mock.method(DuckDBInstance, "create", async (...args: Parameters<typeof real>) => {
    const instance = await real(...args)
    const record = { closed: false }
    const close = instance.closeSync.bind(instance)

    created.push(record)
    instance.closeSync = () => {
      record.closed = true
      close()
    }

    if (created.length === 1) {
      instance.connect = async () => {
        throw new Error("settings refused")
      }
    }

    return instance
  })
  const fresh = new Data(folder, store)

  try {
    await assert.rejects(fresh.query("select 1", folder), /settings refused/)
    assert.deepEqual((await fresh.query("select 1 as n", folder)).grid.rows, [[1]])
    assert.deepEqual(
      created.map(({ closed }) => closed),
      [true, false],
    )
  } finally {
    create.mock.restore()
    await fresh.close()
  }
})

test("a date shows as the date it is on a page, in an embed and in a query; a time keeps its time", async () => {
  fs.writeFileSync(
    file("days.csv"),
    "day,read_at\n2026-10-01,2026-10-01 00:00:00\n2026-10-02,2026-10-02 14:30:00\n",
  )
  const nested = await data.query(
    "select [date '2026-10-03'] as days, {day: date '2026-10-04'} as entry",
    root,
  )

  assert.deepEqual((await data.page(file("days.csv"), "v1")).grid?.rows, [
    ["2026-10-01", "2026-10-01T00:00:00.000Z"],
    ["2026-10-02", "2026-10-02T14:30:00.000Z"],
  ])
  assert.equal((await data.embed(file("days.csv"), "v1", "0.day")).value, "2026-10-01")
  assert.deepEqual(
    (
      await data.query(
        "select date '2026-10-01' as day, timestamp '2026-10-01 00:00' as at, current_date as today",
        root,
      )
    ).grid.rows.map(([day, at, today]) => [day, at, /^\d{4}-\d{2}-\d{2}$/.test(String(today))]),
    [["2026-10-01", "2026-10-01T00:00:00.000Z", true]],
  )
  assert.deepEqual(nested.grid.rows, [['["2026-10-03"]', '{"day":"2026-10-04"}']])
})

test("a query result keeps its values as the engine gives them, paths of the folder included", async () => {
  const { grid } = await data.query(`select '${root}/rows.csv' as written`, root)

  assert.deepEqual(grid.rows, [[`${root}/rows.csv`]])
})

test("query copies keep one version per source; a stopped process's are cleared, a running one's kept", async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-copies-"))
  const stopped = spawnSync(process.execPath, ["-e", ""]).pid
  const startOf = (pid: number) =>
    fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19]
  const leftover = path.join(store, "engine", String(stopped), "read", "old.json")
  const neighbour = path.join(store, "engine", String(process.ppid), "read", "theirs.json")
  const started = `${process.ppid}-${startOf(process.ppid)}`
  const current = path.join(store, "engine", started, "read", "current.json")
  // The parent's id, recorded with a start time it never had: a process that stopped, its id taken again.
  const reused = path.join(store, "engine", `${process.ppid}-1`, "read", "stale.json")
  for (const copy of [leftover, neighbour, current, reused]) {
    fs.mkdirSync(path.dirname(copy), { recursive: true })
    fs.writeFileSync(copy, "[]")
  }
  const own = new Data(root, store)

  fs.writeFileSync(file("copied.yaml"), "- n: 1\n")
  await own.query("select * from 'copied.yaml'", root)
  fs.writeFileSync(file("copied.yaml"), "- n: 1\n- n: 2\n")
  const { grid } = await own.query("select count(*) from 'copied.yaml'", root)
  await own.close()
  fs.rmSync(file("copied.yaml"))

  assert.deepEqual(grid.rows, [[2]])
  const mine = fs
    .readdirSync(path.join(store, "engine"))
    .find((entry) => entry.startsWith(`${process.pid}-`))
  assert.equal(fs.readdirSync(path.join(store, "engine", String(mine), "read")).length, 1)
  assert.equal(fs.existsSync(path.dirname(path.dirname(leftover))), false)
  assert.equal(fs.existsSync(neighbour), true)
  assert.equal(fs.existsSync(current), true)
  assert.equal(fs.existsSync(path.dirname(path.dirname(reused))), false, "a reused id clears")
  fs.rmSync(store, { recursive: true, force: true })
})

test("a running query keeps its copy when a newer version of the file arrives", async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-held-"))
  const big = new DatabaseSync(file("held.sqlite"))
  big.exec(
    "create table t (n integer); insert into t with recursive r(i) as (select 1 union all select i + 1 from r where i < 300000) select i from r;",
  )
  big.close()
  fs.writeFileSync(file("held.yaml"), "- n: 1\n")
  const own = new Data(root, store)
  const copies = () =>
    fs
      .readdirSync(store, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".json"))
  const running = own.query(
    "select (select count(*) from 'held.yaml') as y, (select count(*) from 'held.sqlite#t') as t",
    root,
  )

  while (copies().length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  fs.writeFileSync(file("held.yaml"), "- n: 1\n- n: 2\n")
  const newer = await own.query("select count(*) as y from 'held.yaml'", root)
  const older = await running.then(
    ({ grid }) => grid.rows,
    (error: Error) => error.message,
  )
  await own.close()
  fs.rmSync(file("held.yaml"))
  fs.rmSync(file("held.sqlite"))
  fs.rmSync(store, { recursive: true, force: true })

  assert.deepEqual(newer.grid.rows, [[2]])
  assert.deepEqual(older, [[1, 300000]])
})

test("an error from a query copy names the file it copies, never the copy", async () => {
  const mixed = new DatabaseSync(file("mixed.sqlite"))
  mixed.exec(
    "create table t (a); insert into t with recursive r(i) as (select 1 union all select i + 1 from r where i < 30000) select i from r; insert into t values ('x');",
  )
  mixed.close()
  const { error } = await data.embedQuery("select max(a) from 'mixed.sqlite#t'", root, "v1", "")
  fs.rmSync(file("mixed.sqlite"))

  assert.match(error ?? "", /in file "mixed\.sqlite#t"/)
  assert.doesNotMatch(error ?? "", new RegExp(scratch))
})

test("an embed of a document's own query moves with the query's text, not only with what it reads", async () => {
  const own = file("own-query.md")
  fs.writeFileSync(own, "```sql query q\nselect count(*) as n from 'rows.csv'\n```\n")
  const before = await data.reads(own, "#q#0.n")
  fs.writeFileSync(own, "```sql query q\nselect max(visits) as n from 'rows.csv'\n```\n")
  const after = await data.reads(own, "#q#0.n")

  assert.deepEqual(after.files, before.files)
  assert.notEqual(after.version, before.version)
})

test("rarer files read as a person reads them: deep nesting refused, sets listed, a line being written left out", async () => {
  fs.writeFileSync(file("deep.json"), `${"[".repeat(20_000)}${"]".repeat(20_000)}`)
  fs.writeFileSync(file("kinds.yaml"), "members: !!set {a, b}\nblob: !!binary aGVsbG8=\n")
  fs.writeFileSync(file("growing.jsonl"), '{"n":1}\n{"n":2}\n{"n":')

  const deep = await data.page(file("deep.json"), "v1")
  assert.match(deep.error ?? "", /nests deeper than 1,000 levels/)
  assert.equal(deep.value, undefined)
  assert.ok(JSON.stringify(deep).length > 0, "the answer can be sent")

  assert.deepEqual((await data.page(file("kinds.yaml"), "v1")).value, {
    members: ["a", "b"],
    blob: "5 bytes",
  })

  const growing = await data.page(file("growing.jsonl"), "v1")
  assert.deepEqual(growing.grid?.rows, [[1], [2]])
  assert.equal(growing.error, undefined)
  assert.match(growing.note ?? "", /last line is not complete/)
})

test("a query asked for again while it runs or after, at the same version of what it reads, runs once", async () => {
  const sql = "select count(*) as n from 'shared.csv'"
  const runs: string[] = []
  const counted = new (class extends Data {
    override query(query: string, folder: string, limit?: number) {
      runs.push(query)
      return super.query(query, folder, limit)
    }
  })(root, scratch)
  fs.writeFileSync(file("shared.csv"), "n\n1\n2\n")

  try {
    const [first, second] = await Promise.all([
      counted.embedQuery(sql, root, "v1", "0.n"),
      counted.embedQuery(sql, root, "v1", ""),
    ])
    assert.equal(first.value, 2)
    assert.deepEqual(second.grid?.rows, [[2]])
    assert.equal(runs.length, 1, "one run for both")
    assert.equal((await counted.embedQuery(sql, root, "v1", "0.n")).value, 2)
    assert.equal(
      runs.length,
      1,
      "asked again once it ran, at the same version, it does not run again",
    )

    const stale = counted.embedQuery(sql, root, "v2", "0.n")
    fs.writeFileSync(file("shared.csv"), "n\n1\n")
    const fresh = await counted.embedQuery(sql, root, "v3", "0.n")
    await stale
    assert.equal(fresh.value, 1, "a newer version never takes an older run's result")
    assert.equal(runs.length, 3)
  } finally {
    await counted.close()
  }
})

test("a JSON Lines file with a bad line and a last line still being written shows what parses", async () => {
  fs.writeFileSync(file("mixed.jsonl"), '{"n":1}\n{bad\n{"n":3}\n{"n":')
  const page = await data.page(file("mixed.jsonl"), "v1")

  assert.ok(page.error, "the bad line is named")
  assert.deepEqual(
    page.grid?.rows.filter(([n]) => n !== null),
    [[1], [3]],
  )
  assert.match(page.note ?? "", /last line is not complete/)
})

test("a JSON Lines file whose half-written last line is longer than the bytes first read still leaves it out", async () => {
  fs.writeFileSync(file("wide.jsonl"), `{"n":1}\n{"n":2,"text":"${"x".repeat(100_000)}`)
  const page = await data.page(file("wide.jsonl"), "v1")

  assert.deepEqual(
    page.grid?.rows.map(([n]) => n),
    [1],
  )
  assert.match(page.note ?? "", /last line is not complete/)
})

test("a pattern reads three thousand small files of each format, within the engine's memory and time", async () => {
  const shapes: Record<string, (at: number) => string> = {
    csv: (at) => `n,label\n${at},x${at}\n`,
    tsv: (at) => `n\tlabel\n${at}\tx${at}\n`,
    jsonl: (at) => `{"n":${at},"label":"x${at}"}\n`,
    json: (at) => `[{"n":${at},"label":"x${at}"}]`,
    yaml: (at) => `- n: ${at}\n  label: x${at}\n`,
  }

  for (const [format, shape] of Object.entries(shapes)) {
    fs.mkdirSync(file(`many/${format}`), { recursive: true })

    for (let at = 0; at < 3000; at++) {
      fs.writeFileSync(file(`many/${format}/f${String(at).padStart(4, "0")}.${format}`), shape(at))
    }
  }

  try {
    for (const format of Object.keys(shapes)) {
      const { rows } = (
        await data.query(
          `select count(*), count(distinct filename), min(filename), sum(n) from 'many/${format}/*'`,
          root,
        )
      ).grid
      assert.deepEqual(rows, [[3000, 3000, `many/${format}/f0000.${format}`, 4498500]], format)
    }

    assert.deepEqual(
      (await data.query("select count(*) from read_csv('many/csv/*')", root)).grid.rows,
      [[3000]],
    )
    assert.deepEqual(
      (await data.query("select count(*) from read_json('many/json/*')", root)).grid.rows,
      [[3000]],
    )
  } finally {
    fs.rmSync(file("many"), { recursive: true, force: true })
  }
})

test("a matched file's own filename column is kept as filename_1, and a database among the matches is named", async () => {
  fs.mkdirSync(file("own"), { recursive: true })
  fs.writeFileSync(file("own/a.csv"), "filename,b\nmine,1\n")
  fs.writeFileSync(file("own/b.csv"), "b\n2\n")
  fs.mkdirSync(file("mixed"), { recursive: true })
  fs.writeFileSync(file("mixed/a.csv"), "id\n9\n")
  fs.copyFileSync(file("shop.sqlite"), file("mixed/shop.sqlite"))

  try {
    assert.deepEqual(
      (await data.query("select filename, filename_1, b from 'own/*' order by b", root)).grid.rows,
      [
        ["own/a.csv", "mine", 1],
        ["own/b.csv", null, 2],
      ],
    )
    await assert.rejects(
      data.query("select * from 'mixed/*'", root),
      /mixed\/\* matches mixed\/shop\.sqlite, a database: name one of its tables after a #, or narrow the pattern\./,
    )
    assert.deepEqual(
      (await data.query("select filename, item from 'mixed/*.sqlite#orders' order by id", root))
        .grid.rows,
      [
        ["mixed/shop.sqlite", "pen"],
        ["mixed/shop.sqlite", "ink"],
      ],
    )
  } finally {
    fs.rmSync(file("own"), { recursive: true, force: true })
    fs.rmSync(file("mixed"), { recursive: true, force: true })
  }
})

test("a pattern keeps each JSON file's own shape, reads links and linked folders as readily, and a reader's own options hold", async () => {
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true })
    fs.writeFileSync(file(name), content)
  }

  for (let at = 0; at < 5; at++) {
    write(`shapes/r${at}.json`, `[{"n":${at},"label":"x${at}"}]`)
    write(`shapes/y${at}.yaml`, `- n: ${at + 10}\n`)
  }

  write("shapes/tags.json", '["a","b"]')
  write("shapes/words.yaml", "- a\n- b\n")

  for (let at = 0; at < 300; at++) {
    write(`runs/r1/f${String(at).padStart(3, "0")}.csv`, `n\n${at}\n`)
  }

  fs.symlinkSync(file("runs/r1"), file("current"))
  fs.mkdirSync(file("dup/links"), { recursive: true })

  for (let at = 0; at < 20; at++) {
    write(`dup/f${at}.csv`, `n\n${at}\n`)
    fs.symlinkSync(file(`dup/f${at}.csv`), file(`dup/links/f${at}.csv`))
  }
  fs.mkdirSync(file("links"))

  for (let at = 0; at < 50; at++) {
    fs.symlinkSync(file(`runs/r1/f${String(at).padStart(3, "0")}.csv`), file(`links/f${at}.csv`))
  }

  for (let at = 0; at < 150; at++) {
    write(`ord/f${String(at).padStart(3, "0")}.csv`, at < 100 ? "a,b\n1,2\n" : "b,a\n2,1\n")
    write(`pos/f${String(at).padStart(3, "0")}.csv`, at < 100 ? "a,b\n1,2\n" : "c,d\n3,4\n")
  }

  const rows = async (sql: string) => (await data.query(sql, root)).grid.rows

  try {
    assert.deepEqual(await rows("select n, label from 'shapes/*' where n is not null order by n"), [
      [0, "x0"],
      [1, "x1"],
      [2, "x2"],
      [3, "x3"],
      [4, "x4"],
      [10, null],
      [11, null],
      [12, null],
      [13, null],
      [14, null],
    ])
    assert.deepEqual(await rows("select count(json) from 'shapes/*'"), [[4]])
    assert.deepEqual(await rows("select count(*), min(filename), sum(n) from 'current/*.csv'"), [
      [300, "current/f000.csv", 44850],
    ])
    assert.deepEqual(await rows("select count(*), min(filename), sum(n) from 'links/*.csv'"), [
      [50, "links/f0.csv", 1225],
    ])
    assert.deepEqual(await rows("select sum(x), sum(y) from read_csv('ord/*') t(x, y)"), [
      [150, 300],
    ])
    assert.deepEqual(
      await rows("select count(*) from (select * from read_csv('ord/*') tablesample 10 rows)"),
      [[10]],
    )
    assert.deepEqual(await rows("select count(*), sum(n) from 'dup/**/*.csv'"), [[40, 380]])
    await assert.rejects(
      data.query("select count(a) from read_csv('pos/*', union_by_name = false)", root),
      /Schema mismatch/,
    )
    await assert.rejects(
      data.query("select count(a) from read_csv('pos/*', union_by_name := false)", root),
      /Schema mismatch/,
    )
    assert.deepEqual(
      await rows("select max(ordinality), count(*) from read_csv('ord/*') with ordinality"),
      [[150, 150]],
    )
    assert.deepEqual(await rows("select count(a), count(c) from read_csv('pos/*')"), [[100, 50]])
    fs.copyFileSync(file("shop.sqlite"), file("ord/shop.sqlite"))
    await assert.rejects(
      data.query("select * from read_csv('ord/*')", root),
      /read_csv reads ord\/\*, which matches ord\/shop\.sqlite, a database: narrow the pattern\./,
    )
  } finally {
    for (const name of ["shapes", "runs", "current", "links", "ord", "pos", "dup"]) {
      fs.rmSync(file(name), { recursive: true, force: true })
    }
  }
})

test("a query reading many JSON files at once, by several patterns, one by one or through readers of its own, answers", async () => {
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true })
    fs.writeFileSync(file(name), content)
  }
  const two = (at: number) => String(at).padStart(2, "0")

  for (const set of ["a", "b", "c"]) {
    for (let at = 0; at < 12; at++) {
      write(`trio/${set}/f${two(at)}.json`, `[{"n":${at}}]`)
    }
  }

  for (let at = 0; at < 30; at++) {
    write(`single/f${two(at)}.json`, `[{"n":${at}}]`)
  }

  for (let at = 0; at < 20; at++) {
    write(`wide/f${two(at)}.json`, `[{"n":${at}}]`)
  }

  for (let at = 0; at < 13; at++) {
    write(`named/f${two(at)}.json`, `[{"n":${at}}]`)
  }

  const rows = async (sql: string) => (await data.query(sql, root)).grid.rows
  const singles = Array.from({ length: 30 }, (_, at) => `select n from 'single/f${two(at)}.json'`)
  const readers = Array.from(
    { length: 18 },
    (_, at) => `select n from read_json('single/f${two(at)}.json')`,
  )

  try {
    assert.deepEqual(
      await rows(
        "select count(*), sum(n) from (select n from 'trio/a/*' union all select n from 'trio/b/*' union all select n from 'trio/c/*')",
      ),
      [[36, 198]],
    )
    assert.deepEqual(await rows(`select count(*), sum(n) from (${singles.join(" union all ")})`), [
      [30, 435],
    ])
    assert.deepEqual(
      await rows(
        `select count(*), sum(n) from (select n from 'trio/a/*' union all ${readers.join(" union all ")})`,
      ),
      [[30, 219]],
    )
    assert.deepEqual(
      await rows(
        "select count(*), sum(n) from (select n from 'trio/a/*' union all select n from read_json('wide/*', union_by_name := false))",
      ),
      [[32, 256]],
    )
    assert.deepEqual(
      await rows("select count(*) from read_json_objects('wide/*', union_by_name := false)"),
      [[20]],
    )
    assert.deepEqual(await rows("select count(distinct filename) from read_json('named/*')"), [
      [13],
    ])
  } finally {
    for (const name of ["trio", "single", "wide", "named"]) {
      fs.rmSync(file(name), { recursive: true, force: true })
    }
  }
})

test("a pattern matching database tables and JSON files keeps the columns in the order its matches come", async () => {
  fs.mkdirSync(file("mixed"))
  fs.writeFileSync(file("mixed/a.json"), '[{"x":1,"a":"one"}]')
  fs.writeFileSync(file("mixed/c.json"), '[{"x":3,"c":"three"}]')
  const sqlite = new DatabaseSync(file("mixed/b.sqlite"))
  sqlite.exec("create table t (x integer, b text); insert into t values (2, 'two');")
  sqlite.close()

  try {
    const { grid } = await data.query("select * from 'mixed/*#t' order by x", root)

    assert.deepEqual(
      grid.columns.map(({ name }) => name),
      ["filename", "x", "a", "b", "c"],
    )
    assert.deepEqual(grid.rows, [
      ["mixed/a.json", 1, "one", null, null],
      ["mixed/b.sqlite", 2, null, "two", null],
      ["mixed/c.json", 3, null, null, "three"],
    ])
  } finally {
    fs.rmSync(file("mixed"), { recursive: true, force: true })
  }
})

test("statistics count every column of the whole file, and of the records a filter keeps", async () => {
  const folder = file("counted")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(
    path.join(folder, "runs.jsonl"),
    Array.from({ length: 6000 }, (_, i) =>
      JSON.stringify({
        db: ["north", "south", "east"][i % 3],
        ms: i < 5000 ? 100 + (i % 50) : 100 + i,
        ok: i % 4 !== 0,
        note: i % 10 === 0 ? null : `note ${i}`,
        at: `2026-03-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`,
        tags: Array.from({ length: i % 3 }, () => "t"),
      }),
    ).join("\n"),
  )
  const stats = await data.stats(path.join(folder, "runs.jsonl"), "v1")
  const column = (name: string) => stats.columns.find((found) => found.name === name)

  assert.equal(stats.error, undefined)
  assert.equal(stats.total, 6000)
  assert.deepEqual(column("db")?.top, [
    ["east", 2000],
    ["north", 2000],
    ["south", 2000],
  ])
  assert.equal(column("db")?.distinct, 3)
  assert.equal(column("ms")?.kind, "number")
  assert.equal(column("ms")?.high, 6099)
  assert.ok(column("ms")?.unit !== undefined, "a long tail is binned on a log scale")
  assert.equal(
    column("ms")?.bins?.reduce((sum, n) => sum + n, 0),
    6000,
  )
  assert.equal(column("ok")?.kind, "boolean")
  assert.equal(column("note")?.filled, 5400)
  assert.equal(column("at")?.kind, "date")
  assert.deepEqual(column("tags")?.lengths, [0, 2])

  const north = await data.stats(path.join(folder, "runs.jsonl"), "v1", undefined, {
    field: "db",
    eq: "north",
  })
  assert.equal(north.total, 2000)
  assert.equal(north.where, "db = 'north'")
  assert.deepEqual(north.columns.find((found) => found.name === "db")?.top, [["north", 2000]])

  const tail = await data.stats(path.join(folder, "runs.jsonl"), "v1", undefined, {
    field: "ms",
    from: 5100,
    to: 6099,
    last: true,
  })
  assert.equal(tail.total, 1000)
  assert.equal(tail.where, "ms >= 5100 and ms <= 6099")

  const early = await data.stats(path.join(folder, "runs.jsonl"), "v1", undefined, {
    field: "at",
    from: Date.UTC(2026, 2, 1),
    to: Date.UTC(2026, 2, 3),
  })
  assert.equal(early.error, undefined)
  assert.equal(early.total, 430)
  assert.match(early.where ?? "", /^"at" >= timestamp/)

  const rows = await data.page(path.join(folder, "runs.jsonl"), "v1", undefined, {
    filter: { field: "db", eq: "east" },
    order: { column: 1, descending: true },
    rows: 3,
  })
  assert.deepEqual(
    rows.grid?.rows.map((row) => [row[0], row[1]]),
    [
      ["east", 6099],
      ["east", 6096],
      ["east", 6093],
    ],
  )
})

test("a column of a few long values counts as short ones do, among thirty columns", async () => {
  const long = Array.from({ length: 6 }, (_, i) => `${"v".repeat(1999)}${i}`)
  fs.mkdirSync(file("counted"), { recursive: true })
  fs.writeFileSync(
    file("counted/long.jsonl"),
    Array.from({ length: 300 }, (_, i) =>
      JSON.stringify({
        ...Object.fromEntries(Array.from({ length: 29 }, (_, c) => [`c${c}`, i % (c + 2)])),
        long: long[i % 6],
      }),
    ).join("\n"),
  )
  const stats = await data.stats(file("counted/long.jsonl"), "v1")
  const top = stats.columns.find(({ name }) => name === "long")?.top

  assert.equal(stats.error, undefined)
  assert.equal(stats.columns.length, 30)
  assert.equal(top?.length, 6)
  assert.deepEqual(
    top?.map(([value, count]) => [value.length, count]),
    Array.from({ length: 6 }, () => [2000, 50]),
  )
})

test("a column mostly of zeros with a long tail bins on a log scale from zero to its largest value", async () => {
  fs.mkdirSync(file("counted"), { recursive: true })
  fs.writeFileSync(
    file("counted/zeros.jsonl"),
    Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ wait: i < 700 ? 0 : Math.round(1.03 ** (i - 700)) }),
    ).join("\n"),
  )
  const wait = (await data.stats(file("counted/zeros.jsonl"), "v1")).columns[0]

  assert.equal(wait.low, 0)
  assert.equal(wait.high, Math.round(1.03 ** 299))
  assert.ok(wait.unit !== undefined, "binned on a linear scale")
  assert.equal(
    wait.bins?.reduce((sum, n) => sum + n, 0),
    1000,
  )
})

test("a count the time limit stopped counts again when next asked", async () => {
  const own = new Data(root, fs.mkdtempSync(path.join(os.tmpdir(), "folio-recount-")))
  fs.mkdirSync(file("counted"), { recursive: true })
  const duck = await DuckDBInstance.create(file("counted/recount.duckdb"))
  const connection = await duck.connect()
  await connection.run("create table t as select range as n from range(10)")
  connection.closeSync()
  duck.closeSync()
  mock.method(
    own,
    "query",
    async () => {
      throw new Error("The query ran longer than 10 s and was stopped.")
    },
    { times: 1 },
  )

  try {
    const stopped = await own.stats(file("counted/recount.duckdb"), "v1", "t")
    const again = await own.stats(file("counted/recount.duckdb"), "v1", "t")

    assert.match(stopped.error ?? "", /ran longer than/)
    assert.equal(again.error, undefined)
    assert.equal(again.total, 10)
  } finally {
    await own.close()
  }
})

test("a zoned time's bars hold exactly the records each bar's filter keeps, on a host east of UTC", async () => {
  const folder = file("zoned")
  fs.mkdirSync(folder, { recursive: true })
  const duck = await DuckDBInstance.create()
  const connection = await duck.connect()
  await connection.run(
    `copy (select timestamptz '2024-01-01 10:00:00+00' + to_hours(h) as at from (select unnest([0, 1, 1, 2, 2, 2]) as h)) to '${path.join(folder, "times.parquet")}' (format parquet)`,
  )
  connection.closeSync()
  duck.closeSync()
  const script = path.join(folder, "check.ts")
  fs.writeFileSync(
    script,
    `import { Data } from ${JSON.stringify(path.join(import.meta.dirname, "../src/server/data.ts"))}
const data = new Data(${JSON.stringify(root)}, ${JSON.stringify(fs.mkdtempSync(path.join(os.tmpdir(), "folio-zoned-")))})
const file = ${JSON.stringify(path.join(folder, "times.parquet"))}
const at = (await data.stats(file, "v1")).columns[0]
const width = (at.high - at.low) / at.bins.length
const kept = []
for (const [bin, count] of at.bins.entries()) {
  if (count > 0) {
    const last = bin === at.bins.length - 1
    const filter = { field: "at", from: at.low + bin * width, to: last ? at.high : at.low + (bin + 1) * width, ...(last && { last }) }
    kept.push([count, (await data.stats(file, "v1", undefined, filter)).total])
  }
}
console.log(JSON.stringify({ low: at.low, kept }))
await data.close()
`,
  )
  const ran = spawnSync(process.execPath, [script], {
    env: { ...process.env, TZ: "Europe/Bratislava" },
    encoding: "utf8",
  })
  const { low, kept } = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "{}")

  assert.equal(low, Date.UTC(2024, 0, 1, 10), ran.stderr)
  assert.deepEqual(kept, [
    [1, 1],
    [2, 2],
    [3, 3],
  ])
})

test("a comparison sets a filter's records against the rest, or every field by one, in one held read", async () => {
  const folder = file("compared")
  const records = Array.from({ length: 6000 }, (_, i) => {
    const outcome = i % 10 < 3 ? "late" : "on time"
    return {
      outcome,
      logged: i % 50 === 0 ? (outcome === "late" ? "on time" : "late") : outcome,
      flagged: outcome === "late" ? i % 5 < 2 : i % 20 === 0,
      delay: outcome === "late" ? 20 + (i % 61) : 0,
      size: (outcome === "late" ? i % 20 < 9 : i % 25 < 16) ? "small" : "large",
      berth: `B${i % 6}`,
      wait: (i % 6) * 10 + (i % 97),
      note: `note ${i}`,
    }
  })
  const share = (kept: typeof records, test: (record: (typeof records)[0]) => boolean) =>
    kept.filter(test).length / kept.length
  const late = records.filter(({ outcome }) => outcome === "late")
  const punctual = records.filter(({ outcome }) => outcome === "on time")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(
    path.join(folder, "runs.jsonl"),
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  )
  const runs = path.join(folder, "runs.jsonl")
  const apart = await data.compare(runs, "v1", undefined, {
    filter: { field: "outcome", eq: "late" },
  })
  const field = (name: string) => apart.fields.find((found) => found.name === name)

  assert.equal(apart.error, undefined)
  assert.deepEqual(apart.sets, [
    { label: "here", count: 1800 },
    { label: "elsewhere", count: 4200 },
  ])
  assert.equal(field("outcome"), undefined)
  assert.ok((field("logged")?.distance ?? 0) >= 0.9)
  assert.equal(field("flagged")?.values?.[0].label, "true")
  assert.deepEqual(field("flagged")?.values?.[0].shares, [
    share(late, ({ flagged }) => flagged),
    share(punctual, ({ flagged }) => flagged),
  ])
  assert.deepEqual(field("delay")?.medians, [50, 0])
  assert.equal(field("note"), undefined)
  assert.ok(apart.fields.every((found, at) => at === 0 || apart.fields[at - 1].gap >= found.gap))
  assert.equal(
    await data.compare(runs, "v1", undefined, { filter: { field: "outcome", eq: "late" } }),
    apart,
  )

  const byBerth = await data.compare(runs, "v1", undefined, { by: "berth" })
  assert.equal(byBerth.error, undefined)
  assert.deepEqual(
    byBerth.sets.map(({ label, count }) => [label, count]),
    ["B0", "B1", "B2", "B3", "B4", "B5"].map((label) => [label, 1000]),
  )
  const ran = await data.query(byBerth.query ?? "", folder)
  const columnOf = (name: string) => ran.grid.columns.findIndex((column) => column.name === name)
  const apartFields = byBerth.fields.filter(({ standing }) => standing === "apart")
  assert.ok(apartFields.some(({ medians }) => medians) && apartFields.some(({ values }) => values))
  assert.deepEqual(
    ran.grid.rows.map((row) => [row[0], row[1]]),
    byBerth.sets.map(({ label, count }) => [label, count]),
  )

  for (const { name, values, medians } of apartFields) {
    assert.deepEqual(
      ran.grid.rows.map(
        (row) => row[columnOf(values ? `${name} = ${values[0].label} %` : `median ${name}`)],
      ),
      values ? values[0].shares.map((n) => Math.round(1000 * n) / 10) : medians,
      name,
    )
  }

  const within = await data.compare(runs, "v1", undefined, {
    by: "berth",
    filter: { field: "outcome", eq: "late" },
  })
  const counts = ["B0", "B1", "B2", "B3", "B4", "B5"].map(
    (berth) => [berth, late.filter((record) => record.berth === berth).length] as [string, number],
  )
  assert.deepEqual(
    within.sets.map(({ label, count }) => [label, count]),
    counts.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
  )
  assert.equal(
    within.fields.find(({ name }) => name === "outcome"),
    undefined,
  )
  assert.deepEqual(
    (await data.query(within.query ?? "", folder)).grid.rows.map((row) => [row[0], row[1]]),
    within.sets.map(({ label, count }) => [label, count]),
  )

  assert.match(
    (await data.compare(runs, "v1", undefined, { by: "note" })).error ?? "",
    /compare by a field of 2 to 8 values/,
  )
})

test("a comparison sets apart only what a filter or grouping fixes, names rare values, and lists every field in its query", async () => {
  const folder = file("fixing")
  fs.mkdirSync(folder, { recursive: true })
  const causes = [...["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => `common ${c}`), "rare x"]
  const records = Array.from({ length: 6000 }, (_, i) => {
    const outcome = i % 10 < 3 ? "late" : "on time"
    const level = 1 + (i % 5)
    return {
      outcome,
      logged: i % 50 === 0 ? (outcome === "late" ? "on time" : "late") : outcome,
      delay: outcome === "late" ? 20 + (i % 61) : 0,
      cause: outcome === "late" && i % 3 === 0 ? "rare x" : causes[i % 8],
      level,
      tilt: level === 1 ? "up" : level === 2 ? "down" : ["up", "down"][i % 2],
      active: !(level >= 3 && i % 50 < 5),
      zone: level <= 2 ? "low" : "high",
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_, f) => [`f${f}`, (i % 5) * (f + 1) + (i % 7)]),
      ),
    }
  })
  const runs = path.join(folder, "runs.jsonl")
  fs.writeFileSync(runs, records.map((record) => `${JSON.stringify(record)}\n`).join(""))
  const late = await data.compare(runs, "v1", undefined, {
    filter: { field: "outcome", eq: "late" },
  })
  const standing = (comparison: Comparison, name: string) =>
    comparison.fields.find((found) => found.name === name)?.standing

  assert.equal(late.error, undefined)
  assert.equal(standing(late, "delay"), "apart")
  assert.equal(standing(late, "logged"), "fixed")
  assert.equal(late.fields.find(({ name }) => name === "cause")?.values?.[0].label, "rare x")

  const byLevel = await data.compare(runs, "v1", undefined, { by: "level" })
  const shown = byLevel.fields.filter(({ standing }) => standing === "apart")

  assert.equal(byLevel.error, undefined)
  assert.deepEqual(byLevel.sets.map(({ label }) => label).sort(), ["1", "2", "3", "4", "5"])
  assert.equal(standing(byLevel, "tilt"), "apart")
  assert.equal(standing(byLevel, "active"), "apart")
  assert.equal(standing(byLevel, "zone"), "fixed")
  assert.ok(shown.length > 12, `${shown.length} fields set apart`)
  assert.equal(
    (await data.query(byLevel.query ?? "", folder)).grid.columns.length,
    2 + shown.length,
  )
})

test("comparisons by a field under a filter, asked three at once before any count, all answer", async () => {
  const folder = file("three")
  fs.mkdirSync(folder, { recursive: true })
  const lines = Array.from({ length: 3000 }, (_, i) =>
    JSON.stringify({ kind: ["a", "b", "c"][i % 3], group: `g${i % 4}`, n: i % 11 }),
  ).join("\n")
  const own = new Data(root, fs.mkdtempSync(path.join(os.tmpdir(), "folio-three-")))
  const files = ["one", "two", "three"].map((name) => {
    fs.writeFileSync(path.join(folder, `${name}.jsonl`), lines)
    return path.join(folder, `${name}.jsonl`)
  })
  let timer: NodeJS.Timeout | undefined
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the comparisons never answered")), 30_000)
  })

  try {
    const answered = await Promise.race([
      Promise.all(
        files.map((runs) =>
          own.compare(runs, "v1", undefined, { by: "group", filter: { field: "kind", eq: "a" } }),
        ),
      ),
      stalled,
    ])

    assert.deepEqual(
      answered.map(({ error, sets }) => [error, sets.length]),
      files.map(() => [undefined, 4]),
    )
  } finally {
    clearTimeout(timer)
    await own.close()
  }
})

test("a comparison the time limit stopped runs again when next asked", async () => {
  const own = new Data(root, fs.mkdtempSync(path.join(os.tmpdir(), "folio-recompare-")))
  fs.mkdirSync(file("three"), { recursive: true })
  const duck = await DuckDBInstance.create(file("three/compare.duckdb"))
  const connection = await duck.connect()
  await connection.run(
    "create table t as select ['a', 'b'][range % 2 + 1] as kind, range % 7 as n from range(100)",
  )
  connection.closeSync()
  duck.closeSync()
  const target = file("three/compare.duckdb")
  await own.stats(target, "v1", "t")
  mock.method(
    own,
    "query",
    async () => {
      throw new Error("The query ran longer than 10 s and was stopped.")
    },
    { times: 1 },
  )

  try {
    const stopped = await own.compare(target, "v1", "t", { by: "kind" })
    const again = await own.compare(target, "v1", "t", { by: "kind" })

    assert.match(stopped.error ?? "", /ran longer than/)
    assert.equal(again.error, undefined)
    assert.deepEqual(
      again.sets.map(({ count }) => count),
      [50, 50],
    )
  } finally {
    await own.close()
  }
})

test("a database table counts and filters through the engine, and a filter naming no column says so", async () => {
  const table = await data.stats(file("shop.duckdb"), "v1", "stock", {
    field: "id",
    from: 0,
    to: 10,
  })
  const sqlite = await data.page(file("shop.sqlite"), "v1", "orders", {
    filter: { field: "item", eq: "ink" },
  })
  const missing = await data.stats(file("rows.csv"), "v1", undefined, { field: "nowhere", eq: "x" })

  assert.equal(table.total, 10)
  assert.deepEqual(sqlite.grid?.rows, [[2, "ink"]])
  assert.match(missing.error ?? "", /no column named nowhere/)
})

/** Six readers' copies of one table: `n` holds every number below 6,007 once, as 7919 and 6007 share no factor. */
async function spread(name: string): Promise<string> {
  const folder = file(name)
  fs.mkdirSync(folder, { recursive: true })
  const duck = await DuckDBInstance.create(path.join(folder, "many.duckdb"))
  const connection = await duck.connect()
  const rows = "select (range * 7919) % 6007 as n, 'w' || range as word from range(6007)"

  for (const [name, options] of [
    ["many.csv", "format csv, header"],
    ["many.tsv", "format csv, header, delimiter '\t'"],
    ["many.jsonl", "format json"],
    ["many.parquet", "format parquet"],
  ]) {
    await connection.run(`copy (${rows}) to '${path.join(folder, name)}' (${options})`)
  }

  await connection.run(`create table spread as ${rows}`)
  connection.closeSync()
  duck.closeSync()
  const sqlite = new DatabaseSync(path.join(folder, "many.sqlite"))
  sqlite.exec(
    `begin; create table spread (n integer, word text); ${Array.from({ length: 6007 }, (_, i) => `insert into spread values (${(i * 7919) % 6007}, 'w${i}');`).join(" ")} commit;`,
  )
  sqlite.close()
  return folder
}
