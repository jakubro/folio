import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Data, urgently } from "../src/server/data.ts"
import { impactOf } from "../src/server/impact.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))

after(() => indexer.close())

test("what reaches a file is found through includes at any depth, and follows edits", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-store-"))
  const files: Record<string, string> = {
    "pumps.csv": "n\n3\n",
    "parts/count.md": "Pumps: {value: ../pumps.csv#0.n}.\n",
    "report.md": "# Report\n\n{include: parts/count.md}\n",
    "summary.md": "# Summary\n\n{include: /report.md#report}\n",
    "lonely.md": "# Lonely\n",
  }

  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }

  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store)
  const impact = impactOf(model, data)

  try {
    await model.start()

    assert.deepEqual(await impact.dependents("pumps.csv"), [
      { source: "parts/count.md", how: "embeds" },
      { source: "report.md", how: "embeds" },
      { source: "summary.md", how: "embeds" },
    ])
    assert.deepEqual(await impact.dependents("parts/count.md"), [
      { source: "report.md", how: "includes" },
      { source: "summary.md", how: "includes" },
    ])
    assert.deepEqual(await impact.dependents("lonely.md"), [])
    assert.deepEqual(
      (await impact.dependencies("summary.md")).map(({ path: p, how }) => [p, how]),
      [
        ["report.md", "includes"],
        ["parts/count.md", "includes"],
        ["pumps.csv", "embeds"],
      ],
    )

    fs.writeFileSync(path.join(root, "report.md"), "# Report\n\nNothing included now.\n")
    await waitFor(async () => (await impact.dependents("parts/count.md")).length === 0)
    assert.deepEqual(await impact.dependents("pumps.csv"), [
      { source: "parts/count.md", how: "embeds" },
    ])
  } finally {
    model.close()
    await data.close()
  }
})

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !(await condition()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  assert.ok(await condition(), "the condition never held")
}

test("an escaped include reaches nothing", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-store-"))
  fs.writeFileSync(path.join(root, "part.md"), "Part.\n")
  fs.writeFileSync(path.join(root, "page.md"), "Shown as text: \\{include: part.md}\n")
  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store)

  try {
    await model.start()
    assert.deepEqual(await impactOf(model, data).dependents("part.md"), [])
  } finally {
    model.close()
    await data.close()
  }
})

test("a dependency saved after a read, before its hash is kept, is named", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-store-"))
  fs.writeFileSync(path.join(root, "pumps.csv"), "n\n3\n")
  fs.writeFileSync(path.join(root, "report.md"), "# Report\n\nPumps: {value: pumps.csv#0.n}.\n")
  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store)
  const impact = impactOf(model, data)

  try {
    await model.start()
    const at = Date.now() - 60_000
    const hashes = await impact.hashes("report.md", at)

    assert.deepEqual(
      (await impact.upstream("report.md", { at, depended: { at, hashes } })).map(
        ({ path: p, how }) => [p, how],
      ),
      [["pumps.csv", "embeds"]],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a page a tab waits on gets its dependencies at once while the catch-up they wait on was started by work no tab waits on", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-lane-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-impact-lane-store-"))
  fs.writeFileSync(path.join(root, "t.csv"), "a\n1\n")
  fs.writeFileSync(path.join(root, "q.sql"), "select * from 't.csv'")
  fs.writeFileSync(path.join(root, "page.md"), "# Page\n\n{table: q.sql}\n")
  fs.writeFileSync(path.join(root, "other.md"), "# Other\n\n{table: q.sql}\n")
  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store, 4000)
  const impact = impactOf(model, data)
  const slow = "select sum(hash(a.range + b.range)) from range(200000) a, range(200000) b"
  const background: Promise<unknown>[] = []

  try {
    await model.start()
    await impact.refresh()
    background.push(...[1, 2].map(() => data.query(slow, root).catch((error: Error) => error)))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = model.hashOf("other.md")
    fs.writeFileSync(path.join(root, "other.md"), "# Other\n\nSaved again.\n\n{table: q.sql}\n")

    while (model.hashOf("other.md") === before) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await model.settled()
    void impact.dependents("t.csv")
    const started = Date.now()
    const found = await urgently(() => impact.dependencies("page.md"))

    assert.deepEqual(
      found.map(({ path: depended }) => depended),
      ["q.sql", "t.csv"],
    )
    assert.ok(Date.now() - started < 2000, `the page waited ${Date.now() - started} ms`)
  } finally {
    await Promise.all(background)
    model.close()
    await data.close()
  }
})
