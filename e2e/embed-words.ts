/** The embedding model's stand-in for tests: a vector counts a text's words, so shared words make texts close. */

import { parentPort } from "node:worker_threads"

const DIMENSIONS = 768
const PREPARE_MS = 1500
const BATCH_MS = 60
const COMMON = new Set(["the", "and", "for", "with", "that", "this", "are", "its", "was", "from"])

parentPort?.on("message", async (request: { type: string; id?: number; texts?: string[] }) => {
  if (request.type === "prepare") {
    parentPort?.postMessage({ type: "progress", status: "downloading", done: 4e8, total: 1.2e9 })
    await new Promise((resolve) => setTimeout(resolve, PREPARE_MS))
    parentPort?.postMessage({ type: "ready" })
    return
  }

  await new Promise((resolve) => setTimeout(resolve, BATCH_MS))
  const texts = request.texts ?? []
  const vectors = new Float32Array(texts.length * DIMENSIONS)

  for (const [index, text] of texts.entries()) {
    const vector = vectors.subarray(index * DIMENSIONS, (index + 1) * DIMENSIONS)

    for (const word of text.toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
      if (!COMMON.has(word)) {
        vector[hash(word) % DIMENSIONS] += 1
      }
    }

    const length = Math.hypot(...vector) || 1
    vector.forEach((value, at) => {
      vector[at] = value / length
    })
  }

  parentPort?.postMessage({ type: "embedded", id: request.id, vectors }, [vectors.buffer])
})

function hash(word: string): number {
  let value = 2166136261

  for (const character of word) {
    value = Math.imul(value ^ (character.codePointAt(0) ?? 0), 16777619) >>> 0
  }

  return value
}
