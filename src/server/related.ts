/** Blocks related by meaning across the documents a declaration names, by an embedding model on this machine. */

import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { type Block, titleOf } from "./blocks.ts"
import { conventionsOf } from "./conventions.ts"
import { Embedder, type Preparing } from "./embedder.ts"
import type { Model } from "./model.ts"

export type RelatedState =
  | Preparing
  | { status: "indexing"; done: number; total: number }
  | { status: "ready" }
  | { status: "failed"; message: string }

export interface Neighbour {
  path: string
  block: string
  lines: [number, number]
  /** The document's h1 when it has exactly one. */
  title: string | null
  text: string
  closeness: number
}

export type RelatedAnswer =
  | { asked: false }
  | { asked: true; state: RelatedState; related: Neighbour[]; version: string }

interface Entry {
  path: string
  block: Block
  key: string
  text: string
  by: string[]
}

interface Corpus {
  entries: Entry[]
  inSeveralDocuments: Set<string>
}

const MODEL_KEY = "embeddinggemma-300m-5090578d"
const RELATED_KINDS = new Set(["paragraph", "list", "table", "quote", "footnote"])
const MIN_WORDS = 6
const LEAD_IN_WORDS = 12
const CLOSE_ENOUGH = 0.65
const CLOSE_ENOUGH_ASKED = 0.45
const SHOWN = 8
const BATCH = 16
const TEXT = 200
const KEY_BYTES = 20
const DIMENSIONS = 768
const WAIT_MS = 500
const TELL_MS = 1000
const RETRY_MS = 300_000
const RELATEDS = new WeakMap<Model, Related>()
const WORKER = process.env.FOLIO_EMBED_WORKER
  ? pathToFileURL(process.env.FOLIO_EMBED_WORKER)
  : new URL(
      import.meta.url.endsWith(".ts") ? "./embed-worker.ts" : "./embed-worker.js",
      import.meta.url,
    )

export function relatedOf(model: Model): Related {
  let related = RELATEDS.get(model)

  if (!related) {
    related = new Related(model, new Embedder(WORKER, cacheDir()))
    RELATEDS.set(model, related)
  }

  return related
}

export class Related {
  readonly #model: Model
  readonly #embedder: Embedder
  readonly #file: string
  readonly #vectors = new Map<string, Float32Array>()
  readonly #listeners = new Set<() => void>()
  #state: RelatedState | undefined
  #corpus: Corpus | undefined
  readonly #entries = new Map<string, { stamp: string; entries: Entry[] }>()
  #loaded: Promise<void> | undefined
  #writing = Promise.resolve()
  #indexing = false
  #again = false
  #generation = 0
  #timer: NodeJS.Timeout | undefined
  #retry: NodeJS.Timeout | undefined
  #indexed = ""
  #told = 0
  #failedAt = 0

  constructor(model: Model, embedder: Embedder) {
    this.#model = model
    this.#embedder = embedder
    this.#file = path.join(model.store, "related", `${MODEL_KEY}.vec`)
    embedder.onProgress = (preparing) => this.#set(preparing)
  }

  start(): void {
    this.#model.listen(() => {
      this.#corpus = undefined
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => void this.#index(), WAIT_MS)
      this.#timer.unref()
    })
    void this.#index()
  }

  listen(listener: () => void): void {
    this.#listeners.add(listener)
  }

  version(urlPath: string): string {
    return conventionsOf(this.#model).relates(urlPath) ? this.#version() : "off"
  }

  /** The blocks elsewhere closest to the given blocks taken together, closest first. */
  near(urlPath: string, blocks: { source: string; id: string }[]): RelatedAnswer {
    if (!conventionsOf(this.#model).relates(urlPath)) {
      return { asked: false }
    }

    const state = this.#state ?? { status: "indexing", done: 0, total: 0 }

    if (state.status !== "ready") {
      return { asked: true, state, related: [], version: this.#version() }
    }

    const corpus = this.#corpusNow()
    const within = new Set(conventionsOf(this.#model).relatedBy(urlPath))
    const asked = new Set(blocks.map(({ source, id }) => `${source}\n${id}`))
    const vectors = corpus.entries
      .filter(
        ({ path, block, key }) =>
          asked.has(`${path}\n${block.id}`) && !corpus.inSeveralDocuments.has(key),
      )
      .flatMap(({ key }) => this.#vectors.get(key) ?? [])
    const away = new Set([urlPath, ...blocks.map(({ source }) => source)])

    return {
      asked: true,
      state,
      related:
        vectors.length > 0 ? this.#nearest(mean(vectors), corpus, away, CLOSE_ENOUGH, within) : [],
      version: this.#version(),
    }
  }

  async ask(question: string): Promise<RelatedAnswer> {
    const corpus = this.#corpusNow()

    if (corpus.entries.length === 0) {
      return { asked: false }
    }

    const state = this.#state ?? { status: "indexing", done: 0, total: 0 }

    if (state.status !== "ready") {
      return { asked: true, state, related: [], version: this.#version() }
    }

    const [vector] = await this.#embedder.embed([question], true)

    return {
      asked: true,
      state,
      related: this.#nearest(vector, corpus, new Set(), CLOSE_ENOUGH_ASKED),
      version: this.#version(),
    }
  }

  /** Resolves once every vector embedded so far is on disk, so a start after it embeds none of them again. */
  async close(): Promise<void> {
    this.#embedder.close()
    await this.#writing
  }

  #version(): string {
    const state = this.#state

    return [
      state?.status ?? "waiting",
      state && "done" in state ? state.done : "",
      this.#generation,
    ].join(":")
  }

  #nearest(
    vector: Float32Array,
    corpus: Corpus,
    away: Set<string>,
    least: number,
    within?: Set<string>,
  ): Neighbour[] {
    const seen = new Set<string>()
    const scored: { entry: Entry; closeness: number }[] = []

    for (const entry of corpus.entries) {
      const found = this.#vectors.get(entry.key)
      const once = `${entry.path}\n${entry.key}`

      if (
        !found ||
        away.has(entry.path) ||
        (within && !entry.by.some((declaration) => within.has(declaration))) ||
        corpus.inSeveralDocuments.has(entry.key) ||
        seen.has(once)
      ) {
        continue
      }

      seen.add(once)
      const closeness = dot(vector, found)

      if (closeness >= least) {
        scored.push({ entry, closeness })
      }
    }

    return scored
      .sort((a, b) => b.closeness - a.closeness)
      .slice(0, SHOWN)
      .map(({ entry: { path: at, block, text }, closeness }) => ({
        path: at,
        block: block.id,
        lines: block.lines,
        title: titleOf(this.#model.held(at) ?? []) ?? null,
        text: text.slice(0, TEXT),
        closeness: Math.round(closeness * 1000) / 1000,
      }))
  }

  async #index(): Promise<void> {
    if (this.#indexing) {
      this.#again = true
      return
    }

    this.#indexing = true

    try {
      do {
        this.#again = false
        this.#loaded ??= this.#load()
        await this.#loaded

        if (!this.#model.ready) {
          continue
        }

        const { entries } = this.#corpusNow()
        const keys = new Map(entries.map(({ key, text }) => [key, text]))
        const indexed = createHash("sha1")
          .update(
            entries.map(({ path: at, block, key }) => `${at}\n${block.id}\n${key}`).join("\n"),
          )
          .digest("hex")

        // Blocks moved, renamed or repeated change what a page lists without any new vector.
        if (indexed !== this.#indexed) {
          this.#indexed = indexed
          this.#generation++
        }

        // A batch is padded to its longest text, so texts of a length are embedded together.
        const missing = [...keys]
          .filter(([key]) => !this.#vectors.has(key))
          .sort(([, a], [, b]) => a.length - b.length)

        if (keys.size === 0) {
          this.#set({ status: "ready" })
          continue
        }

        if (missing.length > 0 && Date.now() - this.#failedAt < RETRY_MS) {
          continue
        }

        // A save's few changed blocks are embedded behind the lists already shown.
        const quiet = this.#state?.status === "ready" && missing.length <= BATCH

        for (let start = 0; start < missing.length && !this.#again; start += BATCH) {
          if (!quiet) {
            this.#set({
              status: "indexing",
              done: keys.size - missing.length + start,
              total: keys.size,
            })
          }

          const batch = missing.slice(start, start + BATCH)
          const vectors = await this.#embedder.embed(batch.map(([, text]) => text))

          for (const [index, [key]] of batch.entries()) {
            this.#vectors.set(key, vectors[index])
          }

          this.#generation++
          this.#keep(batch.map(([key], index) => [key, vectors[index]]))
        }

        if (!this.#again) {
          this.#set({ status: "ready" })
          this.#compact(new Set(keys.keys()))
        }
      } while (this.#again)
    } catch (error) {
      this.#failedAt = Date.now()
      this.#set({ status: "failed", message: (error as Error).message })
      clearTimeout(this.#retry)
      this.#retry = setTimeout(() => void this.#index(), RETRY_MS)
      this.#retry.unref()
    } finally {
      this.#indexing = false
    }
  }

  #corpusNow(): Corpus {
    this.#corpus ??= corpusOf(this.#model, this.#entries)
    return this.#corpus
  }

  #set(state: RelatedState | undefined): void {
    const changed = state?.status !== this.#state?.status
    this.#state = state

    if (changed || Date.now() - this.#told >= TELL_MS) {
      this.#told = Date.now()

      for (const listener of this.#listeners) {
        listener()
      }
    }
  }

  async #load(): Promise<void> {
    const held = await fs.promises.readFile(this.#file).catch(() => undefined)
    const size = KEY_BYTES + DIMENSIONS * 4

    // A record cut short by a crash would shift every record appended after it.
    if (held && held.length % size !== 0) {
      await fs.promises.truncate(this.#file, held.length - (held.length % size))
    }

    for (let at = 0; held && at + size <= held.length; at += size) {
      const key = held.subarray(at, at + KEY_BYTES).toString("hex")
      const vector = new Float32Array(DIMENSIONS)

      Buffer.from(vector.buffer).set(held.subarray(at + KEY_BYTES, at + size))
      this.#vectors.set(key, vector)
    }
  }

  #keep(found: [string, Float32Array][]): void {
    const records = Buffer.concat(
      found.flatMap(([key, vector]) => [Buffer.from(key, "hex"), Buffer.from(vector.buffer)]),
    )

    this.#writing = this.#writing
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.#file), { recursive: true })
        await fs.promises.appendFile(this.#file, records)
      })
      .catch((error: Error) => this.#model.log(`related: ${error.message}`, "warning"))
  }

  #compact(live: Set<string>): void {
    const gone = [...this.#vectors.keys()].filter((key) => !live.has(key))

    if (gone.length <= live.size) {
      return
    }

    for (const key of gone) {
      this.#vectors.delete(key)
    }

    const records = Buffer.concat(
      [...this.#vectors].flatMap(([key, vector]) => [
        Buffer.from(key, "hex"),
        Buffer.from(vector.buffer),
      ]),
    )

    this.#writing = this.#writing
      .then(async () => {
        await fs.promises.writeFile(`${this.#file}.tmp`, records)
        await fs.promises.rename(`${this.#file}.tmp`, this.#file)
      })
      .catch((error: Error) => this.#model.log(`related: ${error.message}`, "warning"))
  }
}

/** Where Folio keeps what it fetches once for every folder it serves: the runtime and the model. */
function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache"), "folio")
}

function corpusOf(model: Model, kept: Map<string, { stamp: string; entries: Entry[] }>): Corpus {
  const conventions = conventionsOf(model)
  const entries: Entry[] = []
  const documents = new Map<string, Set<string>>()
  const seen = new Set<string>()

  for (const urlPath of model.paths()) {
    const by = conventions.relatedBy(urlPath)

    if (by.length === 0) {
      continue
    }

    const ids = (model.held(urlPath) ?? []).map(({ id }) => id)
    const stamp = [model.hashOf(urlPath), ...by, ...ids].join("\0")
    const held = kept.get(urlPath)
    const own = held?.stamp === stamp ? held.entries : entriesOf(urlPath, model.held(urlPath), by)

    kept.set(urlPath, { stamp, entries: own })
    seen.add(urlPath)

    for (const entry of own) {
      entries.push(entry)
      documents.set(entry.key, (documents.get(entry.key) ?? new Set()).add(urlPath))
    }
  }

  for (const urlPath of kept.keys()) {
    if (!seen.has(urlPath)) {
      kept.delete(urlPath)
    }
  }

  return {
    entries,
    inSeveralDocuments: new Set(
      [...documents].filter(([, held]) => held.size > 1).map(([key]) => key),
    ),
  }
}

function entriesOf(urlPath: string, blocks: Block[] | undefined, by: string[]): Entry[] {
  return (blocks ?? []).flatMap((block) => {
    const text = plain(block.text)
    const words = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0

    if (
      !RELATED_KINDS.has(block.kind) ||
      words < MIN_WORDS ||
      (text.endsWith(":") && words < LEAD_IN_WORDS)
    ) {
      return []
    }

    const key = createHash("sha1").update(text.toLowerCase()).digest("hex")
    return [{ path: urlPath, block, key, text, by }]
  })
}

function plain(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/[*_`~|#]+|-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function mean(vectors: Float32Array[]): Float32Array {
  const sum = new Float32Array(vectors[0].length)

  for (const vector of vectors) {
    for (let index = 0; index < vector.length; index++) {
      sum[index] += vector[index]
    }
  }

  const length = Math.hypot(...sum) || 1
  return sum.map((value) => value / length)
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0

  for (let index = 0; index < a.length; index++) {
    sum += a[index] * b[index]
  }

  return sum
}
