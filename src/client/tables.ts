/**
 * Tables written loosely still render in full: rows wider than the header widen the table, and
 * consecutive lines starting or ending with a pipe form a table, headed when a divider line follows the first.
 */

import type { Nodes, Paragraph, Root, RootContent, Table } from "mdast"
import { defaultHandlers } from "remark-rehype"
import type { Processor, Transformer } from "unified"

type Point = NonNullable<Paragraph["position"]>["start"]

interface Source {
  text: string
  parse: (text: string) => RootContent[]
  at: (offset: number) => Point
}

const HEADERLESS = new WeakSet<Table>()
const EDGE_PIPE = /^\||(?<!\\)(?:\\\\)*\|$/
const DIVIDER = /^(?=.*\|)\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/
/** GFM keeps body cells beyond the header's count, so one header cell fits any row. */
const PLACEHOLDER_HEADER = "| |\n|-|\n"

/** Turn runs of pipe lines into headerless tables, and widen every table to its widest row. */
export function tables(this: Processor): Transformer<Root> {
  return (tree, file) => {
    // The parser counts offsets after a byte order mark, so the text it cuts from is read without one.
    const source = String(file.value).replace(/^\uFEFF/, "")
    const definitions = collect(tree, ["definition", "footnoteDefinition"])
      .map((node) => source.slice(node.position?.start.offset, node.position?.end.offset))
      .join("\n\n")
    const parse = (text: string) =>
      (this.parse(`${text}\n\n${definitions}`) as Root).children.filter(
        (node) => node.type !== "definition" && node.type !== "footnoteDefinition",
      )

    convert(tree, 0, { text: source, parse, at: pointer(source) })

    for (const table of collect(tree, ["table"]) as Table[]) {
      const width = Math.max(...table.children.map((row) => row.children.length))
      const align = table.align ?? []
      table.align = [...align, ...Array(Math.max(0, width - align.length)).fill(null)]
    }
  }
}

/** Render a table as usual, without its placeholder header row when it was written without one. */
export const table: typeof defaultHandlers.table = (state, node) => {
  const element = defaultHandlers.table(state, node)

  if (HEADERLESS.has(node)) {
    const sections = element.children.filter((child) => child.type === "element")
    element.children = state.wrap(
      sections.filter((section) => section.tagName !== "thead"),
      true,
    )
  }

  return element
}

function convert(parent: Nodes, quoteDepth: number, source: Source): void {
  if (!("children" in parent)) {
    return
  }

  const depth = quoteDepth + (parent.type === "blockquote" ? 1 : 0)
  parent.children = (parent.children as RootContent[]).flatMap((child) => {
    if (child.type === "paragraph") {
      return split(child, depth, source)
    }
    convert(child, depth, source)

    return [child]
  }) as typeof parent.children
}

function split(paragraph: Paragraph, quoteDepth: number, source: Source): RootContent[] {
  let offset = paragraph.position?.start.offset ?? 0
  const segments: { table: boolean; start: number; lines: string[]; starts: number[] }[] = []
  for (const [index, raw] of source.text
    .slice(offset, paragraph.position?.end.offset)
    .split("\n")
    .entries()) {
    const line = strip(raw, index === 0 ? 0 : quoteDepth)
    const piped = EDGE_PIPE.test(line.trimEnd()) || DIVIDER.test(line.trimEnd())
    const last = segments.at(-1)
    const begins = offset + raw.length - line.length

    if (last && last.table === piped) {
      last.lines.push(line)
      last.starts.push(begins)
    } else {
      segments.push({ table: piped, start: offset, lines: [line], starts: [begins] })
    }
    offset += raw.length + 1
  }

  const merged: typeof segments = []
  for (const segment of segments) {
    const table = segment.table && segment.lines.length > 1
    const last = merged.at(-1)

    if (last && !last.table && !table) {
      last.lines.push(...segment.lines)
      last.starts.push(...segment.starts)
    } else {
      merged.push({ ...segment, table })
    }
  }

  const cuts = merged.slice(1).map((segment) => segment.start)
  const spansCut = paragraph.children.some(
    (child) =>
      child.type !== "text" &&
      cuts.some(
        (cut) =>
          (child.position?.start.offset ?? 0) < cut && cut < (child.position?.end.offset ?? 0),
      ),
  )

  if (!merged.some((segment) => segment.table) || spansCut) {
    return [paragraph]
  }

  const dividers = merged.map((segment) =>
    segment.table && DIVIDER.test(segment.lines[1].trimEnd()) ? segment.lines[1].trim() : undefined,
  )
  const places: number[] = []
  const text = merged
    .map((segment, index) => {
      const kept = segment.lines.flatMap((_, at) => (at === 1 && dividers[index] ? [] : [at]))
      const first = segment.starts[0]
      places.push(
        ...(index > 0 ? [first] : []),
        ...(segment.table ? [first, first] : []),
        ...kept.map((at) => segment.starts[at]),
      )

      return (
        (segment.table ? PLACEHOLDER_HEADER : "") + kept.map((at) => segment.lines[at]).join("\n")
      )
    })
    .join("\n\n")
  const blocks = source.parse(text)
  const expected = merged.map((segment) => (segment.table ? "table" : "paragraph"))

  // A continuation line lifted out of its paragraph can parse as another block, e.g. `2. x` as a list.
  if (blocks.map((block) => block.type).join() !== expected.join()) {
    return [paragraph]
  }

  const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((found) => found.index + 1)]
  const inFile = ({ line, offset: at = 0 }: Point) =>
    source.at(places[line - 1] + at - lineStarts[line - 1])

  for (const [index, block] of blocks.entries()) {
    const divider = dividers[index]
    const following = merged[index + 1]?.start
    const end = following === undefined ? (paragraph.position?.end.offset ?? 0) : following - 1
    placeWithin(block, inFile)
    block.position = { start: source.at(merged[index].start), end: source.at(end) }

    if (block.type === "table" && divider) {
      block.children.shift()
      block.align = alignments(divider)
    } else if (block.type === "table") {
      HEADERLESS.add(block)
    }
  }

  return blocks
}

/** Nodes parsed from the rewritten text take their place in the file, so each knows where it was written. */
function placeWithin(node: Nodes, inFile: (point: Point) => Point): void {
  for (const child of "children" in node ? node.children : []) {
    if (child.position) {
      child.position = { start: inFile(child.position.start), end: inFile(child.position.end) }
    }

    if (child.data?.destination) {
      const { start, end } = child.data.destination
      child.data.destination = { start: inFile(start), end: inFile(end) }
    }

    placeWithin(child, inFile)
  }
}

function pointer(text: string): (offset: number) => Point {
  const breaks = [...text.matchAll(/\n/g)].map((found) => found.index)

  return (offset) => {
    let [low, high] = [0, breaks.length]

    while (low < high) {
      const middle = (low + high) >> 1
      ;[low, high] = breaks[middle] < offset ? [middle + 1, high] : [low, middle]
    }

    return { line: low + 1, column: offset - (low > 0 ? breaks[low - 1] + 1 : 0) + 1, offset }
  }
}

function alignments(divider: string): Table["align"] {
  return divider
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => {
      const [left, right] = [cell.trim().startsWith(":"), cell.trim().endsWith(":")]

      return left && right ? "center" : left ? "left" : right ? "right" : null
    })
}

function strip(line: string, quoteDepth: number): string {
  let content = line
  for (let level = 0; level < quoteDepth; level++) {
    content = content.replace(/^\s*>/, "")
  }

  return content.trimStart()
}

function collect(tree: Nodes, types: string[]): Nodes[] {
  const found = types.includes(tree.type) ? [tree] : []

  return "children" in tree
    ? [...found, ...tree.children.flatMap((child) => collect(child, types))]
    : found
}
