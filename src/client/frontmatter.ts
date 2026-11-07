/** A page's YAML frontmatter as a key/value table at its end, or as the YAML itself when unreadable. */

import type { Element, ElementContent, Properties } from "hast"
import { isMap, isScalar, isSeq, type Node, parseDocument, Scalar, visit, type YAMLMap } from "yaml"
import { SCHEMA } from "./schema.ts"

export interface FrontmatterLink {
  url: string
  /** `key: value` under the top-level key holding it, each link in the value shown by its text. */
  context: string
  /** Where the link's text sits in `context`. */
  span: [number, number]
  /** Its offset in the frontmatter, or its value's when folding or escapes reword it. */
  offset: number
}

interface Found {
  start: number
  end: number
  text: string
  url: string
}

interface Fit {
  score: number
  distance: number
}

interface Placed {
  /** The value as YAML reads it, which `found` indexes. */
  text: string
  found: Found
  valueStart: number
  written?: [number, number]
}

const BLOCK = new Set<string | undefined>([Scalar.BLOCK_LITERAL, Scalar.BLOCK_FOLDED])
const LINK = /\[([^[\]\n]*)\]\((?:<([^<>\n]*)>|([^()\s<>]+))\)/g

/** Turn a frontmatter block into a key/value table, a YAML code block, or nothing when it is empty. */
export function frontmatter(yaml: string): Element | undefined {
  if (!yaml.trim()) {
    return undefined
  }

  // The failsafe schema keeps every scalar as the text it was written as: 1.10 stays 1.10, ~ stays ~.
  const document = parseDocument(yaml, { schema: "failsafe" })
  const map = document.contents

  if (document.errors.length > 0 || !isMap(map)) {
    return code(yaml)
  }

  return rowsOf(yaml, map)
}

/** In file order; none when the frontmatter is not a readable map. */
export function linksOf(yaml: string): FrontmatterLink[] {
  const document = parseDocument(yaml, { schema: "failsafe" })
  const map = document.contents

  if (document.errors.length > 0 || !isMap(map)) {
    return []
  }

  const links: FrontmatterLink[] = []

  for (const { key, value } of map.items) {
    const name = scalarText(yaml, key)

    if (value === null) {
      continue
    }

    for (const { text, found, written, valueStart } of placed(yaml, value as Node)) {
      const before = `${name}: ${plain(text.slice(0, found.start))}`
      links.push({
        url: found.url,
        context: `${name}: ${plain(text)}`,
        span: [before.length, before.length + (found.text || found.url).length],
        offset: written?.[0] ?? valueStart,
      })
    }
  }

  return links
}

function rowsOf(yaml: string, map: YAMLMap): Element {
  const rows = map.items.map(({ key, value }) =>
    element("tr", [
      element("th", [{ type: "text", value: scalarText(yaml, key) }]),
      element("td", shown(yaml, value)),
    ]),
  )

  return element("table", [element("tbody", rows)], { className: ["frontmatter"] })
}

function shown(yaml: string, value: unknown): ElementContent[] {
  if (isMap(value)) {
    return [rowsOf(yaml, value)]
  }

  if (isSeq(value)) {
    return value.items.length > 0 && value.items.every(isMap)
      ? [entriesOf(yaml, value.items as YAMLMap[])]
      : [
          element(
            "ul",
            value.items.map((item) => element("li", shown(yaml, item))),
          ),
        ]
  }

  return withLinks(scalarText(yaml, value))
}

function entriesOf(yaml: string, entries: YAMLMap[]): Element {
  const keys = [
    ...new Set(entries.flatMap((entry) => entry.items.map(({ key }) => scalarText(yaml, key)))),
  ]
  const rows = entries.map((entry) => {
    const values = new Map(entry.items.map(({ key, value }) => [scalarText(yaml, key), value]))
    return element(
      "tr",
      keys.map((key) => element("td", values.has(key) ? shown(yaml, values.get(key)) : [])),
    )
  })

  return element(
    "table",
    [
      element("thead", [
        element(
          "tr",
          keys.map((key) => element("th", [{ type: "text", value: key }])),
        ),
      ]),
      element("tbody", rows),
    ],
    { className: ["frontmatter"] },
  )
}

/** Where each link is written, unless folding cuts it across lines or escapes reword its address. */
function placed(yaml: string, node: Node): Placed[] {
  const links: Placed[] = []

  visit(node, {
    Collection(at) {
      return at === "key" ? visit.SKIP : undefined
    },
    Scalar(at, scalar) {
      if (at === "key") {
        return
      }

      const text = String(scalar.value ?? "")
      const [start, end] = scalar.range ?? [0, 0]
      // A block scalar's header line may hold a comment.
      const header = BLOCK.has(scalar.type) ? yaml.indexOf("\n", start) : -1
      const from = header < 0 || header > end ? start : header + 1
      const read = linksIn(text)
      const written = linksIn(yaml.slice(from, end))
      const pairs = aligned(read, written)

      for (const [index, found] of read.entries()) {
        const match = written[pairs[index]]
        links.push({
          text,
          found,
          valueStart: start,
          written: match && [from + match.start, from + match.end],
        })
      }
    },
  })

  return links
}

/**
 * Pair links read with links written, in order and by address, preferring equal text, as escapes reword text;
 * between twins, the pair whose places in the value lie closest.
 */
function aligned(read: Found[], written: Found[]): number[] {
  const none = (): Fit => ({ score: 0, distance: 0 })
  const fits = read
    .map(() => written.map(none).concat(none()))
    .concat([written.map(none).concat(none())])
  const paired = (r: number, w: number): Fit | undefined =>
    read[r].url !== written[w].url
      ? undefined
      : {
          score: fits[r + 1][w + 1].score + (read[r].text === written[w].text ? 2 : 1),
          distance: fits[r + 1][w + 1].distance + Math.abs(read[r].start - written[w].start),
        }

  for (let r = read.length - 1; r >= 0; r--) {
    for (let w = written.length - 1; w >= 0; w--) {
      const pair = paired(r, w)
      const skip = better(fits[r + 1][w], fits[r][w + 1]) ? fits[r + 1][w] : fits[r][w + 1]
      fits[r][w] = pair && !better(skip, pair) ? pair : skip
    }
  }

  const pairs = read.map(() => -1)

  for (let r = 0, w = 0; r < read.length && w < written.length; ) {
    const pair = paired(r, w)

    if (pair && !better(fits[r][w], pair)) {
      pairs[r++] = w++
    } else if (!better(fits[r][w], fits[r + 1][w])) {
      r++
    } else {
      w++
    }
  }

  return pairs
}

function better(fit: Fit, than: Fit): boolean {
  return fit.score !== than.score ? fit.score > than.score : fit.distance < than.distance
}

function withLinks(text: string): ElementContent[] {
  const pieces: ElementContent[] = []
  let at = 0

  for (const found of linksIn(text)) {
    if (!allowed(found.url)) {
      continue
    }

    if (found.start > at) {
      pieces.push({ type: "text", value: text.slice(at, found.start) })
    }

    pieces.push(
      element("a", [{ type: "text", value: found.text || found.url }], { href: found.url }),
    )
    at = found.end
  }

  if (at < text.length || pieces.length === 0) {
    pieces.push({ type: "text", value: text.slice(at) })
  }

  return pieces
}

function linksIn(text: string): Found[] {
  const code = codeSpans(text)

  return [...text.matchAll(LINK)].flatMap((match) => {
    const url = match[2] ?? match[3]
    const inCode = code.some(([from, to]) => from <= match.index && match.index < to)

    return url && !inCode
      ? [{ start: match.index, end: match.index + match[0].length, text: match[1], url }]
      : []
  })
}

/** A run of backticks opens code that the next run of the same length closes, as on the page. */
function codeSpans(text: string): [number, number][] {
  const runs = [...text.matchAll(/`+/g)]
  const spans: [number, number][] = []

  for (let open = 0; open < runs.length; open++) {
    const close = runs.findIndex((run, at) => at > open && run[0].length === runs[open][0].length)

    if (close > -1) {
      spans.push([runs[open].index, runs[close].index + runs[close][0].length])
      open = close
    }
  }

  return spans
}

function plain(text: string): string {
  let shown = ""
  let at = 0

  for (const found of linksIn(text)) {
    shown += text.slice(at, found.start) + (found.text || found.url)
    at = found.end
  }

  return shown + text.slice(at)
}

/** Whether sanitizing would keep the address; a link it would refuse stays its markdown. */
function allowed(url: string): boolean {
  const colon = url.indexOf(":")
  const earlier = [url.indexOf("?"), url.indexOf("#"), url.indexOf("/")].some(
    (at) => at > -1 && at < colon,
  )

  return colon < 0 || earlier || (SCHEMA.protocols?.href ?? []).includes(url.slice(0, colon))
}

function scalarText(yaml: string, node: unknown): string {
  if (node === null) {
    return ""
  }

  return isScalar(node) ? String(node.value ?? "") : asWritten(yaml, node as Node)
}

function asWritten(yaml: string, node: Node): string {
  const [start, end] = node.range ?? [0, 0]
  const lineStart = yaml.lastIndexOf("\n", start - 1) + 1
  const onOwnLine = !yaml.slice(lineStart, start).trim()
  const lines = yaml
    .slice(onOwnLine ? lineStart : start, end)
    .replace(/\s+$/, "")
    .split("\n")
  const indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
  )

  return lines.map((line) => line.slice(indent)).join("\n")
}

function code(text: string): Element {
  return element("pre", [
    element("code", [{ type: "text", value: text }], { className: ["language-yaml"] }),
  ])
}

function element(
  tagName: string,
  children: Element["children"],
  properties: Properties = {},
): Element {
  return { type: "element", tagName, properties, children }
}
