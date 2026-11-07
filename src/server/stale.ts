/**
 * Documents that have probably outlived their use: by default unchanged for a year, never read and linked
 * from nowhere; below a folder whose declaration holds a `stale` query, the rows that query returns.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { conventionsOf, type Declaration } from "./conventions.ts"
import type { Data } from "./data.ts"
import { recordsOf, runDeclared } from "./declared.ts"
import type { Model } from "./model.ts"

interface Outlived {
  path: string
  changed: string
  why: string
}

export interface StaleState {
  ready: boolean
  documents: Outlived[]
  version: string
  watched: string[]
}

interface Kept {
  times: Map<string, { hash: string; at: number }>
  moved: boolean
  writing: Promise<void>
}

const UNCHANGED_MS = 365 * 86_400_000
const READ_AT_ONCE = 32
const KEPT_FILE = "stale.json"
const KEPT_FORMAT = 1
const KEPT = new WeakMap<Model, Promise<Kept>>()

export async function staleOf(model: Model, data: Data, now = Date.now()): Promise<StaleState> {
  if (!model.ready) {
    return { ready: false, documents: [], version: "", watched: [] }
  }

  await model.reads.load()
  const kept = await keptOf(model)
  const conventions = conventionsOf(model)
  const declaring = conventions
    .all()
    .filter((declaration) => declaration.stale !== undefined)
    .sort((a, b) => b.folder.length - a.folder.length)
  const nearest = (urlPath: string) =>
    declaring.find(({ folder }) => !folder || urlPath.startsWith(`${folder}/`))
  const documents: Outlived[] = []
  const watch = new Set<string>()

  const candidates = model
    .paths()
    .filter(
      (urlPath) =>
        !nearest(urlPath) && !model.reads.get(urlPath) && model.linkedFrom(urlPath).length === 0,
    )
  const times = new Map<string, number>()
  let next = 0

  await Promise.all(
    Array.from({ length: READ_AT_ONCE }, async () => {
      for (let at = next++; at < candidates.length; at = next++) {
        times.set(candidates[at], await changedAt(model, kept, candidates[at]))
      }
    }),
  )

  for (const urlPath of candidates) {
    const time = times.get(urlPath) ?? 0

    if (time < now - UNCHANGED_MS) {
      documents.push({
        path: urlPath,
        changed: new Date(time).toISOString(),
        why: "Unchanged for a year, never read and linked from nowhere",
      })
    }
  }

  const lastRead = new Map(
    model.reads.documents().map(({ path: at, at: when }) => [at, Date.parse(when)]),
  )
  // A named document leaves the list once read, edited or linked to, as a default candidate does.
  const used = (outlived: Outlived) =>
    (lastRead.get(outlived.path) ?? 0) > now - UNCHANGED_MS ||
    Date.parse(outlived.changed) > now - UNCHANGED_MS ||
    model.linkedFrom(outlived.path).length > 0

  for (const declaration of declaring) {
    documents.push(
      ...(await declared(model, data, kept, declaration, nearest, watch)).filter(
        (outlived) => outlived.path === declaration.path || !used(outlived),
      ),
    )
  }

  documents.sort((a, b) => a.changed.localeCompare(b.changed) || a.path.localeCompare(b.path))
  keep(model, kept)

  return {
    ready: true,
    documents,
    version: createHash("sha1").update(JSON.stringify(documents)).digest("hex").slice(0, 16),
    watched: [...watch],
  }
}

async function declared(
  model: Model,
  data: Data,
  kept: Kept,
  declaration: Declaration,
  nearest: (urlPath: string) => Declaration | undefined,
  watch: Set<string>,
): Promise<Outlived[]> {
  const run = await runDeclared(model, data, declaration, "stale", declaration.stale as string)

  for (const dir of run.watch) {
    watch.add(dir)
  }

  if (!run.grid?.columns.some((column) => column.name === "path")) {
    return [
      {
        path: declaration.path,
        changed: new Date(await changedAt(model, kept, declaration.path)).toISOString(),
        why: `The stale query cannot run: ${run.error ?? "it returns no path column."}`,
      },
    ]
  }

  const named = recordsOf(run.grid)
    .map((record) => String(record.path))
    .filter((urlPath) => model.hashOf(urlPath) !== undefined && nearest(urlPath) === declaration)

  return Promise.all(
    named.map(async (urlPath) => ({
      path: urlPath,
      changed: new Date(await changedAt(model, kept, urlPath)).toISOString(),
      why: `Named by the stale query of ${declaration.path}`,
    })),
  )
}

/**
 * When the text the document holds now first appeared - committed, saved, or else the file's time, which
 * a checkout resets - kept while the text holds, in the store too, so a restart reads no history for it.
 */
async function changedAt(model: Model, kept: Kept, urlPath: string): Promise<number> {
  const hash = model.hashOf(urlPath) ?? ""
  const known = kept.times.get(urlPath)

  if (known?.hash === hash) {
    return known.at
  }

  const [newest] = await model.history.versions(urlPath)
  const at =
    newest?.at ??
    fs.statSync(path.join(model.root, urlPath), { throwIfNoEntry: false })?.mtimeMs ??
    0
  kept.times.set(urlPath, { hash, at })
  kept.moved = true
  return at
}

export async function flushStale(model: Model): Promise<void> {
  await (await KEPT.get(model))?.writing
}

function keptOf(model: Model): Promise<Kept> {
  let kept = KEPT.get(model)

  if (!kept) {
    kept = fs.promises
      .readFile(path.join(model.store, KEPT_FILE), "utf8")
      .then(
        (text) =>
          JSON.parse(text) as {
            format?: number
            times?: Record<string, { hash: string; at: number }>
          },
      )
      .then(
        (stored) =>
          new Map(stored.format === KEPT_FORMAT ? Object.entries(stored.times ?? {}) : []),
      )
      .catch(() => new Map())
      .then((times) => ({ times, moved: false, writing: Promise.resolve() }))
    KEPT.set(model, kept)
  }

  return kept
}

function keep(model: Model, kept: Kept): void {
  if (!kept.moved) {
    return
  }

  kept.moved = false
  const file = path.join(model.store, KEPT_FILE)
  const times = Object.fromEntries(
    [...kept.times].filter(([urlPath]) => model.hashOf(urlPath) !== undefined),
  )
  kept.writing = kept.writing
    .then(async () => {
      await fs.promises.mkdir(model.store, { recursive: true })
      await fs.promises.writeFile(`${file}.tmp`, JSON.stringify({ format: KEPT_FORMAT, times }))
      await fs.promises.rename(`${file}.tmp`, file)
    })
    .catch((error: Error) => model.log(`stale: cannot keep the documents' times: ${error.message}`))
}
