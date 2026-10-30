/** A page's markdown as it shows: includes filled in, embeds by what they show, tables in their views' order. */

import type { Nodes, Root } from "mdast"
import { TABLE, VALUE } from "./embeds.ts"
import { levelOf } from "./folds.ts"
import type { Viewed } from "./tableviews.ts"
import { unmarked } from "./unresolved.ts"

type Align = "left" | "right" | "center" | null

export interface Site {
  kind: "value" | "table" | "query" | "grid"
  start: number
  end: number
  ref?: string
  cells?: [number, number][][]
  align?: Align[]
}

/** A block's ranges in the page's text - the footnotes section has one per definition - and its sites. */
export interface Span {
  parts: [number, number][]
  sites: Site[]
}

interface Replacement {
  start: number
  end: number
  text: string
}

type Views = (table: HTMLTableElement) => Viewed | undefined

const SPANS = new WeakMap<Element, Span>()
const NOT_COPIED = "pre, hr, .mermaid, .embed-chart, .geo-map, .stl-model, .drawing-failed"
const QUERY = /^query(?:\s+\S+)?\s*$/
/** The quote markers and list markers a line opens with: a replacement's later lines stay inside them. */
const CONTAINERS = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$)[ \t]?)*[ \t]*/

export function sitesIn(tree: Root, text: string): Site[] {
  const shift = byteOrderMark(text)
  const found: Site[] = []
  const visit = (node: Nodes) => {
    if (node.position?.start.offset === undefined || node.position.end.offset === undefined) {
      return
    }

    const start = node.position.start.offset + shift
    const end = node.position.end.offset + shift

    if (node.type === "text") {
      for (const match of text.slice(start, end).matchAll(VALUE)) {
        found.push({
          kind: "value",
          start: start + match.index,
          end: start + match.index + match[0].length,
          ref: match[1],
        })
      }
    } else if (
      node.type === "paragraph" &&
      node.children.length === 1 &&
      node.children[0].type === "text" &&
      TABLE.test(node.children[0].value)
    ) {
      const at = start + text.slice(start, end).lastIndexOf("{table:")

      if (at >= start) {
        found.push({ kind: "table", start: at - Number(text[at - 1] === "\\"), end })
      }
    } else if (node.type === "code" && node.lang === "sql" && QUERY.test(node.meta ?? "")) {
      found.push({ kind: "query", start, end })
    } else if (node.type === "table") {
      found.push({
        kind: "grid",
        start,
        end,
        align: node.align ?? [],
        cells: node.children.map((row) =>
          row.children.map(
            (cell) =>
              [
                (cell.position?.start.offset ?? 0) + shift,
                (cell.position?.end.offset ?? 0) + shift,
              ] as [number, number],
          ),
        ),
      })
    }

    if ("children" in node) {
      for (const child of node.children) {
        visit(child as Nodes)
      }
    }
  }

  visit(tree)
  return found
}

/** The parser counts offsets after a byte order mark; the page's text keeps it. */
export function byteOrderMark(text: string): number {
  return text.startsWith("\uFEFF") ? 1 : 0
}

export function setSpan(block: Element, span: Span | undefined): void {
  if (span) {
    SPANS.set(block, span)
  }
}

export function moveSpan(from: Element, to: Element): void {
  const span = SPANS.get(from)

  if (span) {
    SPANS.set(to, span)
  }
}

export function copies(block: Element): boolean {
  return SPANS.has(block) && !block.matches(NOT_COPIED)
}

export function documentMarkdown(text: string, blocks: Element[], views: Views): string {
  return finished(
    apply(
      text,
      0,
      text.length,
      blocks.flatMap((block) => replaced(block, text, views)),
    ),
  )
}

export function blockMarkdown(
  text: string,
  blocks: Element[],
  block: Element,
  views: Views,
): string | undefined {
  const span = SPANS.get(block)

  if (!span || !copies(block)) {
    return undefined
  }

  const level = levelOf(block)

  if (Number.isFinite(level)) {
    const at = blocks.indexOf(block)
    const next = blocks.slice(at + 1).find((later) => levelOf(later) <= level)
    const end = (next && SPANS.get(next)?.parts[0][0]) ?? text.length
    const section = blocks.slice(at, next ? blocks.indexOf(next) : undefined)

    return finished(
      apply(
        text,
        span.parts[0][0],
        end,
        section.flatMap((member) => replaced(member, text, views)),
      ),
    )
  }

  const replacements = replaced(block, text, views)
  const written = span.parts
    .map(([start, end]) => apply(text, start, end, replacements))
    .join("\n\n")

  if (!block.matches("blockquote")) {
    return finished(written)
  }

  const quoted = written
    .split("\n")
    .map((line) => line.replace(/^[ \t]*>[ ]?/, ""))
    .join("\n")

  return finished(
    block.classList.contains("markdown-alert") ? quoted.slice(quoted.indexOf("\n") + 1) : quoted,
  )
}

function finished(markdown: string): string {
  return unmarked(markdown).trimEnd()
}

function replaced(block: Element, text: string, views: Views): Replacement[] {
  const span = SPANS.get(block)
  const within = (selector: string) =>
    [
      ...(block.matches(selector) ? [block] : []),
      ...block.querySelectorAll<HTMLElement>(selector),
    ] as HTMLElement[]
  const values = within('[data-embed="value"]')
  const tables = within('[data-embed="table"]')
  const queries = within('[data-embed="query"]')
  const grids = within("table").filter(
    (table) => !table.closest("[data-embed]") && !table.classList.contains("frontmatter"),
  ) as HTMLTableElement[]
  const found: Replacement[] = []

  for (const site of span?.sites ?? []) {
    if (site.kind === "value") {
      const at = values.findIndex((value) => value.dataset.ref === site.ref)
      const [value] = at < 0 ? [] : values.splice(at, 1)

      if (value && !value.classList.contains("embed-missing")) {
        found.push({ start: site.start, end: site.end, text: value.textContent ?? "" })
      }
    } else if (site.kind === "table" || site.kind === "query") {
      const holder = (site.kind === "table" ? tables : queries).shift()
      const table = holder?.querySelector<HTMLTableElement>(
        site.kind === "table" ? "table" : ":scope > .query-result table",
      )

      if (holder && table && !holder.classList.contains("embed-missing")) {
        found.push({ start: site.start, end: site.end, text: gridMarkdown(table, views(table)) })
      }
    }
  }

  for (const site of span?.sites.filter((one) => one.kind === "grid") ?? []) {
    const table = grids.shift()
    const viewed = table && views(table)

    if (table && viewed && site.cells) {
      found.push({
        start: site.start,
        end: site.end,
        text: tableMarkdown(text, site, Boolean(table.tHead), viewed, found),
      })
    }
  }

  return found
}

/** The text between two offsets with its replacements; an outer one takes the place of those it holds. */
function apply(text: string, start: number, end: number, replacements: Replacement[]): string {
  const inside = replacements
    .filter((one) => start <= one.start && one.end <= end)
    .sort((a, b) => a.start - b.start || b.end - a.end)
  let at = start
  let out = ""

  for (const one of inside) {
    if (one.start >= at) {
      const lead = text.slice(text.lastIndexOf("\n", one.start - 1) + 1, one.start)
      const within = (CONTAINERS.exec(lead.replace(/^\uFEFF/, ""))?.[0] ?? "").replace(
        /[^>\t ]/g,
        " ",
      )
      out += text.slice(at, one.start) + one.text.replaceAll("\n", `\n${within}`)
      at = one.end
    }
  }

  return out + text.slice(at, end)
}

function tableMarkdown(
  text: string,
  site: Site,
  headed: boolean,
  viewed: Viewed,
  values: Replacement[],
): string {
  const hidden = new Set(viewed.hidden)
  const [head, ...body] = site.cells ?? []
  const kept = (row: [number, number][]) =>
    row
      .filter((_, column) => !hidden.has(column))
      .map(([start, end]) =>
        apply(text, start, end, values)
          .replace(/^\s*\|/, "")
          .replace(/(?<!\\)\|\s*$/, "")
          .trim(),
      )
  const rows = viewed.rows.flatMap((row) => {
    const cells = body[viewed.written.indexOf(row)]
    return cells ? [cells] : []
  })
  const header = kept(head ?? [])
  const divider = (site.align ?? [])
    .filter((_, column) => !hidden.has(column))
    .slice(0, header.length)
    .map((align) =>
      align === "left" ? ":--" : align === "right" ? "--:" : align === "center" ? ":-:" : "---",
    )

  return [
    ...(headed
      ? [line(header), line([...divider, ...header.slice(divider.length).map(() => "---")])]
      : []),
    ...rows.map((row) => line(kept(row))),
  ].join("\n")
}

function gridMarkdown(table: HTMLTableElement, viewed: Viewed | undefined): string {
  const hidden = new Set(viewed?.hidden ?? [])
  const cell = (element: Element) =>
    (element.textContent ?? "")
      .replace(/\s*\n\s*/g, " ")
      .trim()
      .replaceAll("|", "\\|")
  const kept = (cells: Element[]) => cells.filter((_, column) => !hidden.has(column)).map(cell)
  const header = kept([...(table.tHead?.rows[0]?.cells ?? [])])
  const rows = viewed?.rows ?? [...(table.tBodies[0]?.rows ?? [])]

  return [
    line(header),
    line(header.map(() => "---")),
    ...rows.map((row) => line(kept([...row.cells]))),
  ].join("\n")
}

function line(cells: string[]): string {
  return `| ${cells.join(" | ")} |`
}
