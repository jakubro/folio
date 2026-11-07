/** The read-only model API: what Folio knows of the folder, as JSON, for agents and other tools. */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { conventionsOf } from "./conventions.ts"
import type { Data } from "./data.ts"
import { digest } from "./digest.ts"
import { type Part, partOf, within } from "./failures.ts"
import { belowRoot, confine, isDocument, isPruned, renderable } from "./files.ts"
import { healthOf } from "./health.ts"
import { impactOf } from "./impact.ts"
import type { Model } from "./model.ts"
import { needsOf } from "./needs.ts"
import { presenceOf } from "./presence.ts"
import { provenance } from "./provenance.ts"
import { Unreadable } from "./queries.ts"
import { relatedOf } from "./related.ts"
import { staleOf } from "./stale.ts"
import { changesState, pageState, readState } from "./versions.ts"

export class Refusal extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Resource = (asked: Asked) => Promise<unknown> | unknown

interface Asked {
  root: string
  model: Model
  data: Data
  /** The path the request names, relative to the served folder; "" for the folder itself. */
  urlPath: string
  query: URLSearchParams
}

const DAY_MS = 86_400_000
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)([Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/
const EXCERPT = 300
const SHARED = new Set(["reads", "changes", "needs", "presence", "stale"])

export const PATHS = "a path is relative to it, or absolute under it"

export const PAUSED = {
  paused: true,
  message: "The reader has paused sharing in Folio: what they read and look at is not shared.",
}

export const RESOURCES: Record<
  string,
  { address: string; answers: string; part: Part; read: Resource }
> = {
  documents: {
    address: "/<folder>/?api=documents",
    answers: "Every document under the folder, with its kind when a declaration places it",
    part: "model",
    read: ({ model, urlPath }) => {
      const prefix = urlPath && !urlPath.endsWith("/") ? `${urlPath}/` : urlPath
      const conventions = conventionsOf(model)

      return {
        ready: model.ready,
        documents: model
          .paths()
          .filter((found) => found.startsWith(prefix))
          .sort()
          .map((found) => ({ path: found, kind: conventions.kindOf(found) ?? null })),
      }
    },
  },
  document: {
    address: "/<path>?api=document",
    answers:
      "A document's blocks - id, kind, lines, the start of its text - its blocks as its page places them through includes, its kind and fields, and the data files it reads",
    part: "model",
    read: async ({ root, model, data, urlPath }) => {
      const file = documentFile(root, urlPath)
      const own = model.inspect(urlPath)

      if (!own) {
        throw new Refusal(503, "Folio has not read this document yet.")
      }

      return {
        ...own,
        page: pageState(root, file, model).blocks,
        conventions: conventionsOf(model).describe(urlPath),
        data: await data.dependencies(file),
      }
    },
  },
  provenance: {
    address: "/<path>?api=provenance&block=<id>[&source=<file>]",
    answers:
      "Where one block of the page came from: its file, lines, last change, data and figures",
    part: "provenance",
    read: async ({ root, model, data, urlPath, query }) => {
      const file = documentFile(root, urlPath)
      const source = query.get("source") ?? urlPath
      documentFile(root, source)
      const found = await provenance(
        root,
        model,
        data,
        pageState(root, file, model),
        urlPath,
        source,
        required(query, "block"),
      )

      if (!found) {
        throw new Refusal(404, "No such block on this page.")
      }

      return found
    },
  },
  related: {
    address: "/<path>?api=related&block=<id>[&source=<file>] or /?api=related&question=<text>",
    answers:
      "The blocks elsewhere in the folder closest in meaning to blocks of a page, taken together, or to a question, closest first - where a FOLIO.md's related asks for it",
    part: "related",
    read: ({ root, model, urlPath, query }) => {
      const question = query.get("question")

      if (question?.trim()) {
        return relatedOf(model).ask(question)
      }

      const blocks = query.getAll("block").map((block) => {
        const split = block.lastIndexOf("#")
        return split > 0
          ? { source: block.slice(0, split), id: block.slice(split + 1) }
          : { source: query.get("source") ?? urlPath, id: block }
      })

      if (blocks.length === 0) {
        throw new Refusal(400, "Name a block of the page, or ask a question.")
      }

      for (const { source } of blocks) {
        documentFile(root, source)
      }

      return relatedOf(model).near(urlPath, blocks)
    },
  },
  query: {
    address: "/<folder>/?api=query&sql=<select>",
    answers:
      "The result of one SELECT, run from the folder as a query in it runs, reading data files and the document tables",
    part: "data engine",
    read: async ({ root, data, urlPath, query }) => {
      const { grid, files } = await data
        .query(required(query, "sql"), path.join(root, urlPath), { absolute: true })
        .catch((error: Error) => {
          const part = partOf(error)

          // The engine is guarded as a part, so its mark is on every error the query itself meets.
          if (part !== undefined && part !== "data engine") {
            throw error
          }

          throw new Refusal(
            400,
            error instanceof Unreadable
              ? `${error.message} The served folder is ${root}: a path in a query is relative to the query's folder, from the served folder after a slash, or absolute under it.`
              : error.message,
          )
        })
      return { ...grid, files }
    },
  },
  embed: {
    address: "/<path>?api=embed&reference=<reference>",
    answers:
      "What a reference written in the document names - a file's rows, a value, a query's result",
    part: "data engine",
    read: ({ root, data, urlPath, query }) => {
      const reference = required(query, "reference")
      const below = belowRoot(root, reference)

      return data.embedReference(
        documentFile(root, urlPath),
        below === undefined ? reference : `/${below}`,
      )
    },
  },
  kinds: {
    address: "/<path>?api=kinds",
    answers:
      "The kinds, rules and health entries applying at a path, layered as the declarations layer them",
    part: "declarations",
    read: ({ model, urlPath }) => {
      const { kinds, rules, health } = conventionsOf(model).layered(urlPath)
      const from = ({ from: declared }: { from: { path: string } }) => declared.path

      return {
        declarations: conventionsOf(model)
          .applying(urlPath)
          .map((declaration) => declaration.path),
        kinds: kinds.map((kind) => ({
          name: kind.name,
          declaredIn: from(kind),
          where: kind.definition.where.map(String),
          fields: kind.definition.fields,
        })),
        rules: rules.map((rule) => ({
          name: rule.name,
          declaredIn: from(rule),
          ...rule.definition,
        })),
        health: health.map((entry) => ({
          declaredIn: from(entry),
          where: entry.definition.where.map(String),
          skip: entry.definition.skip,
          error: entry.definition.error,
        })),
      }
    },
  },
  health: {
    address: "/?api=health, /<path>?api=health",
    answers:
      "Everything wrong in the folder, or in a document or the folder under it - each problem's kind, document, line, block, severity and what is wrong",
    part: "health",
    read: async ({ root, model, data, urlPath }) =>
      narrowed(root, urlPath, "problems", await healthOf(model, data).state()),
  },
  presence: {
    address: "/?api=presence",
    answers:
      "What the reader is looking at now: the page in each open tab and the block under the pointer, with the start of its text, the most recent first",
    part: "presence",
    read: ({ model }) => ({
      paused: false,
      looking: presenceOf(model)
        .looking()
        .map((looking) => {
          const text = looking.block
            ? model.held(looking.block.source)?.find(({ id }) => id === looking.block?.id)?.text
            : undefined
          return {
            ...looking,
            ...(looking.block &&
              text !== undefined && {
                block: { ...looking.block, text: text.slice(0, EXCERPT) },
              }),
          }
        }),
    }),
  },
  needs: {
    address: "/?api=needs, /<path>?api=needs",
    answers:
      "What needs the reader, ranked: errors, problems in documents they read, rows of the folder's attention queries, and changes to what they read; for a path, only what lies there",
    part: "needs",
    read: async ({ root, model, data, urlPath }) => {
      const { ready, needs, version } = await needsOf(model, data)
      return narrowed(root, urlPath, "needs", { ready, needs, version })
    },
  },
  stale: {
    address: "/?api=stale, /<path>?api=stale",
    answers:
      "Documents that have probably outlived their use - by default unchanged for a year, never read and linked from nowhere, or what a folder's stale query names - each with when it last changed and why; for a path, only those there",
    part: "stale",
    read: async ({ root, model, data, urlPath }) => {
      const { ready, documents, version } = await staleOf(model, data)
      return narrowed(root, urlPath, "documents", { ready, documents, version })
    },
  },
  changes: {
    address: "/?api=changes, /<path>?api=changes",
    answers:
      "Every document read before whose blocks changed since, newest change first; for a path, only those there",
    part: "read record",
    read: async ({ root, model, data, urlPath }) =>
      narrowed(root, urlPath, "documents", await changesState(root, model, data)),
  },
  reads: {
    address: "/?api=reads, /<path>?api=reads",
    answers:
      "Every document read and when it was last read; for a document, each block with its version and the version and time it was read, and what is marked new, changed or removed",
    part: "read record",
    read: async ({ root, model, data, urlPath }) => {
      await model.reads.load()

      if (!urlPath || urlPath.endsWith("/")) {
        return { documents: model.reads.documents(urlPath) }
      }

      const file = documentFile(root, urlPath)
      const state = await readState(model, urlPath, pageState(root, file, model).blocks, data)
      return { ...state, marks: timed(state.marks), removed: timed(state.removed) }
    },
  },
  history: {
    address: "/<path>?api=history[&version=<id>|&block=<id>|&reference=<reference>]",
    answers:
      "A document's versions, newest first; with version, that version's text; with block, each text the block has had; with reference, each result the embed has shown",
    part: "history",
    read: async ({ model, urlPath, query }) => {
      const history = model.history
      const version = query.get("version")
      const block = query.get("block")
      const reference = query.get("reference")

      if (version !== null) {
        return { path: urlPath, version, text: (await history.text(urlPath, version)) ?? null }
      }

      if (block !== null) {
        return {
          path: urlPath,
          block,
          versions: timed(await history.block(urlPath, block, model.held(urlPath) ?? [])),
        }
      }

      if (reference !== null) {
        return {
          path: urlPath,
          reference,
          results: timed(await history.values(urlPath, reference)),
        }
      }

      return { path: urlPath, versions: timed(await history.versions(urlPath)) }
    },
  },
  "used-by": {
    address: "/<path>?api=used-by",
    answers: "The documents including the file, or whose embeds and queries read it",
    part: "used-by",
    read: async ({ model, data, urlPath }) =>
      model.ready
        ? { ready: true, documents: await impactOf(model, data).dependents(urlPath) }
        : { ready: false, documents: [] },
  },
  digest: {
    address: "/?api=digest[&from=<time>&to=<time>]",
    answers:
      "Every document created, changed or removed in a period, and every value that moved; the last day by default",
    part: "digest",
    read: async ({ root, model, query }) => {
      const to = timeOf("to", query.get("to")) ?? Date.now()
      const from = timeOf("from", query.get("from")) ?? to - DAY_MS
      const found = await digest(root, model, from, to)

      return { ...found, from: iso(found.from), to: iso(found.to), values: timed(found.values) }
    },
  },
}

export async function api(
  root: string,
  model: Model,
  data: Data,
  asked: string,
  query: URLSearchParams,
): Promise<unknown> {
  const name = query.get("api") ?? ""

  if (!name) {
    return {
      folio: path.basename(root),
      root,
      ready: model.ready,
      resources: Object.fromEntries(
        Object.entries(RESOURCES).map(([key, { address, answers }]) => [key, { address, answers }]),
      ),
    }
  }

  const resource = RESOURCES[name]

  if (!resource) {
    throw new Refusal(404, `No resource is named ${name}: ?api lists them.`)
  }

  if (SHARED.has(name) && presenceOf(model).paused) {
    return PAUSED
  }

  // An address holds no leading slash of its own, so the absolute form is read only where nothing is at the path.
  const urlPath = confine(root, asked) ? asked : (belowRoot(root, `/${asked}`) ?? asked)
  const source = query.get("source")
  const shown = new URLSearchParams(query)

  if (source) {
    shown.set("source", placed(root, source))
  }

  for (const apart of [urlPath, shown.get("source")]) {
    if (apart) {
      await within("model", () => readPageApart(root, model, apart))
    }
  }

  return within(resource.part, () => resource.read({ root, model, data, urlPath, query: shown }))
}

async function readPageApart(root: string, model: Model, urlPath: string): Promise<void> {
  const target = urlPath.split("/").some(isPruned) ? renderable(root, urlPath) : undefined
  const read = new Set<string>()

  for (let next = [urlPath]; next.length > 0 && target && isDocument(target.kind); ) {
    for (const one of next) {
      read.add(one)
      await model.readApart(one)
    }

    next = pageState(root, target.file, model)
      .files.map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter((source) => !read.has(source) && source.split("/").some(isPruned))
  }
}

function placed(root: string, written: string): string {
  if (!written.startsWith("/")) {
    return written
  }

  const below = belowRoot(root, written)

  if (below === undefined) {
    throw new Refusal(404, `${written} is outside the served folder, ${root}: ${PATHS}.`)
  }

  return below
}

/** Keep a list's entries lying at a document or under a folder; the version then names that list alone. */
function narrowed<
  K extends string,
  T extends { [key in K]: { path: string }[] } & { version: string },
>(root: string, urlPath: string, key: K, state: T): T {
  if (!urlPath) {
    return state
  }

  const found = confine(root, urlPath)

  if (
    !found ||
    !(isDocument(renderable(root, urlPath)?.kind) || fs.statSync(found).isDirectory())
  ) {
    throw new Refusal(
      404,
      `${urlPath} is no document or folder of the served folder, ${root}: ${PATHS}.`,
    )
  }

  const at = urlPath.replace(/\/$/, "")
  const kept = state[key].filter(({ path: entry }) => entry === at || entry.startsWith(`${at}/`))

  return {
    ...state,
    [key]: kept,
    version: createHash("sha1")
      .update(JSON.stringify(["ready" in state ? state.ready : null, kept]))
      .digest("hex")
      .slice(0, 16),
  }
}

/**
 * A time without an offset is UTC, as a date alone is - where Date.parse would read the machine's zone.
 * It names its whole millisecond: a time an answer gave, cut to the millisecond, still takes in what it timed.
 */
function timeOf(name: string, written: string | null): number | undefined {
  if (written === null) {
    return undefined
  }

  const parts = ISO_TIME.exec(written)
  const [year, month, day] = (parts?.slice(1, 4) ?? []).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  const at =
    parts && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4] ?? "00:00"}${zone(parts[5])}`)
      : Number.NaN

  if (!Number.isFinite(at)) {
    throw new Refusal(
      400,
      `${name} ${written} is no time Folio reads: it reads an ISO 8601 date, 2026-11-02, or a date and time to the minute or finer with an optional offset - Z, +01 or +01:00 - as 2026-11-02T09:00:00+01:00; a date alone is midnight UTC, a time without an offset UTC.`,
    )
  }

  // The largest time below the next millisecond: adding a fixed 0.999 rounds short of it at today's times.
  const next = at + 1
  return next - 2 ** (Math.floor(Math.log2(Math.abs(next) || 1)) - 52)
}

function zone(written: string | undefined): string {
  const offset = written?.toUpperCase()

  return !offset || offset === "Z"
    ? "Z"
    : offset.length === 3
      ? `${offset}:00`
      : offset.includes(":")
        ? offset
        : `${offset.slice(0, 3)}:${offset.slice(3)}`
}

function timed<T extends { at?: number }>(entries: T[]): (Omit<T, "at"> & { at?: string })[] {
  return entries.map(({ at, ...entry }) => ({ ...entry, ...(at !== undefined && { at: iso(at) }) }))
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

function documentFile(root: string, urlPath: string): string {
  const target = renderable(root, urlPath)

  if (!target || !isDocument(target.kind)) {
    throw new Refusal(
      404,
      `${urlPath || "/"} is no document of the served folder, ${root}: ${PATHS}.`,
    )
  }

  return target.file
}

function required(query: URLSearchParams, name: string): string {
  const value = query.get(name)

  if (value === null || value === "") {
    throw new Refusal(400, `This resource needs ${name}.`)
  }

  return value
}
