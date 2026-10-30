import assert from "node:assert/strict"
import { test } from "node:test"
import { Indexer, IndexerDown } from "../src/server/indexer.ts"

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
