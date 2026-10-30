/**
 * GitHub-flavoured markdown read as remark-gfm reads it, in time linear in the text.
 * Its footnote calls, emphasis, strikethrough and autolinks skip the walks back that cost seconds.
 */

import type { Link, Nodes, Parent, PhrasingContent, Root, Text } from "mdast"
import remarkGfm from "remark-gfm"
import type { Data, Processor } from "unified"

type Syntax = NonNullable<Data["micromarkExtensions"]>[number]
type Construct = Extract<NonNullable<Syntax["text"]>[number], { tokenize: unknown }>
type Tokenizer = Construct["tokenize"]
type Resolver = NonNullable<Construct["resolveAll"]>
type Context = ThisParameterType<Tokenizer>
type Events = Context["events"]
type Token = Events[number][1]
type Point = Token["start"]
type Tree = Exclude<NonNullable<Data["fromMarkdownExtensions"]>[number], unknown[]>

interface Found {
  at: number
  length: number
  nodes: PhrasingContent[]
}

interface Opener {
  token: Token
  /** Its marker for emphasis, its size for strikethrough: only a closer of the same one closes it. */
  mark: number
  exit: number
}

const RIGHT_BRACKET = 93
const ASTERISK = 42
const UNDERSCORE = 95
const TILDE = 126
const CARET = 94
const POTENTIAL_CALL = "gfmPotentialFootnoteCall"
const OPENINGS = new Set(["labelImage", "gfmFootnoteCall", "labelLink", "label", "image", "link"])
const SCANNED = new WeakMap<Events, { length: number; last: Events[number]; found: number }>()
const CALLS = new WeakMap<Token, { end: Point; text: string; over: boolean }>()
const LONGEST = new WeakMap<string[], { count: number; length: number }>()
const TRAIL = new Set("!\"&'),.:;<>?]}")
const LOCAL = /[-.\w+]/
const DOMAIN = /[-\w]/
const HOST = /[-.\w]/
const PATH_END = new Set([" ", "\t", "\r", "\n"])
const BEFORE_EMAIL = /[\s\p{P}\p{S}]/u
const PUNCTUATION = /\p{P}|\p{S}/u
const SLASH = 47

export function gfm(this: Processor): void {
  remarkGfm.call(this)
  const data = this.data()
  const strikethroughs: Construct[] = []

  for (const syntax of data.micromarkExtensions ?? []) {
    const constructs = syntax.text?.[RIGHT_BRACKET]

    if (Array.isArray(constructs)) {
      for (const [index, construct] of constructs.entries()) {
        if (construct.name === POTENTIAL_CALL) {
          constructs[index] = { ...construct, tokenize: potentialCall }
        }
      }
    }

    // Listed twice, to tokenize and to resolve inside spans: both get the one-pass resolver.
    for (const list of [syntax.text?.[TILDE], syntax.insideSpan?.null] as unknown[]) {
      if (Array.isArray(list)) {
        for (const [index, construct] of (list as Construct[]).entries()) {
          if (construct.name === "strikethrough") {
            const replaced =
              strikethroughs.find((done) => done.tokenize === construct.tokenize) ??
              ({ ...construct, resolveAll: resolveStrikethrough } as Construct)

            list[index] = replaced
            strikethroughs.push(replaced)
          }
        }
      }
    }
  }

  // Prepended, these sit just before micromark's own: an email autolink still tries `_` first.
  // Inside spans, strikethrough still resolves before emphasis.
  const attention: Construct = { name: "attention", tokenize: tokenizeAttention }
  attention.resolveAll = resolveAttention
  data.micromarkExtensions = [
    {
      text: { [ASTERISK]: attention, [UNDERSCORE]: attention },
      insideSpan: { null: [...new Set(strikethroughs), attention] },
    },
    ...(data.micromarkExtensions ?? []),
  ]

  for (const extension of (data.fromMarkdownExtensions ?? []).flat() as Tree[]) {
    if (extension.enter?.literalAutolink) {
      extension.transforms = [autolinks]
    }
  }
}

/**
 * The extension walks back from every `]` to find a `![`, then reads all the text since.
 * Here the opening is found once, and the text read only while it can still name a footnote.
 */
const potentialCall: Tokenizer = function (this: Context, effects, ok, nok) {
  const at = opening(this.events)
  const labelStart =
    at >= 0 && this.events[at][1].type === "labelImage" ? this.events[at][1] : undefined
  const parser = this.parser as Context["parser"] & { gfmFootnotes?: string[] }
  const defined = parser.gfmFootnotes ?? []
  parser.gfmFootnotes = defined

  return (code) => {
    if (!labelStart?._balanced) {
      return nok(code)
    }

    const id = calledId(this, labelStart, defined)

    if (id === undefined || !defined.includes(id)) {
      return nok(code)
    }

    effects.enter("gfmFootnoteCallLabelMarker")
    effects.consume(code)
    effects.exit("gfmFootnoteCallLabelMarker")
    return ok(code)
  }
}

/** Events looked at before stay trusted while they end in the same event: closing a link rewrites to the end. */
function opening(events: Events): number {
  const held = SCANNED.get(events)
  const kept =
    held !== undefined && events.length >= held.length && events[held.length - 1] === held.last
  const floor = kept ? held.length : 0
  let found = kept ? held.found : -1

  for (let index = events.length - 1; index >= floor; index--) {
    if (OPENINGS.has(events[index][1].type)) {
      found = index
      break
    }
  }

  SCANNED.set(events, { length: events.length, last: events[events.length - 1], found })
  return found
}

/**
 * The text since the label opened, read on from the last `]` and normalized as an identifier is.
 * Past the longest footnote name it is read no more: collapsing whitespace never shrinks it.
 */
function calledId(context: Context, labelStart: Token, defined: string[]): string | undefined {
  const held = CALLS.get(labelStart) ?? { end: labelStart.end, text: "", over: false }
  CALLS.set(labelStart, held)

  if (held.over) {
    return undefined
  }

  const now = context.now()
  held.text = `${held.text}${context.sliceSerialize({ start: held.end, end: now })}`.replace(
    /[\t\n\r ]+/g,
    " ",
  )
  held.end = now
  const trimmed = held.text.replace(/^ | $/g, "")

  if (trimmed.length > 1 + longest(defined)) {
    held.over = true
    return undefined
  }

  const id = trimmed.toLowerCase().toUpperCase()
  return id.codePointAt(0) === CARET ? id.slice(1) : undefined
}

function longest(defined: string[]): number {
  const held = LONGEST.get(defined)

  if (held?.count === defined.length) {
    return held.length
  }

  const length = defined.reduce((most, id) => Math.max(most, id.length), 0)
  LONGEST.set(defined, { count: defined.length, length })
  return length
}

/** micromark's own attention tokenizer, found beside this one, so sequences are marked alike. */
const tokenizeAttention: Tokenizer = function (this: Context, effects, ok, nok) {
  const own = (this.parser.constructs.text[ASTERISK] as Construct[]).find(
    (construct) => construct.name === "attention" && construct.tokenize !== tokenizeAttention,
  ) as Construct

  return own.tokenize.call(this, effects, ok, nok)
}

/**
 * micromark's resolver walks back from every closer and splices the paragraph's events per match.
 * Here open openers wait on a stack, and a closer finding none sets a floor its kind stops at.
 * Events are written once, a match taking those after its opener off the end: same result.
 */
const resolveAttention: Resolver = (events, context) => {
  if (!events.some(([, token]) => token.type === "attentionSequence")) {
    return events
  }

  const out: Events = []
  const openers: Opener[] = []
  const floors = new Map<string, number>()
  const insideSpan = context.parser.constructs.insideSpan.null as Construct[]

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    const closer = event[1]

    if (event[0] !== "enter" || closer.type !== "attentionSequence") {
      out.push(event)
      continue
    }

    const exit = events[++index]
    const marker = context.sliceSerialize(closer).charCodeAt(0)
    let remade = false
    let used = false

    while (closer._close && !used) {
      const key = `${marker} ${closer._open} ${size(closer) % 3}`
      const floor = floors.get(key) ?? 0
      let at = openers.length - 1

      while (
        at >= floor &&
        (openers[at].mark !== marker ||
          ((openers[at].token._close || closer._open) &&
            size(closer) % 3 &&
            !((size(openers[at].token) + size(closer)) % 3)))
      ) {
        at--
      }

      if (at < floor) {
        floors.set(key, openers.length)
        break
      }

      const opener = openers[at]
      const use = size(opener.token) > 1 && size(closer) > 1 ? 2 : 1
      const kind = use > 1 ? "strong" : "emphasis"
      const start = { ...opener.token.end }
      const end = { ...closer.start }

      move(start, -use)
      move(end, use)

      const openingSequence = { type: `${kind}Sequence`, start, end: { ...opener.token.end } }
      const closingSequence = { type: `${kind}Sequence`, start: { ...closer.start }, end }
      const text = { type: `${kind}Text`, start: { ...opener.token.end }, end: { ...closer.start } }
      const group = {
        type: kind,
        start: { ...openingSequence.start },
        end: { ...closingSequence.end },
      }

      opener.token.end = { ...openingSequence.start }
      closer.start = { ...closingSequence.end }

      const between = out.splice(opener.exit + 1)
      out.length = opener.exit - 1
      openers.length = at

      if (size(opener.token) > 0) {
        out.push(["enter", opener.token, context], ["exit", opener.token, context])
        opener.exit = out.length - 1
        openers.push(opener)
      }

      out.push(
        ["enter", group as Token, context],
        ["enter", openingSequence as Token, context],
        ["exit", openingSequence as Token, context],
        ["enter", text as Token, context],
      )
      append(out, resolveAll(insideSpan, between, context))
      out.push(
        ["exit", text as Token, context],
        ["enter", closingSequence as Token, context],
        ["exit", closingSequence as Token, context],
        ["exit", group as Token, context],
      )
      lower(floors, at)
      remade = true
      used = size(closer) === 0
    }

    if (!used) {
      out.push(
        ...(remade
          ? ([
              ["enter", closer, context],
              ["exit", closer, context],
            ] as Events)
          : [event, exit]),
      )

      if (closer._open) {
        openers.push({ token: closer, mark: marker, exit: out.length - 1 })
      }
    }
  }

  for (const [, token] of out) {
    if (token.type === "attentionSequence") {
      token.type = "data"
    }
  }

  return rewritten(events, out)
}

/** The strikethrough extension's resolver, made one pass as resolveAttention is. */
const resolveStrikethrough: Resolver = (events, context) => {
  if (!events.some(([, token]) => token.type === "strikethroughSequenceTemporary")) {
    return events
  }

  const out: Events = []
  const openers: Opener[] = []
  const floors = new Map<string, number>()
  const insideSpan = context.parser.constructs.insideSpan.null as Construct[] | undefined

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    const closer = event[1]

    if (event[0] !== "enter" || closer.type !== "strikethroughSequenceTemporary") {
      out.push(event)
      continue
    }

    const exit = events[++index]
    const length = size(closer)
    let at = -1

    if (closer._close) {
      const floor = floors.get(String(length)) ?? 0
      at = openers.length - 1

      while (at >= floor && openers[at].mark !== length) {
        at--
      }

      if (at < floor) {
        floors.set(String(length), openers.length)
        at = -1
      }
    }

    if (at < 0) {
      out.push(event, exit)

      if (closer._open) {
        openers.push({ token: closer, mark: length, exit: out.length - 1 })
      }

      continue
    }

    const opener = openers[at].token
    const strikethrough = {
      type: "strikethrough",
      start: { ...opener.start },
      end: { ...closer.end },
    }
    const text = { type: "strikethroughText", start: { ...opener.end }, end: { ...closer.start } }

    closer.type = "strikethroughSequence"
    opener.type = "strikethroughSequence"

    const between = out.splice(openers[at].exit + 1)
    out.length = openers[at].exit - 1
    openers.length = at
    out.push(
      ["enter", strikethrough as Token, context],
      ["enter", opener, context],
      ["exit", opener, context],
      ["enter", text as Token, context],
    )
    append(out, insideSpan ? resolveAll(insideSpan, between, context) : between)
    out.push(
      ["exit", text as Token, context],
      ["enter", closer, context],
      ["exit", closer, context],
      ["exit", strikethrough as Token, context],
    )
    lower(floors, at)
  }

  for (const [, token] of out) {
    if (token.type === "strikethroughSequenceTemporary") {
      token.type = "data"
    }
  }

  return rewritten(events, out)
}

/**
 * As micromark-util-resolve-all, which folio reaches only through micromark.
 * micromark's own emphasis resolver is skipped: run after this one, it finds nothing to do.
 */
function resolveAll(constructs: Construct[], events: Events, context: Context): Events {
  const called: Resolver[] = []
  let resolved = events

  for (const { name, resolveAll: resolve } of constructs) {
    if (
      resolve &&
      !called.includes(resolve) &&
      (name !== "attention" || resolve === resolveAttention)
    ) {
      resolved = resolve(resolved, context)
      called.push(resolve)
    }
  }

  return resolved
}

/** In place, as micromark's resolvers do: subtokenize keeps the array it passed in. */
function rewritten(events: Events, out: Events): Events {
  events.length = 0
  append(events, out)
  return events
}

/** Pushed one at a time: spreading a long line's events into one call overflows the stack. */
function append(out: Events, events: Events): void {
  for (const event of events) {
    out.push(event)
  }
}

/** A match removes the openers from its own up, so no floor may stand above where it was. */
function lower(floors: Map<string, number>, at: number): void {
  for (const [key, floor] of floors) {
    if (floor > at) {
      floors.set(key, at)
    }
  }
}

function size(token: Token): number {
  return token.end.offset - token.start.offset
}

/** Moves within a line only, as micromark's own does. */
function move(point: Point, offset: number): void {
  point.column += offset
  point.offset += offset
  point._bufferIndex += offset
}

/** A port of mdast-util-gfm-autolink-literal's transform, finding the same links in one pass. */
function autolinks(tree: Root): undefined {
  replaceIn(tree, urlsIn)
  replaceIn(tree, emailsIn)
}

function replaceIn(parent: Parent, find: (value: string) => Found[]): void {
  for (let index = 0; index < parent.children.length; index++) {
    const child = parent.children[index] as Nodes

    if (child.type === "text") {
      const nodes = replaced(child, find(child.value))

      if (nodes) {
        parent.children.splice(index, 1, ...(nodes as Parent["children"]))
        index += nodes.length - 1
      }
    } else if (child.type !== "link" && child.type !== "linkReference" && "children" in child) {
      replaceIn(child, find)
    }
  }
}

function replaced(node: Text, found: Found[]): PhrasingContent[] | undefined {
  if (found.length === 0) {
    return undefined
  }

  const nodes: PhrasingContent[] = []
  const add = (child: PhrasingContent) => {
    const previous = nodes.at(-1)

    if (previous?.type === "text" && child.type === "text") {
      previous.value += child.value
    } else {
      nodes.push(child)
    }
  }
  let start = 0

  for (const { at, length, nodes: made } of found) {
    if (start !== at) {
      add({ type: "text", value: node.value.slice(start, at) })
    }

    for (const child of made) {
      add(child)
    }

    start = at + length
  }

  if (start < node.value.length) {
    add({ type: "text", value: node.value.slice(start) })
  }

  return nodes
}

/** A refused start is tried again one character on, as the expression is; the run ends it reached are held. */
function urlsIn(value: string): Found[] {
  const found: Found[] = []
  const ends = runs(value)

  for (let at = 0; at < value.length; ) {
    const start = protocolFrom(value, at)

    if (start < 0) {
      break
    }

    const www = /w/i.test(value[start])
    const hostStart = start + (www ? 3 : /^https/i.test(value.slice(start, start + 5)) ? 8 : 7)
    const hostEnd = ends.host(hostStart)
    const end = ends.path(hostEnd)
    const link = hostEnd > hostStart && url(value, start, www, hostStart, hostEnd, end, ends)

    if (link) {
      found.push({ at: start, length: end - start, nodes: link })
      at = end
    } else {
      at = start + 1
    }
  }

  return found
}

function protocolFrom(value: string, from: number): number {
  for (let at = from; at < value.length; at++) {
    const head = value.slice(at, at + 8).toLowerCase()

    if (head.startsWith("http://") || head.startsWith("https://") || head.startsWith("www.")) {
      return at
    }
  }

  return -1
}

function url(
  value: string,
  start: number,
  www: boolean,
  hostStart: number,
  hostEnd: number,
  end: number,
  ends: Runs,
): PhrasingContent[] | undefined {
  const domainStart = www ? start : hostStart

  if (
    (start > 0 && !spaceOrPunctuation(value.charCodeAt(start - 1))) ||
    !ends.domainPasses(domainStart, hostEnd)
  ) {
    return undefined
  }

  const protocol = www ? "" : value.slice(start, hostStart)
  const [kept, trail] = splitUrl(value.slice(domainStart, end))

  if (!kept) {
    return undefined
  }

  const link: Link = {
    type: "link",
    title: null,
    url: (www ? "http://" : "") + protocol + kept,
    children: [{ type: "text", value: protocol + kept }],
  }

  return trail ? [link, { type: "text", value: trail }] : [link]
}

function splitUrl(link: string): [string, string | undefined] {
  let cut = link.length

  while (cut > 0 && TRAIL.has(link[cut - 1])) {
    cut--
  }

  if (cut === link.length) {
    return [link, undefined]
  }

  const kept = link.slice(0, cut)
  const trail = link.slice(cut)
  let open = 0
  let moved = 0

  for (const character of kept) {
    open += character === "(" ? 1 : character === ")" ? -1 : 0
  }

  for (let index = 0; index < trail.length && open > 0; index++) {
    if (trail[index] === ")") {
      moved = index + 1
      open--
    }
  }

  return [kept + trail.slice(0, moved), trail.slice(moved)]
}

/** Every start inside one run of address characters reaches the same `@` and domain: a run is judged once. */
function emailsIn(value: string): Found[] {
  const found: Found[] = []

  for (let at = 0; at < value.length; ) {
    const start = localFrom(value, at)

    if (start < 0) {
      break
    }

    let localEnd = start

    while (localEnd < value.length && LOCAL.test(value[localEnd])) {
      localEnd++
    }

    const domainEnd = value[localEnd] === "@" ? domainFrom(value, localEnd + 1) : -1
    const first =
      domainEnd < 0 || /[-\d_]/.test(value[domainEnd - 1]) ? -1 : linkable(value, start, localEnd)

    if (first < 0) {
      at = localEnd + 1
      continue
    }

    const address = value.slice(first, domainEnd)
    const link: Link = {
      type: "link",
      title: null,
      url: `mailto:${address}`,
      children: [{ type: "text", value: address }],
    }

    found.push({ at: first, length: domainEnd - first, nodes: [link] })
    at = domainEnd
  }

  return found
}

function localFrom(value: string, from: number): number {
  for (let at = from; at < value.length; at++) {
    if (LOCAL.test(value[at]) && (at === 0 || BEFORE_EMAIL.test(codePointBefore(value, at)))) {
      return at
    }
  }

  return -1
}

/** The expression reads the character before a start as a code point, the transform's own check as a code unit. */
function linkable(value: string, start: number, end: number): number {
  for (let at = start; at < end; at++) {
    const before = value.charCodeAt(at - 1)

    if (
      at === 0 ||
      (BEFORE_EMAIL.test(codePointBefore(value, at)) &&
        spaceOrPunctuation(before) &&
        before !== SLASH)
    ) {
      return at
    }
  }

  return -1
}

function domainFrom(value: string, from: number): number {
  let at = from

  while (at < value.length && DOMAIN.test(value[at])) {
    at++
  }

  if (at === from) {
    return -1
  }

  let labels = 0

  while (value[at] === "." && at + 1 < value.length && DOMAIN.test(value[at + 1])) {
    at++

    while (at < value.length && DOMAIN.test(value[at])) {
      at++
    }

    labels++
  }

  return labels > 0 ? at : -1
}

function codePointBefore(value: string, at: number): string {
  const low = value.charCodeAt(at - 1)
  const high = value.charCodeAt(at - 2)
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
    ? value.slice(at - 2, at)
    : value[at - 1]
}

function spaceOrPunctuation(code: number): boolean {
  const character = String.fromCharCode(code)
  return /\s/.test(character) || PUNCTUATION.test(character)
}

interface Runs {
  host(from: number): number
  path(from: number): number
  domainPasses(start: number, end: number): boolean
}

function runs(value: string): Runs {
  let hostFrom = -1
  let hostTo = -1
  let pathFrom = -1
  let pathTo = -1
  const judged = new Map<string, boolean>()
  const passes = (part: string) => !part || (!part.includes("_") && /[a-zA-Z\d]/.test(part))

  return {
    host(from) {
      if (from < hostFrom || from > hostTo) {
        hostFrom = from
        hostTo = from

        while (hostTo < value.length && HOST.test(value[hostTo])) {
          hostTo++
        }
      }

      return hostTo
    },
    path(from) {
      if (from < pathFrom || from > pathTo) {
        pathFrom = from
        pathTo = from

        while (pathTo < value.length && !PATH_END.has(value[pathTo])) {
          pathTo++
        }
      }

      return pathTo
    },
    domainPasses(start, end) {
      const last = value.lastIndexOf(".", end - 1)

      if (last < start) {
        return false
      }

      const second = Math.max(value.lastIndexOf(".", last - 1) + 1, start)
      const key = `${second}:${end}`
      let judgement = judged.get(key)

      if (judgement === undefined) {
        judgement = passes(value.slice(last + 1, end)) && passes(value.slice(second, last))
        judged.set(key, judgement)
      }

      return judgement
    },
  }
}
