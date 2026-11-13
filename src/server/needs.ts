/**
 * What needs the reader, ranked: errors, problems in documents they read, what the folder declares needs
 * attention, and changes to what they read.
 */

import { createHash } from "node:crypto"
import { conventionsOf } from "./conventions.ts"
import type { Data } from "./data.ts"
import { recordsOf, runDeclared } from "./declared.ts"
import { type HealthState, healthOf } from "./health.ts"
import type { Model } from "./model.ts"
import { changesState } from "./versions.ts"

export interface Need {
  source: "error" | "problem" | "attention" | "changed"
  path: string
  line?: number
  block?: string
  what: string
  name?: string
  at?: string
}

export interface NeedsState {
  ready: boolean
  needs: Need[]
  version: string
  watched: string[]
}

export interface NeedsPart {
  needs: Need[]
  watched: string[]
}

const RANK: Need["source"][] = ["error", "problem", "attention", "changed"]

export async function needsOf(model: Model, data: Data): Promise<NeedsState> {
  return needsFrom(
    await Promise.all([
      problemNeeds(model, data),
      attentionNeeds(model, data),
      changedNeeds(model, data),
    ]),
  )
}

/** A part not known yet - undefined - leaves the state unready; the others are shown. */
export function needsFrom(parts: (NeedsPart | undefined)[]): NeedsState {
  const needs = parts
    .flatMap((part) => part?.needs ?? [])
    .sort((a, b) => RANK.indexOf(a.source) - RANK.indexOf(b.source))
  const ready = parts.every((part) => part !== undefined)

  return {
    ready,
    needs,
    version: createHash("sha1")
      .update(JSON.stringify([ready, needs]))
      .digest("hex")
      .slice(0, 16),
    watched: [...new Set(parts.flatMap((part) => part?.watched ?? []))],
  }
}

/** Undefined until health is known, which is not the same as nothing wrong. */
export async function problemNeeds(model: Model, data: Data): Promise<NeedsPart | undefined> {
  return problemNeedsIn(model, await healthOf(model, data).state())
}

export async function problemNeedsIn(
  model: Model,
  health: HealthState,
): Promise<NeedsPart | undefined> {
  if (!health.ready) {
    return undefined
  }

  await model.reads.load()
  const read = new Set(model.reads.documents().map(({ path: at }) => at))
  const needs: Need[] = []

  for (const { kind, path: at, line, block, what, severity } of health.problems) {
    const source = severity === "error" ? "error" : read.has(at) ? "problem" : undefined

    if (source) {
      needs.push({ source, path: at, line, ...(block && { block }), what: `${kind}: ${what}` })
    }
  }

  return { needs, watched: [] }
}

/** Undefined until the folder is read: queries over a half-read folder list too little. */
export async function attentionNeeds(model: Model, data: Data): Promise<NeedsPart | undefined> {
  if (!model.ready) {
    return undefined
  }

  const conventions = conventionsOf(model)
  const needs: Need[] = []
  const dirs = new Set<string>()

  for (const declaration of conventions.all()) {
    for (const [name, definition] of Object.entries(declaration.attention)) {
      const found = await attention(model, data, declaration, name, definition, dirs)
      needs.push(...found.filter(({ path: at }) => !conventions.skipsAll(at)))
    }
  }

  return { needs, watched: [...dirs] }
}

/** Undefined until the folder is read: documents not read yet would count as changed. */
export async function changedNeeds(model: Model, data: Data): Promise<NeedsPart | undefined> {
  if (!model.ready) {
    return undefined
  }

  const { documents } = await changesState(model.root, model, data)

  return {
    needs: documents.map(({ path: at, blocks, at: when }) => ({
      source: "changed",
      path: at,
      what: `${blocks} ${blocks === 1 ? "block" : "blocks"} changed since last read`,
      at: when,
    })),
    watched: [],
  }
}

async function attention(
  model: Model,
  data: Data,
  declaration: { path: string; folder: string },
  name: string,
  { query, message }: { query: string; message: string },
  dirs: Set<string>,
): Promise<Need[]> {
  const {
    grid,
    error,
    watch: read,
  } = await runDeclared(model, data, declaration, `attention ${name}`, query)

  for (const dir of read) {
    dirs.add(dir)
  }

  return grid?.columns.some((column) => column.name === "path")
    ? recordsOf(grid).map((record) => ({
        source: "attention",
        name,
        path: String(record.path),
        ...(Number(record.line) > 0 && { line: Number(record.line) }),
        what: message.replace(/\{(\w+)\}/g, (all, column: string) =>
          Object.hasOwn(record, column) ? String(record[column] ?? "") : all,
        ),
      }))
    : [
        {
          source: "error",
          path: declaration.path,
          what: `The attention query ${name} cannot run: ${error ?? "it returns no path column."}`,
        },
      ]
}
