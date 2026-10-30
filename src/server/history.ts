/** History of a document: its git history merged with the saves folio keeps, and the results each embed showed. */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import zlib from "node:zlib"
import { type Block, versionOf } from "./blocks.ts"
import type { Embedded } from "./data.ts"
import { isInside } from "./files.ts"
import { type Commit, commits, gitText, repositoryOf, tracked } from "./git.ts"
import type { Log } from "./http.ts"

export interface Version {
  /** The git blob id of the version's text, whichever way it was seen. */
  id: string
  /** When it was first seen: saved, committed, or the file's own time. */
  at: number
  seen: ("saved" | "committed" | "file")[]
  by?: string
  removed?: boolean
}

interface Save {
  at: number
  id: string
  removed?: boolean
}

export interface Paired {
  status: "same" | "changed" | "added" | "removed"
  kind: string
  before?: string
  after?: string
}

export interface BlockVersion {
  /** The document version it was read from, and when that version was first seen. */
  version: string
  at: number
  /** Absent where the block was not in the document. */
  text?: string
}

type Split = (text: string, kind: "markdown" | "mermaid", previous?: Block[]) => Promise<Block[]>

export interface ValueResult {
  at: number
  /** A scalar as shown, or a table as its columns, its first rows and how many it had. */
  value?: unknown
  table?: { columns: string[]; rows: unknown[][]; total: number }
  error?: string
}

const DAY_MS = 86_400_000
const KEEP_EVERY_MS = 30 * DAY_MS
const VALUE_ROWS = 200
const VALUES_KEPT = 1000
const BLOCK_VERSIONS = 200
const COMPARED = 2000
const LOG = "saves.log"
const PER_DOCUMENT = 500
const TOTAL_BYTES = 512 * 1024 * 1024
const REMOVED = "0".repeat(40)
const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

export class History {
  readonly #root: string
  readonly #dir: string
  readonly #log: Log
  readonly #split: Split
  readonly #budget: number
  readonly #compared = new Map<string, Paired[]>()
  readonly #lines = new Map<string, number>()
  readonly #trackedFiles = new Map<string, Promise<Set<string>>>()
  #writes = Promise.resolve()

  /** `budget` bounds the bytes of text kept for all documents together. */
  constructor(root: string, store: string, log: Log, split: Split, budget = TOTAL_BYTES) {
    this.#root = root
    this.#dir = path.join(store, "history")
    this.#log = log
    this.#split = split
    this.#budget = budget
  }

  /** Keep a document's new text; each save older than 30 days is thinned to the last of its day. */
  saved(urlPath: string, text: string, at = Date.now()): Promise<void> {
    return this.#queue(() => this.#store(urlPath, text, at))
  }

  removed(urlPath: string, at = Date.now()): Promise<void> {
    return this.#queue(() => this.#append(urlPath, { at, id: REMOVED, removed: true }))
  }

  /** Newest first. */
  async versions(urlPath: string): Promise<Version[]> {
    const file = this.#file(urlPath)

    if (!file) {
      return []
    }

    const log = await readLog(this.#folder(urlPath))
    const saves = log?.saves ?? []
    const events: Version[] = saves.map(({ at, id, removed }) => ({
      id,
      at,
      seen: ["saved"],
      ...(removed && { removed }),
    }))

    // git times a commit to the second.
    // A commit holding a save of that second comes right after it, so the two are one version.
    // Any other commit opens its second, before the saves made later in it.
    for (const commit of await this.#commits(file, log?.was ?? [])) {
      const saved = saves.find(
        ({ id, at }) => id === commit.blob && at >= commit.at && at < commit.at + 1000,
      )

      events.push({
        id: commit.blob,
        at: saved ? saved.at + 0.5 : commit.at,
        seen: ["committed"],
        by: commit.by,
        ...(commit.blob === REMOVED && { removed: true }),
      })
    }

    const now = await fs.promises.readFile(file, "utf8").catch(() => undefined)

    // What is on disk is the newest version, whatever the clocks say.
    if (now !== undefined) {
      const stat = await fs.promises.stat(file)
      const newest = Math.max(stat.mtimeMs, ...events.map(({ at }) => at))
      events.push({ id: blobId(now), at: newest, seen: ["file"] })
    }

    return collapse(events).reverse()
  }

  async text(urlPath: string, id: string): Promise<string | undefined> {
    if (!/^[0-9a-f]{40}$/.test(id) || id === REMOVED) {
      return undefined
    }

    const saved = await fs.promises
      .readFile(path.join(this.#folder(urlPath), `${id}.gz`))
      .then(async (bytes) => (await gunzip(bytes)).toString("utf8"))
      .catch(() => undefined)

    if (saved !== undefined) {
      return saved
    }

    const file = this.#file(urlPath)

    if (!file) {
      return undefined
    }

    const now = await fs.promises.readFile(file, "utf8").catch(() => undefined)

    if (now !== undefined && blobId(now) === id) {
      return now
    }

    // Only a blob git lists for this file or a place it moved from, so no other file's text is read through it.
    const was = (await readLog(this.#folder(urlPath)))?.was ?? []

    for (const at of [file, ...this.#places(was)]) {
      if ((await commits(at, this.#root)).some((commit) => commit.blob === id)) {
        return gitText(at, id)
      }
    }

    return undefined
  }

  async movedTo(urlPath: string): Promise<string | undefined> {
    const documents = path.join(this.#dir, "documents")
    let latest: { path: string; at: number } | undefined

    for (const name of await fs.promises.readdir(documents).catch(() => [])) {
      const log = await readLog(path.join(documents, name))
      const at = Math.max(-1, ...(log?.saves ?? []).map((save) => save.at))

      if (log?.was.includes(urlPath) && (!latest || at > latest.at)) {
        latest = { path: log.path, at }
      }
    }

    return latest?.path
  }

  /**
   * Carry a document's history to where it moved: its saves, the results its embeds showed, and the
   * place it was, whose commits stay part of it.
   */
  rename(from: string, to: string): Promise<void> {
    return this.#queue(async () => {
      const [old, held] = await Promise.all([
        readLog(this.#folder(from)),
        readLog(this.#folder(to)),
      ])
      const saves = [...(old?.saves ?? []).filter((save) => !save.removed), ...(held?.saves ?? [])]
        .sort((a, b) => a.at - b.at)
        .filter(
          (save, index, all) =>
            index === 0 || save.at !== all[index - 1].at || save.id !== all[index - 1].id,
        )
      const was = [...new Set([...(old?.was ?? []), from, ...(held?.was ?? [])])].filter(
        (place) => place !== to,
      )
      const source = this.#folder(from)
      const target = this.#folder(to)

      await fs.promises.mkdir(target, { recursive: true })

      for (const name of await fs.promises.readdir(source).catch(() => [])) {
        if (name.endsWith(".gz")) {
          await fs.promises.rename(path.join(source, name), path.join(target, name))
        }
      }

      await this.#write(to, saves, was)
      await fs.promises.rm(source, { recursive: true, force: true })

      const values = path.join(this.#dir, "values", hash(from))
      const moved = path.join(this.#dir, "values", hash(to))

      for (const name of await fs.promises.readdir(values).catch(() => [])) {
        const kept = await readJson<{ reference: string; results: ValueResult[] }>(
          path.join(values, name),
        )

        if (kept) {
          await fs.promises.mkdir(moved, { recursive: true })
          await writeAtomic(path.join(moved, name), JSON.stringify({ ...kept, from: to }))
        }
      }

      await fs.promises.rm(values, { recursive: true, force: true })
    })
  }

  /** Two versions' blocks side by side, paired by identity as the model pairs them across an edit. */
  async compare(urlPath: string, from: string, to: string): Promise<Paired[] | undefined> {
    // Versions never change, so a comparison made once holds for every later digest and page.
    const key = `${urlPath}\0${from}\0${to}`
    const held = this.#compared.get(key)

    if (held) {
      return held
    }

    const pairs = await this.#compare(urlPath, from, to)

    if (pairs) {
      if (this.#compared.size >= COMPARED) {
        this.#compared.delete(this.#compared.keys().next().value as string)
      }

      this.#compared.set(key, pairs)
    }

    return pairs
  }

  async #compare(urlPath: string, from: string, to: string): Promise<Paired[] | undefined> {
    const [before, after] = await Promise.all([this.text(urlPath, from), this.text(urlPath, to)])

    if (before === undefined || after === undefined) {
      return undefined
    }

    const kind = kindOf(urlPath)
    const left = await this.#split(before, kind)
    const right = await this.#split(after, kind, left)
    const kept = new Set(right.map((block) => block.id))
    const pairs: Paired[] = []
    let next = 0
    // A removed block follows the block it came after, or opens the list when nothing did.
    const flush = () => {
      for (; next < left.length && !kept.has(left[next].id); next++) {
        pairs.push({ status: "removed", kind: left[next].kind, before: left[next].text })
      }
    }

    flush()

    for (const block of right) {
      const was = left.find((other) => other.id === block.id)

      pairs.push(
        was
          ? {
              status: versionOf(was) === versionOf(block) ? "same" : "changed",
              kind: block.kind,
              before: was.text,
              after: block.text,
            }
          : { status: "added", kind: block.kind, after: block.text },
      )

      if (was) {
        next = Math.max(next, left.indexOf(was) + 1)
        flush()
      }
    }

    return pairs
  }

  /**
   * Each text a block had, newest first. Identity is followed backwards from the model's blocks, so
   * the id asked for is the id the page shows; only the newest 200 versions are read.
   */
  async block(urlPath: string, id: string, current: Block[]): Promise<BlockVersion[]> {
    const kind = kindOf(urlPath)
    const found: BlockVersion[] = []
    let newer = current

    for (const version of (await this.versions(urlPath)).slice(0, BLOCK_VERSIONS)) {
      const text = version.removed ? undefined : await this.text(urlPath, version.id)

      if (text === undefined) {
        continue
      }

      newer = await this.#split(text, kind, newer)
      const block = newer.find((other) => other.id === id)
      const last = found.at(-1)

      if (!last || last.text !== block?.text) {
        found.push({ version: version.id, at: version.at, ...(block && { text: block.text }) })
      } else {
        Object.assign(last, { version: version.id, at: version.at })
      }
    }

    return found
  }

  /** Keep a result an embed showed, when it differs from the one before. */
  value(from: string, reference: string, embedded: Embedded, at = Date.now()): Promise<void> {
    const result = resultOf(embedded, at)

    return this.#queue(async () => {
      const file = this.#valueFile(from, reference)
      const held = await this.values(from, reference)
      const last = held.at(-1)

      if (last && same(last, result)) {
        return
      }

      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await writeAtomic(
        file,
        JSON.stringify({ from, reference, results: [...held, result].slice(-VALUES_KEPT) }),
      )
    })
  }

  async values(from: string, reference: string): Promise<ValueResult[]> {
    return (
      (await readJson<{ results: ValueResult[] }>(this.#valueFile(from, reference)))?.results ?? []
    )
  }

  async references(from: string): Promise<string[]> {
    const dir = path.join(this.#dir, "values", hash(from))
    const found: string[] = []

    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      const held = await readJson<{ reference: string }>(path.join(dir, name))

      if (held) {
        found.push(held.reference)
      }
    }

    return found.sort()
  }

  /**
   * Thin every document's saves: older than 30 days the last of each day, at most 500 a document,
   * and, past the budget of kept text in all, the oldest saves of any document but its newest.
   */
  async sweep(now = Date.now()): Promise<void> {
    const documents = path.join(this.#dir, "documents")
    const held: { urlPath: string; saves: Save[]; sizes: Map<string, number>; was: string[] }[] = []

    for (const name of await fs.promises.readdir(documents).catch(() => [])) {
      const dir = path.join(documents, name)
      const log = await readLog(dir)

      if (log) {
        const sizes = new Map<string, number>()

        for (const file of await fs.promises.readdir(dir)) {
          if (file.endsWith(".gz")) {
            sizes.set(file.slice(0, -3), (await fs.promises.stat(path.join(dir, file))).size)
          }
        }

        held.push({ urlPath: log.path, saves: bounded(log.saves, now), sizes, was: log.was })

        if (held.at(-1)?.saves.length !== log.saves.length) {
          await this.#queue(() => this.#write(log.path, bounded(log.saves, now), log.was))
        }
      }
    }

    const kept = (saves: Save[], sizes: Map<string, number>) =>
      [...new Set(saves.map(({ id }) => id))].reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0)
    let total = held.reduce((sum, { saves, sizes }) => sum + kept(saves, sizes), 0)
    const oldest = held
      .flatMap((document) => document.saves.slice(0, -1).map((save) => ({ document, save })))
      .sort((a, b) => a.save.at - b.save.at)
    const touched = new Set<(typeof held)[number]>()

    for (const { document, save } of oldest) {
      if (total <= this.#budget) {
        break
      }

      const before = kept(document.saves, document.sizes)
      document.saves = document.saves.filter((other) => other !== save)
      total -= before - kept(document.saves, document.sizes)
      touched.add(document)
    }

    for (const { urlPath, saves, was } of touched) {
      await this.#queue(() => this.#write(urlPath, saves, was))
    }
  }

  /**
   * Keep the text a document had when folio first knew it, unless git tracks it or folio already
   * keeps its saves: queued before any later save, so an edit soon after start never replaces it.
   */
  firstSeen(urlPath: string, text: string, at: number): Promise<void> {
    const file = path.join(this.#root, urlPath)

    return this.#queue(async () => {
      if (fs.existsSync(this.#folder(urlPath)) || (await this.#tracked(file))) {
        return
      }

      await this.#store(urlPath, text, at)
    })
  }

  async lastDigest(): Promise<number | undefined> {
    return (await readJson<{ last: number }>(path.join(this.#dir, "digest.json")))?.last
  }

  /** Record that the reader saw a digest ending at `to`: never later than now, never moving back. */
  markDigest(to: number, now = Date.now()): Promise<void> {
    const file = path.join(this.#dir, "digest.json")

    return this.#queue(async () => {
      const last = Math.max(Math.min(to, now), (await this.lastDigest()) ?? 0)

      await fs.promises.mkdir(this.#dir, { recursive: true })
      await writeAtomic(file, JSON.stringify({ last }))
    })
  }

  /** The documents folio saw saved or removed in a period, in milliseconds. */
  async savedIn(from: number, to: number): Promise<string[]> {
    const dir = path.join(this.#dir, "documents")
    const found: string[] = []

    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      const log = await readLog(path.join(dir, name))

      if (log?.saves.some(({ at }) => from < at && at <= to)) {
        found.push(log.path)
      }
    }

    return found
  }

  async allValues(): Promise<{ from: string; reference: string; results: ValueResult[] }[]> {
    const dir = path.join(this.#dir, "values")
    const found: { from: string; reference: string; results: ValueResult[] }[] = []

    for (const folder of await fs.promises.readdir(dir).catch(() => [])) {
      for (const name of await fs.promises.readdir(path.join(dir, folder)).catch(() => [])) {
        const held = await readJson<{ from: string; reference: string; results: ValueResult[] }>(
          path.join(dir, folder, name),
        )

        if (held) {
          found.push(held)
        }
      }
    }

    return found
  }

  async #saves(urlPath: string): Promise<Save[]> {
    return (await readLog(this.#folder(urlPath)))?.saves ?? []
  }

  /**
   * A save is one line added to the document's log; the log is written whole only when it has grown
   * to twice what a document keeps, or by the daily sweep.
   */
  async #append(urlPath: string, save: Save): Promise<void> {
    const log = path.join(this.#folder(urlPath), LOG)
    const line = `${JSON.stringify(save)}\n`

    if (!fs.existsSync(log)) {
      await fs.promises.writeFile(log, `${JSON.stringify({ path: urlPath })}\n${line}`)
      this.#lines.set(urlPath, 1)
      return
    }

    await fs.promises.appendFile(log, line)
    const lines = (this.#lines.get(urlPath) ?? (await this.#saves(urlPath)).length - 1) + 1
    this.#lines.set(urlPath, lines)

    if (lines > 2 * PER_DOCUMENT) {
      const log = await readLog(this.#folder(urlPath))
      await this.#write(urlPath, bounded(log?.saves ?? [], save.at), log?.was ?? [])
    }
  }

  async #write(urlPath: string, saves: Save[], was: string[]): Promise<void> {
    const dir = this.#folder(urlPath)
    const kept = new Set(saves.map(({ id }) => `${id}.gz`))
    const head = was.length > 0 ? { path: urlPath, was } : { path: urlPath }
    const lines = [head, ...saves].map((line) => `${JSON.stringify(line)}\n`)

    await fs.promises.mkdir(dir, { recursive: true })
    await writeAtomic(path.join(dir, LOG), lines.join(""))
    this.#lines.set(urlPath, saves.length)

    for (const name of await fs.promises.readdir(dir)) {
      if (name.endsWith(".gz") && !kept.has(name)) {
        await fs.promises.rm(path.join(dir, name), { force: true })
      }
    }
  }

  async #store(urlPath: string, text: string, at: number): Promise<void> {
    const id = blobId(text)
    const dir = this.#folder(urlPath)
    const file = path.join(dir, `${id}.gz`)

    await fs.promises.mkdir(dir, { recursive: true })

    if (!fs.existsSync(file)) {
      await fs.promises.writeFile(file, await gzip(text))
    }

    await this.#append(urlPath, { at, id })
  }

  /** Each repository's tracked files are listed once, the first time a file in it is asked about. */
  async #tracked(file: string): Promise<boolean> {
    const repository = await repositoryOf(path.dirname(file), this.#root)

    if (!repository) {
      return false
    }

    let files = this.#trackedFiles.get(repository)

    if (!files) {
      files = tracked(repository)
      this.#trackedFiles.set(repository, files)
    }

    return (await files).has(file)
  }

  #queue(work: () => Promise<void>): Promise<void> {
    this.#writes = this.#writes
      .then(work)
      .catch((error: Error) => this.#log(`history: ${error.message}`))
    return this.#writes
  }

  /** The document's own file, through any symlink, or where it was: never a file outside the folder. */
  #file(urlPath: string): string | undefined {
    const file = path.join(this.#root, urlPath)

    try {
      fs.lstatSync(file)
    } catch {
      let dir = path.dirname(file)

      while (!fs.existsSync(dir)) {
        dir = path.dirname(dir)
      }

      return isInside(this.#root, fs.realpathSync(dir)) ? file : undefined
    }

    try {
      const real = fs.realpathSync(file)
      return isInside(this.#root, real) ? real : undefined
    } catch {
      return undefined
    }
  }

  async #commits(file: string, was: string[]): Promise<Commit[]> {
    const found = await commits(file, this.#root)

    // The commit removing it from a place it moved from is the move, not the document's end.
    for (const place of this.#places(was)) {
      found.push(...(await commits(place, this.#root)).filter(({ blob }) => blob !== REMOVED))
    }

    return found
  }

  #places(was: string[]): string[] {
    return was.flatMap((place) => {
      const file = path.join(this.#root, place)
      return isInside(this.#root, file) ? [file] : []
    })
  }

  #folder(urlPath: string): string {
    return path.join(this.#dir, "documents", hash(urlPath))
  }

  #valueFile(from: string, reference: string): string {
    return path.join(this.#dir, "values", hash(from), `${hash(reference)}.json`)
  }
}

function kindOf(urlPath: string): "markdown" | "mermaid" {
  return /\.(mermaid|mmd)$/i.test(urlPath) ? "mermaid" : "markdown"
}

/** The id git gives a text as a blob, so a save and a commit of the same text are one version. */
export function blobId(text: string): string {
  const bytes = Buffer.from(text, "utf8")
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

/** In time order, a version seen again at once - saved, then committed minutes later - is one version. */
function collapse(events: Version[]): Version[] {
  const merged: Version[] = []

  for (const event of events.sort((a, b) => a.at - b.at)) {
    const last = merged.at(-1)

    if (last?.id === event.id) {
      last.seen = [...new Set([...last.seen, ...event.seen])]
      last.by ??= event.by
    } else {
      merged.push({ ...event })
    }
  }

  return merged
}

function bounded(saves: Save[], now: number): Save[] {
  return thin(saves, now).slice(-PER_DOCUMENT)
}

/** A document's log: its path, then one save a line; a line cut short by a crash is skipped. */
async function readLog(
  dir: string,
): Promise<{ path: string; saves: Save[]; was: string[] } | undefined> {
  const text = await fs.promises.readFile(path.join(dir, LOG), "utf8").catch(() => undefined)
  const [head, ...lines] = (text ?? "").split("\n").filter(Boolean)
  const parse = (line: string) => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  }
  const header = head && parse(head)

  return header?.path === undefined
    ? undefined
    : {
        path: header.path,
        saves: lines.map(parse).filter((save) => save?.id !== undefined),
        was: header.was ?? [],
      }
}

function thin(saves: Save[], now: number): Save[] {
  const lastOfDay = new Map<string, Save>()

  for (const save of saves) {
    if (now - save.at > KEEP_EVERY_MS) {
      lastOfDay.set(new Date(save.at).toDateString(), save)
    }
  }

  const old = new Set(lastOfDay.values())
  return saves.filter((save) => now - save.at <= KEEP_EVERY_MS || old.has(save))
}

function resultOf(embedded: Embedded, at: number): ValueResult {
  if (embedded.error) {
    return { at, error: embedded.error }
  }

  if (embedded.grid) {
    const { columns, rows, total } = embedded.grid
    return {
      at,
      table: {
        columns: columns.map(({ name }) => name),
        rows: rows.slice(0, VALUE_ROWS),
        total: total ?? rows.length,
      },
    }
  }

  return { at, value: embedded.value }
}

function same(a: ValueResult, b: ValueResult): boolean {
  const { at: _a, ...left } = a
  const { at: _b, ...right } = b
  return JSON.stringify(left) === JSON.stringify(right)
}

/** A file cut short by a crash reads as absent. */
async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.promises.writeFile(`${file}.tmp`, text)
  await fs.promises.rename(`${file}.tmp`, file)
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}
