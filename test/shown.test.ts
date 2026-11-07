import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, test } from "node:test"
import { Data } from "../src/server/data.ts"
import { documentsOf } from "../src/server/documents.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"
import { shownHealth, shownNeeds, shownOf } from "../src/server/shown.ts"
import { served } from "./served.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))

after(() => indexer.close())

const FILES = {
  "FOLIO.md": `# Folder\n\n\`\`\`yaml folio\n${[
    "health:",
    "  - where: '**'",
    "    error: [link]",
    "attention:",
    "  due:",
    "    message: '{path} is due'",
    "    query: select path from 'due.csv'",
  ].join("\n")}\n\`\`\`\n`,
  "a.md": "# A\n\nSee [gone](gone.md).\n",
  "due.csv": "path\na.md\n",
}

const listed = async (model: Model, data: Data) => {
  const { ready, needs } = await shownNeeds(model, data)
  return { ready, needs: needs.map(({ source, path: at }) => `${source} ${at}`) }
}

async function until(test: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; !(await test()); tries++) {
    assert.ok(tries < 400, "timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test("after a restart, what needs you and health answer at once with what they last showed, then each part as worked out again", async () => {
  const { root, store, model, data } = await served(indexer, FILES)

  try {
    await until(async () => (await listed(model, data)).needs.length === 2)
    assert.deepEqual(await listed(model, data), {
      ready: true,
      needs: ["error a.md", "attention a.md"],
    })
    await shownOf(model).flush()
  } finally {
    model.close()
    await data.close()
  }

  fs.writeFileSync(path.join(root, "a.md"), "# A\n\nSee [b](b.md).\n")
  fs.writeFileSync(path.join(root, "b.md"), "# B\n")
  const again = new Model(root, store, indexer, () => {})
  const engine = new Data(root, store)
  engine.useBlocks((file, text) => again.blocksReady(file, text))
  engine.useDocuments(documentsOf(again))
  const starting = again.start()

  try {
    const asked = Date.now()
    const early = await listed(again, engine)
    const health = await shownHealth(again, engine)

    assert.ok(Date.now() - asked < 1000, `answered after ${Date.now() - asked} ms`)
    assert.equal(again.ready, false)
    assert.deepEqual(early, { ready: true, needs: ["error a.md", "attention a.md"] })
    assert.deepEqual(
      health.problems.map(({ kind, path: at }) => `${kind} ${at}`),
      ["link a.md"],
    )

    await starting
    await until(async () => (await listed(again, engine)).needs.length === 1)
    assert.deepEqual(await listed(again, engine), { ready: true, needs: ["attention a.md"] })
    assert.deepEqual((await shownHealth(again, engine)).problems, [])
  } finally {
    again.close()
    await engine.close()
  }
})

test("on a first start nothing is kept: the parts not known yet leave what needs you unready", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "folio-shown-")),
  )
  const store = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "folio-shown-store-"))

  for (const [name, text] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(root, name), text)
  }

  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store)
  data.useBlocks((file, text) => model.blocksReady(file, text))
  data.useDocuments(documentsOf(model))
  const starting = model.start()

  try {
    assert.deepEqual(await listed(model, data), { ready: false, needs: [] })
    assert.equal((await shownHealth(model, data)).ready, false)
    await starting
    await until(async () => (await listed(model, data)).ready)
    assert.deepEqual((await listed(model, data)).needs, ["error a.md", "attention a.md"])
  } finally {
    model.close()
    await data.close()
  }
})
