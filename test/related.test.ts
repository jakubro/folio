import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Embedder } from "../src/server/embedder.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"
import { Related } from "../src/server/related.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))
const WORDS = new URL("../e2e/embed-words.ts", import.meta.url)
const related: Related[] = []

after(async () => {
  for (const one of related) {
    one.close()
  }

  await indexer.close()
})

async function served(files: Record<string, string>): Promise<Model> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-related-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-related-store-"))

  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }

  const model = new Model(root, store, indexer, () => {})
  await model.start()
  return model
}

function relating(model: Model): { related: Related; embedded: string[] } {
  const embedder = new Embedder(WORDS, model.store)
  const embedded: string[] = []
  const embed = embedder.embed.bind(embedder)

  embedder.embed = (texts, query) => {
    embedded.push(...texts)
    return embed(texts, query)
  }

  const one = new Related(model, embedder)
  related.push(one)
  one.start()
  return { related: one, embedded }
}

async function ready(one: Related, urlPath: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const answer = one.near(urlPath, [])

    if (answer.asked && answer.state.status === "ready") {
      return
    }

    assert.ok(tries < 400, `still ${JSON.stringify(answer)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test("only what a declaration places is related, short, lead-in and repeated blocks never are, and vectors outlive a restart", async () => {
  const model = await served({
    "FOLIO.md": "# Rules\n\n```yaml folio\nrelated:\n  - where: kept/**\n```\n",
    "kept/a.md":
      "# A\n\nThe north pump stops when the storage tank is completely full.\n\nCovered by the lease:\n\nToo short to count here.\n\nEvery valve is inspected by the engineer on duty before the shift ends.\n",
    "kept/b.md":
      "# B\n\nWhen the storage tank is completely full the north pump stops.\n\nEvery valve is inspected by the engineer on duty before the shift ends.\n",
    "other/c.md": "# C\n\nThe north pump stops when the storage tank is completely full.\n",
  })
  const { related: first, embedded } = relating(model)
  const ids = (urlPath: string) => (model.held(urlPath) ?? []).map(({ id }) => id)
  const [, pump, lease, short, valve] = ids("kept/a.md")
  const near = (id: string) => {
    const answer = first.near("kept/a.md", [{ source: "kept/a.md", id }])
    assert.ok(answer.asked)
    return answer.related.map(({ path: at, text }) => `${at}: ${text}`)
  }

  await ready(first, "kept/a.md")

  assert.deepEqual(near(pump), [
    "kept/b.md: When the storage tank is completely full the north pump stops.",
  ])
  assert.deepEqual(near(lease), [], "a lead-in line")
  assert.deepEqual(near(short), [], "fewer than six words")
  assert.deepEqual(near(valve), [], "the same words in two documents")
  assert.deepEqual(first.near("other/c.md", []), { asked: false })
  assert.deepEqual(
    embedded.sort(),
    [
      "The north pump stops when the storage tank is completely full.",
      "When the storage tank is completely full the north pump stops.",
      "Every valve is inspected by the engineer on duty before the shift ends.",
    ].sort(),
  )

  first.close()
  const { related: again, embedded: anew } = relating(model)
  await ready(again, "kept/a.md")

  assert.deepEqual(anew, [], "a restart embeds nothing it kept")
  const asked = await again.ask("north pump storage tank")
  assert.ok(asked.asked)
  assert.deepEqual(asked.related.map(({ path: at }) => at).sort(), ["kept/a.md", "kept/b.md"])
})

test("a block relates only within its own declaration's documents, a word-for-word copy stops it being listed, and a torn vector file is mended", async () => {
  const model = await served({
    "east/FOLIO.md": "# East\n\n```yaml folio\nrelated:\n  - where: '**'\n```\n",
    "west/FOLIO.md": "# West\n\n```yaml folio\nrelated:\n  - where: '**'\n```\n",
    "east/a.md": "# A\n\nThe north pump stops when the storage tank is completely full.\n",
    "east/b.md": "# B\n\nThe north pump halts once the storage tank is completely full again.\n",
    "west/c.md": "# C\n\nThe north pump stops when the storage tank is completely full today.\n",
    "empty/FOLIO.md": "# Empty\n\n```yaml folio\nrelated:\n  - where: '*.md'\n```\n",
    "empty/short.md": "# Short\n\nToo few words here.\n",
  })
  const { related: first } = relating(model)
  const [, pump] = (model.held("east/a.md") ?? []).map(({ id }) => id)
  const listed = (one: Related) => {
    const answer = one.near("east/a.md", [{ source: "east/a.md", id: pump }])
    assert.ok(answer.asked)
    return answer.related.map(({ path: at }) => at)
  }

  await ready(first, "east/a.md")
  assert.deepEqual(listed(first), ["east/b.md"], "west/c.md is closer but another declaration's")

  const before = first.version("east/a.md")
  fs.appendFileSync(
    path.join(model.root, "east/a.md"),
    "\nThe north pump halts once the storage tank is completely full again.\n",
  )

  for (let tries = 0; first.version("east/a.md") === before; tries++) {
    assert.ok(tries < 400, "the version never moved")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  await ready(first, "east/a.md")
  assert.deepEqual(listed(first), [], "b.md's paragraph is now written in two documents")

  const empty = first.near("empty/short.md", [])
  assert.ok(empty.asked && empty.state.status === "ready", "nothing to relate is ready, not 0 of 0")

  first.close()
  const file = path.join(model.store, "related", "embeddinggemma-300m-5090578d.vec")
  const whole = fs.statSync(file).size
  fs.appendFileSync(file, Buffer.alloc(100))
  const { related: again, embedded } = relating(model)
  await ready(again, "east/a.md")

  assert.equal(fs.statSync(file).size, whole, "the torn record is cut off")
  assert.deepEqual(embedded, [])
})

test("a text written again after another keeps its blocks' current ids in what is related", async () => {
  const kept = "The north pump stops when the storage tank is completely full today."
  const model = await served({
    "FOLIO.md": "# Root\n\n```yaml folio\nrelated:\n  - where: '**'\n```\n",
    "a.md": "# A\n\nThe north pump stops when the storage tank is completely full.\n",
    "b.md": "# B\n\nThe north pump halts once the storage tank is completely full again.\n",
  })
  const { related: one } = relating(model)
  const paragraph = (urlPath: string) =>
    (model.held(urlPath) ?? []).find(({ kind }) => kind === "paragraph")?.id as string
  const saved = async (text: string) => {
    const before = model.hashOf("a.md")
    fs.writeFileSync(path.join(model.root, "a.md"), text)

    for (let tries = 0; model.hashOf("a.md") === before; tries++) {
      assert.ok(tries < 400, "the save was never read")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await model.settled()
  }

  await ready(one, "a.md")
  await saved(`# A\n\n${kept}\n`)
  await new Promise((resolve) => setTimeout(resolve, 800))
  await ready(one, "a.md")
  await saved("# A\n\nShort.\n")
  await saved(`# A\n\n${kept}\n`)
  await new Promise((resolve) => setTimeout(resolve, 800))
  await ready(one, "a.md")

  const current = paragraph("a.md")
  const near = one.near("a.md", [{ source: "a.md", id: current }])
  const back = one.near("b.md", [{ source: "b.md", id: paragraph("b.md") }])
  assert.ok(near.asked && back.asked)
  assert.deepEqual(
    near.related.map(({ path: at }) => at),
    ["b.md"],
  )
  assert.deepEqual(
    back.related.map(({ path: at, block }) => [at, block]),
    [["a.md", current]],
  )
})
