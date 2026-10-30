/** Versions of what a tab shows, so a reconnecting tab learns exactly what changed while it was away. */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Data } from "./data.ts"
import { type Entry, listing } from "./files.ts"
import { impactOf, type Upstream } from "./impact.ts"
import { expand } from "./includes.ts"
import type { Backlink, Model, PageBlock } from "./model.ts"
import { drawnOf, partsOf } from "./parts.ts"
import type { Changed, LinkMark, Mark, Removed } from "./reads.ts"

export interface PageState {
  text: string
  files: string[]
  /** Ends in `-partial` while some block sources are still being parsed. */
  version: string
  blocks: PageBlock[]
  layout: PageLayout
}

export interface PageLayout {
  instances: { source: string; first: number; last: number; starts: number[]; ends: number[] }[]
  owners: number[]
}

export interface FolderState {
  entries: Entry[]
  version: string
}

export function pageState(root: string, file: string, model?: Model): PageState {
  const expansion = expand(root, file, model && ((target, text) => model.blocksReady(target, text)))
  const { text, files, instances, owners } = expansion
  const placed = model?.page(instances) ?? { blocks: [], partial: false }
  const partial = expansion.partial || placed.partial

  return {
    text,
    files,
    version: `${hash(text)}${partial ? "-partial" : ""}`,
    blocks: placed.blocks,
    layout: {
      instances: instances.map(({ file: source, first, last, starts, ends }) => ({
        source: path.relative(root, source).split(path.sep).join("/"),
        first,
        last,
        starts,
        ends,
      })),
      owners,
    },
  }
}

export function linksState(
  model: Model,
  urlPath: string,
  page: PageBlock[],
): { links: Backlink[]; version: string } {
  const links = model.backlinks(urlPath, page)

  return { links, version: hash(JSON.stringify(links)) }
}

interface ReadBlock extends Omit<PageBlock, "at"> {
  read: { version: string; at: string } | null
}

export interface ReadState {
  blocks: ReadBlock[]
  marks: Mark[]
  removed: Removed[]
  links: LinkMark[]
  /** What the page depends on that changed since it was last read. */
  upstream: Upstream[]
  version: string
}

export async function readState(
  model: Model,
  own: string,
  page: PageBlock[],
  data?: Data,
): Promise<ReadState> {
  await model.reads.load()
  const impact = data && impactOf(model, data)
  const keys = page.flatMap(({ source, id }) =>
    Object.keys(model.reads.get(source)?.blocks[id]?.embeds ?? {}),
  )
  const embeds = impact ? await impact.embeds([...new Set(keys)]) : new Map()
  const found = model.reads.marks(page, own, embeds)
  const { removed, links } = found
  const marks = found.marks.map((mark) => {
    const block = model.held(mark.source)?.find(({ id }) => id === mark.id)
    const drawn = block && drawnOf(block.text, block.kind)
    const parts =
      mark.before !== undefined && mark.after !== undefined
        ? block && partsOf(mark.before, mark.after, block.kind)
        : drawn !== undefined && { drawn, marked: [], gone: [] }
    return parts ? { ...mark, parts } : mark
  })
  const record = model.reads.get(own)
  const upstream = impact && record ? await impact.upstream(own, record) : []

  return {
    blocks: page.map(({ id, kind, source, lines, version }) => {
      const entry = model.reads.get(source)?.blocks[id]
      const seen =
        entry?.at === undefined
          ? null
          : { version: entry.version, at: new Date(entry.at).toISOString() }

      return { id, kind, source, lines, version, read: seen }
    }),
    marks,
    removed,
    links,
    upstream,
    version: hash(JSON.stringify([marks, removed, links, upstream])),
  }
}

export interface ChangedDocument {
  path: string
  blocks: number
  /** When the latest of its marked changes happened, as ISO time; the file's time when unknown. */
  at: string
}

export async function changed(
  model: Model,
  data?: Data,
): Promise<{ documents: Changed[]; version: string }> {
  await model.reads.load()
  const embeds = data ? await impactOf(model, data).embeds(model.reads.embedKeys()) : new Map()
  const documents = model.reads.changed(embeds)

  return {
    documents,
    version: hash(JSON.stringify(documents.map(({ path: p, blocks, at }) => [p, blocks, at]))),
  }
}

export async function changesState(
  root: string,
  model: Model,
  data?: Data,
): Promise<{ documents: ChangedDocument[]; version: string }> {
  const { documents, version } = await changed(model, data)
  const found = documents.map(({ path: urlPath, blocks, read, at }) => {
    const when =
      at || (fs.statSync(path.join(root, urlPath), { throwIfNoEntry: false })?.mtimeMs ?? read)
    return { path: urlPath, blocks, at: new Date(when).toISOString() }
  })

  return {
    documents: found.sort((a, b) => b.at.localeCompare(a.at) || a.path.localeCompare(b.path)),
    version,
  }
}

export function folderState(root: string, urlPath: string, data = false): FolderState | undefined {
  const entries = listing(root, urlPath, data)

  return entries && { entries, version: hash(JSON.stringify(entries)) }
}

export function fileVersion(file: string): string | undefined {
  try {
    const stat = fs.statSync(file)
    return `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`
  } catch {
    return undefined
  }
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}
