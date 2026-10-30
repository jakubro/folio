/**
 * What a folder declares about itself in `FOLIO.md` files: each holds its declarations in fenced blocks
 * between prose, and applies to its folder and everything below, a deeper one layered over a higher.
 */

import fs from "node:fs"
import path from "node:path"
import { isMap, isSeq, parseDocument } from "yaml"
import { isPruned } from "./files.ts"
import {
  type Field,
  type KindDefinition,
  kindDefinition,
  patternsOf,
  type Read,
  readFields,
  within,
} from "./kinds.ts"
import type { Model } from "./model.ts"

export const DECLARATION = "FOLIO.md"

/** One declaration file as read: what it declares, and what in it could not be read. */
export interface Declaration {
  path: string
  /** The folder it applies to, as a path in the served folder; "" for the served folder itself. */
  folder: string
  kinds: Record<string, KindDefinition>
  rules: Record<string, RuleDefinition>
  health: HealthScope[]
  /** Where folio writes the views marked in documents back into them. */
  save: { where: RegExp[] }[]
  /** Queries whose rows need the reader: each row's `path`, its message filled from the row. */
  attention: Record<string, AttentionDefinition>
  /** A query naming the documents below the folder that have outlived their use, by `path`. */
  stale?: string
  /** Digest documents to write: a path in the served folder, `{day}` or `{week}` naming the period. */
  digests: Digest[]
  problems: { line: number; block: string; what: string }[]
}

export interface Digest {
  path: string
  period: "day" | "week"
  declaredIn: string
  line: number
}

/** A declared entry with the declaration it comes from, whose folder its paths are relative to. */
interface Declared<T = unknown> {
  name: string
  definition: T
  from: Declaration
}

/** What applies to a document once its declarations are layered, the nearest winning on a name. */
export interface Layered {
  kinds: Declared<KindDefinition>[]
  rules: Declared<RuleDefinition>[]
  health: Declared<HealthScope>[]
}

/** A part of the folder: the checks health leaves out there, and those whose problems count as errors. */
interface HealthScope {
  where: RegExp[]
  skip: "all" | string[]
  error: "all" | string[]
}

interface AttentionDefinition {
  query: string
  message: string
}

/** A rule: a query that should return no row, each row it returns a violation. */
export interface RuleDefinition {
  query: string
  /** Said of each violation, `{column}` taking the row's value of that column. */
  message: string
  severity: "error" | "warning"
  /** Where the rule is declared, so a rule that cannot run is listed there. */
  line: number
  block: string
}

/** A document of a declared kind, as the folder declares it. */
export interface Document extends Read {
  kind: string
  /** The declaration the kind comes from. */
  declaredIn: string
}

export interface Described {
  declarations: string[]
  kind?: string
  declaredIn?: string
  fields?: Record<string, unknown>
}

const SECTIONS: Record<string, "map" | "list"> = {
  kinds: "map",
  rules: "map",
  health: "list",
  save: "list",
  digests: "list",
  attention: "map",
  stale: "map",
}
const NAMED = Object.keys(SECTIONS)
  .join(", ")
  .replace(/, ([^,]+)$/, " and $1")
const FENCE = /^(`{3,}|~{3,})\s*yaml\s+folio\s*$/
const CLOSE = /^(`{3,}|~{3,})\s*$/
const CONVENTIONS = new WeakMap<Model, Conventions>()

/** The one reading of a model's declarations, so every caller shares it. */
export function conventionsOf(model: Model): Conventions {
  let conventions = CONVENTIONS.get(model)

  if (!conventions) {
    conventions = new Conventions(model)
    CONVENTIONS.set(model, conventions)
  }

  return conventions
}

export class Conventions {
  readonly #model: Model
  readonly #read = new Map<string, { hash: string; declaration: Declaration }>()
  readonly #fields = new Map<string, { key: string; read: Document | undefined }>()
  readonly #ids = new Map<string, Map<string, string>>()
  /** Moves for a kind whenever the ids its documents hold may have changed, so resolved fields know. */
  readonly #generations = new Map<string, number>()
  readonly #resolved = new Map<string, { read: Document; stamp: string; document: Document }>()
  #paths: string[] | undefined

  constructor(model: Model) {
    this.#model = model
    model.listen((changed) => this.#changed(changed))
  }

  /** The declaration file at a path, read from the text the model holds, or undefined if it is none. */
  declaration(urlPath: string): Declaration | undefined {
    const hash = this.#model.hashOf(urlPath)

    if (hash === undefined || path.posix.basename(urlPath) !== DECLARATION) {
      return undefined
    }

    const held = this.#read.get(urlPath)

    if (held?.hash === hash) {
      return held.declaration
    }

    const declaration = read(urlPath, this.#model)
    this.#read.set(urlPath, { hash, declaration })
    return declaration
  }

  /**
   * What the folder declares of one document: the declarations applying to it, in the order they layer,
   * and its kind and fields when one of its kinds places it.
   */
  describe(urlPath: string): Described {
    const declarations = this.applying(urlPath).map((declaration) => declaration.path)
    const found = this.document(urlPath)

    return found
      ? {
          declarations,
          kind: found.kind,
          declaredIn: found.declaredIn,
          fields: Object.fromEntries(
            Object.entries(found.fields).map(([name, { value }]) => [name, value]),
          ),
        }
      : { declarations }
  }

  /**
   * A document's kind - the first kind placing it, nearest declaration first - and its fields, ids a
   * link names resolved to the document of that kind holding them; with every value that did not fit.
   */
  document(urlPath: string): Document | undefined {
    const read = this.#unresolved(urlPath)

    if (!read || read.references.length === 0) {
      return read
    }

    const stamp = [...new Set(read.references.map(({ to }) => to))]
      .map((kind) => `${kind}:${this.#generations.get(kind) ?? 0}`)
      .join(",")
    const held = this.#resolved.get(urlPath)

    if (held?.read === read && held.stamp === stamp) {
      return held.document
    }

    const fields: Record<string, Field> = structuredClone(read.fields)
    const problems = [...read.problems]
    const placed = new Map<string, Map<number, unknown[]>>()
    // An id found in a document's own text never names the document itself.
    const found = read.references.map(({ to, by, text, path: target, candidates, external }) => {
      const ids = this.#idsOf(to, by)
      return external !== undefined
        ? [external]
        : target !== undefined && this.#unresolved(target)?.kind === to
          ? [target]
          : [
              ...new Set(
                (candidates ?? (target === undefined ? [text] : [])).flatMap(
                  (word) => ids.get(word) ?? [],
                ),
              ),
            ].filter((named) => named !== urlPath)
    })
    // One word with no digit, among ids that all hold one, is the tail of a note split at a comma.
    const noted = read.references.map(
      ({ prose, text, to, by, path: target, external }) =>
        prose === true ||
        (target === undefined &&
          external === undefined &&
          !/\d/.test(text) &&
          [...this.#idsOf(to, by).keys()].every((id) => /\d/.test(id))),
    )
    const naming = new Set(
      read.references.flatMap(({ field, group = 0 }, index) =>
        !noted[index] || found[index].length > 0 ? [`${field}\0${group}`] : [],
      ),
    )

    for (const [index, { field, item, text, to, line, group = 0 }] of read.references.entries()) {
      const named = found[index]
      const wrong = named.length === 0 && (!noted[index] || !naming.has(`${field}\0${group}`))

      if (wrong) {
        problems.push({ line, what: `${field}: ${text} names no ${to}` })
      }

      if (item === undefined) {
        fields[field].value = named[0] ?? null
      } else {
        const at = placed.get(field) ?? new Map<number, unknown[]>()
        at.set(item, wrong ? [null] : named)
        placed.set(field, at)
      }
    }

    // A piece of prose may name several ids or none, so the list is laid out again around them.
    for (const [field, at] of placed) {
      const laid = (fields[field].value as unknown[]).flatMap(
        (value, item) => at.get(item) ?? [value],
      )
      fields[field].value = laid.filter(
        (value, index) => value === null || laid.indexOf(value) === index,
      )
    }

    const document = { ...read, fields, problems }
    this.#resolved.set(urlPath, { read, stamp, document })
    return document
  }

  /** The kind placing a document, its fields left unread past what placing it takes. */
  kindOf(urlPath: string): string | undefined {
    return this.#unresolved(urlPath)?.kind
  }

  /** Every kind whose fields name a document of one of the kinds given by id. */
  naming(kinds: ReadonlySet<string>): Set<string> {
    const named = new Set<string>()

    for (const declaration of this.all()) {
      for (const [name, kind] of Object.entries(declaration.kinds)) {
        if (Object.values(kind.fields).some(({ to }) => to !== undefined && kinds.has(to))) {
          named.add(name)
        }
      }
    }

    return named
  }

  /** Every kind the folder declares. */
  kinds(): Set<string> {
    return new Set(this.all().flatMap((declaration) => Object.keys(declaration.kinds)))
  }

  /** Moves whenever the ids a kind's documents hold may have changed. */
  generation(kind: string): number {
    return this.#generations.get(kind) ?? 0
  }

  /**
   * Layer every declaration applying to a path: a kind or rule declared again nearer replaces the one
   * above in its place, and health entries add up, the nearest last.
   */
  layered(urlPath: string): Layered {
    const kinds = new Map<string, Declared<KindDefinition>>()
    const rules = new Map<string, Declared<RuleDefinition>>()
    const health: Declared<HealthScope>[] = []

    for (const from of this.applying(urlPath)) {
      for (const [name, definition] of Object.entries(from.kinds)) {
        kinds.set(name, { name, definition, from })
      }

      for (const [name, definition] of Object.entries(from.rules)) {
        rules.set(name, { name, definition, from })
      }

      health.push(
        ...from.health.map((definition, index) => ({ name: String(index), definition, from })),
      )
    }

    return { kinds: [...kinds.values()], rules: [...rules.values()], health }
  }

  /** Fields as read from the document alone, kept while its text and every declaration applying to it hold. */
  #unresolved(urlPath: string): Document | undefined {
    const hash = this.#model.hashOf(urlPath)
    const applying = this.applying(urlPath)
    const key = [hash, ...applying.map((declaration) => this.#model.hashOf(declaration.path))].join(
      "\0",
    )
    const held = this.#fields.get(urlPath)

    if (held?.key === key) {
      return held.read
    }

    const depth = (folder: string) => (folder ? folder.split("/").length : 0)
    const kinds = this.layered(urlPath).kinds.sort(
      (a, b) => depth(b.from.folder) - depth(a.from.folder),
    )
    const kind =
      hash === undefined
        ? undefined
        : kinds.find(({ definition, from }) => within(definition.where, from.folder, urlPath))
    const read = kind && {
      kind: kind.name,
      declaredIn: kind.from.path,
      ...readFields(urlPath, this.#model.held(urlPath) ?? [], kind.definition.fields),
    }

    this.#fields.set(urlPath, { key, read })
    return read
  }

  /** A kind's ids are gathered again only once a document's kind or id moved; a changed declaration, all. */
  #changed(changed: readonly string[] | undefined): void {
    const declarations =
      changed === undefined ||
      changed.some((urlPath) => path.posix.basename(urlPath) === DECLARATION)

    if (declarations) {
      this.#paths = undefined
      this.#ids.clear()
      this.#resolved.clear()

      for (const kind of this.#generations.keys()) {
        this.#generations.set(kind, (this.#generations.get(kind) ?? 0) + 1)
      }

      return
    }

    const named = this.all().flatMap((declaration) =>
      Object.values(declaration.kinds).flatMap(({ fields }) =>
        Object.values(fields).flatMap(({ to, by }) => (to === undefined ? [] : [{ to, by }])),
      ),
    )

    for (const urlPath of changed) {
      const was = this.#fields.get(urlPath)?.read
      const now = this.#unresolved(urlPath)

      for (const { to, by } of named) {
        const reached = was?.kind === to || now?.kind === to
        const moved = was?.kind !== now?.kind || was?.fields[by]?.value !== now?.fields[by]?.value

        if (reached && moved) {
          this.#generations.set(to, (this.#generations.get(to) ?? 0) + 1)
          this.#ids.delete(`${to}\0${by}`)
        }
      }

      if (this.#model.hashOf(urlPath) === undefined) {
        this.#fields.delete(urlPath)
        this.#resolved.delete(urlPath)
      }
    }
  }

  #idsOf(kind: string, by: string): Map<string, string> {
    let ids = this.#ids.get(`${kind}\0${by}`)

    if (!ids) {
      ids = new Map()

      for (const urlPath of this.#model.paths()) {
        const read = this.#unresolved(urlPath)
        const id = read?.kind === kind ? read.fields[by]?.value : undefined

        if (typeof id === "string" && !ids.has(id)) {
          ids.set(id, urlPath)
        }
      }

      this.#ids.set(`${kind}\0${by}`, ids)
    }

    return ids
  }

  /** Whether health skips a kind of check at a path, as the declarations applying to it scope it. */
  skips(urlPath: string, kind: string): boolean {
    return this.layered(urlPath).health.some(
      ({ definition, from }) =>
        (definition.skip === "all" || definition.skip.includes(kind)) &&
        within(definition.where, from.folder, urlPath),
    )
  }

  /** Whether a problem of a kind of check counts as an error at a path, as a health entry declares. */
  errs(urlPath: string, kind: string): boolean {
    return this.layered(urlPath).health.some(
      ({ definition, from }) =>
        (definition.error === "all" || definition.error.includes(kind)) &&
        within(definition.where, from.folder, urlPath),
    )
  }

  /** Whether a declaration asks folio to write the views marked in a document into it. */
  saves(urlPath: string): boolean {
    return this.applying(urlPath).some((declaration) =>
      declaration.save.some(({ where }) => within(where, declaration.folder, urlPath)),
    )
  }

  /** Every digest the folder's declarations ask for. */
  digests(): Digest[] {
    return this.all().flatMap((declaration) => declaration.digests)
  }

  /** Every declaration in the folder, the served folder's first. */
  all(): Declaration[] {
    return this.#declarationPaths().flatMap((held) => this.declaration(held) ?? [])
  }

  /** Every declaration applying to a path, the served folder's first and the nearest last. */
  applying(urlPath: string): Declaration[] {
    return this.all().filter(
      (declaration) => !declaration.folder || urlPath.startsWith(`${declaration.folder}/`),
    )
  }

  #declarationPaths(): string[] {
    this.#paths ??= this.#model
      .paths()
      .filter((held) => path.posix.basename(held) === DECLARATION)
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))

    return this.#paths
  }
}

/** Each fence is read on its own: one that cannot be read is listed and left out, the rest still apply. */
function read(urlPath: string, model: Model): Declaration {
  const folder = path.posix.dirname(urlPath)
  const declaration: Declaration = {
    path: urlPath,
    folder: folder === "." ? "" : folder,
    kinds: {},
    rules: {},
    health: [],
    save: [],
    digests: [],
    attention: {},
    problems: [],
  }

  for (const block of model.held(urlPath) ?? []) {
    const lines = block.text.split("\n")

    if (block.kind !== "code" || !FENCE.test(lines[0])) {
      continue
    }

    const body = lines.slice(1, CLOSE.test(lines.at(-1) ?? "") ? -1 : undefined).join("\n")
    const at = (line: number, what: string) =>
      declaration.problems.push({ line: block.lines[0] + line, block: block.id, what })
    const parsed = parseDocument(body)

    if (parsed.errors.length > 0) {
      const [error] = parsed.errors
      // The parser places the fault within the fence; the problem's line places it in the file.
      const reason = error.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "")
      at(error.linePos?.[0].line ?? 1, `The declaration cannot be read: ${reason}`)
      continue
    }

    if (parsed.contents === null) {
      continue
    }

    if (!isMap(parsed.contents)) {
      at(1, `A declaration is a map of sections: ${NAMED}.`)
      continue
    }

    const value = parsed.toJS() as Record<string, unknown>
    const wrong = Object.keys(value).find((key) => !Object.hasOwn(SECTIONS, key))

    if (wrong !== undefined) {
      at(
        fenceLineOf(parsed, body, [wrong]),
        `No section is named ${wrong}: a declaration holds ${NAMED}.`,
      )
      continue
    }

    const misshapen = Object.keys(value).find((key) =>
      SECTIONS[key] === "list" ? !isSeq(parsed.get(key)) : !isMap(parsed.get(key)),
    )

    if (misshapen !== undefined) {
      at(
        fenceLineOf(parsed, body, [misshapen]),
        `${misshapen} is a ${SECTIONS[misshapen] === "list" ? "list" : "map of names"}.`,
      )
      continue
    }

    for (const [name, definition] of Object.entries(value.kinds ?? {})) {
      const kind = kindDefinition(name, definition)

      if (typeof kind === "string") {
        at(fenceLineOf(parsed, body, ["kinds", name]), kind)
      } else {
        declaration.kinds[name] = kind

        for (const folder of bareFolders(model.root, declaration.folder, definition)) {
          at(
            fenceLineOf(parsed, body, ["kinds", name, "where"]),
            `The kind ${name} places nothing at ${folder}, a folder: ${folder}/** places every document in it.`,
          )
        }
      }
    }

    for (const [name, definition] of Object.entries(value.rules ?? {})) {
      const line = block.lines[0] + fenceLineOf(parsed, body, ["rules", name])
      const rule = ruleDefinition(name, definition, line, block.id)

      if (typeof rule === "string") {
        at(line - block.lines[0], rule)
      } else {
        declaration.rules[name] = rule
      }
    }
    for (const [index, entry] of ((value.health as unknown[] | undefined) ?? []).entries()) {
      const scope = healthScope(entry)

      if (typeof scope === "string") {
        at(fenceLineOf(parsed, body, ["health", String(index)]), scope)
      } else {
        declaration.health.push(scope)

        for (const folder of bareFolders(model.root, declaration.folder, entry)) {
          at(
            fenceLineOf(parsed, body, ["health", String(index), "where"]),
            `This entry skips nothing at ${folder}, a folder: ${folder}/** skips every document in it.`,
          )
        }
      }
    }

    for (const [index, entry] of ((value.save as unknown[] | undefined) ?? []).entries()) {
      const { where, ...rest } = (entry ?? {}) as Record<string, unknown>
      const places = patternsOf(where)

      if (!places || Object.keys(rest).length > 0 || typeof entry !== "object") {
        at(
          fenceLineOf(parsed, body, ["save", String(index)]),
          "A save entry is a map with where: the documents whose marked views folio writes.",
        )
      } else {
        declaration.save.push({ where: places })
      }
    }

    for (const [name, definition] of Object.entries(value.attention ?? {})) {
      const { query, message = name, ...rest } = (definition ?? {}) as Record<string, unknown>

      if (
        typeof query !== "string" ||
        !query.trim() ||
        typeof message !== "string" ||
        Object.keys(rest).length > 0
      ) {
        at(
          fenceLineOf(parsed, body, ["attention", name]),
          `The attention query ${name} is a map with query and message.`,
        )
      } else {
        declaration.attention[name] = { query, message }
      }
    }

    if (value.stale !== undefined) {
      const { query, ...rest } = value.stale as Record<string, unknown>

      if (typeof query !== "string" || !query.trim() || Object.keys(rest).length > 0) {
        at(
          fenceLineOf(parsed, body, ["stale"]),
          "stale is a map with a query naming, by path, the documents that have outlived their use.",
        )
      } else {
        declaration.stale = query
      }
    }

    for (const [index, entry] of ((value.digests as unknown[] | undefined) ?? []).entries()) {
      const digest = digestOf(declaration.folder, entry)
      const line = fenceLineOf(parsed, body, ["digests", String(index)])

      if (typeof digest === "string") {
        at(line, digest)
      } else {
        declaration.digests.push({ ...digest, declaredIn: urlPath, line: block.lines[0] + line })
      }
    }
  }

  return declaration
}

function digestOf(
  folder: string,
  entry: unknown,
): { path: string; period: "day" | "week" } | string {
  const { path: at, period, ...rest } = (entry ?? {}) as Record<string, unknown>
  const placed =
    typeof at === "string" ? path.posix.normalize(path.posix.join(folder, at)) : undefined

  if (typeof entry !== "object" || Object.keys(rest).length > 0 || typeof at !== "string") {
    return "A digest is a map with path and period."
  }

  if (period !== "day" && period !== "week") {
    return "A digest's period is day or week."
  }

  if (!placed || placed.startsWith("../") || !/\.md$/i.test(placed)) {
    return `A digest's path is a markdown file inside the folder, not ${at}.`
  }

  if (placed.split("/").some(isPruned)) {
    return `A digest is written where the folder lists it, never under a dot-name or node_modules: ${at}.`
  }

  return { path: placed, period }
}

/** A pattern naming a folder as it is, with no wildcard, matches the folder and so no document in it. */
function bareFolders(root: string, folder: string, definition: unknown): string[] {
  const where = (definition as { where?: unknown } | null)?.where

  return [where]
    .flat()
    .filter((pattern): pattern is string => typeof pattern === "string" && !/[*?[{]/.test(pattern))
    .map((pattern) => pattern.replace(/\/+$/, ""))
    .filter((pattern) => {
      try {
        return fs.statSync(path.join(root, folder, pattern)).isDirectory()
      } catch {
        return false
      }
    })
}

function fenceLineOf(
  parsed: ReturnType<typeof parseDocument>,
  body: string,
  keys: string[],
): number {
  let node: unknown = parsed.contents
  let offset = 0

  for (const key of keys) {
    if (isSeq(node)) {
      node = node.items[Number(key)]
      offset = (node as { range?: [number, number] } | undefined)?.range?.[0] ?? offset
      continue
    }

    const pair = isMap(node)
      ? node.items.find((item) => String((item.key as { value?: unknown })?.value) === key)
      : undefined
    offset = (pair?.key as { range?: [number, number] } | undefined)?.range?.[0] ?? offset
    node = pair?.value
  }

  return body.slice(0, offset).split("\n").length
}

function ruleDefinition(
  name: string,
  value: unknown,
  line: number,
  block: string,
): RuleDefinition | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `The rule ${name} is a map with query, message and severity.`
  }

  const { query, message = name, severity = "error", ...rest } = value as Record<string, unknown>
  const unknown = Object.keys(rest)[0]

  if (unknown !== undefined) {
    return `The rule ${name} has no ${unknown}: a rule has query, message and severity.`
  }

  if (typeof query !== "string" || !query.trim()) {
    return `The rule ${name} needs a query, which returns a row for each violation.`
  }

  if (typeof message !== "string") {
    return `The message of ${name} is a text.`
  }

  if (severity !== "error" && severity !== "warning") {
    return `The severity of ${name} is error or warning.`
  }

  return { query, message, severity, line, block }
}

/** Every kind of check health makes, in the order it lists them. */
export const CHECKS = [
  "figure",
  "link",
  "include",
  "loop",
  "diagram",
  "chart",
  "query",
  "data",
  "declaration",
  "field",
  "rule",
  "view",
] as const

function healthScope(value: unknown): HealthScope | string {
  const shape = "A health entry is a map with where, and skip or error."

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return shape
  }

  const { where, skip, error, ...rest } = value as Record<string, unknown>
  const places = patternsOf(where)

  if (Object.keys(rest).length > 0 || (skip === undefined && error === undefined)) {
    return shape
  }

  if (!places) {
    return "A health entry names where it applies: a path pattern, or a list of them."
  }

  const skipped = checksOf(skip, "skips")
  const errors = checksOf(error, "counts as errors")

  return "wrong" in skipped
    ? skipped.wrong
    : "wrong" in errors
      ? errors.wrong
      : { where: places, skip: skipped.kinds, error: errors.kinds }
}

function checksOf(value: unknown, verb: string): { kinds: "all" | string[] } | { wrong: string } {
  const kinds = typeof value === "string" && value !== "all" ? [value] : (value ?? [])

  if (kinds === "all") {
    return { kinds }
  }

  const wrong =
    Array.isArray(kinds) && kinds.every((kind) => typeof kind === "string")
      ? kinds.find((kind) => !(CHECKS as readonly string[]).includes(kind))
      : String(value)

  return wrong === undefined
    ? { kinds: kinds as string[] }
    : { wrong: `Health ${verb} all, or kinds of check among ${CHECKS.join(", ")}; not ${wrong}.` }
}
