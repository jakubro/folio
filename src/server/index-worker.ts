/** The indexer's worker thread: splits a text into blocks, or gives parsed blocks their identities. */

import { parentPort } from "node:worker_threads"
import { type Block, blocks, identify, type Part } from "./blocks.ts"

type Request = { id: number; previous: Block[] } & (
  | { text: string; kind: "markdown" | "mermaid" }
  | { parts: Part[] }
)

parentPort?.on("message", (request: Request) => {
  const { id, previous } = request

  try {
    parentPort?.postMessage({
      id,
      blocks:
        "parts" in request
          ? identify(request.parts, previous)
          : blocks(request.text, request.kind, previous),
    })
  } catch (error) {
    parentPort?.postMessage({ id, error: (error as Error).message })
  }
})

parentPort?.postMessage({ ready: true })
