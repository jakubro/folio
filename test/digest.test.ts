import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { digest } from "../src/server/digest.ts"
import type { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"

/** The digest's values come from the kept results alone; no document is parsed. */
const indexer = { split: async () => [], close: async () => {} } as unknown as Indexer

test("a table whose cells moved names the first cell that differs; one moved past the rows kept is left out", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-digest-")))
  const model = new Model(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-digest-store-")),
    indexer,
    () => {},
  )
  const grid = (rows: (string | number)[][], total = rows.length) => ({
    version: "1",
    grid: {
      columns: [
        { name: "pump", type: "VARCHAR" },
        { name: "hours", type: "INTEGER" },
      ],
      rows,
      total,
      partial: total > rows.length,
    },
  })

  await model.history.value(
    "report.md",
    "hours.csv",
    grid([
      ["north", 3],
      ["south", 4],
    ]),
    1000,
  )
  await model.history.value(
    "report.md",
    "hours.csv",
    grid([
      ["north", 3],
      ["south", 5],
    ]),
    2000,
  )
  const many = Array.from({ length: 200 }, (_, i) => [`p${i}`, i])
  await model.history.value("report.md", "long.csv", grid(many, 900), 1000)
  await model.history.value("report.md", "long.csv", { ...grid(many, 900), version: "2" }, 2000)
  const { values } = await digest(root, model, 1500, 3000)

  assert.deepEqual(
    values.map(({ reference, before, after }) => [reference, before, after]),
    [["hours.csv", "a table of 2 rows, row 2 hours: 4", "a table of 2 rows, row 2 hours: 5"]],
  )
  model.close()
})
