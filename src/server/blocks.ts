/** A document as the blocks its page shows, each with an identity that lasts while the block is edited. */

import { createHash } from "node:crypto"
import GithubSlugger from "github-slugger"
import type { Nodes as HastNodes, Root as HastRoot } from "hast"
import { toString as textOf } from "hast-util-to-string"
import type { Definition, Image, Link as LinkNode, Nodes, Root, RootContent } from "mdast"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import remarkFrontmatter from "remark-frontmatter"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { type Processor, unified } from "unified"
import { backticks } from "../client/backticks.ts"
import { SCHEMA } from "../client/schema.ts"
import { table, tables } from "../client/tables.ts"
import { type Claim, claimsIn, queriesIn, referencesIn, VALUE } from "./embeds.ts"
import { gfm } from "./gfm.ts"

export interface Block {
  id: string
  kind: string
  /** First and last line in its file, 1-based and inclusive. */
  lines: [number, number]
  text: string
  /** A heading's anchor, named as the page names it. */
  slug?: string
  /** A heading's text as its anchor is made from. */
  title?: string
  /** Every heading the page draws from the block, itself included, in order. */
  headings?: Heading[]
  links?: Link[]
  /** When the block took its current text, in milliseconds. */
  seen?: number
  /** What its embeds and charts name, and the SQL of its queries. */
  references?: string[]
  queries?: string[]
  claims?: Claim[]
  /** Where it holds text its page reads no link in - code, HTML, math, frontmatter - by offset in its file. */
  literals?: Literal[]
  /** Where it writes the address of each link and definition, angle brackets included, by offset in its file. */
  addresses?: Address[]
}

interface Literal {
  type: string
  start: number
  end: number
}

interface Address {
  start: number
  end: number
  /** The address as its page reads it, escapes and character references decoded. */
  url: string
}

type Places = Required<Pick<Block, "literals" | "addresses">>

declare module "mdast" {
  interface Data {
    destination?: NonNullable<Nodes["position"]>
  }
}

interface Heading {
  text: string
  /** The anchor its author gave it, which the page keeps and numbers no other heading for. */
  id?: string
  level: number
  /** Its line in its file, 1-based. */
  line: number
}

interface Link {
  url: string
  /** The block's text around the link, as read. */
  context: string
}

type Part = Omit<Block, "id">

interface Drawn extends Omit<Heading, "line"> {
  offset: number
  slug?: string
}

const MARKDOWN = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(gfm)
  .use(remarkMath)
  .use(backticks)
  .use(destinations)
  .use(tables)
const HTML = unified().use(remarkRehype, { allowDangerousHtml: true, handlers: { table } })
const RAW = unified().use(rehypeRaw)
const SANITIZE = unified().use(rehypeSanitize, SCHEMA)
const KINDS: Record<string, string> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  table: "table",
  code: "code",
  blockquote: "quote",
  math: "math",
  html: "html",
  thematicBreak: "rule",
  yaml: "frontmatter",
  definition: "definition",
  footnoteDefinition: "footnote",
}
const SIMILAR = 0.5
const DIVIDER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const EXACT = new Set(["code", "diagram", "frontmatter"])
const ITEM = /^([ \t]*)([-*+]|\d+[.)])(?:[ \t]+|$)(.*)$/
const EMBEDS = /\{table:|\{value:|```\s*vega-lite|```\s*sql\s+query|<data\s/i
const CONTEXT = 80
const INCLUDE = /(\\?)\{include:\s*([^}\n[\]{"',]*?)\s*\}/g
const HIDDEN = "\uE0A0"
const HIDDEN_RUN = /\uE0A0(?:\s*\uE0A0)*/g
const LITERALS = new Set(["inlineCode", "code", "html", "math", "inlineMath", "yaml"])
const PHRASING = new Set([
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "tableCell",
])

/** Split a document into its top-level blocks, keeping the identity of each block found in its last version. */
export function blocks(
  text: string,
  kind: "markdown" | "mermaid",
  previous: Block[] = [],
): Block[] {
  return identify(kind === "mermaid" ? diagram(text) : parts(text), previous)
}

function parts(text: string): Part[] {
  const tree = MARKDOWN.runSync(MARKDOWN.parse(text), text) as Root
  const drawn = headingsOf(tree, text)
  const breaks = [...text.matchAll(/\n/g)].map((found) => found.index)
  const lineAt = (offset: number) => {
    let [low, high] = [0, breaks.length]

    while (low < high) {
      const middle = (low + high) >> 1
      ;[low, high] = breaks[middle] < offset ? [middle + 1, high] : [low, middle]
    }

    return low + 1
  }
  const definitions = new Map(
    tree.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier.toLowerCase(), node.url]] : [],
    ),
  )
  const masked = text.includes("{include:") ? withIncludesMasked(text) : undefined

  return tree.children.map((node: RootContent, index) => {
    const { start, end } = node.position as NonNullable<RootContent["position"]>
    const language = node.type === "code" ? node.lang : undefined
    const links = linksIn(node, definitions)
    const shown = masked?.children[index]
    const read = shown?.type === node.type ? linksIn(shown, definitions) : []

    if (read.length === links.length) {
      links.forEach((link, at) => {
        link.context = read[at].context
      })
    }
    const { literals, addresses } = placesIn(node, text)
    const [from, to] = [start.offset as number, end.offset as number]
    const headings = drawn.filter(({ offset }) => from <= offset && offset < to)

    return {
      kind:
        language === "mermaid"
          ? "diagram"
          : language === "math"
            ? "math"
            : (KINDS[node.type] ?? node.type),
      lines: [start.line, end.line],
      text: text.slice(start.offset, end.offset),
      ...(node.type === "heading" && { slug: headings[0]?.slug, title: headings[0]?.text }),
      ...(headings.length > 0 && {
        headings: headings.map(({ text: title, id, level, offset }) => ({
          text: title,
          ...(id !== undefined && { id }),
          level,
          line: lineAt(offset),
        })),
      }),
      ...(links.length > 0 && { links }),
      ...(literals.length > 0 && { literals }),
      ...(addresses.length > 0 && { addresses }),
      ...reachOf(text.slice(start.offset, end.offset)),
    }
  })
}

/** Worked out here, on the indexer's thread, so no page waits while a long document is parsed again. */
function reachOf(text: string): Pick<Block, "references" | "queries" | "claims"> {
  if (!EMBEDS.test(text)) {
    return {}
  }

  const references = referencesIn(text)
  const queries = queriesIn(text).map(({ sql }) => sql)
  const claims = claimsIn(text)

  return {
    ...(references.length > 0 && { references }),
    ...(queries.length > 0 && { queries }),
    ...(claims.length > 0 && { claims }),
  }
}

/**
 * Headings are read off the page as the page draws it - raw HTML parsed, then sanitized - and named
 * and anchored as its slugger names them, so every form of heading reads as the browser shows it.
 */
function headingsOf(tree: Root, text: string): Drawn[] {
  let hast = HTML.runSync(tree, text) as HastRoot

  if (some(hast, (node) => node.type === "raw")) {
    hast = RAW.runSync(hast, text) as HastRoot
  }

  const slugger = new GithubSlugger()
  const drawn: Drawn[] = []
  const visit = (node: HastNodes) => {
    if (node.type === "element" && /^h[1-6]$/.test(node.tagName)) {
      const id = typeof node.properties.id === "string" ? node.properties.id : undefined
      const title = textOf(node)
      const slug = id === undefined ? slugger.slug(title) : undefined
      const offset = node.position?.start.offset

      if (offset !== undefined) {
        drawn.push({
          offset,
          text: title,
          slug,
          id: id?.replace(/^user-content-/, ""),
          level: Number(node.tagName[1]),
        })
      }
    }

    if ("children" in node) {
      node.children.forEach(visit)
    }
  }

  visit(SANITIZE.runSync(hast, text) as HastRoot)
  return drawn
}

function some(node: HastNodes, test: (node: HastNodes) => boolean): boolean {
  return test(node) || ("children" in node && node.children.some((child) => some(child, test)))
}

function linksIn(node: RootContent, definitions: Map<string, string>): Link[] {
  const urls: string[] = []
  const marked = plainText(node, (child) => {
    const url =
      child.type === "link" || child.type === "image"
        ? child.url
        : child.type === "linkReference" || child.type === "imageReference"
          ? definitions.get(child.identifier.toLowerCase())
          : undefined

    if (url !== undefined) {
      urls.push(url)
    }

    return url !== undefined
  })
  const spans: [number, number][] = []
  const open: number[] = []
  let plain = ""

  for (let at = 0; at < marked.length; at++) {
    if (marked[at] === "\0") {
      if (marked[++at] === "(") {
        open.push(spans.length)
        spans.push([plain.length, plain.length])
      } else {
        spans[open.pop() as number][1] = plain.length
      }
    } else {
      plain += marked[at]
    }
  }

  return urls.map((url, index) => ({ url, context: around(plain, ...spans[index]) }))
}

/**
 * Separate blocks, such as list items, read apart; inline text runs on as written. Given `linked`, each part
 * it picks is set between `\0(` and `\0)`: parsing turns NUL into U+FFFD, so no text holds one.
 */
function plainText(node: Nodes, linked?: (part: Nodes) => boolean): string {
  const text = (part: Nodes): string => {
    const shown =
      part.type === "html"
        ? /^<br\b/i.test(part.value)
          ? " "
          : ""
        : linked && part.type === "text"
          ? part.value.replace(HIDDEN_RUN, "...").replace(VALUE, "...")
          : linked && part.type === "inlineCode"
            ? part.value.replace(HIDDEN_RUN, "...")
            : "value" in part
              ? part.value
              : "children" in part
                ? part.children
                    .map((child) => text(child as Nodes))
                    .join(PHRASING.has(part.type) ? "" : " ")
                : ""

    return linked?.(part) ? `\0(${shown}\0)` : shown
  }

  return text(node).replace(/\s+/g, " ").trim()
}

/**
 * The text parsed again as expansion leaves it, each include masked, line breaks kept, and an escaped one
 * unescaped: expansion reads the raw text, which tells includes apart where the parsed text cannot.
 */
function withIncludesMasked(text: string): Root {
  const masked = text.replace(INCLUDE, (include: string, slash: string) =>
    slash ? include.slice(1) : include.replace(/[^\n]/g, HIDDEN),
  )

  return MARKDOWN.runSync(MARKDOWN.parse(masked), masked) as Root
}

function around(plain: string, start: number, end: number): string {
  const cut = (index: number) => index - (/[\uDC00-\uDFFF]/.test(plain[index] ?? "") ? 1 : 0)
  const from = cut(Math.max(0, start - CONTEXT))
  const to = cut(Math.min(plain.length, end + CONTEXT))

  return `${from > 0 ? "..." : ""}${plain.slice(from, to)}${to < plain.length ? "..." : ""}`
}

function diagram(text: string): Part[] {
  return text.trim()
    ? [{ kind: "diagram", lines: [1, text.trimEnd().split("\n").length], text }]
    : []
}

/** Markdown as the text a reader sees: markup and HTML tags gone, a link by its text, blocks apart by a space. */
export function plainOf(markdown: string): string {
  return plainText(MARKDOWN.runSync(MARKDOWN.parse(markdown), markdown) as Root)
}

/** The text of a document's one h1, in its own file; none with no h1, an empty one or several. */
export function titleOf(blocks: Block[]): string | undefined {
  const top = blocks.flatMap((block) => (block.headings ?? []).filter(({ level }) => level === 1))
  return top.length === 1 && top[0].text !== "" ? top[0].text : undefined
}

/** Where markdown holds text its page reads no link in, by node type, and where it writes each link's address. */
export function placesOf(markdown: string): Places {
  return placesIn(MARKDOWN.runSync(MARKDOWN.parse(markdown), markdown) as Root, markdown)
}

/** The parser counts offsets after a byte order mark, so one is counted back in. */
function placesIn(node: Nodes, markdown: string): Places {
  const shift = markdown.startsWith("\uFEFF") ? 1 : 0
  const literals: Literal[] = []
  const addresses: Address[] = []
  const visit = (child: Nodes) => {
    if (LITERALS.has(child.type) && child.position) {
      literals.push({
        type: child.type,
        start: (child.position.start.offset as number) + shift,
        end: (child.position.end.offset as number) + shift,
      })
    }

    if (child.data?.destination && "url" in child) {
      addresses.push({
        start: (child.data.destination.start.offset as number) + shift,
        end: (child.data.destination.end.offset as number) + shift,
        url: child.url,
      })
    }

    if ("children" in child) {
      child.children.forEach(visit)
    }
  }

  visit(node)
  return { literals, addresses }
}

/** The parser knows where a link or definition writes its address, which the tree it builds forgets. */
function destinations(this: Processor): void {
  const data = this.data()
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    { exit: { resourceDestination: destination, definitionDestination: destination } },
  ]
}

function destination(this: { stack: unknown[] }, token: NonNullable<Nodes["position"]>): void {
  const node = this.stack.at(-1) as LinkNode | Image | Definition
  node.data = { ...node.data, destination: { start: token.start, end: token.end } }
}

/**
 * A block's version. In prose each run of whitespace counts as one space, a table's cell padding
 * and divider widths count for nothing, and a list's indentation counts only where it nests an
 * item; in code, diagrams and frontmatter every character counts. Line endings never count.
 */
export function blockVersion(text: string, kind: string): string {
  return createHash("sha1").update(canonical(text, kind)).digest("hex").slice(0, 12)
}

const VERSIONS = new WeakMap<Block, string>()

export function versionOf(block: Block): string {
  let version = VERSIONS.get(block)

  if (version === undefined) {
    version = blockVersion(block.text, block.kind)
    VERSIONS.set(block, version)
  }

  return version
}

export interface Unit {
  text: string
  /** What it is compared by: spacing, padding and line endings count no more than in a version. */
  key: string
  /** Its place among the rows, items or lines its page draws; none for a code fence. */
  shown?: number
  /** For the first item of an ordered list, the number the list starts at. */
  start?: number
}

/**
 * The parts a page draws of a table, list or code block: each row, the header with its divider; each item
 * from its marker to the next item's, so a nested item is a part of its own; each line, its fences apart.
 */
export function unitsOf(text: string, kind: string): Unit[] | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")

  if (kind === "table") {
    const rows =
      lines.length > 1 && DIVIDER_ROW.test(lines[1])
        ? [`${lines[0]}\n${lines[1]}`, ...lines.slice(2)]
        : lines
    return rows.map((row, shown) => ({ text: row, key: cells(row), shown }))
  }

  if (kind === "code") {
    const fence = opening(lines[0])
    const end =
      fence !== undefined && lines.length > 1 && closes(lines.at(-1) as string, fence)
        ? lines.length - 1
        : lines.length
    const first = fence === undefined ? 0 : 1

    return lines.map((line, at) => ({
      text: line,
      key: line,
      ...(at >= first && at < end && { shown: at - first }),
    }))
  }

  return kind === "list" ? itemsOf(text, lines) : undefined
}

/** Dice's coefficient over character trigrams. */
export function similarity(a: string, b: string): number {
  const left = trigrams(a)
  const right = trigrams(b)
  let shared = 0

  for (const gram of left) {
    if (right.has(gram)) {
      shared++
    }
  }

  return left.size + right.size === 0 ? 1 : (2 * shared) / (left.size + right.size)
}

/** Identity holds for unchanged text wherever it moved, then for similar text of one kind, best pairs first. */
function identify(current: Part[], previous: Block[]): Block[] {
  const ids: (string | undefined)[] = current.map(() => undefined)
  const unused = new Set(previous)

  for (const [index, part] of current.entries()) {
    const match = previous.find(
      (block) =>
        unused.has(block) &&
        block.kind === part.kind &&
        normal(block.text, part.kind) === normal(part.text, part.kind),
    )

    if (match) {
      ids[index] = match.id
      unused.delete(match)
    }
  }

  const pairs = current.flatMap((part, index) =>
    ids[index] !== undefined
      ? []
      : [...unused]
          .filter((block) => block.kind === part.kind)
          .map((block) => ({ index, block, score: similarity(block.text, part.text) }))
          .filter(({ score }) => score >= SIMILAR),
  )

  for (const { index, block } of pairs.sort((a, b) => b.score - a.score)) {
    if (ids[index] === undefined && unused.has(block)) {
      ids[index] = block.id
      unused.delete(block)
    }
  }

  const taken = new Set(ids.filter((id) => id !== undefined))

  return current.map((part, index) => ({ id: ids[index] ?? fresh(part, taken), ...part }))
}

/** Derived from content, not random, so a rebuilt model gives unedited blocks the ids they had. */
function fresh(part: Part, taken: Set<string>): string {
  for (let occurrence = 0; ; occurrence++) {
    const id = createHash("sha1")
      .update(`${part.kind}\0${normal(part.text, part.kind)}\0${occurrence}`)
      .digest("hex")
      .slice(0, 8)

    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

function trigrams(text: string): Set<string> {
  const normalized = normal(text)
  const grams = new Set<string>()

  for (let i = 0; i + 3 <= normalized.length; i++) {
    grams.add(normalized.slice(i, i + 3))
  }

  return grams.size > 0 || !normalized ? grams : new Set([normalized])
}

/** Identity compares texts as versions do, ignoring case, so a block whose version holds keeps its id. */
function normal(text: string, kind = ""): string {
  return canonical(text.toLowerCase(), kind)
}

function canonical(text: string, kind: string): string {
  const lines = text.replace(/\r\n?/g, "\n")

  if (EXACT.has(kind)) {
    return lines
  }

  return kind === "table" ? cells(lines) : kind === "list" ? items(lines) : spaced(lines)
}

/**
 * Each item at its depth, marked alike but for the number an ordered list starts at, its text spaced; a
 * continuation line joins its item, but a line of code inside it, fenced or indented, keeps every character.
 */
function items(text: string): string {
  const found: { prose: string[]; code: string; content: number }[] = []
  const widths: number[] = []
  let fence: string | undefined
  let after: "blank" | "code" | "text" = "text"

  for (const line of text.split("\n")) {
    const item = fence === undefined ? ITEM.exec(line) : null
    const held = found.at(-1)
    const indent = /^[ \t]*/.exec(line)?.[0].replace(/\t/g, "    ").length ?? 0
    const indented: boolean =
      held !== undefined &&
      fence === undefined &&
      line.trim() !== "" &&
      after !== "text" &&
      indent >= held.content + 4
    const was: "blank" | "code" | "text" = after

    after = line.trim() === "" ? (was === "code" ? "code" : "blank") : indented ? "code" : "text"

    if (indented && held) {
      held.code += `\n${line.trimEnd()}`
      continue
    }

    if (item) {
      const width = item[1].replace(/\t/g, "    ").length

      while (widths.length > 0 && (widths.at(-1) as number) > width) {
        widths.pop()
      }

      const sibling = widths.at(-1) === width

      if (!sibling) {
        widths.push(width)
      }

      const number = /^(\d+)[.)]$/.exec(item[2])?.[1]
      const marker = number === undefined ? "-" : sibling ? "1." : `${Number(number)}.`
      found.push({
        prose: [`${widths.length - 1}${marker} ${item[3]}`],
        code: "",
        content: line.replace(/\t/g, "    ").length - item[3].length,
      })
      fence = opening(item[3])
    } else if (held && (fence !== undefined || opening(line) !== undefined)) {
      held.code += `\n${line.trimEnd()}`
      fence = fence === undefined ? opening(line) : closes(line, fence) ? undefined : fence
    } else if (held) {
      held.prose.push(line)
    } else {
      found.push({ prose: [line], code: "", content: 0 })
    }
  }

  return found
    .map(({ prose, code }) => `${spaced(prose.join(" "))}${code}`)
    .filter(Boolean)
    .join("\n")
}

function itemsOf(text: string, lines: string[]): Unit[] {
  const starts: { line: number; depth: number; start?: number }[] = []
  const visit = (node: Nodes, depth: number, start?: number) => {
    if (node.type === "listItem" && node.position) {
      starts.push({ line: node.position.start.line - 1, depth, start })
    }

    if ("children" in node) {
      for (const [index, child] of node.children.entries()) {
        const first = node.type === "list" && node.ordered && index === 0
        visit(
          child as Nodes,
          depth + (node.type === "listItem" ? 1 : 0),
          first ? (node.start ?? 1) : undefined,
        )
      }
    }
  }
  visit(MARKDOWN.runSync(MARKDOWN.parse(text), text) as Root, 0)

  const before = lines.slice(0, starts[0]?.line ?? lines.length).join("\n")
  const found = starts.map(({ line, depth, start }, shown) => {
    const own = lines.slice(line, starts[shown + 1]?.line ?? lines.length).join("\n")

    // A version counts code in an item as written, so its key does too.
    return {
      text: own,
      key: `${depth} ${items(own).replace(/^0(?:-|\d+\.) ?/, "")}`,
      shown,
      ...(start !== undefined && { start }),
    }
  })

  return [...(before ? [{ text: before, key: spaced(before) }] : []), ...found]
}

function opening(line: string): string | undefined {
  return /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
}

function closes(line: string, fence: string): boolean {
  const run = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1]
  return run !== undefined && run[0] === fence[0] && run.length >= fence.length
}

function spaced(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Each row as its cells, trimmed and spaced, between single pipes; a divider row as one dash a cell. */
function cells(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const row = line.trim().replace(/^\|/, "").replace(/\|$/, "")
      const divider = DIVIDER_ROW.test(line)
      return row
        .split("|")
        .map((cell) => (divider ? cell.trim().replace(/-+/g, "-") : spaced(cell)))
        .join("|")
    })
    .filter(Boolean)
    .join("\n")
}
