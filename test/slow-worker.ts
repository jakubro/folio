/** The real parsing worker, except that it holds its thread for half a second before each request. */

import { parentPort } from "node:worker_threads"

parentPort?.on("message", () => {
  const until = Date.now() + 500

  while (Date.now() < until) {}
})

await import("../src/server/index-worker.ts")
