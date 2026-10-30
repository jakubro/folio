/**
 * Kinds of documents a folder declares - where its documents of each kind live, and the typed fields read
 * from each - and a document's fields as read from its text and its place, nothing written into it.
 */

import path from "node:path"
import { parse as parseYaml } from "yaml"
import { numberOf } from "../client/tableviews.ts"
import { type Block, plainOf } from "./blocks.ts"
import { globOf, linkTarget } from "./files.ts"

type Scalar = "text" | "number" | "date" | "link"

export interface FieldDefinition {
  from: "frontmatter" | "label" | "section" | "folder" | "name"
  type: Scalar | "list"
  /** What a list holds. */
  of: Scalar
  /** The frontmatter key, the label or the section heading it is read from; the field's name by default. */
  key: string
  /** For a file name, the part a pattern's first group takes. */
  pattern?: RegExp
  /** For a link written as an id, the kind it names a document of, and the field holding that id. */
  to?: string
  by: string
  /** Texts written for no value, such as `None`; compared ignoring case. */
  empty: string[]
}

export interface KindDefinition {
  where: RegExp[]
  fields: Record<string, FieldDefinition>
}

export interface Field {
  value: unknown
  /** The value as written. */
  text: string
  line: number
}

/** What a link field names, found once every document of the kind it names is known. */
interface Reference {
  field: string
  item?: number
  text: string
  to: string
  by: string
  line: number
  /** A link's target, which must be a document of the kind. */
  path?: string
  /** Words of a text, any of which may be an id; for a link whose target is no such document, its text. */
  candidates?: string[]
  /** Prose naming no document is a note, a problem only in a line that names nothing else. */
  prose?: boolean
  /** The line of the field it stands in, among items written one a line. */
  group?: number
  /** A link to the web, taken as written. */
  external?: string
}

export interface Read {
  fields: Record<string, Field>
  problems: { line: number; what: string }[]
  references: Reference[]
}

const SOURCES = ["frontmatter", "label", "section", "folder", "name"]
const TYPES = ["text", "number", "date", "link", "list"]
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const LINK = /^\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)$/
const SPACE = /\s/
const NAME_START = /[a-z]/i
const NAME = /[a-z\d-]/i
const WORD = /[\p{L}\p{N}][\p{L}\p{N}._-]*/gu
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const BREAK = /[\n\r\u2028\u2029]/
const EXTERNAL = /^[a-z][a-z\d+.-]*:|^\/\//i

/** Read a declared kind, or say what is wrong with it. */
export function kindDefinition(name: string, value: unknown): KindDefinition | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `The kind ${name} is a map with where and fields.`
  }

  const { where, fields = {}, ...rest } = value as Record<string, unknown>
  const places = patternsOf(where)
  const unknown = Object.keys(rest)[0]

  if (unknown !== undefined) {
    return `The kind ${name} has no ${unknown}: a kind has where and fields.`
  }

  if (!places) {
    return `The kind ${name} names where its documents live: a path pattern, or a list of them.`
  }

  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return `The fields of ${name} are a map of names.`
  }

  const definitions: Record<string, FieldDefinition> = {}

  for (const [field, definition] of Object.entries(fields)) {
    if (field === "path") {
      return `${name}.path: path is the document's own column, so no field takes the name.`
    }

    const read = fieldDefinition(field, definition)

    if (typeof read === "string") {
      return `${name}.${field}: ${read}`
    }

    definitions[field] = read
  }

  return { where: places, fields: definitions }
}

/** Path patterns as declared - one, or a list of them - or undefined when they are neither. */
export function patternsOf(where: unknown): RegExp[] | undefined {
  const places = typeof where === "string" ? [where] : where

  return Array.isArray(places) && places.length > 0 && places.every((at) => typeof at === "string")
    ? places.map(globOf)
    : undefined
}

/** Whether a document lies where a kind declared in a folder places its documents. */
export function within(where: RegExp[], folder: string, urlPath: string): boolean {
  const inside = folder
    ? urlPath.startsWith(`${folder}/`)
      ? urlPath.slice(folder.length + 1)
      : undefined
    : urlPath
  return inside !== undefined && where.some((pattern) => pattern.test(inside))
}

/** Read a document's fields from its blocks and its place; ids a link names are left to resolve. */
export function readFields(
  urlPath: string,
  blocks: Block[],
  fields: Record<string, FieldDefinition>,
): Read {
  const read: Read = { fields: {}, problems: [], references: [] }
  const frontmatter = frontmatterOf(blocks)

  for (const [name, definition] of Object.entries(fields)) {
    const found = written(urlPath, blocks, frontmatter, definition)

    if (!found) {
      continue
    }

    const { raw, line } = found
    const text = typeof raw === "string" ? raw : JSON.stringify(raw)
    const misfit = (what: string) => read.problems.push({ line, what: `${name}: ${what}` })

    if (definition.empty.includes(text.trim().toLowerCase())) {
      read.fields[name] = { value: definition.type === "list" ? [] : null, text, line }
      continue
    }

    if (definition.type === "list" && definition.of === "link" && !Array.isArray(raw)) {
      read.fields[name] = {
        value: linksIn(urlPath, String(raw), name, line, definition, read),
        text,
        line,
      }
      continue
    }

    if (definition.type === "list") {
      const items = Array.isArray(raw) ? raw : itemsOf(String(raw))
      const values: unknown[] = []

      for (const [index, item] of items.entries()) {
        const value = typed(urlPath, item, definition.of, definition)

        if (value.wrong) {
          misfit(value.wrong)
        } else if (value.id !== undefined && definition.to) {
          read.references.push({
            field: name,
            item: index,
            text: value.id,
            to: definition.to,
            by: definition.by,
            line,
          })
        }

        values.push(value.value)
      }

      read.fields[name] = { value: values, text, line }
      continue
    }

    const value = typed(urlPath, raw, definition.type, definition)

    if (value.wrong) {
      misfit(value.wrong)
    } else if (value.id !== undefined && definition.to) {
      read.references.push({
        field: name,
        text: value.id,
        to: definition.to,
        by: definition.by,
        line,
      })
    }

    read.fields[name] = { value: value.value, text, line }
  }

  return read
}

function fieldDefinition(field: string, value: unknown): FieldDefinition | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "a field is a map naming where it is read from: from, and its type"
  }

  const {
    from,
    type = "text",
    of = "text",
    key,
    label,
    section,
    pattern,
    to,
    by = "id",
    empty = [],
    ...rest
  } = value as Record<string, unknown>
  const unknown = Object.keys(rest)[0]

  if (unknown !== undefined) {
    return `no field option is named ${unknown}`
  }

  if (typeof from !== "string" || !SOURCES.includes(from)) {
    return `from is one of ${SOURCES.join(", ")}`
  }

  if (typeof type !== "string" || !TYPES.includes(type)) {
    return `type is one of ${TYPES.join(", ")}`
  }

  if (typeof of !== "string" || !TYPES.includes(of) || of === "list") {
    return "of is one of text, number, date and link"
  }

  if (to !== undefined && typeof to !== "string") {
    return "to names a kind"
  }

  const blanks = typeof empty === "string" ? [empty] : empty

  if (!Array.isArray(blanks) || !blanks.every((blank) => typeof blank === "string")) {
    return "empty is a text, or a list of texts, written for no value"
  }

  let compiled: RegExp | undefined

  if (pattern !== undefined) {
    try {
      compiled = new RegExp(String(pattern))
    } catch (error) {
      return `the pattern cannot be read: ${(error as Error).message}`
    }
  }

  return {
    from: from as FieldDefinition["from"],
    type: type as FieldDefinition["type"],
    of: of as Scalar,
    key: String(key ?? label ?? section ?? field),
    ...(compiled && { pattern: compiled }),
    ...(to !== undefined && { to: to as string }),
    by: String(by),
    empty: blanks.map((blank) => blank.trim().toLowerCase()),
  }
}

/** `**` crosses folders, `*` and `?` do not; unlike gitignore, `*.md` matches only the declaring folder. */
function written(
  urlPath: string,
  blocks: Block[],
  frontmatter: { value: Record<string, unknown>; line: number } | undefined,
  definition: FieldDefinition,
): { raw: unknown; line: number } | undefined {
  switch (definition.from) {
    case "frontmatter":
      return frontmatter && Object.hasOwn(frontmatter.value, definition.key)
        ? { raw: frontmatter.value[definition.key], line: frontmatter.line }
        : undefined
    case "label":
      return labelled(blocks, definition.key)
    case "section":
      return sectionOf(blocks, definition.key)
    case "folder": {
      const folder = path.posix.basename(path.posix.dirname(urlPath))
      return folder === "." ? undefined : { raw: folder, line: 1 }
    }
    default: {
      const name = path.posix.basename(urlPath)

      if (!definition.pattern) {
        return { raw: name.replace(/\.[^.]*$/, ""), line: 1 }
      }

      const match = definition.pattern.exec(name)
      return match ? { raw: match[1] ?? match[0], line: 1 } : undefined
    }
  }
}

/** `**Label:** value`, `**Label**: value` or `Label: value` opening any line of a paragraph or list item. */
function labelled(blocks: Block[], label: string): { raw: string; line: number } | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(
    `^\\s*(?:(?:[-*+]|\\d+[.)])\\s+)?(?:\\*\\*|__)?${escaped}(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*`,
    "i",
  )

  for (const block of blocks) {
    if (block.kind !== "paragraph" && block.kind !== "list") {
      continue
    }

    for (const [index, line] of block.text.split("\n").entries()) {
      const match = pattern.exec(line)
      const raw = match && line.slice(match[0].length).trimEnd()

      if (raw !== null && !BREAK.test(raw)) {
        return { raw, line: block.lines[0] + index }
      }
    }
  }

  return undefined
}

/** A section runs from its heading to the next heading of the same or a higher level. */
function sectionOf(blocks: Block[], heading: string): { raw: string; line: number } | undefined {
  const at = blocks.findIndex(
    (block) =>
      block.kind === "heading" && block.title?.trim().toLowerCase() === heading.toLowerCase(),
  )

  if (at < 0) {
    return undefined
  }

  const level = levelOf(blocks[at])
  const end = blocks.findIndex(
    (block, index) => index > at && block.kind === "heading" && levelOf(block) <= level,
  )
  const body = blocks.slice(at + 1, end < 0 ? undefined : end).map((block) => block.text)

  return { raw: body.join("\n\n").trim(), line: blocks[at].lines[0] }
}

function levelOf(heading: Block): number {
  return /^#{1,6}/.exec(heading.text)?.[0].length ?? (/\n=+\s*$/.test(heading.text) ? 1 : 2)
}

function frontmatterOf(
  blocks: Block[],
): { value: Record<string, unknown>; line: number } | undefined {
  const block = blocks.find((found) => found.kind === "frontmatter")

  if (!block) {
    return undefined
  }

  try {
    const value = parseYaml(block.text.replace(/^---\r?\n/, "").replace(/\r?\n---\s*$/, ""))
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? { value: value as Record<string, unknown>, line: block.lines[0] }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * A line of links takes the links in it and, for a field naming a kind, every id of that kind it holds;
 * the rest - notes beside them, line break tags, punctuation - is notes, and a line opening with an empty
 * marker names nothing.
 */
function linksIn(
  urlPath: string,
  text: string,
  name: string,
  line: number,
  definition: FieldDefinition,
  read: Read,
): unknown[] {
  const plain = spliced(text, spansOf(text, true), true).trim()
  const opening = plain.toLowerCase()
  const values: unknown[] = []
  const { to, by } = definition

  if (
    definition.empty.some(
      (blank) => opening.startsWith(blank) && !/^[\p{L}\p{N}_]/u.test(opening.slice(blank.length)),
    )
  ) {
    return values
  }

  // Items written one a line are lines of their own: an indented line carries its item on, any other is a note.
  // Pieces of one line between commas share it.
  const items = listedIn(plain)

  for (const [index, piece] of (items ?? itemsOf(plain)).entries()) {
    const spans = spansOf(piece, false)
    const links = spans.map(({ start, end }) => piece.slice(start, end))
    const group = items ? index : 0

    for (const link of links) {
      const { value, id } = typed(urlPath, link, "link", definition)
      const external = typeof value === "string" && EXTERNAL.test(value)

      if (to && (id !== undefined || typeof value === "string")) {
        read.references.push({
          field: name,
          item: values.length,
          text: link,
          to,
          by,
          line,
          group,
          ...(external
            ? { external: value }
            : {
                candidates: wordsOf(/^\[([^\]]*)\]/.exec(link)?.[1] ?? ""),
                ...(id === undefined && { path: value as string }),
              }),
        })
      }

      values.push(value)
    }

    const rest = spliced(piece, spans, false)
      .trim()
      .replace(/(?<![.,;:])[.,;:]+$/, "")

    if (!to) {
      if (links.length === 0) {
        const value = typed(urlPath, piece, "link", definition)

        if (value.wrong) {
          read.problems.push({ line, what: `${name}: ${value.wrong}` })
        }

        values.push(value.value)
      }
    } else if (rest) {
      read.references.push({
        field: name,
        item: values.length,
        text: rest,
        to,
        by,
        line,
        group,
        candidates: [rest, ...wordsOf(rest)],
        ...((links.length > 0 || /\s/.test(rest)) && { prose: true }),
      })
      values.push(null)
    }
  }

  return values
}

function listedIn(text: string): string[] | undefined {
  const lines = text.split("\n")

  if (!lines.some((written) => itemOf(written) !== undefined)) {
    return undefined
  }

  const items: string[] = []
  let open = false

  for (const written of lines) {
    const item = itemOf(written)

    if (item !== undefined) {
      items.push(item)
      open = true
    } else if (open && /^\s+\S/.test(written)) {
      items[items.length - 1] += ` ${written.trim()}`
    } else {
      open = false
    }
  }

  return items
}

function wordsOf(text: string): string[] {
  return (text.match(WORD) ?? []).map((word) => word.replace(/(?<![._-])[._-]+$/, ""))
}

/** A list written as list items, one a line, or else as one line of values set apart by commas. */
function itemsOf(text: string): string[] {
  const lines = text.split("\n").filter((line) => line.trim())
  const items = lines.flatMap((line) => itemOf(line) ?? [])

  return (items.length === lines.length && items.length > 0 ? items : outsideLinks(text))
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Split at each comma outside a link: its next bracket is no `]` and its next parenthesis no `)`. */
function outsideLinks(text: string): string[] {
  const pieces: string[] = []
  let bracket = ""
  let parenthesis = ""
  let end = text.length

  for (let at = text.length - 1; at >= 0; at--) {
    const char = text[at]

    if (char === "[" || char === "]") {
      bracket = char
    } else if (char === "(" || char === ")") {
      parenthesis = char
    } else if (char === "," && bracket !== "]" && parenthesis !== ")") {
      pieces.push(text.slice(at + 1, end))
      end = at
    }
  }

  pieces.push(text.slice(0, end))
  return pieces.reverse()
}

/** A list item's text as `^\s*(?:[-*+]|\d+[.)])\s+(.*)$` reads it, its spaces read once. */
function itemOf(line: string): string | undefined {
  const marker = ITEM.exec(line)
  const text = marker && line.slice(marker[0].length).trimStart()

  return text === null || BREAK.test(text) ? undefined : text
}

interface Span {
  start: number
  end: number
  link: boolean
}

/**
 * The links in a text and, with `tags`, the tags outside them, leftmost first as one expression would find
 * them, in one pass: a link failing once its address ends fails for every later link whose address ends there.
 */
function spansOf(text: string, tags: boolean): Span[] {
  const spans: Span[] = []
  const lastClose = tags ? text.lastIndexOf(">") : -1
  let bracket = text.indexOf("[")
  let angle = tags ? text.indexOf("<") : -1
  let failedUntil = 0

  while (bracket >= 0 || angle >= 0) {
    const link = bracket >= 0 && (angle < 0 || bracket < angle)
    const start = link ? bracket : angle
    let end = -1

    if (link) {
      const close = text.indexOf("]", bracket + 1)

      if (close < 0) {
        bracket = -1
        continue
      }

      if (text[close + 1] === "(" && close + 2 >= failedUntil) {
        const read = destination(text, close + 2)
        end = read.end
        failedUntil = read.addressEnd
      }

      if (end < 0) {
        bracket = text.indexOf("[", close + 1)
        continue
      }
    } else {
      if (angle > lastClose) {
        angle = -1
        continue
      }

      end = tagEnd(text, angle)

      if (end < 0) {
        angle = text.indexOf("<", angle + 1)
        continue
      }
    }

    spans.push({ start, end, link })
    bracket = bracket >= 0 && bracket < end ? text.indexOf("[", end) : bracket
    angle = angle >= 0 && angle < end ? text.indexOf("<", end) : angle
  }

  return spans
}

/**
 * Where `\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)` matching from `at` ends, or -1, and where its address ends: a
 * match ends there or nowhere, whatever the backtracking.
 */
function destination(text: string, at: number): { end: number; addressEnd: number } {
  let start = at

  while (start < text.length && SPACE.test(text[start])) {
    start++
  }

  const bare = text[start] === "<" && start + 1 < text.length && !ends(text[start + 1])
  let addressEnd = bare ? start + 1 : start

  while (addressEnd < text.length && !ends(text[addressEnd])) {
    addressEnd++
  }

  if (addressEnd === (bare ? start + 1 : start)) {
    return { end: -1, addressEnd }
  }

  const after = text[addressEnd] === ">" ? addressEnd + 1 : addressEnd
  let title = after

  while (title < text.length && SPACE.test(text[title])) {
    title++
  }

  if (title > after && text[title] === '"') {
    const quote = text.indexOf('"', title + 1)
    const closing = quote < 0 ? -1 : closingAfter(text, quote + 1)

    if (closing >= 0) {
      return { end: closing, addressEnd }
    }
  }

  return { end: closingAfter(text, after), addressEnd }
}

function closingAfter(text: string, at: number): number {
  let close = at

  while (close < text.length && SPACE.test(text[close])) {
    close++
  }

  return text[close] === ")" ? close + 1 : -1
}

function ends(char: string): boolean {
  return char === ")" || char === ">" || SPACE.test(char)
}

/** Where `<\/?[a-z][a-z\d-]*(?:\s[^>]*)?\/?>`, case-insensitive, matching from `at` ends, or -1. */
function tagEnd(text: string, at: number): number {
  let name = text[at + 1] === "/" ? at + 2 : at + 1

  if (!NAME_START.test(text[name] ?? "")) {
    return -1
  }

  do {
    name++
  } while (name < text.length && NAME.test(text[name]))

  if (SPACE.test(text[name] ?? "")) {
    const close = text.indexOf(">", name)
    return close < 0 ? -1 : close + 1
  }

  const close = text[name] === "/" ? name + 1 : name
  return text[close] === ">" ? close + 1 : -1
}

function spliced(text: string, spans: Span[], keepLinks: boolean): string {
  let written = ""
  let at = 0

  for (const { start, end, link } of spans) {
    written += text.slice(at, start) + (link && keepLinks ? text.slice(start, end) : " ")
    at = end
  }

  return written + text.slice(at)
}

function typed(
  urlPath: string,
  raw: unknown,
  type: Scalar,
  definition: FieldDefinition,
): { value: unknown; wrong?: string; id?: string } {
  const text = typeof raw === "string" ? raw.trim() : raw

  switch (type) {
    case "number": {
      const number = typeof text === "number" ? text : numberOf(String(text))
      return number === undefined
        ? { value: null, wrong: `${String(text)} is not a number` }
        : { value: number }
    }
    case "date": {
      const date = text instanceof Date ? text.toISOString() : String(text)
      return DATE.test(date) && realDay(date)
        ? { value: date }
        : { value: null, wrong: `${date} is not a date` }
    }
    case "link": {
      const written = String(text)
      const address =
        LINK.exec(written)?.[1] ?? (!definition.to && EXTERNAL.test(written) ? written : undefined)
      const target = address === undefined ? undefined : linkTarget(urlPath, address)

      if (target) {
        return { value: target.path }
      }

      if (address !== undefined && EXTERNAL.test(address)) {
        return { value: address }
      }

      return definition.to
        ? { value: null, id: written }
        : { value: null, wrong: `${written} is not a link` }
    }
    default:
      return {
        value:
          typeof text !== "string"
            ? JSON.stringify(text)
            : definition.from === "label" || definition.from === "section"
              ? plainOf(text)
              : text,
      }
  }
}

/** Date.parse rolls a day past its month's end into the next month instead of refusing it. */
function realDay(date: string): boolean {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    !Number.isNaN(Date.parse(date))
  )
}
