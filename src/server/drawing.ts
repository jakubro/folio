/** Whether diagrams and charts draw, checked on a worker thread that starts on first use and stops once idle. */

import { Worker } from "node:worker_threads";

interface Waiting {
  resolve: (error: string | undefined) => void;
}

const IDLE_MS = 10_000;

export class Drawing {
  readonly #script: URL;
  readonly #waiting = new Map<number, Waiting>();
  #worker: Worker | undefined;
  #idle: NodeJS.Timeout | undefined;
  #next = 0;

  constructor(script: URL) {
    this.#script = script;
  }

  /** Why a mermaid diagram cannot be drawn, or undefined when it can. */
  diagram(source: string): Promise<string | undefined> {
    return this.#ask({ kind: "diagram", source });
  }

  /** Why a Vega-Lite description, its data already in place, cannot be drawn, or undefined when it can. */
  chart(spec: Record<string, unknown>): Promise<string | undefined> {
    return this.#ask({ kind: "chart", spec });
  }

  #ask(request: object): Promise<string | undefined> {
    const id = ++this.#next;
    this.#worker ??= this.#start();
    clearTimeout(this.#idle);

    return new Promise((resolve) => {
      this.#waiting.set(id, { resolve });
      this.#worker?.postMessage({ id, ...request });
    });
  }

  #start(): Worker {
    const worker = new Worker(this.#script);
    worker.unref();
    worker.on("message", ({ id, error }: { id: number; error?: string }) => {
      this.#waiting.get(id)?.resolve(error);
      this.#waiting.delete(id);

      if (this.#waiting.size === 0) {
        this.#idle = setTimeout(() => {
          if (this.#worker === worker && this.#waiting.size === 0) {
            this.#worker = undefined;
            void worker.terminate();
          }
        }, IDLE_MS);
        this.#idle.unref();
      }
    });
    worker.on("error", (error) => this.#died(worker, error.message));
    worker.on("exit", (code) => this.#died(worker, `the drawing check exited with code ${code}`));
    return worker;
  }

  /** Whatever was waiting on a worker that died is answered with why, so no check hangs. */
  #died(worker: Worker, why: string): void {
    if (this.#worker !== worker) {
      return;
    }

    this.#worker = undefined;

    for (const waiting of this.#waiting.values()) {
      waiting.resolve(`Could not be checked: ${why}`);
    }

    this.#waiting.clear();
  }
}
