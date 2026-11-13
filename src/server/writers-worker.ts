/** The writers check's worker thread: scans every process's descriptors away from requests. */

import { parentPort } from "node:worker_threads"
import { heldForWriting } from "./writers.ts"

parentPort?.on("message", ({ id, file, dev, ino }) => {
  parentPort?.postMessage({ id, held: heldForWriting(file, { dev, ino }) })
})
