/** The embedding model on a worker thread, started when there is text to embed and stopped once idle. */

import { Worker } from "node:worker_threads"

export interface Preparing {
  status: "installing" | "downloading"
  done?: number
  total?: number
}

interface Waiting {
  resolve: (vectors: Float32Array) => void
  reject: (error: Error) => void
}

type Reply =
  | { type: "ready" }
  | ({ type: "progress" } & Preparing)
  | { type: "embedded"; id: number; vectors: Float32Array }
  | { type: "failed"; id?: number; message: string }

const IDLE_MS = 60_000

export class Embedder {
  readonly #script: URL
  readonly #cache: string
  readonly #waiting = new Map<number, Waiting>()
  #worker: { thread: Worker; ready: Promise<void> } | undefined
  #idle: NodeJS.Timeout | undefined
  #next = 0
  onProgress: (preparing: Preparing) => void = () => {}

  constructor(script: URL, cache: string) {
    this.#script = script
    this.#cache = cache
  }

  async embed(texts: string[], query = false): Promise<Float32Array[]> {
    const worker = this.#start()
    const id = ++this.#next
    clearTimeout(this.#idle)
    await worker.ready

    const vectors = await new Promise<Float32Array>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject })
      worker.thread.postMessage({ type: "embed", id, texts, query })
    })
    const size = vectors.length / texts.length

    return texts.map((_, index) => vectors.slice(index * size, (index + 1) * size))
  }

  close(): void {
    clearTimeout(this.#idle)
    void this.#worker?.thread.terminate()
    this.#worker = undefined
  }

  #start(): { thread: Worker; ready: Promise<void> } {
    if (this.#worker) {
      return this.#worker
    }

    const thread = new Worker(this.#script)
    let prepared: { resolve: () => void; reject: (error: Error) => void } | undefined
    const ready = new Promise<void>((resolve, reject) => {
      prepared = { resolve, reject }
    })
    const died = (message: string) => {
      if (this.#worker?.thread !== thread) {
        return
      }

      this.#worker = undefined
      prepared?.reject(new Error(message))

      for (const waiting of this.#waiting.values()) {
        waiting.reject(new Error(message))
      }

      this.#waiting.clear()
    }

    ready.catch(() => {})
    thread.unref()
    thread.on("message", (reply: Reply) => {
      if (reply.type === "ready") {
        prepared?.resolve()
      } else if (reply.type === "progress") {
        this.onProgress(reply)
      } else if (reply.type === "failed" && reply.id === undefined) {
        died(reply.message)
        void thread.terminate()
      } else if (reply.id !== undefined) {
        const waiting = this.#waiting.get(reply.id)

        this.#waiting.delete(reply.id)

        if (reply.type === "embedded") {
          waiting?.resolve(reply.vectors)
        } else {
          waiting?.reject(new Error(reply.message))
        }

        this.#rest(thread)
      }
    })
    thread.on("error", (error: Error) => died(error.message))
    thread.on("exit", (code) => died(`the embedding model exited with code ${code}`))
    thread.postMessage({ type: "prepare", cache: this.#cache })
    this.#worker = { thread, ready }
    return this.#worker
  }

  /** The loaded model holds gigabytes; only ending its thread gives them back. */
  #rest(thread: Worker): void {
    if (this.#waiting.size > 0) {
      return
    }

    clearTimeout(this.#idle)
    this.#idle = setTimeout(() => {
      if (this.#worker?.thread === thread && this.#waiting.size === 0) {
        this.#worker = undefined
        void thread.terminate()
      }
    }, IDLE_MS)
    this.#idle.unref()
  }
}
