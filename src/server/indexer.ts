/** Splits documents into blocks on a worker thread, so a long document never holds up a request. */

import os from "node:os"
import { Worker } from "node:worker_threads"
import type { Block, Part } from "./blocks.ts"

type Request = { previous: Block[] } & (
  | { text: string; kind: "markdown" | "mermaid" }
  | { parts: Part[] }
)

interface Reply {
  ready?: true
  id: number
  blocks?: Block[]
  error?: string
}

interface Waiting {
  request: Request
  resolve: (blocks: Block[]) => void
  reject: (error: Error) => void
}

const IDLE_MS = 10_000
const BESIDE = Math.min(4, Math.max(1, os.availableParallelism() >> 1))

/** No worker could answer: one died before it listened, or the indexer was closed. The text may parse fine. */
export class IndexerDown extends Error {}

export class Indexer {
  readonly #script: URL
  readonly #idleMs: number
  readonly #waiting = new Map<number, Waiting>()
  #worker: Worker | undefined
  #idle: NodeJS.Timeout | undefined
  #closed = false
  #next = 0
  #beside: Indexers | undefined

  constructor(script: URL, idleMs = IDLE_MS) {
    this.#script = script
    this.#idleMs = idleMs
  }

  /** Whether a worker thread is running; one starts with the first request and stops once idle. */
  get running(): boolean {
    return this.#worker !== undefined
  }

  get pending(): number {
    return this.#waiting.size
  }

  /** Threads of their own, closed with this one: work run there never waits behind a document's split. */
  get beside(): Indexers {
    this.#beside ??= new Indexers(this.#script, this.#idleMs)
    return this.#beside
  }

  split(text: string, kind: "markdown" | "mermaid", previous: Block[] = []): Promise<Block[]> {
    return this.#ask({ text, kind, previous })
  }

  /** Give parsed blocks the identities a split with `previous` gives; an `id` left on a part outlives it. */
  identify(parts: Part[], previous: Block[]): Promise<Block[]> {
    return this.#ask({ parts, previous })
  }

  async close(): Promise<void> {
    const worker = this.#worker

    this.#closed = true
    this.#worker = undefined
    clearTimeout(this.#idle)
    this.#reject(new IndexerDown("indexer closed"))
    await Promise.all([worker?.terminate(), this.#beside?.close()])
  }

  #ask(request: Request): Promise<Block[]> {
    if (this.#closed) {
      return Promise.reject(new IndexerDown("indexer closed"))
    }

    return new Promise((resolve, reject) => {
      this.#send(++this.#next, { request, resolve, reject })
    })
  }

  #send(id: number, waiting: Waiting): void {
    this.#worker ??= this.#start()
    clearTimeout(this.#idle)
    this.#waiting.set(id, waiting)
    this.#worker.postMessage({ id, ...waiting.request })
  }

  /** A worker holds hundreds of megabytes once it has parsed a large folder; only a new thread gives them back. */
  #start(): Worker {
    const worker = new Worker(this.#script)
    let ready = false
    worker.unref()
    worker.on("message", ({ ready: listening, id, blocks, error }: Reply) => {
      if (listening) {
        ready = true
        return
      }

      const waiting = this.#waiting.get(id)
      this.#waiting.delete(id)

      if (blocks) {
        waiting?.resolve(blocks)
      } else {
        waiting?.reject(new Error(error))
      }

      if (this.#waiting.size === 0) {
        this.#idle = setTimeout(() => this.#stop(worker), this.#idleMs)
        this.#idle.unref()
      }
    })
    worker.on("error", (error) =>
      this.#died(worker, ready, error instanceof Error ? error : new Error(String(error))),
    )
    worker.on("exit", (code) =>
      this.#died(worker, ready, new Error(`indexer exited with code ${code}`)),
    )
    return worker
  }

  #stop(worker: Worker): void {
    if (this.#worker === worker && this.#waiting.size === 0) {
      this.#worker = undefined
      void worker.terminate()
    }
  }

  /**
   * A worker answers in order, so one that dies once listening dies on the oldest request: that text
   * fails, and the requests behind it go to a new worker. One that never listened is down, failing all.
   */
  #died(worker: Worker, ready: boolean, error: Error): void {
    if (this.#worker !== worker) {
      return
    }

    this.#worker = undefined

    if (!ready) {
      this.#reject(new IndexerDown(error.message))
      return
    }

    const [first, ...rest] = this.#waiting
    this.#waiting.clear()
    first?.[1].reject(error)

    for (const [id, waiting] of rest) {
      this.#send(id, waiting)
    }
  }

  #reject(error: Error): void {
    for (const waiting of this.#waiting.values()) {
      waiting.reject(error)
    }

    this.#waiting.clear()
  }
}

/** Requests run side by side, each on the least busy thread, so answers come in no fixed order. */
export class Indexers {
  readonly #all: Indexer[]

  constructor(script: URL, idleMs = IDLE_MS, count = BESIDE) {
    this.#all = Array.from({ length: count }, () => new Indexer(script, idleMs))
  }

  split(text: string, kind: "markdown" | "mermaid", previous: Block[] = []): Promise<Block[]> {
    return this.#least().split(text, kind, previous)
  }

  identify(parts: Part[], previous: Block[]): Promise<Block[]> {
    return this.#least().identify(parts, previous)
  }

  async close(): Promise<void> {
    await Promise.all(this.#all.map((indexer) => indexer.close()))
  }

  #least(): Indexer {
    return this.#all.reduce((least, indexer) => (indexer.pending < least.pending ? indexer : least))
  }
}
