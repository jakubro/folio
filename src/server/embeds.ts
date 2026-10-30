/** What a document reads from the folder's data: its embeds' references, its charts' data and its queries. */

import type { Code, Nodes, Root } from "mdast"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { parse as parseYaml } from "yaml"
import { cycleIn } from "../client/cycles.ts"
import { MARKED, unmarked } from "../client/unresolved.ts"
import { gfm } from "./gfm.ts"
import type { Expansion } from "./includes.ts"

export interface Claim {
  reference: string
  figure: string
}

export interface QueryFence {
  name?: string
  /** The line its fence opens on: an unnamed query's address, `#@<line>`. */
  line: number
  sql: string
}

const MARKDOWN = unified().use(remarkParse).use(gfm)
const TABLE = /^\s*\{table:\s*([^}\n]+?)\s*\}\s*$/
export const VALUE = /\{value:\s*([^}\n]+?)(?:\s+\|\s+[^}\n]*?)?\s*\}/g
const QUERY = /^query(?:\s+(\S+))?\s*$/
const CLAIM_OPEN = /^<data\b[^>]*?\svalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>$/i
const CLAIM_CLOSE = /^<\/data\s*>$/i
const CODES = new Map<string, Code[]>()
const CODES_KEPT = 32

export function queriesIn(text: string): QueryFence[] {
  return codesOf(text).flatMap((code) => {
    const match = code.lang === "sql" ? QUERY.exec(code.meta ?? "") : null

    return match
      ? [
          {
            ...(match[1] && { name: match[1] }),
            line: code.position?.start.line ?? 0,
            sql: code.value,
          },
        ]
      : []
  })
}

export interface Fence {
  lang: string
  meta: string
  /** The line of the document's own file the fence opens on. */
  line: number
  /** What the fence shows, includes expanded and any that resolved to nothing as written. */
  text: string
  unresolved: boolean
}

/** The fences a document shows of its own text, as its page shows them once includes are expanded. */
export function fencesOf({ text, instances, owners }: Expansion): Fence[] {
  const own = instances[0]

  return codesOf(text).flatMap((code) => {
    const at = code.position?.start.line ?? 0
    const index = own && owners[at] === 0 ? own.starts.indexOf(at) : -1

    return index < 0
      ? []
      : [
          {
            lang: code.lang ?? "",
            meta: code.meta ?? "",
            line: own.first + index,
            text: unmarked(code.value),
            unresolved: code.value.includes(MARKED),
          },
        ]
  })
}

/**
 * A text's code blocks, kept for the texts read last: a document rechecked for what it reads, its own
 * text unchanged, is not parsed again.
 */
function codesOf(text: string): Code[] {
  const held = CODES.get(text)

  if (held) {
    CODES.delete(text)
    CODES.set(text, held)
    return held
  }

  const codes = codeIn(MARKDOWN.parse(text))
  CODES.set(text, codes)

  for (const oldest of [...CODES.keys()].slice(0, -CODES_KEPT)) {
    CODES.delete(oldest)
  }

  return codes
}

/** A document's queries as its page shows and runs them, includes expanded and escapes undone. */
export function queriesOf(expansion: Expansion): QueryFence[] {
  return queryFences(fencesOf(expansion))
}

export function queryFences(fences: Fence[]): QueryFence[] {
  return fences.flatMap(({ lang, meta, line, text }) => {
    const match = lang === "sql" ? QUERY.exec(meta) : null
    return match ? [{ ...(match[1] && { name: match[1] }), line, sql: text }] : []
  })
}

export function claimsIn(text: string): Claim[] {
  return claimsOf(MARKDOWN.parse(text))
}

export function referencesIn(text: string): string[] {
  const tree = MARKDOWN.parse(text)
  const found: string[] = claimsOf(tree).map(({ reference }) => reference)
  const visit = (node: Nodes) => {
    if (
      node.type === "paragraph" &&
      node.children.length === 1 &&
      node.children[0].type === "text"
    ) {
      const table = TABLE.exec(node.children[0].value)

      if (table) {
        found.push(table[1])
        return
      }
    }

    if (node.type === "text") {
      for (const match of node.value.matchAll(VALUE)) {
        found.push(match[1])
      }
    }

    if ("children" in node) {
      node.children.forEach(visit)
    }
  }

  visit(tree)

  for (const code of codeIn(tree)) {
    if (code.lang === "vega-lite") {
      found.push(...chartUrls(code.value))
    }
  }

  return found
}

/** The opening and closing tags of an inline element parse as separate HTML nodes around its text. */
function claimsOf(tree: Root): Claim[] {
  const found: Claim[] = []
  const visit = (node: Nodes) => {
    if (!("children" in node)) {
      return
    }

    let open: { reference: string; figure: string } | undefined

    for (const child of node.children as Nodes[]) {
      const opening = child.type === "html" ? CLAIM_OPEN.exec(child.value.trim()) : null

      if (opening) {
        open = { reference: (opening[1] ?? opening[2] ?? opening[3]).trim(), figure: "" }
      } else if (open && child.type === "html" && CLAIM_CLOSE.test(child.value.trim())) {
        found.push({ reference: open.reference, figure: open.figure.trim() })
        open = undefined
      } else if (open) {
        open.figure += plain(child)
      } else {
        visit(child)
      }
    }
  }

  visit(tree)
  return found.filter(({ reference, figure }) => reference && figure)
}

function plain(node: Nodes): string {
  return "value" in node && node.type !== "html"
    ? node.value
    : "children" in node
      ? (node.children as Nodes[]).map(plain).join("")
      : ""
}

function codeIn(tree: Root): Code[] {
  const found: Code[] = []
  const visit = (node: Nodes) => {
    if (node.type === "code") {
      found.push(node)
    } else if ("children" in node) {
      node.children.forEach(visit)
    }
  }

  visit(tree)
  return found
}

function chartUrls(source: string): string[] {
  let spec: unknown

  try {
    spec = JSON.parse(source)
  } catch {
    try {
      spec = parseYaml(source)
    } catch {
      return []
    }
  }

  if (cycleIn(spec) !== undefined) {
    return []
  }

  const found: string[] = []
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") {
      return
    }

    const url = (node as { data?: { url?: unknown } }).data?.url

    if (typeof url === "string") {
      found.push(url)
    }

    Object.values(node).forEach(visit)
  }

  visit(spec)
  return found
}
