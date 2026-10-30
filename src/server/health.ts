/**
 * Everything wrong in the folder, worked out from the model on request: contradicted figures, broken links
 * and includes, diagrams and charts that do not draw, failing queries and data that cannot be read.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import GithubSlugger from "github-slugger"
import { chartSpec } from "../client/charts.ts"
import { problemKey } from "../client/problems.ts"
import { MARKED, unmarked } from "../client/unresolved.ts"
import type { Block } from "./blocks.ts"
import {
  CHECKS,
  conventionsOf,
  DECLARATION,
  type Declaration,
  type RuleDefinition,
} from "./conventions.ts"
import { type Data, timedOut } from "./data.ts"
import { Drawing } from "./drawing.ts"
import { type Fence, fencesOf, queryFences } from "./embeds.ts"
import { confine, isInside, linkTarget } from "./files.ts"
import { type Expansion, expand } from "./includes.ts"
import type { Model } from "./model.ts"
import { claimStates } from "./provenance.ts"
import { savedOf } from "./saved.ts"
import { fileVersion, pageState } from "./versions.ts"

type ProblemKind = (typeof CHECKS)[number]

export interface Problem {
  kind: ProblemKind
  path: string
  line: number
  block?: string
  /** The element to land on when it is not the whole block, such as an include's marker. */
  anchor?: string
  /** The document showing the problem, when another than its own: a loop shows on the other page. */
  opens?: string
  /** How much a problem matters: a rule's as the rule declares it, another an error where health declares it. */
  severity?: "error" | "warning"
  /** Which of a rule's rows reading alike, at one place, this is: absent on the first, then 1, 2... */
  occurrence?: number
  what: string
}

export interface HealthState {
  ready: boolean
  problems: Problem[]
  /** Names the problems listed: the same version, the same problems. */
  version: string
}

/** What changed since a version a tab holds: the problems added, and the keys of those gone. */
export interface HealthDelta {
  ready: true
  since: string
  version: string
  added: Problem[]
  removed: string[]
}

interface Checked {
  key: string
  problems: Problem[]
  dirs: string[]
  files: string[]
  /** The document tables it read, `folio.<name>` or `kind.<name>`, each read with their version then. */
  tables: TablesRead[]
}

/**
 * What one document contributes, and what its result depends on besides its own text: the stamp of
 * every file it read or looked for, so a restart knows whether the result still holds.
 */
interface DocumentCheck {
  hash: string
  problems: Problem[]
  dirs: Set<string>
  links: Set<string>
  includes: Set<string>
  stamps: Record<string, string>
  diagrams: Record<string, string | null>
  /** The document tables it read, each read with their version then: it holds until one moves. */
  tables: TablesRead[]
  /** The kinds its fields name documents of by id. */
  names: string[]
}

interface TablesRead {
  tables: string[]
  version: string
}

interface Stored {
  format: number
  path: string
  check: Omit<DocumentCheck, "dirs" | "links" | "includes"> & {
    dirs: string[]
    links: string[]
    includes: string[]
  }
  data?: Checked
}

const KINDS: readonly ProblemKind[] = CHECKS
const DOCUMENT = /\.(md|markdown|mermaid|mmd)$/i
const INCLUDE = /\{include:/
const CHART = /^\s*(`{3,}|~{3,})\s*vega-lite\b/
const HTML_ID = /\b(?:id|name)\s*=\s*["']([^"']+)["']/g
const NO_HTML = new Set(["code", "diagram", "math", "frontmatter"])
const SLICE = 100
const LOG_KEPT = 100
const FORMAT = 3
const RETRY_MS = 30_000
const BATCH = 64

const DRAW_WORKER = new URL(
  import.meta.url.endsWith(".ts") ? "./draw-worker.ts" : "./draw-worker.js",
  import.meta.url,
)
const HEALTHS = new WeakMap<Model, Health>()

/** The one health of a model, so every caller shares its checks. */
export function healthOf(model: Model, data: Data): Health {
  let health = HEALTHS.get(model)

  if (!health) {
    health = new Health(model, data, new Drawing(DRAW_WORKER))
    HEALTHS.set(model, health)
  }

  return health
}

/** Every anchor a document's page draws, counted over the page as drawn, includes and all. */
export function anchorsOf(model: Model, urlPath: string): Set<string> {
  const own = model.held(urlPath) ?? []
  const file = path.join(model.root, urlPath)
  const placed = own.some((block) => INCLUDE.test(block.text))
    ? pageState(model.root, file, model).blocks.flatMap(
        ({ source, id }) => model.held(source)?.find((block) => block.id === id) ?? [],
      )
    : own

  return anchorsIn(placed)
}

/** The anchors blocks draw: their headings' slugs, and the ids inline HTML gives itself. */
export function anchorsIn(blocks: Block[]): Set<string> {
  const slugger = new GithubSlugger()
  const found = new Set<string>()

  for (const block of blocks) {
    for (const { text, id } of block.headings ?? []) {
      found.add(id ?? slugger.slug(text))
    }

    for (const [, id] of NO_HTML.has(block.kind) ? [] : block.text.matchAll(HTML_ID)) {
      found.add(id)
    }
  }

  return found
}

class Health {
  readonly #root: string
  readonly #store: string
  readonly #model: Model
  readonly #data: Data
  readonly #drawing: Drawing
  readonly #diagrams = new Map<string, Promise<string | undefined>>()
  readonly #checked = new Map<string, Checked>()
  readonly #documents = new Map<string, DocumentCheck>()
  /** Documents whose result read document tables, and the documents a change named since the last check. */
  readonly #readers = new Set<string>()
  readonly #written = new Map<string, string>()
  /** The documents naming each kind's documents by id, and the generation of its ids they were checked at. */
  readonly #naming = new Map<string, Set<string>>()
  readonly #generations = new Map<string, number>()
  readonly #pending = new Set<string>()
  #everything = true
  readonly #ruleRuns = new Map<string, { key: string; problems: Problem[] }>()
  readonly #linkedBy = new Map<string, Set<string>>()
  readonly #includedBy = new Map<string, Set<string>>()
  readonly #byDir = new Map<string, Set<string>>()
  readonly #found = new Map<string, Map<string, Problem>>()
  readonly #moved = new Set<string>()
  readonly #touched = new Set<string>()
  readonly #listeners = new Set<() => void>()
  readonly #boot = Date.now().toString(36)
  readonly #log: { from: string; added: Problem[]; changed: string[]; removed: string[] }[] = []
  readonly #waiting = new Set<string>()
  readonly #checkingNow = new Set<string>()
  readonly #timedOut = new Set<string>()
  readonly #gone = new Set<string>()
  #retry: NodeJS.Timeout | undefined
  readonly #problems = new Map<string, Problem>()
  #sorted: { revision: number; problems: Problem[] } | undefined
  #scope = "[]"
  #dirs: string[] | undefined
  #revision = 0
  #stale = true
  #running: Promise<void> | undefined
  #progress: { checked: number; of: number } | undefined
  #next: Promise<void> | undefined
  #loaded: Promise<void> | undefined
  #saving = Promise.resolve()

  constructor(model: Model, data: Data, drawing: Drawing) {
    this.#root = model.root
    this.#store = path.join(model.store, "health")
    this.#model = model
    this.#data = data
    this.#drawing = drawing
    model.listen((changed) => {
      if (changed === undefined) {
        this.#everything = true
      } else {
        for (const urlPath of changed) {
          this.#pending.add(urlPath)
        }
      }

      this.#changed()
    })
    model.listenFolders((dir) => this.heard(dir))
    savedOf(model, data).listen((urlPath) => {
      this.#touched.add(urlPath)
      this.#changed()
    })
  }

  /** Wait for every result already worked out to be kept, so a restart finds it. */
  flush(): Promise<void> {
    return this.#saving
  }

  /** Hear when health may have moved; checking it says whether it did. */
  listen(listener: () => void): void {
    this.#listeners.add(listener)
  }

  /** The latest check's count, kept once it ends; `of` counts only what it checks again. */
  get progress(): { checked: number; of: number } | undefined {
    return this.#progress
  }

  /** The folder's problems, checked again only where something changed since the last check. */
  async state(): Promise<HealthState> {
    const version = await this.checkedVersion()

    return version
      ? { ready: true, problems: this.#sortedProblems(), version }
      : { ready: false, problems: [], version: "" }
  }

  /**
   * The version health is at once checked again where something changed, after every change heard.
   * Empty until the folder is read.
   */
  async checkedVersion(): Promise<string> {
    if (!this.#model.ready) {
      return ""
    }

    await this.#model.settled()

    if (this.#stale || this.#running) {
      await this.#checking()
    }

    return this.#version()
  }

  /** Only what changed since the version a tab holds, or everything when that version is gone. */
  async since(version: string): Promise<HealthState | HealthDelta> {
    const now = await this.checkedVersion()
    const from = this.#log.findIndex((entry) => entry.from === version)

    if (!now || (from < 0 && version !== now)) {
      return this.state()
    }

    const added = new Map<string, Problem>()
    const removed = new Set<string>()
    // Problems first listed after the tab's version: one gone again was never the tab's to remove.
    const fresh = new Set<string>()

    for (const entry of from < 0 ? [] : this.#log.slice(from)) {
      for (const problem of entry.added) {
        const key = problemKey(problem)

        if (!entry.changed.includes(key) && !removed.has(key)) {
          fresh.add(key)
        }

        added.set(key, problem)
        removed.delete(key)
      }

      for (const key of entry.removed) {
        added.delete(key)

        if (!fresh.delete(key)) {
          removed.add(key)
        }
      }
    }

    return {
      ready: true,
      since: version,
      version: now,
      added: [...added.values()],
      removed: [...removed],
    }
  }

  /** A call while a check runs gets the check that starts after it, so it sees every change before it. */
  #checking(): Promise<void> {
    if (this.#running) {
      this.#next ??= this.#running
        .catch(() => {})
        .then(() => {
          this.#next = undefined
          return this.#checking()
        })
      return this.#next
    }

    this.#stale = false
    this.#running = this.#check().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  #changed(): void {
    this.#stale = true

    // A part include whose blocks were still parsing is checked again once the model moves.
    for (const urlPath of this.#waiting) {
      this.#touched.add(urlPath)
    }

    this.#waiting.clear()
    this.#notify()
  }

  /** Hear a folder in which a file changed: a new folder is heard as its parent, so held ones below count. */
  heard(dir: string): void {
    const inside = `${dir}${path.sep}`
    let reached = false

    for (const [held, readers] of this.#byDir) {
      if (held === dir || held.startsWith(inside)) {
        for (const urlPath of readers) {
          this.#touched.add(urlPath)
        }

        reached = true
      }
    }

    // A document being checked holds no result yet, so what changed under it is checked again after.
    for (const urlPath of this.#checkingNow) {
      this.#touched.add(urlPath)
      reached = true
    }

    if (reached) {
      this.#changed()
    }
  }

  /** The folders whose files the folder's documents read or link to, where a change may move health. */
  get dirs(): string[] {
    this.#dirs ??= [...this.#byDir.keys()]
    return this.#dirs
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**
   * A document is checked again when its text changed, when a file it includes or a document it
   * links to changed, or when a folder holding what it reads or links to changed.
   */
  async #check(): Promise<void> {
    this.#progress = undefined
    this.#loaded ??= this.#load()
    await this.#loaded
    const changed = this.#everything ? this.#model.paths() : [...this.#pending]
    const everything = this.#everything
    this.#everything = false
    this.#pending.clear()

    if (everything) {
      for (const urlPath of this.#documents.keys()) {
        if (this.#model.hashOf(urlPath) === undefined) {
          changed.push(urlPath)
        }
      }
    }

    const reached = new Set(
      changed.filter(
        (urlPath) => this.#documents.get(urlPath)?.hash !== this.#model.hashOf(urlPath),
      ),
    )

    for (const urlPath of this.#gone) {
      reached.add(urlPath)
    }

    this.#gone.clear()

    for (const urlPath of reached) {
      for (const holder of this.#includedBy.get(urlPath) ?? []) {
        reached.add(holder)
      }
    }

    // A changed declaration may place, read and scope any document.
    if ([...reached].some((urlPath) => path.posix.basename(urlPath) === DECLARATION)) {
      for (const urlPath of this.#model.paths()) {
        reached.add(urlPath)
      }
    }

    const conventions = conventionsOf(this.#model)

    for (const [kind, naming] of this.#naming) {
      const generation = conventions.generation(kind)

      if (this.#generations.get(kind) !== generation) {
        this.#generations.set(kind, generation)

        for (const urlPath of naming) {
          this.#touched.add(urlPath)
        }
      }
    }

    const dirty = new Set([...reached, ...this.#touched, ...this.#timedOut])
    this.#touched.clear()

    // A result read from document tables holds until a change reaches one of them.
    // A declaration never checked yet is checked, as its kinds and rules may list something.
    if (dirty.size > 0) {
      for (const declaration of conventions.all()) {
        const kinds = Object.keys(declaration.kinds).length + Object.keys(declaration.rules).length

        if (kinds > 0 && !this.#documents.has(declaration.path)) {
          dirty.add(declaration.path)
        }
      }

      for (const urlPath of this.#readers) {
        const check = this.#documents.get(urlPath)

        const moved = check?.tables.some(
          ({ tables, version }) => this.#data.documentsVersion(tables) !== version,
        )

        if (!check || moved) {
          dirty.add(urlPath)
        }
      }
    }

    for (const urlPath of reached) {
      for (const linker of this.#linkedBy.get(urlPath) ?? []) {
        dirty.add(linker)
      }
    }

    const exists = new Map<string, boolean>()
    const anchors = new Map<string, Set<string>>()
    const queue = [...dirty]
    const progress = { checked: 0, of: queue.length }
    this.#progress = progress

    for (let start = 0; start < queue.length; start += SLICE) {
      await new Promise((resolve) => setImmediate(resolve))

      for (const urlPath of queue.slice(start, start + SLICE)) {
        const hash = this.#model.hashOf(urlPath)
        this.#forget(urlPath)

        if (hash !== undefined) {
          this.#checkingNow.add(urlPath)
          this.#remember(urlPath, await this.#document(urlPath, hash, exists, anchors))
          this.#checkingNow.delete(urlPath)
        }

        progress.checked++
      }
    }

    this.#gather()
    this.#save(queue)
    this.#retryTimedOut(queue)
  }

  /** A check that only ran out of time is tried again with every later check, and after a pause meanwhile. */
  #retryTimedOut(checked: string[]): void {
    for (const urlPath of checked) {
      if (this.#documents.get(urlPath)?.problems.some(({ what }) => timedOut(what))) {
        this.#timedOut.add(urlPath)
      } else {
        this.#timedOut.delete(urlPath)
      }
    }

    clearTimeout(this.#retry)

    if (this.#timedOut.size > 0) {
      this.#retry = setTimeout(() => this.#changed(), RETRY_MS)
      this.#retry.unref()
    }
  }

  /** A kept result whose links reach a document changed meanwhile is checked again through that document. */
  async #load(): Promise<void> {
    const stamps = new Map<string, string>()

    const names = await fs.promises.readdir(this.#store).catch(() => [])
    const files = names.map((name) => path.join(this.#store, name))
    const read: (Stored | undefined)[] = []

    for (let start = 0; start < files.length; start += BATCH) {
      read.push(...(await Promise.all(files.slice(start, start + BATCH).map(readJson<Stored>))))
    }

    for (const [index, held] of read.entries()) {
      const file = files[index]

      if (!held || held.format !== FORMAT || this.#model.hashOf(held.path) === undefined) {
        // A document gone while folio was stopped is a change its linkers must hear of.
        if (held && this.#model.hashOf(held.path) === undefined) {
          this.#gone.add(held.path)
        }

        await fs.promises.rm(file, { force: true })
        continue
      }

      const { check, data } = held
      const current = Object.entries(check.stamps).every(([at, stamp]) => {
        const now = stamps.get(at) ?? stampOf(at)
        stamps.set(at, now)
        return now === stamp
      })

      if (this.#model.hashOf(held.path) !== check.hash || !current || check.tables.length > 0) {
        continue
      }

      this.#remember(held.path, {
        ...check,
        dirs: new Set(check.dirs),
        links: new Set(check.links),
        includes: new Set(check.includes),
      })

      if (data) {
        this.#checked.set(held.path, data)
      }

      if (check.problems.some(({ what }) => timedOut(what))) {
        this.#timedOut.add(held.path)
      }

      for (const [key, error] of Object.entries(check.diagrams)) {
        this.#diagrams.set(key, Promise.resolve(error ?? undefined))
      }
    }
  }

  /** A file cut short by a stop fails to parse, and its document is checked anew. */
  #save(paths: string[]): void {
    this.#saving = this.#saving.then(async () => {
      await fs.promises.mkdir(this.#store, { recursive: true })

      for (let start = 0; start < paths.length; start += BATCH) {
        await Promise.all(paths.slice(start, start + BATCH).map((urlPath) => this.#write(urlPath)))
      }
    })
  }

  async #write(urlPath: string): Promise<void> {
    const file = path.join(this.#store, `${hash(urlPath)}.json`)
    const check = this.#documents.get(urlPath)

    try {
      if (check) {
        const stored: Stored = {
          format: FORMAT,
          path: urlPath,
          check: {
            ...check,
            dirs: [...check.dirs],
            links: [...check.links],
            includes: [...check.includes],
          },
          data: this.#checked.get(urlPath),
        }
        const text = JSON.stringify(stored)
        const written = hash(text)

        // A result checked again and found the same is not written again.
        if (this.#written.get(urlPath) !== written) {
          await fs.promises.writeFile(file, text)
          this.#written.set(urlPath, written)
        }
      } else {
        await fs.promises.rm(file, { force: true })
        this.#written.delete(urlPath)
      }
    } catch (error) {
      this.#model.log(`health: cannot store ${urlPath}: ${(error as Error).message}`)
    }
  }

  async #document(
    urlPath: string,
    hash: string,
    exists: Map<string, boolean>,
    anchors: Map<string, Set<string>>,
  ): Promise<DocumentCheck> {
    const blocks = this.#model.held(urlPath) ?? []
    const check: DocumentCheck = {
      hash,
      problems: [],
      dirs: new Set(),
      links: new Set(),
      includes: new Set(),
      stamps: {},
      diagrams: {},
      tables: [],
      names: [],
    }
    const read: string[] = []

    check.problems.push(...this.#links(urlPath, blocks, exists, anchors, check))

    const conventions = conventionsOf(this.#model)

    for (const { line, block, what } of conventions.declaration(urlPath)?.problems ?? []) {
      check.problems.push({ kind: "declaration", path: urlPath, line, block, what })
    }

    // A value that does not fit its field is the document's own problem.
    // An id it names moves with the kind holding that id, so the kinds it names are kept to check it again by.
    const own = conventions.document(urlPath)

    for (const { line, what } of own?.problems ?? []) {
      const block = blocks.find((found) => within(found, line))
      check.problems.push({
        kind: "field",
        path: urlPath,
        line,
        ...(block && { block: block.id }),
        what,
      })
    }

    check.names = [...new Set((own?.references ?? []).map(({ to }) => to))]

    for (const { line, what } of savedOf(this.#model, this.#data).problems(urlPath)) {
      const block = blocks.find((found) => within(found, line))
      check.problems.push({
        kind: "view",
        path: urlPath,
        line,
        ...(block && { block: block.id }),
        what,
      })
    }

    const declaration = conventions.declaration(urlPath)

    for (const [name, rule] of Object.entries(declaration?.rules ?? {})) {
      check.problems.push(
        ...(await this.#rule(declaration as Declaration, name, rule, check, read)),
      )
    }

    if (blocks.some((block) => INCLUDE.test(block.text))) {
      check.problems.push(...this.#includes(urlPath, check))
    }

    // Diagrams, charts and queries are checked as the page shows them, includes expanded.
    const shown = blocks.some(
      (block) => block.kind === "diagram" || block.queries || CHART.test(block.text),
    )
      ? expand(this.#root, path.join(this.#root, urlPath), (target, text) =>
          this.#model.blocksReady(target, text),
        )
      : undefined
    const fences = shown ? fencesOf(shown) : []

    check.problems.push(...(await this.#diagramsOf(urlPath, blocks, shown, fences, check)))

    if (
      blocks.some(
        (block) => block.references || block.queries || block.claims || CHART.test(block.text),
      )
    ) {
      const checked = await this.#dataOf(urlPath, blocks, fences)
      check.problems.push(...checked.problems)
      check.tables.push(...checked.tables)
      read.push(...checked.files)

      for (const dir of checked.dirs) {
        check.dirs.add(dir)
      }
    } else {
      this.#checked.delete(urlPath)
    }

    for (const dir of [...check.dirs]) {
      if (!isInside(this.#root, dir)) {
        check.dirs.delete(dir)
      }
    }

    for (const at of [...[...check.includes].map((name) => path.join(this.#root, name)), ...read]) {
      check.stamps[at] = stampOf(at)
    }

    return check
  }

  #remember(urlPath: string, check: DocumentCheck): void {
    this.#documents.set(urlPath, check)

    if (check.tables.length > 0) {
      this.#readers.add(urlPath)
    }

    for (const kind of check.names) {
      this.#naming.set(kind, (this.#naming.get(kind) ?? new Set()).add(urlPath))
    }

    for (const target of check.links) {
      this.#linkedBy.set(target, (this.#linkedBy.get(target) ?? new Set()).add(urlPath))
    }

    for (const target of check.includes) {
      this.#includedBy.set(target, (this.#includedBy.get(target) ?? new Set()).add(urlPath))
    }

    for (const dir of check.dirs) {
      const readers = this.#byDir.get(dir)

      if (readers) {
        readers.add(urlPath)
      } else {
        this.#byDir.set(dir, new Set([urlPath]))
        this.#dirs = undefined
      }
    }

    const own = new Map<string, Problem>()

    for (const problem of check.problems) {
      const key = problemKey(problem)
      const held = own.get(key)

      if (!held || rank(problem) < rank(held)) {
        own.set(key, problem)
      }
    }

    for (const [key, problem] of own) {
      const found = this.#found.get(key) ?? new Map<string, Problem>()
      this.#found.set(key, found.set(urlPath, problem))
      this.#moved.add(key)
    }
  }

  #forget(urlPath: string): void {
    const held = this.#documents.get(urlPath)

    for (const target of held?.links ?? []) {
      this.#linkedBy.get(target)?.delete(urlPath)
    }

    for (const target of held?.includes ?? []) {
      this.#includedBy.get(target)?.delete(urlPath)
    }

    for (const dir of held?.dirs ?? []) {
      const readers = this.#byDir.get(dir)
      readers?.delete(urlPath)

      if (readers?.size === 0) {
        this.#byDir.delete(dir)
        this.#dirs = undefined
      }
    }

    for (const problem of held?.problems ?? []) {
      const key = problemKey(problem)
      const found = this.#found.get(key)
      found?.delete(urlPath)

      if (found?.size === 0) {
        this.#found.delete(key)
      }

      this.#moved.add(key)
    }

    for (const kind of held?.names ?? []) {
      this.#naming.get(kind)?.delete(urlPath)
    }

    this.#documents.delete(urlPath)
    this.#readers.delete(urlPath)

    if (!this.#model.hashOf(urlPath)) {
      this.#checked.delete(urlPath)
    }
  }

  /**
   * The same include problem is found from every page expanding it: one entry, opening its own
   * page when that page shows it, or else the first such page by path, whatever order checks ran in.
   */
  #gather(): void {
    const added: [string, Problem][] = []
    const removed: string[] = []
    const conventions = conventionsOf(this.#model)
    const scope = JSON.stringify(
      conventions
        .all()
        .map(({ path: at, health }) => [
          at,
          health.map(({ where, skip, error }) => [where.map(String), skip, error]),
        ]),
    )

    // A change to what health skips moves every problem: each is judged again against the new scope.
    if (scope !== this.#scope) {
      this.#scope = scope

      for (const key of [...this.#found.keys(), ...this.#problems.keys()]) {
        this.#moved.add(key)
      }
    }

    for (const key of this.#moved) {
      let best: Problem | undefined

      for (const problem of this.#found.get(key)?.values() ?? []) {
        if (!best || rank(problem) < rank(best)) {
          best = problem
        }
      }

      if (best && conventions.skips(best.path, best.kind)) {
        best = undefined
      } else if (best && conventions.errs(best.path, best.kind)) {
        best = { ...best, severity: "error" }
      }

      if (!best) {
        if (this.#problems.has(key)) {
          removed.push(key)
        }
      } else if (!same(this.#problems.get(key), best)) {
        added.push([key, best])
      }
    }

    this.#moved.clear()

    if (added.length + removed.length === 0) {
      return
    }

    const from = this.#version()
    this.#revision++
    this.#log.push({
      from,
      added: added.map(([, problem]) => problem),
      changed: added.flatMap(([key]) => (this.#problems.has(key) ? [key] : [])),
      removed,
    })

    for (const key of removed) {
      this.#problems.delete(key)
    }

    for (const [key, problem] of added) {
      this.#problems.set(key, problem)
    }

    this.#log.splice(0, Math.max(0, this.#log.length - LOG_KEPT))
  }

  #version(): string {
    return `${this.#boot}-${this.#revision}`
  }

  #sortedProblems(): Problem[] {
    if (this.#sorted?.revision !== this.#revision) {
      const problems = [...this.#problems.values()].sort(
        (a, b) =>
          KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
          a.line - b.line,
      )
      this.#sorted = { revision: this.#revision, problems }
    }

    return this.#sorted.problems
  }

  #links(
    urlPath: string,
    blocks: Block[],
    exists: Map<string, boolean>,
    anchors: Map<string, Set<string>>,
    check: DocumentCheck,
  ): Problem[] {
    const found: Problem[] = []

    for (const block of blocks) {
      for (const { url } of block.links ?? []) {
        const target = linkTarget(urlPath, url)

        if (!target || target.path === ".." || target.path.startsWith("../")) {
          continue
        }

        check.links.add(target.path)
        let there = exists.get(target.path)

        if (there === undefined) {
          there =
            this.#model.hashOf(target.path) !== undefined ||
            (fs.existsSync(path.join(this.#root, target.path)) &&
              confine(this.#root, target.path) !== undefined)
          exists.set(target.path, there)
        }

        const at = { path: urlPath, line: block.lines[0], block: block.id }

        // A document's arrival or loss reaches the model; any other file's only a watch of its folder.
        if (!this.#model.hashOf(target.path)) {
          const file = path.join(this.#root, target.path)
          check.dirs.add(path.dirname(file))
          check.stamps[file] = stampOf(file)
        }

        if (!there) {
          found.push({ kind: "link", ...at, what: `Links to ${target.path}, which is not there` })
          continue
        }

        const fragment = target.fragment

        if (!fragment || !DOCUMENT.test(target.path)) {
          continue
        }

        if (fragment.startsWith("^")) {
          if (!this.#model.held(target.path)?.some((other) => other.id === fragment.slice(1))) {
            found.push({
              kind: "link",
              ...at,
              what: `Links to a block no longer in ${target.path}: #${fragment}`,
            })
          }

          continue
        }

        let known = anchors.get(target.path)

        if (!known) {
          known = anchorsOf(this.#model, target.path)
          anchors.set(target.path, known)
        }

        if (!known.has(fragment) && !known.has(fragment.replace(/^user-content-/, ""))) {
          found.push({
            kind: "link",
            ...at,
            what: `Links to a heading not in ${target.path}: #${fragment}`,
          })
        }
      }
    }

    return found
  }

  #includes(urlPath: string, check: DocumentCheck): Problem[] {
    const expansion = expand(this.#root, path.join(this.#root, urlPath), (target, text) =>
      this.#model.blocksReady(target, text),
    )

    if (expansion.partial) {
      this.#waiting.add(urlPath)
    }

    for (const file of expansion.files) {
      check.dirs.add(path.dirname(file))
      check.includes.add(path.relative(this.#root, file).split(path.sep).join("/"))
    }

    return expansion.problems.flatMap(({ file, line, column, target, why }) => {
      if (!isInside(this.#root, file)) {
        return []
      }

      const holder = path.relative(this.#root, file).split(path.sep).join("/")
      const block = this.#model.held(holder)?.find((found) => within(found, line))
      return [
        {
          kind: why === "loop" ? "loop" : "include",
          path: holder,
          line,
          ...(block && { block: block.id }),
          anchor: `include-${holder}:${line}:${column}`,
          ...(holder !== urlPath && { opens: urlPath }),
          what:
            why === "loop"
              ? `Includes ${target}, which leads back to itself`
              : `Includes ${target}, which is not there`,
        } satisfies Problem,
      ]
    })
  }

  /** Rows below a deeper declaration naming the same rule are that rule's to judge. */
  async #rule(
    declaration: Declaration,
    name: string,
    rule: RuleDefinition,
    check: DocumentCheck,
    read: string[],
  ): Promise<Problem[]> {
    const folder = path.join(this.#root, declaration.folder)
    const broken = (what: string): Problem[] => [
      {
        kind: "rule",
        severity: rule.severity,
        path: declaration.path,
        line: rule.line,
        block: rule.block,
        what: `The rule ${name} cannot run: ${what}`,
      },
    ]
    const {
      files,
      missing,
      tables = [],
      dirs = [],
    } = await this.#data.queryReads(path.join(folder, DECLARATION), rule.query)
    const reads = [
      ...files.map((name) => path.join(this.#root, name)),
      ...(missing ? [missing] : []),
    ]

    const version = this.#data.documentsVersion(tables)

    if (tables.length > 0) {
      check.tables.push({ tables, version })
    }

    for (const file of reads) {
      check.dirs.add(path.dirname(file))
      read.push(file)
    }

    for (const dir of dirs) {
      check.dirs.add(dir)
    }

    // A rule runs again only once what it reads, or the declaration holding it, has changed.
    const key = hash(
      [
        JSON.stringify(rule),
        this.#model.hashOf(declaration.path),
        version,
        ...reads.map((file) => fileVersion(file) ?? file),
      ].join("\0"),
    )
    const at = `${declaration.path}\0${name}`
    const ran = this.#ruleRuns.get(at)

    if (ran?.key === key) {
      return ran.problems
    }

    const problems = await this.#ruleRows(declaration, name, rule, folder, broken)

    if (!problems.some(({ what }) => timedOut(what))) {
      this.#ruleRuns.set(at, { key, problems })
    }

    return problems
  }

  async #ruleRows(
    declaration: Declaration,
    name: string,
    rule: RuleDefinition,
    folder: string,
    broken: (what: string) => Problem[],
  ): Promise<Problem[]> {
    const { grid, error } = await this.#data.embedQuery(rule.query, folder, "", "")

    if (!grid) {
      return broken(error ?? "it returns no rows.")
    }

    const names = grid.columns.map((column) => column.name)

    if (!names.includes("path")) {
      return broken("it returns no path column, so its violations land nowhere.")
    }

    const judged = conventionsOf(this.#model)
      .all()
      .filter(
        (other) =>
          other !== declaration &&
          other.rules[name] &&
          (!declaration.folder || other.folder.startsWith(`${declaration.folder}/`)),
      )
      .map((other) => `${other.folder}/`)

    const alike = new Map<string, number>()
    const listed = grid.rows.flatMap((row) => {
      const record = Object.fromEntries(names.map((column, index) => [column, row[index]]))
      const at = String(record.path ?? "")

      if (
        (declaration.folder && !at.startsWith(`${declaration.folder}/`)) ||
        judged.some((folder) => at.startsWith(folder))
      ) {
        return []
      }

      const line = Number(record.line) > 0 ? Number(record.line) : 1
      const block =
        typeof record.block === "string"
          ? record.block
          : this.#model.held(at)?.find((found) => within(found, line))?.id
      const what = rule.message.replace(/\{(\w+)\}/g, (all, column: string) =>
        Object.hasOwn(record, column) ? String(record[column] ?? "") : all,
      )

      const key = `${at}\0${line}\0${what}`
      const occurrence = alike.get(key) ?? 0
      alike.set(key, occurrence + 1)

      return [
        {
          kind: "rule",
          severity: rule.severity,
          path: at,
          line,
          ...(block !== undefined && { block }),
          ...(occurrence > 0 && { occurrence }),
          what,
        } satisfies Problem,
      ]
    })

    if (grid.partial) {
      const counted = await this.#data.embedQuery(
        `select count(*) as n from (${rule.query})`,
        folder,
        "",
        "",
      )
      const all = Number(counted.grid?.rows[0]?.[0] ?? Number.NaN)
      const shown = grid.rows.length.toLocaleString("en")
      listed.push({
        kind: "rule",
        severity: rule.severity,
        path: declaration.path,
        line: rule.line,
        block: rule.block,
        what: `The rule ${name} returns more rows than health lists: ${shown} of ${Number.isNaN(all) ? "more" : all.toLocaleString("en")} shown.`,
      })
    }

    return listed
  }

  /** A diagram missing an include is listed for that include alone, as its page does not draw it. */
  async #diagramsOf(
    urlPath: string,
    blocks: Block[],
    shown: Expansion | undefined,
    fences: Fence[],
    check: DocumentCheck,
  ): Promise<Problem[]> {
    const found: Problem[] = []
    const whole = /\.(mermaid|mmd)$/i.test(urlPath)
    const diagrams = whole
      ? blocks.slice(0, 1).map((block) => ({
          block,
          source: unmarked(shown?.text ?? block.text),
          unresolved: (shown?.text ?? "").includes(MARKED),
        }))
      : fences.flatMap((fence) => {
          const block = blocks.find((held) => within(held, fence.line))
          return fence.lang === "mermaid" && block
            ? [{ block, source: fence.text, unresolved: fence.unresolved }]
            : []
        })

    for (const { block, source, unresolved } of diagrams) {
      if (unresolved) {
        continue
      }

      const key = hash(source)
      let checking = this.#diagrams.get(key)

      if (!checking) {
        checking = this.#drawing.diagram(source)
        this.#diagrams.set(key, checking)
      }

      const error = await checking
      check.diagrams[key] = error ?? null

      if (error) {
        found.push({
          kind: "diagram",
          path: urlPath,
          line: block.lines[0],
          block: block.id,
          what: `The diagram cannot be drawn: ${error}`,
        })
      }
    }

    return found
  }

  /**
   * Run whenever the document is checked again; a result is reused only while the versions of what it
   * read are unchanged and it found nothing wrong, since a missing file's arrival changes no version.
   */
  async #dataOf(urlPath: string, blocks: Block[], fences: Fence[]): Promise<Checked> {
    const file = path.join(this.#root, urlPath)
    const versions: string[] = []
    const dirs = new Set<string>([path.dirname(file)])
    const read = new Set<string>()
    const readTables: TablesRead[] = []

    for (const block of blocks) {
      for (const reference of block.references ?? []) {
        const {
          files,
          version,
          missing,
          tables = [],
          dirs: matched = [],
        } = await this.#data.reads(file, reference)
        versions.push(`${reference}\0${version}`)

        for (const dir of matched) {
          dirs.add(dir)
        }

        if (tables.length > 0) {
          readTables.push({ tables, version: this.#data.documentsVersion(tables) })
        }

        for (const found of files) {
          read.add(found)
        }

        if (missing) {
          read.add(missing)
        }

        for (const read of [...files, ...(missing ? [missing] : [])]) {
          dirs.add(path.dirname(read))
        }
      }
    }

    for (const { sql } of queryFences(fences)) {
      versions.push(sql)
      const {
        files,
        missing,
        tables = [],
        dirs: matched = [],
      } = await this.#data.queryReads(file, sql)
      versions.push(...files.map((name) => fileVersion(path.join(this.#root, name)) ?? name))

      for (const dir of matched) {
        dirs.add(dir)
      }

      if (tables.length > 0) {
        const read = { tables, version: this.#data.documentsVersion(tables) }
        versions.push(read.version)
        readTables.push(read)
      }

      for (const name of files) {
        read.add(path.join(this.#root, name))
      }

      if (missing) {
        read.add(missing)
      }

      for (const read of [
        ...files.map((name) => path.join(this.#root, name)),
        ...(missing ? [missing] : []),
      ]) {
        dirs.add(path.dirname(read))
      }
    }

    const key = hash(`${this.#model.hashOf(urlPath)}\0${versions.join("\0")}`)
    const held = this.#checked.get(urlPath)

    if (held?.key === key && held.problems.length === 0) {
      return held
    }

    const problems: Problem[] = []

    for (const block of blocks) {
      problems.push(...(await this.#blockData(urlPath, file, block, fences)))
    }

    const checked = {
      key,
      problems,
      dirs: [...dirs].filter((dir) => isInside(this.#root, dir)),
      files: [...read],
      tables: readTables,
    }
    this.#checked.set(urlPath, checked)
    return checked
  }

  async #blockData(
    urlPath: string,
    file: string,
    block: Block,
    fences: Fence[],
  ): Promise<Problem[]> {
    const at = { path: urlPath, line: block.lines[0], block: block.id }
    const found: Problem[] = []
    const tied = new Set(block.claims?.map((claim) => claim.reference))
    const own = fences.filter((fence) => within(block, fence.line))
    const chart = own.find((fence) => fence.lang === "vega-lite")

    // A chart missing an include is listed for that include alone, as its page does not draw it.
    if (chart && !chart.unresolved) {
      try {
        const spec = await chartSpec(chart.text, async (reference) => {
          const embedded = await this.#data.embedReference(file, reference)

          if (embedded.error) {
            throw Object.assign(new Error(embedded.error), { reference })
          }

          return embedded
        })
        const error = await this.#drawing.chart(spec)

        if (error) {
          found.push({ kind: "chart", ...at, what: `The chart cannot be drawn: ${error}` })
        }
      } catch (error) {
        const { reference } = error as { reference?: string }
        found.push(
          reference
            ? { kind: kindOf(reference), ...at, what: `${reference}: ${(error as Error).message}` }
            : {
                kind: "chart",
                ...at,
                what: `The chart cannot be drawn: ${(error as Error).message}`,
              },
        )
      }
    } else if (!chart) {
      for (const reference of new Set(block.references ?? [])) {
        if (tied.has(reference)) {
          continue
        }

        const embedded = await this.#data.embedReference(file, reference)

        if (embedded.error) {
          found.push({ kind: kindOf(reference), ...at, what: `${reference}: ${embedded.error}` })
        }
      }
    }

    for (const { sql } of queryFences(own)) {
      const { error } = await this.#data.embedQuery(sql, path.dirname(file), "", "")

      if (error) {
        found.push({ kind: "query", ...at, what: `The query fails: ${error}` })
      }
    }

    for (const claim of await claimStates(this.#data, file, block.claims ?? [])) {
      if (claim.state === "contradicted") {
        found.push({
          kind: "figure",
          ...at,
          what: `${claim.figure} is contradicted: the data says ${claim.live} (${claim.reference})`,
        })
      } else if (claim.state === "unchecked" && !claim.deliberate) {
        found.push({
          kind: kindOf(claim.reference),
          ...at,
          what: `${claim.reference}: ${claim.reason}`,
        })
      }
    }

    return found
  }
}

function rank(problem: Problem): string {
  return problem.opens === undefined ? "" : `~${problem.opens}`
}

function same(a: Problem | undefined, b: Problem): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

function kindOf(reference: string): "query" | "data" {
  return reference.startsWith("#") || /\.sql(#|$)/i.test(reference) ? "query" : "data"
}

function within(block: Block, line: number): boolean {
  return block.lines[0] <= line && line <= block.lines[1]
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

function stampOf(at: string): string {
  const stat = fs.statSync(at, { throwIfNoEntry: false })
  return stat ? `${stat.mtimeMs}-${stat.size}` : "-"
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}
