/** The indexer's worker thread: answers each document's text with its blocks. */

import { parentPort } from "node:worker_threads"
import { type Block, blocks } from "./blocks.ts"

interface Request {
  id: number
  text: string
  kind: "markdown" | "mermaid"
  previous: Block[]
}

parentPort?.on("message", ({ id, text, kind, previous }: Request) => {
  try {
    parentPort?.postMessage({ id, blocks: blocks(text, kind, previous) })
  } catch (error) {
    parentPort?.postMessage({ id, error: (error as Error).message })
  }
})

parentPort?.postMessage({ ready: true })
