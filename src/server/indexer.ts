/** Splits documents into blocks on a worker thread, so a long document never holds up a request. */

import { Worker } from "node:worker_threads";
import type { Block } from "./blocks.ts";

interface Request {
  text: string;
  kind: "markdown" | "mermaid";
  previous: Block[];
}

interface Reply {
  ready?: true;
  id: number;
  blocks?: Block[];
  error?: string;
}

interface Waiting {
  request: Request;
  resolve: (blocks: Block[]) => void;
  reject: (error: Error) => void;
}

const IDLE_MS = 10_000;

/** No worker could answer: one died before it listened, or the indexer was closed. The text may parse fine. */
export class IndexerDown extends Error {}

export class Indexer {
  readonly #script: URL;
  readonly #idleMs: number;
  readonly #waiting = new Map<number, Waiting>();
  #worker: Worker | undefined;
  #idle: NodeJS.Timeout | undefined;
  #closed = false;
  #next = 0;

  constructor(script: URL, idleMs = IDLE_MS) {
    this.#script = script;
    this.#idleMs = idleMs;
  }

  /** Whether a worker thread is running; one starts with the first request and stops once idle. */
  get running(): boolean {
    return this.#worker !== undefined;
  }

  split(text: string, kind: "markdown" | "mermaid", previous: Block[] = []): Promise<Block[]> {
    if (this.#closed) {
      return Promise.reject(new IndexerDown("indexer closed"));
    }

    return new Promise((resolve, reject) => {
      this.#send(++this.#next, { request: { text, kind, previous }, resolve, reject });
    });
  }

  async close(): Promise<void> {
    const worker = this.#worker;

    this.#closed = true;
    this.#worker = undefined;
    clearTimeout(this.#idle);
    this.#reject(new IndexerDown("indexer closed"));
    await worker?.terminate();
  }

  #send(id: number, waiting: Waiting): void {
    this.#worker ??= this.#start();
    clearTimeout(this.#idle);
    this.#waiting.set(id, waiting);
    this.#worker.postMessage({ id, ...waiting.request });
  }

  /** A worker holds hundreds of megabytes once it has parsed a large folder; only a new thread gives them back. */
  #start(): Worker {
    const worker = new Worker(this.#script);
    let ready = false;
    worker.unref();
    worker.on("message", ({ ready: listening, id, blocks, error }: Reply) => {
      if (listening) {
        ready = true;
        return;
      }

      const waiting = this.#waiting.get(id);
      this.#waiting.delete(id);

      if (blocks) {
        waiting?.resolve(blocks);
      } else {
        waiting?.reject(new Error(error));
      }

      if (this.#waiting.size === 0) {
        this.#idle = setTimeout(() => this.#stop(worker), this.#idleMs);
        this.#idle.unref();
      }
    });
    worker.on("error", (error) => this.#died(worker, ready, error));
    worker.on("exit", (code) =>
      this.#died(worker, ready, new Error(`indexer exited with code ${code}`)),
    );
    return worker;
  }

  #stop(worker: Worker): void {
    if (this.#worker === worker && this.#waiting.size === 0) {
      this.#worker = undefined;
      void worker.terminate();
    }
  }

  /**
   * A worker answers in order, so one that dies once listening dies on the oldest request: that text
   * fails, and the requests behind it go to a new worker. One that never listened is down, failing all.
   */
  #died(worker: Worker, ready: boolean, error: Error): void {
    if (this.#worker !== worker) {
      return;
    }

    this.#worker = undefined;

    if (!ready) {
      this.#reject(new IndexerDown(error.message));
      return;
    }

    const [first, ...rest] = this.#waiting;
    this.#waiting.clear();
    first?.[1].reject(error);

    for (const [id, waiting] of rest) {
      this.#send(id, waiting);
    }
  }

  #reject(error: Error): void {
    for (const waiting of this.#waiting.values()) {
      waiting.reject(error);
    }

    this.#waiting.clear();
  }
}
