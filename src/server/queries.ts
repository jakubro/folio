/**
 * A query's plan: one SELECT whose file references are checked against the served folder and bound to
 * sources Folio reads itself, rebuilt as SQL before the engine runs it.
 */

import fs from "node:fs"
import path from "node:path"
import { belowRoot, confine, type Format, formatOf, globOf, isInside, isPruned } from "./files.ts"

export interface Reference {
  /** Resolved through symlinks, inside the served folder. */
  file: string
  format: Format
  part: string
}

/** Binds a file, or every file a pattern matched, to a view; matches carry a `filename` column. */
export type Source = (
  reference: Reference | Matched[] | Readers,
  written: string,
) => Promise<string>

/** A reader handed a pattern's matches, as one statement per batch of them, its rows stacked by name. */
export interface Readers {
  readers: string[]
  json: boolean
}

/**
 * A reader over many files holds each file's buffer until its query ends, so a pattern's matches are read
 * a hundred files to a reader.
 */
export const BATCH = 100

/** A JSON reader stacking files by name holds a buffer for each of them while it binds: it is handed sixteen. */
const JSON_FILES = 16

/** A path a query or reference names that Folio will not read; its text names the path as written. */
export class Unreadable extends Error {}

/** A file a pattern matched, with its path in the served folder. */
export interface Matched extends Reference {
  path: string
}

/** Binds a table of the folder's documents, `folio.<name>` or `kind.<name>`, to a view for the query. */
type Documents = (schema: "folio" | "kind", name: string) => Promise<string>

interface Argument {
  name: string
  expression: Record<string, unknown>
}

export interface Runner {
  runAndReadAll(sql: string, values?: string[]): Promise<{ getRowsJS(): unknown[][] }>
}

interface Planning {
  documents?: Documents
  reserve?: (readers: number) => void
  absolute?: boolean
  walks?: Walks
  /** Only what the query reads: nothing is bound and no SQL rebuilt, so only parsing needs the engine. */
  filesOnly?: boolean
}

interface Walked {
  at: string
  left: number
  files: Omit<Matched, "part">[]
  subdirs: string[]
  linked: boolean
  /** Read while the folder model watched it and with no link the pattern matches, whose target it never hears. */
  trusted: boolean
  identity: string | undefined
}

interface Kept {
  dirs: Map<string, Walked>
  stale: Set<string>
}

const READERS = new Set([
  "read_csv",
  "read_csv_auto",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
  "read_json_objects",
  "read_parquet",
  "parquet_scan",
])
const GENERATORS = new Set(["range", "generate_series", "unnest"])
const SCHEME = /^[a-z][a-z\d+.-]*:/i
const PATTERN = /[*?]/
const PARSED = new Map<string, string>()
const PARSED_KEPT = 256
const WALKS_KEPT = 64
/** `JSON.rawJSON`: in every supported Node, though not yet in TypeScript's library. */
export const RAW_JSON = JSON as unknown as { rawJSON(text: string): unknown }

/**
 * Admit one SELECT only; bind each table named like a path to a folder file through `source`, point
 * file readers at folder files, and refuse every other table function. Returns the SQL and its files.
 */
export async function plan(
  runner: Runner,
  sql: string,
  root: string,
  folder: string,
  source: Source,
  { documents, reserve, absolute = false, walks, filesOnly = false }: Planning = {},
): Promise<{ sql: string; files: string[]; documents: string[]; dirs: string[]; linked: boolean }> {
  const tree = treeOf(await parsed(runner, sql))

  if (tree.error && !/only select/i.test(tree.error_message)) {
    throw new Error(tree.error_message)
  }

  if (tree.error || tree.statements?.length !== 1) {
    throw new Error(
      "Only one SELECT statement runs in a query; PIVOT and statements that change anything do not.",
    )
  }

  const files = new Set<string>()
  const tables = new Set<string>()
  const dirs = new Set<string>()
  let linked = false
  // The visit below is synchronous, and a walk of a large folder must not hold up the server.
  const walked = new Map(
    await Promise.all(
      patternsIn(tree.statements).map(
        async (name) =>
          [
            name,
            await matches(name, root, folder, absolute, walks).catch((error: unknown) => ({
              error,
            })),
          ] as const,
      ),
    ),
  )
  const matched = (name: string) => {
    const found = walked.get(name) as Awaited<ReturnType<typeof matches>> | { error: unknown }

    if ("error" in found) {
      throw found.error
    }

    linked ||= found.linked

    for (const dir of found.dirs) {
      dirs.add(dir)
    }

    for (const { file } of found.files) {
      files.add(relative(root, file))
    }

    return found.files
  }
  // Bound once the whole tree is checked, so a refusal never leaves a source half-made and unawaited.
  const bindings: (() => Promise<void>)[] = []
  let inline = 0
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }

    if (node === null || typeof node !== "object") {
      return
    }

    const record = node as Record<string, unknown>

    if (record.type === "BASE_TABLE" && fileLike(record) && isPattern(String(record.table_name))) {
      const found = matched(String(record.table_name))
      bindings.push(async () => {
        const bound = await source(found, String(record.table_name))
        record.alias ||= record.table_name
        rename(record, bound)
      })
    } else if (record.type === "BASE_TABLE" && fileLike(record)) {
      const reference = resolve(String(record.table_name), root, folder, absolute)
      linked ||= viaLink(String(record.table_name), reference, root, folder, absolute)
      files.add(relative(root, reference.file))
      bindings.push(async () => {
        const bound = await source(reference, String(record.table_name))
        record.alias ||= record.table_name
        rename(record, bound)
      })
    }

    const schema = record.schema_name

    if (
      record.type === "BASE_TABLE" &&
      documents &&
      !record.catalog_name &&
      (schema === "folio" || schema === "kind")
    ) {
      const name = String(record.table_name)
      tables.add(`${schema}.${name}`)
      bindings.push(async () => {
        const bound = await documents(schema, name)
        record.alias ||= name
        rename(record, bound)
      })
    }

    if (record.type === "TABLE_FUNCTION") {
      const call = record.function as { function_name?: string; arguments?: Argument[] }
      const name = call.function_name ?? ""

      if (READERS.has(name)) {
        const json = /json/.test(name)
        const { literal } = (call.arguments?.[0]?.expression ?? {}) as {
          literal?: { kind: string; text: string }
        }

        if (literal?.kind !== "STRING") {
          throw new Error(`${name} reads only a file of the folder named in quotes.`)
        }

        if (isPattern(literal.text)) {
          const found = matched(literal.text)

          if (found.length === 0) {
            throw Object.assign(new Unreadable(`No data file matches ${literal.text}.`), {
              dirs: [...dirs],
            })
          }

          const args = call.arguments as Argument[]
          const files = found.map(({ file }) => file)
          const pattern = literal.text
          const database = found.find(({ format }) => format === "sqlite" || format === "duckdb")
          const stacking = args.find((argument) => named(argument) === "union_by_name")
          const batch = json ? JSON_FILES : BATCH

          if (database) {
            throw new Error(
              `${name} reads ${pattern}, which matches ${database.path}, a database: narrow the pattern.`,
            )
          }

          if (!stacking) {
            args.push(byName())
          }

          // Batches stack by name and number their rows apart.
          // A reader told to read by position, or to number its rows, is handed every match at once instead.
          const batched =
            files.length > batch &&
            record.with_ordinality !== "WITH_ORDINALITY" &&
            (!stacking || isTrue(optionValue(stacking)))
          args[0] = { name: "", expression: listOf(batched ? files.slice(0, batch) : files) }

          if (json && !batched) {
            inline += files.length
          }

          if (batched && !filesOnly) {
            bindings.push(async () => {
              const readers: string[] = []

              for (let at = 0; at < files.length; at += batch) {
                args[0] = { name: "", expression: listOf(files.slice(at, at + batch)) }
                readers.push(
                  await statementOf(runner, {
                    ...record,
                    alias: "",
                    column_name_alias: [],
                    sample: null,
                  }),
                )
              }

              const bound = await source({ readers, json }, pattern)
              const { alias = "", column_name_alias = [], sample = null } = record

              for (const key of Object.keys(record)) {
                delete record[key]
              }

              Object.assign(record, baseTable(bound, String(alias)), { column_name_alias, sample })
            })
          }
        } else {
          const reference = resolve(literal.text, root, folder, absolute)
          linked ||= viaLink(literal.text, reference, root, folder, absolute)
          files.add(relative(root, reference.file))
          literal.text = reference.file

          if (json) {
            inline++
          }
        }
      } else if (!GENERATORS.has(name)) {
        throw new Error(`A query may not call ${name}.`)
      }
    }

    Object.values(record).forEach(visit)
  }

  visit(tree.statements)
  reserve?.(inline)

  for (const bind of bindings) {
    await bind()
  }

  const [[rebuilt]] = filesOnly
    ? [[""]]
    : (
        await runner.runAndReadAll("select json_deserialize_sql(json(?::varchar))", [
          JSON.stringify(tree),
        ])
      ).getRowsJS()

  return {
    sql: String(rebuilt),
    files: [...files],
    documents: [...tables],
    dirs: [...dirs],
    linked,
  }
}

/** Whether a name reached its file through a link, whose target no change in the folders read is heard for. */
function viaLink(
  name: string,
  { file }: Reference,
  root: string,
  folder: string,
  absolute: boolean,
): boolean {
  const asked = absolute ? fromRoot(root, name) : name
  const written = asked.startsWith("/") ? path.join(root, asked) : path.resolve(folder, asked)
  return file !== written && file !== written.slice(0, written.lastIndexOf("#"))
}

/** Every pattern's walk, kept: a folder is read again once a change in it is heard, or whenever unwatched. */
export class Walks {
  readonly #watched: (dir: string) => boolean
  readonly #kept = new Map<string, Kept>()
  readonly #turns = new Map<string, Promise<void>>()

  constructor(watched: (dir: string) => boolean) {
    this.#watched = watched
  }

  heard(dir: string): void {
    for (const { dirs, stale } of this.#kept.values()) {
      if (dirs.has(dir)) {
        stale.add(dir)
      }
    }
  }

  /** Walks of one pattern from one folder take turns, so none reads a walk another has only half done. */
  walk(
    pattern: string,
    root: string,
    start: string,
    at: string,
    depth: number,
  ): Promise<{ files: Omit<Matched, "part">[]; dirs: string[]; linked: boolean }> {
    const key = `${pattern}\0${start}`
    const turn = (this.#turns.get(key) ?? Promise.resolve()).then(() =>
      this.#walkNow(key, pattern, root, start, at, depth),
    )
    const settled = turn.then(
      () => {},
      () => {},
    )
    this.#turns.set(key, settled)
    void settled.then(() => {
      if (this.#turns.get(key) === settled) {
        this.#turns.delete(key)
      }
    })

    return turn
  }

  async #walkNow(
    key: string,
    pattern: string,
    root: string,
    start: string,
    at: string,
    depth: number,
  ): Promise<{ files: Omit<Matched, "part">[]; dirs: string[]; linked: boolean }> {
    let kept = this.#kept.get(key)

    if (kept) {
      this.#kept.delete(key)
    } else {
      kept = { dirs: new Map(), stale: new Set([start]) }
      kept.dirs.set(start, {
        at,
        left: depth,
        files: [],
        subdirs: [],
        linked: false,
        trusted: false,
        identity: undefined,
      })
    }

    this.#kept.set(key, kept)

    for (const old of this.#kept.keys()) {
      if (this.#kept.size <= WALKS_KEPT) {
        break
      }

      this.#kept.delete(old)
    }

    const regex = globOf(pattern)

    for (const [dir, walked] of [...kept.dirs]) {
      const current = kept.dirs.get(dir) === walked
      const unheard = walked.trusted && this.#watched(dir) && !kept.stale.has(dir)

      if (current && !unheard) {
        kept.stale.delete(dir)
        await this.#read(kept, dir, walked.at, walked.left, regex, root)
      }
    }

    const files = [...kept.dirs.values()].flatMap((walked) => walked.files)
    return {
      files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      dirs: [...kept.dirs.keys()],
      linked: [...kept.dirs.values()].some((walked) => walked.linked),
    }
  }

  async #read(
    kept: Kept,
    dir: string,
    at: string,
    left: number,
    regex: RegExp,
    root: string,
  ): Promise<void> {
    const { dirs } = kept
    const watched = this.#watched(dir)
    const before = dirs.get(dir)
    const linked: string[] = []
    const walked: Walked = {
      at,
      left,
      files: [],
      subdirs: [],
      linked: false,
      trusted: false,
      identity: await identityOf(dir),
    }
    dirs.set(dir, walked)
    await visitDir(dir, at, left, regex, root, walked.files, walked.subdirs, linked)
    walked.linked = linked.length > 0
    walked.trusted = watched && !walked.linked

    for (const sub of before?.subdirs ?? []) {
      // A folder moved away and made again under its name is another folder, walked again whole.
      const replaced =
        walked.subdirs.includes(sub) && dirs.get(sub)?.identity !== (await identityOf(sub))

      if (!walked.subdirs.includes(sub) || replaced) {
        for (const held of [...dirs.keys()]) {
          if (held === sub || held.startsWith(`${sub}${path.sep}`)) {
            dirs.delete(held)
          }
        }
      }
    }

    for (const sub of walked.subdirs) {
      if (!dirs.has(sub)) {
        await this.#read(
          kept,
          sub,
          `${at ? `${at}/` : ""}${path.basename(sub)}`,
          left - 1,
          regex,
          root,
        )
      }
    }
  }
}

/**
 * Resolve a reference against a folder, or the root after a slash; a whole name beats a split at its last `#`.
 * `absolute` also reads a name starting with root's own path as one below root.
 */
export function resolve(name: string, root: string, folder: string, absolute = false): Reference {
  if (SCHEME.test(name)) {
    throw new Unreadable(`Only the served folder's files can be read, not ${name}.`)
  }

  const asked = absolute ? fromRoot(root, name) : name
  const hash = asked.lastIndexOf("#")
  const whole = locate(asked, name, root, folder)

  if (whole) {
    return { ...whole, part: "" }
  }

  const found = hash < 0 ? undefined : locate(asked.slice(0, hash), name, root, folder)

  if (!found) {
    const address = hash < 0 ? asked : asked.slice(0, hash)
    const missing = address.startsWith("/")
      ? path.join(root, address)
      : path.resolve(folder, address)
    throw Object.assign(new Unreadable(`No data file at ${name}.`), { missing })
  }

  return { ...found, part: asked.slice(hash + 1) }
}

/** Symlinked folders are not followed, so a walk can neither loop nor leave the served folder. */
async function matches(
  name: string,
  root: string,
  folder: string,
  absolute: boolean,
  walks?: Walks,
): Promise<{ files: Matched[]; dirs: string[]; linked: boolean }> {
  if (SCHEME.test(name)) {
    throw new Unreadable(`Only the served folder's files can be read, not ${name}.`)
  }

  const asked = absolute ? fromRoot(root, name) : name
  const hash = asked.lastIndexOf("#")
  const address = hash < 0 || isPattern(asked.slice(hash)) ? asked : asked.slice(0, hash)
  const part = address === asked ? "" : asked.slice(hash + 1)
  const pattern = path.posix.normalize(
    address.startsWith("/") ? address.slice(1) : path.posix.join(relative(root, folder), address),
  )

  if (pattern === ".." || pattern.startsWith("../")) {
    throw new Unreadable(`${name} is outside the served folder.`)
  }

  const segments = pattern.split("/")
  const fixed = segments.findIndex((segment) => isPattern(segment))
  const start = confine(root, segments.slice(0, fixed).join("/"))
  const depth = pattern.includes("**") ? Number.POSITIVE_INFINITY : segments.length - fixed
  const regex = globOf(pattern)
  const files: Matched[] = []
  const dirs: string[] = []
  const walk = async (dir: string, at: string, left: number): Promise<void> => {
    const subdirs: string[] = []
    dirs.push(dir)
    await visitDir(dir, at, left, regex, root, files, subdirs)

    for (const sub of subdirs) {
      await walk(sub, `${at ? `${at}/` : ""}${path.basename(sub)}`, left - 1)
    }
  }

  if (start && (await fs.promises.stat(start)).isDirectory()) {
    const at = segments.slice(0, fixed).join("/")

    if (walks) {
      const walked = await walks.walk(pattern, root, start, at, depth)
      const found = walked.files.map((match) => ({ ...match, part }))
      return {
        files: found,
        dirs: walked.dirs,
        linked: walked.linked || linkedOf(root, start, at, found),
      }
    }

    await walk(start, at, depth)
    for (const found of files) {
      found.part = part
    }
  } else {
    // A pattern whose fixed folder is not there yet is heard through the nearest folder that is.
    for (let at = fixed - 1; at >= 0; at--) {
      const there = confine(root, segments.slice(0, at).join("/"))

      if (there) {
        dirs.push(there)
        break
      }
    }
  }

  const sorted = files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    files: sorted,
    dirs,
    linked: start ? linkedOf(root, start, segments.slice(0, fixed).join("/"), sorted) : false,
  }
}

function linkedOf(root: string, start: string, at: string, found: Matched[]): boolean {
  return (
    start !== path.join(root, at) ||
    found.some(({ file, path: within }) => file !== path.join(root, within))
  )
}

async function visitDir(
  dir: string,
  at: string,
  left: number,
  regex: RegExp,
  root: string,
  files: Omit<Matched, "part">[],
  subdirs: string[],
  linked: string[] = [],
): Promise<void> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const dirent of dirents.filter(({ name: entry }) => !isPruned(entry))) {
    const within = at ? `${at}/${dirent.name}` : dirent.name

    if (dirent.isDirectory()) {
      if (left > 1) {
        subdirs.push(path.join(dir, dirent.name))
      }

      continue
    }

    const real = regex.test(within) ? confine(root, within) : undefined
    const format = real && formatOf(real)
    const file = real ? await fs.promises.stat(real).catch(() => undefined) : undefined

    if (real && format && format !== "sql" && file?.isFile()) {
      files.push({ file: real, format, path: within })

      if (real !== path.join(dir, dirent.name)) {
        linked.push(real)
      }
    } else if (dirent.isSymbolicLink() && regex.test(within)) {
      linked.push(path.join(dir, dirent.name))
    }
  }
}

async function identityOf(dir: string): Promise<string | undefined> {
  const stat = await fs.promises.stat(dir).catch(() => undefined)
  return stat && `${stat.dev}:${stat.ino}`
}

/** Kept by text, since parsing takes an engine connection. */
async function parsed(runner: Runner, sql: string): Promise<string> {
  const held = PARSED.get(sql)

  if (held !== undefined) {
    PARSED.delete(sql)
    PARSED.set(sql, held)
    return held
  }

  const [[serialized]] = (
    await runner.runAndReadAll("select json_serialize_sql(?::varchar)", [sql])
  ).getRowsJS()
  PARSED.set(sql, String(serialized))

  for (const old of PARSED.keys()) {
    if (PARSED.size <= PARSED_KEPT) {
      break
    }

    PARSED.delete(old)
  }

  return String(serialized)
}

/** Exactly the names the visit in `plan` reads through a pattern, each of which it looks up walked. */
function patternsIn(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(patternsIn)
  }

  if (node === null || typeof node !== "object") {
    return []
  }

  const record = node as Record<string, unknown>
  const call = record.function as { function_name?: string; arguments?: Argument[] } | undefined
  const { literal } = (call?.arguments?.[0]?.expression ?? {}) as {
    literal?: { kind: string; text: string }
  }
  const own =
    record.type === "BASE_TABLE" && fileLike(record) && isPattern(String(record.table_name))
      ? [String(record.table_name)]
      : record.type === "TABLE_FUNCTION" &&
          READERS.has(call?.function_name ?? "") &&
          literal?.kind === "STRING" &&
          isPattern(literal.text)
        ? [literal.text]
        : []

  return [...own, ...Object.values(record).flatMap(patternsIn)]
}

/** A CTE or a view is named plainly; a dot, a slash or a `#` marks a file. */
function fileLike(table: Record<string, unknown>): boolean {
  return !table.schema_name && !table.catalog_name && /[./#]/.test(String(table.table_name))
}

function locate(
  address: string,
  name: string,
  root: string,
  folder: string,
): { file: string; format: Format } | undefined {
  const target = address.startsWith("/") ? path.join(root, address) : path.resolve(folder, address)
  const real = isInside(root, target) ? confine(root, path.relative(root, target)) : undefined

  // Not inside, or not once resolved: the path or a symlink on it leads out of the folder.
  if (!real && (!isInside(root, target) || fs.existsSync(target))) {
    throw new Unreadable(`${name} is outside the served folder.`)
  }

  const format = real && formatOf(real)
  return real && format && fs.statSync(real).isFile() ? { file: real, format } : undefined
}

function fromRoot(root: string, name: string): string {
  const below = belowRoot(root, name)
  return below === undefined ? name : `/${below}`
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/")
}

function isPattern(name: string): boolean {
  return PATTERN.test(name)
}

/** An option written `name := value` carries its name; written `name = value`, it is a comparison. */
function named({ name, expression }: Argument): string | undefined {
  const left = expression.left as { column_names?: string[] } | undefined
  return name || (expression.type === "COMPARE_EQUAL" ? left?.column_names?.[0] : undefined)
}

function optionValue({ name, expression }: Argument): unknown {
  return !name && expression.type === "COMPARE_EQUAL" ? expression.right : expression
}

/** A table function as a statement of its own, `SELECT * FROM` it, as the engine writes it out. */
async function statementOf(runner: Runner, table: Record<string, unknown>): Promise<string> {
  const [[serialized]] = (
    await runner.runAndReadAll("select json_serialize_sql('select * from range(1)')")
  ).getRowsJS()
  const tree = treeOf(serialized)
  tree.statements[0].node.from_table = table
  const [[rebuilt]] = (
    await runner.runAndReadAll("select json_deserialize_sql(json(?::varchar))", [
      JSON.stringify(tree),
    ])
  ).getRowsJS()

  return String(rebuilt)
}

/** Numbers stay as written: the engine refuses `-1` where it wrote `-1.0`, and positions overflow a double. */
function treeOf(serialized: unknown) {
  return JSON.parse(String(serialized), (_, value, context?: { source?: string }) =>
    typeof value === "number" ? RAW_JSON.rawJSON(context?.source as string) : value,
  )
}

/** The engine writes a boolean option as a constant, or as text cast to a boolean. */
function isTrue(node: unknown): boolean {
  const {
    class: kind,
    literal,
    child,
  } = (node ?? {}) as {
    class?: string
    literal?: { text?: string }
    child?: { literal?: { text?: string } }
  }
  const written = kind === "CAST" ? child?.literal?.text : literal?.text

  return /^(t|true|1)$/i.test(String(written))
}

function baseTable(name: string, alias: string): Record<string, unknown> {
  return {
    type: "BASE_TABLE",
    alias,
    sample: null,
    schema_name: "",
    table_name: name,
    column_name_alias: [],
    catalog_name: "",
    at_clause: null,
  }
}

/** The engine names a table by its qualified name before its parts, so a rebound table is renamed in both. */
function rename(table: Record<string, unknown>, name: string): void {
  table.schema_name = ""
  table.table_name = name
  table.qualified_name = { path: [name] }
}

/** `union_by_name := true`, so the matches stack by column name as a pattern in a table name does. */
function byName(): Argument {
  return { name: "union_by_name", expression: constant("BOOLEAN", "true") }
}

/** A list of constant paths, as DuckDB serializes `['a', 'b']`, for a reader handed every match. */
function listOf(paths: string[]): Record<string, unknown> {
  return {
    class: "FUNCTION",
    type: "FUNCTION",
    alias: "",
    function_name: "list_value",
    schema: "",
    arguments: paths.map((text) => ({ name: "", expression: constant("STRING", text) })),
    filter: null,
    order_bys: { type: "ORDER_MODIFIER", orders: [] },
    distinct: false,
    is_operator: false,
    export_state: false,
    catalog: "",
  }
}

function constant(kind: "BOOLEAN" | "STRING", text: string): Record<string, unknown> {
  return { class: "CONSTANT", type: "VALUE_CONSTANT", alias: "", literal: { kind, text } }
}
