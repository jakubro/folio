/**
 * A digest of a period: documents created, changed and removed, each changed block before and after,
 * and every embedded value that moved.
 */

import fs from "node:fs"
import path from "node:path"
import { isInside, isPruned } from "./files.ts"
import { repositoryOf, touched } from "./git.ts"
import type { ValueResult, Version } from "./history.ts"
import type { Model } from "./model.ts"

export interface DigestDocument {
  path: string
  status: "created" | "changed" | "removed"
  /** The versions the period started and ended on, where the document had one. */
  from?: string
  to?: string
}

interface MovedValue {
  document: string
  reference: string
  before: string
  after: string
  at: number
}

export interface Digest {
  from: number
  to: number
  documents: DigestDocument[]
  values: MovedValue[]
}

const DOCUMENT = /\.(md|markdown|mermaid|mmd)$/i

/** What changed between two times, in milliseconds, worked out on demand; nothing is written. */
export async function digest(
  root: string,
  model: Model,
  from: number,
  to: number,
): Promise<Digest> {
  const history = model.history
  const documents: DigestDocument[] = []

  for (const urlPath of [...(await candidates(root, model, from, to))].sort()) {
    const versions = await history.versions(urlPath)
    const start = latest(versions, from)
    const end = latest(versions, to)
    const was = start && !start.removed
    const is = end && !end.removed

    if (!was && is && (seenBorn(versions, to) || bornIn(path.join(root, urlPath), from))) {
      documents.push({ path: urlPath, status: "created", to: end.id })
    } else if (!was && is) {
      documents.push({ path: urlPath, status: "changed", to: end.id })
    } else if (was && !is) {
      documents.push({ path: urlPath, status: "removed", from: start.id })
    } else if (was && is && start.id !== end.id) {
      documents.push({ path: urlPath, status: "changed", from: start.id, to: end.id })
    }
  }

  return { from, to, documents, values: moved(await history.allValues(), from, to) }
}

/**
 * Every document something in the period may have touched: folio's saves, git's commits in every
 * repository the folder holds or lies in, and files whose time falls in it.
 */
async function candidates(
  root: string,
  model: Model,
  from: number,
  to: number,
): Promise<Set<string>> {
  const found = new Set(await model.history.savedIn(from, to))
  const tops = new Set<string>()

  for (const folder of [
    root,
    ...model.folders().filter((dir) => fs.existsSync(path.join(dir, ".git"))),
  ]) {
    const top = await repositoryOf(folder, root)

    if (top) {
      tops.add(top)
    }
  }

  for (const top of tops) {
    for (const file of await touched(top, from, to)) {
      const urlPath = path.relative(root, file).split(path.sep).join("/")

      if (
        isInside(root, file) &&
        DOCUMENT.test(file) &&
        !urlPath.split("/").some((part) => isPruned(part))
      ) {
        found.add(urlPath)
      }
    }
  }

  for (const urlPath of model.paths()) {
    const time = fs.statSync(path.join(root, urlPath), { throwIfNoEntry: false })?.mtimeMs ?? 0

    if (from < time && time <= to) {
      found.add(urlPath)
    }
  }

  return found
}

/**
 * A document seen only as the file on disk may have existed long before: it was created in the
 * period only if folio or git saw it come to be, or the file itself was born in it.
 */
function seenBorn(versions: Version[], to: number): boolean {
  return versions.some(({ at, seen }) => at <= to && seen.some((how) => how !== "file"))
}

function bornIn(file: string, from: number): boolean {
  return (fs.statSync(file, { throwIfNoEntry: false })?.birthtimeMs ?? 0) > from
}

function latest(versions: Version[], at: number): Version | undefined {
  return versions.find((version) => version.at <= at)
}

function moved(
  kept: { from: string; reference: string; results: ValueResult[] }[],
  from: number,
  to: number,
): MovedValue[] {
  const found: MovedValue[] = []

  // A value first shown inside the period starts from that first showing.
  for (const { from: document, reference, results } of kept) {
    const before =
      results.findLast((result) => result.at <= from) ??
      results.find((result) => result.at > from && result.at <= to)
    const after = results.findLast((result) => result.at <= to)

    const [was, is] = before && after ? summaries(before, after) : ["", ""]

    if (before && after && after.at > from && was !== is) {
      found.push({ document, reference, before: was, after: is, at: after.at })
    }
  }

  return found.sort(
    (a, b) => a.document.localeCompare(b.document) || a.reference.localeCompare(b.reference),
  )
}

/**
 * Two tables of the same size read alike, so the first cell that differs is named in both; a
 * difference beyond the rows kept leaves the two alike, and the value is not listed.
 */
function summaries(before: ValueResult, after: ValueResult): [string, string] {
  const was = summary(before)
  const is = summary(after)

  if (was !== is || !before.table || !after.table) {
    return [was, is]
  }

  const { columns, rows } = before.table
  const other = after.table

  if (columns.join("\0") !== other.columns.join("\0")) {
    return [`${was}, columns ${columns.join(", ")}`, `${is}, columns ${other.columns.join(", ")}`]
  }

  for (const [index, row] of rows.entries()) {
    const column = row.findIndex((cell, at) => !Object.is(cell, other.rows[index]?.[at]))

    if (column >= 0) {
      const cell = (value: unknown) => `row ${index + 1} ${columns[column]}: ${String(value)}`
      return [`${was}, ${cell(row[column])}`, `${is}, ${cell(other.rows[index]?.[column])}`]
    }
  }

  return [was, is]
}

function summary({ value, table, error }: ValueResult): string {
  if (error) {
    return error
  }

  if (table) {
    return `a table of ${table.total} ${table.total === 1 ? "row" : "rows"}`
  }

  return typeof value === "string" ? value : JSON.stringify(value)
}
