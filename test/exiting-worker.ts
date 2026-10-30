/** The real parsing worker, except that it exits mid-request when asked to parse "exit". */

import { parentPort } from "node:worker_threads"

parentPort?.on("message", ({ text }: { text: string }) => {
  if (text === "exit") {
    process.exit(1)
  }
})

await import("../src/server/index-worker.ts")
