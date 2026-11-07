/** The served folder's rules: which paths resolve inside it, which files render, and what a folder lists. */

import fs from "node:fs"
import path from "node:path"

export type Kind = "markdown" | "mermaid" | "image" | "data"

export type Format =
  | "csv"
  | "tsv"
  | "jsonl"
  | "parquet"
  | "json"
  | "yaml"
  | "sqlite"
  | "duckdb"
  | "sql"

export interface Entry {
  name: string
  kind: Kind | "folder"
}

const KINDS: Record<string, Kind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mermaid": "mermaid",
  ".mmd": "mermaid",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".svg": "image",
  ".webp": "image",
  ".avif": "image",
  ".bmp": "image",
  ".ico": "image",
}
const FORMATS: Record<string, Format> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".parquet": "parquet",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sqlite": "sqlite",
  ".sqlite3": "sqlite",
  ".db": "sqlite",
  ".duckdb": "duckdb",
  ".sql": "sql",
}
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const WALKED = new Map<string, { file: string } | { folders: [string, number | undefined][] }>()
const SETTLED_MS = 1000

function kindOf(name: string): Kind | undefined {
  return KINDS[path.extname(name).toLowerCase()] ?? (formatOf(name) && "data")
}

/** Whether a kind of file is a document: a page with text, blocks and includes. */
export function isDocument(kind: Kind | undefined): kind is "markdown" | "mermaid" {
  return kind === "markdown" || kind === "mermaid"
}

export function formatOf(name: string): Format | undefined {
  return FORMATS[path.extname(name).toLowerCase()]
}

/** A path pattern as a regular expression: `**` crosses folders, `*` and `?` stay within one. */
export function globOf(glob: string): RegExp {
  let source = ""

  for (let at = 0; at < glob.length; at++) {
    const character = glob[at]

    if (glob.startsWith("**/", at)) {
      source += "(?:.*/)?"
      at += 2
    } else if (glob.startsWith("**", at)) {
      source += ".*"
      at += 1
    } else if (character === "*") {
      source += "[^/]*"
    } else if (character === "?") {
      source += "[^/]"
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }

  return new RegExp(`^${source.replace(/^\.\//, "")}$`)
}

export function isPruned(name: string): boolean {
  return name.startsWith(".") || name === "node_modules"
}

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

export function belowRoot(root: string, written: string): string | undefined {
  const prefix = root.endsWith("/") ? root : `${root}/`

  return written === root
    ? ""
    : written.startsWith(prefix)
      ? written.slice(prefix.length)
      : undefined
}

/** Resolve a URL path through symlinks to an existing path inside root, which must itself be real. */
export function confine(root: string, urlPath: string): string | undefined {
  if (urlPath.includes("\0")) {
    return undefined
  }

  let real: string

  try {
    real = fs.realpathSync(path.join(root, urlPath))
  } catch {
    return undefined
  }

  return isInside(root, real) ? real : undefined
}

/** Resolve a URL path to a renderable file inside root, judged by the extension of its real target. */
export function renderable(
  root: string,
  urlPath: string,
): { file: string; kind: Kind } | undefined {
  const file = confine(root, urlPath)
  const kind = file && kindOf(file)

  if (!file || !kind || !fs.statSync(file).isFile()) {
    return undefined
  }

  return { file, kind }
}

/** List one folder level: renderable files, data files only when asked, and the folders holding one. */
export function listing(root: string, urlPath: string, data = false): Entry[] | undefined {
  const dir = confine(root, urlPath)

  if (!dir || !fs.statSync(dir).isDirectory()) {
    return undefined
  }

  const entries: Entry[] = []

  for (const dirent of readdir(dir)) {
    const full = path.join(dir, dirent.name)

    if (dirent.isDirectory()) {
      if (hasRenderable(root, full, data)) {
        entries.push({ name: dirent.name, kind: "folder" })
      }
    } else {
      const kind = fileKind(root, full, dirent)

      if (kind && (data || kind !== "data")) {
        entries.push({ name: dirent.name, kind })
      }
    }
  }

  return entries.sort(
    (a, b) =>
      Number(b.kind === "folder") - Number(a.kind === "folder") ||
      (a.kind === "folder" ? COLLATOR.compare(a.name, b.name) : byStem(a.name, b.name)),
  )
}

/** Find the pages either side of a page in the order the tree lists them, across folders. */
export function neighbours(
  root: string,
  urlPath: string,
): { previous: string | null; next: string | null } | undefined {
  if (!isDocument(renderable(root, urlPath)?.kind)) {
    return undefined
  }

  return { previous: step(root, urlPath, -1), next: step(root, urlPath, 1) }
}

function step(root: string, urlPath: string, direction: 1 | -1): string | null {
  let child = urlPath

  while (child) {
    const folder = path.posix.dirname(child).replace(/^\.$/, "")
    const walk = ordered(listing(root, folder) ?? [], direction)
    const index = walk.findIndex((entry) => join(folder, entry.name) === child)

    if (index < 0) {
      return null
    }

    const found = firstPage(root, folder, walk.slice(index + 1), direction)

    if (found) {
      return found
    }

    child = folder
  }

  return null
}

function firstPage(root: string, folder: string, walk: Entry[], direction: 1 | -1): string | null {
  for (const entry of walk) {
    const entryPath = join(folder, entry.name)
    const found =
      entry.kind === "folder"
        ? firstPage(root, entryPath, ordered(listing(root, entryPath) ?? [], direction), direction)
        : isDocument(entry.kind)
          ? entryPath
          : null

    if (found) {
      return found
    }
  }

  return null
}

function ordered(entries: Entry[], direction: 1 | -1): Entry[] {
  return direction > 0 ? entries : [...entries].reverse()
}

function byStem(a: string, b: string): number {
  const [first, second] = [path.parse(a), path.parse(b)]
  return COLLATOR.compare(first.name, second.name) || COLLATOR.compare(first.ext, second.ext)
}

function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name
}

/**
 * A folder holding no page is walked to its bottom, so the answer is kept: one found holds while a walk would
 * still find that file, none while no folder walked has changed - kept only when each changed well before the
 * walk, as a folder's time moves in steps of milliseconds and a change in the same step would go unseen.
 */
function hasRenderable(root: string, dir: string, data: boolean): boolean {
  const key = `${data}\0${dir}`
  const held = WALKED.get(key)

  if (
    held &&
    ("file" in held
      ? stillServed(root, dir, held.file, data)
      : held.folders.every(([folder, changed]) => changedAt(folder) === changed))
  ) {
    return "file" in held
  }

  const pending = [dir]
  const folders: [string, number | undefined][] = []
  const walked = Date.now()
  let linked = false

  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    folders.push([current, changedAt(current)])

    for (const dirent of readdir(current)) {
      const full = path.join(current, dirent.name)
      linked ||= dirent.isSymbolicLink() && kindOf(dirent.name) !== undefined

      if (dirent.isDirectory()) {
        pending.push(full)
      } else {
        const kind = fileKind(root, full, dirent)

        if (kind && (data || kind !== "data")) {
          WALKED.set(key, { file: full })
          return true
        }
      }
    }
  }

  // A link's target may appear or move away with no folder walked changing.
  if (
    !linked &&
    folders.every(([, changed]) => changed !== undefined && changed < walked - SETTLED_MS)
  ) {
    WALKED.set(key, { folders })
  } else {
    WALKED.delete(key)
  }

  return false
}

function stillServed(root: string, dir: string, file: string, data: boolean): boolean {
  try {
    for (let folder = path.dirname(file); folder !== dir; folder = path.dirname(folder)) {
      if (!fs.lstatSync(folder).isDirectory() || folder === path.dirname(folder)) {
        return false
      }
    }

    const real = fs.realpathSync(file)
    const kind = isInside(root, real) && fs.statSync(real).isFile() ? kindOf(real) : undefined
    return kind !== undefined && (data || kind !== "data")
  } catch {
    return false
  }
}

function changedAt(folder: string): number | undefined {
  try {
    return fs.statSync(folder).ctimeMs
  } catch {
    return undefined
  }
}

/** The renderable files directly inside a real folder, judged as listings judge them. */
export function renderableFiles(root: string, dir: string): { name: string; kind: Kind }[] {
  return readdir(dir).flatMap((dirent) => {
    const kind = dirent.isDirectory()
      ? undefined
      : fileKind(root, path.join(dir, dirent.name), dirent)
    return kind ? [{ name: dirent.name, kind }] : []
  })
}

/** The unpruned folders directly inside a real folder, symlinks excluded. */
export function subfolders(dir: string): string[] {
  return readdir(dir)
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(dir, dirent.name))
}

/** Only links within the folder count: a scheme or a host leads outside it. */
export function linkTarget(
  from: string,
  url: string,
): { path: string; fragment: string } | undefined {
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(url)) {
    return undefined
  }

  const hash = url.indexOf("#")
  const address = (hash < 0 ? url : url.slice(0, hash)).replace(/\?.*$/, "")
  let decoded: string

  try {
    decoded = decodeURIComponent(address)
  } catch {
    return undefined
  }

  const target = !decoded
    ? from
    : decoded.startsWith("/")
      ? path.posix.normalize(decoded.slice(1))
      : path.posix.join(path.posix.dirname(from), decoded)

  try {
    return { path: target, fragment: hash < 0 ? "" : decodeURIComponent(url.slice(hash + 1)) }
  } catch {
    return undefined
  }
}

/** Symlinked folders are never followed, so walks cannot loop; a symlinked file counts if its target does. */
function fileKind(root: string, full: string, dirent: fs.Dirent): Kind | undefined {
  if (dirent.isFile()) {
    return kindOf(dirent.name)
  }

  if (!dirent.isSymbolicLink() || !kindOf(dirent.name)) {
    return undefined
  }

  try {
    const real = fs.realpathSync(full)
    return isInside(root, real) && fs.statSync(real).isFile() ? kindOf(real) : undefined
  } catch {
    return undefined
  }
}

/** An unreadable folder holds nothing Folio can serve, so it lists as empty rather than failing the walk. */
function readdir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((dirent) => !isPruned(dirent.name))
  } catch {
    return []
  }
}
