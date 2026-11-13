import assert from "node:assert/strict"
import { test } from "node:test"
import { blocks } from "../src/server/blocks.ts"
import { Indexer, IndexerDown, Indexers } from "../src/server/indexer.ts"

const WORKER = new URL("../src/server/index-worker.ts", import.meta.url)

test("the worker stops once idle and starts again for the next request", async () => {
  const indexer = new Indexer(WORKER, 100)

  assert.deepEqual(
    (await indexer.split("# x", "markdown")).map((block) => block.kind),
    ["heading"],
  )
  assert.equal(indexer.running, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(indexer.running, false)
  assert.deepEqual(
    (await indexer.split("Words.", "markdown")).map((block) => block.kind),
    ["paragraph"],
  )
  await indexer.close()
})

test("a closed indexer refuses every request at once instead of leaving it waiting", async () => {
  const indexer = new Indexer(WORKER)

  await indexer.split("# x", "markdown")
  await indexer.close()
  await assert.rejects(indexer.split("# x", "markdown"), /closed/)
})

test("a worker that dies mid-request fails that request at once, and the next one runs on a new worker", async () => {
  const indexer = new Indexer(new URL("./exiting-worker.ts", import.meta.url))

  await assert.rejects(indexer.split("exit", "markdown"), /exited/)
  assert.deepEqual(
    (await indexer.split("# x", "markdown")).map((block) => block.kind),
    ["heading"],
  )
  await indexer.close()
})

test("a text that brings the worker down fails alone, and the requests waiting behind it are answered", async () => {
  const indexer = new Indexer(new URL("./exiting-worker.ts", import.meta.url))
  const [crashed, behind] = await Promise.allSettled([
    indexer.split("exit", "markdown"),
    indexer.split("# x", "markdown"),
  ])

  assert.equal(crashed.status, "rejected")
  assert.ok(!((crashed as PromiseRejectedResult).reason instanceof IndexerDown))
  assert.deepEqual(behind.status === "fulfilled" && behind.value.map((block) => block.kind), [
    "heading",
  ])
  await indexer.close()
})

test("a worker that cannot start fails every request as down", async () => {
  const indexer = new Indexer(new URL("./no-such-worker.ts", import.meta.url))

  await assert.rejects(indexer.split("# x", "markdown"), IndexerDown)
  await indexer.close()
})

test("parsed blocks given identities on the worker match a split carrying the previous version", async () => {
  const indexer = new Indexer(WORKER)
  const before = blocks("# Title\n\nFirst words here.\n\nSecond words.\n", "markdown")
  const after = "# Title\n\nNew opening.\n\nFirst words here, reworded.\n\nSecond words.\n"
  const parts = blocks(after, "markdown").map(({ id: _, ...part }) => part)

  assert.deepEqual(await indexer.identify(parts, before), blocks(after, "markdown", before))
  await indexer.close()
})

test("texts sent to indexers at once split side by side, each on a thread of its own", async () => {
  const indexers = new Indexers(new URL("./slow-worker.ts", import.meta.url), 10_000, 2)
  // Both threads started first, so the time measured is the splits' and not a loaded machine's start-up.
  await Promise.all([indexers.split("# Warm", "markdown"), indexers.split("# Up", "markdown")])
  const started = performance.now()
  const split = await Promise.all([
    indexers.split("# One", "markdown"),
    indexers.split("# Two", "markdown"),
  ])
  const took = performance.now() - started

  assert.deepEqual(
    split.map((found) => found.map((block) => block.text)),
    [["# One"], ["# Two"]],
  )
  assert.ok(took < 900, `two half-second splits took ${Math.round(took)} ms`)
  await indexers.close()
  await assert.rejects(indexers.split("# x", "markdown"), /closed/)
})

test("an indexer's threads beside it close with it", async () => {
  const indexer = new Indexer(WORKER)

  await indexer.beside.split("# x", "markdown")
  await indexer.close()
  await assert.rejects(indexer.beside.split("# x", "markdown"), /closed/)
})
