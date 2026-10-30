/** Where a changed table, list or code block changed: its rows, items or lines, matched against the text read. */

import { createHash } from "node:crypto"
import { similarity, type Unit, unitsOf } from "./blocks.ts"

export interface Parts {
  drawn: number
  marked: PartMark[]
  gone: GonePart[]
}

export interface PartMark {
  at: number
  count: number
  mark: "new" | "changed"
  before?: string
  after?: string
  changedCells?: number[]
}

interface GonePart {
  key: string
  text: string
  /** The parts now on either side of where it stood. */
  after?: number
  before?: number
}

type Segment = { old: number; now: number } | { olds: number[]; nows: number[] }

/** Past this many cells a comparison is not made, and the block is marked whole. */
const MAX_CELLS = 4_000_000
/** Past this many cells the parts left over between matches pair in order rather than by likeness. */
const MAX_PAIRING = 10_000
/** Less alike than this, a part left over is new or removed rather than changed. */
const ALIKE = 0.3
const UNITS = new Map<string, Unit[] | undefined>()
const UNITS_KEPT = 64

/**
 * What changed between the text read and the text now, part by part: undefined when no part tells it -
 * a change to a code fence, to a list's numbering, or rows only moved.
 */
export function partsOf(before: string, after: string, kind: string): Parts | undefined {
  const old = cachedUnits(before, kind)
  const now = cachedUnits(after, kind)
  const segments = old && now && startsOf(old) === startsOf(now) && align(old, now, kind)

  if (!old || !now || !segments) {
    return undefined
  }

  const drawn = now.filter((unit) => unit.shown !== undefined).length
  const marked: PartMark[] = []
  const gone: GonePart[] = []
  let last: number | undefined

  for (const segment of segments) {
    if ("now" in segment) {
      last = now[segment.now].shown ?? last
      continue
    }

    const olds = segment.olds.map((index) => old[index])
    const nows = segment.nows.map((index) => now[index])

    if ([...olds, ...nows].some((unit) => unit.shown === undefined)) {
      return undefined
    }

    if (nows.length === 0) {
      const next = last === undefined ? 0 : last + 1
      gone.push({
        key: keyOf(olds),
        text: textOf(olds),
        ...(last !== undefined && { after: last }),
        ...(next < drawn && { before: next }),
      })
      continue
    }

    const at = nows[0].shown as number
    last = nows.at(-1)?.shown
    marked.push({
      at,
      count: nows.length,
      mark: olds.length > 0 ? "changed" : "new",
      ...(olds.length > 0 && { before: textOf(olds), after: textOf(nows) }),
      ...(kind === "table" &&
        olds.length === 1 && { changedCells: cellsChanged(olds[0], nows[0]) }),
    })
  }

  return marked.length > 0 || gone.length > 0 ? { drawn, marked, gone } : undefined
}

/**
 * The text read with the parts named read taken as they stand now - each by its place now, a removed one by
 * its key - and every other part kept as it was read.
 */
export function partlyRead(
  before: string,
  after: string,
  kind: string,
  read: number[],
  gone: string[],
): string | undefined {
  const old = cachedUnits(before, kind)
  const now = cachedUnits(after, kind)
  const segments = old && now && align(old, now, kind)

  if (!old || !now || !segments) {
    return undefined
  }

  const seen = new Set(read)
  const forgotten = new Set(gone)

  return segments
    .flatMap((segment) => {
      if ("now" in segment) {
        return [now[segment.now].text]
      }

      const olds = segment.olds.map((index) => old[index])
      const nows = segment.nows.map((index) => now[index])
      const taken =
        nows.length > 0
          ? nows.every((unit) => unit.shown !== undefined && seen.has(unit.shown))
          : forgotten.has(keyOf(olds))

      return (taken ? nows : olds).map((unit) => unit.text)
    })
    .join("\n")
}

/**
 * Parts with the same key match as their longest common run; a table row or list item matching one elsewhere
 * moved and matches too. The rest pair up between matches: a code block's as one run, others one by one.
 */
function align(old: Unit[], now: Unit[], kind: string): Segment[] | undefined {
  const matched = common(
    old.map((unit) => unit.key),
    now.map((unit) => unit.key),
  )

  if (!matched) {
    return undefined
  }

  const moved = new Map<number, number>()

  if (kind !== "code") {
    const used = new Set(matched.map(([index]) => index))
    const kept = new Set(matched.map(([, index]) => index))
    const unmatched = new Map<string, number[]>()

    for (const [index, unit] of old.entries()) {
      if (!used.has(index)) {
        unmatched.set(unit.key, [...(unmatched.get(unit.key) ?? []), index])
      }
    }

    for (const [index, unit] of now.entries()) {
      const from = kept.has(index) ? undefined : unmatched.get(unit.key)?.shift()

      if (from !== undefined) {
        moved.set(index, from)
      }
    }
  }

  const movedFrom = new Set(moved.values())
  const segments: Segment[] = []
  let [i, j] = [0, 0]

  for (const [oldAt, nowAt] of [...matched, [old.length, now.length]]) {
    const olds = range(i, oldAt).filter((index) => !movedFrom.has(index))
    let nows: number[] = []

    for (const index of range(j, nowAt)) {
      const from = moved.get(index)

      if (from === undefined) {
        nows.push(index)
      } else {
        segments.push(...gap(old, now, olds.splice(0), nows, kind), { old: from, now: index })
        nows = []
      }
    }

    segments.push(...gap(old, now, olds, nows, kind))

    if (oldAt < old.length) {
      segments.push({ old: oldAt, now: nowAt })
    }

    ;[i, j] = [oldAt + 1, nowAt + 1]
  }

  return segments
}

function gap(old: Unit[], now: Unit[], olds: number[], nows: number[], kind: string): Segment[] {
  if (olds.length === 0 && nows.length === 0) {
    return []
  }

  if (kind === "code" || nows.length === 0) {
    return [{ olds, nows }]
  }

  if (olds.length === 0) {
    return nows.map((index) => ({ olds: [], nows: [index] }))
  }

  const pairs =
    olds.length * nows.length > MAX_PAIRING
      ? range(0, Math.min(olds.length, nows.length)).map((k): [number, number] => [k, k])
      : likest(
          olds.map((index) => old[index]),
          nows.map((index) => now[index]),
          kind,
        )
  const segments: Segment[] = []
  let [i, j] = [0, 0]

  for (const [oldAt, nowAt] of [...pairs, [olds.length, nows.length]]) {
    const [left, right] = [olds.slice(i, oldAt), nows.slice(j, nowAt)]

    // As many left over on each side between two pairs stand in for each other, however unlike.
    if (left.length === right.length) {
      segments.push(...left.map((index, k) => ({ olds: [index], nows: [right[k]] })))
    } else {
      if (left.length > 0) {
        segments.push({ olds: left, nows: [] })
      }

      segments.push(...right.map((index) => ({ olds: [], nows: [index] })))
    }

    if (oldAt < olds.length) {
      segments.push({ olds: [olds[oldAt]], nows: [nows[nowAt]] })
    }

    ;[i, j] = [oldAt + 1, nowAt + 1]
  }

  return segments
}

/** The longest common run of equal keys, as index pairs; undefined when the texts are too long to compare. */
function common(left: string[], right: string[]): [number, number][] | undefined {
  let start = 0
  let end = 0

  while (start < Math.min(left.length, right.length) && left[start] === right[start]) {
    start++
  }

  while (
    end < Math.min(left.length, right.length) - start &&
    left.at(-1 - end) === right.at(-1 - end)
  ) {
    end++
  }

  const [a, b] = [left.slice(start, left.length - end), right.slice(start, right.length - end)]

  if (a.length * b.length > MAX_CELLS) {
    return undefined
  }

  const width = b.length + 1
  const lengths = new Uint32Array((a.length + 1) * width)

  for (let x = 1; x <= a.length; x++) {
    for (let y = 1; y <= b.length; y++) {
      lengths[x * width + y] =
        a[x - 1] === b[y - 1]
          ? lengths[(x - 1) * width + y - 1] + 1
          : Math.max(lengths[(x - 1) * width + y], lengths[x * width + y - 1])
    }
  }

  const middle: [number, number][] = []

  for (let [x, y] = [a.length, b.length]; x > 0 && y > 0; ) {
    if (a[x - 1] === b[y - 1]) {
      middle.unshift([start + x - 1, start + y - 1])
      ;[x, y] = [x - 1, y - 1]
    } else if (lengths[(x - 1) * width + y] >= lengths[x * width + y - 1]) {
      x--
    } else {
      y--
    }
  }

  return [
    ...range(0, start).map((k): [number, number] => [k, k]),
    ...middle,
    ...range(0, end).map((k): [number, number] => [left.length - end + k, right.length - end + k]),
  ]
}

/** The most alike parts paired in order; a table's rows also by the share of cells kept in place. */
function likest(left: Unit[], right: Unit[], kind: string): [number, number][] {
  const width = right.length + 1
  const scores = new Float64Array((left.length + 1) * width)

  for (let x = 1; x <= left.length; x++) {
    for (let y = 1; y <= right.length; y++) {
      const [a, b] = [left[x - 1], right[y - 1]]
      const alike = Math.max(similarity(a.key, b.key), kind === "table" ? kept(a, b) : 0)

      scores[x * width + y] = Math.max(
        scores[(x - 1) * width + y],
        scores[x * width + y - 1],
        alike >= ALIKE ? scores[(x - 1) * width + y - 1] + alike : 0,
      )
    }
  }

  const pairs: [number, number][] = []

  for (let [x, y] = [left.length, right.length]; x > 0 && y > 0; ) {
    if (scores[x * width + y] === scores[(x - 1) * width + y]) {
      x--
    } else if (scores[x * width + y] === scores[x * width + y - 1]) {
      y--
    } else {
      pairs.unshift([x - 1, y - 1])
      ;[x, y] = [x - 1, y - 1]
    }
  }

  return pairs
}

function cellsChanged(old: Unit, now: Unit): number[] {
  const [was, is] = [cellsOf(old), cellsOf(now)]
  return range(0, is.length).filter((index) => was[index] !== is[index])
}

function kept(old: Unit, now: Unit): number {
  const [was, is] = [cellsOf(old), cellsOf(now)]
  const same = range(0, Math.min(was.length, is.length)).filter((k) => was[k] === is[k]).length
  return same / Math.max(was.length, is.length)
}

/** A row's cells as GFM splits them: on every pipe a backslash does not escape. */
function cellsOf(unit: Unit): string[] {
  return (unit.text.split("\n")[0] ?? "")
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\s+/g, " ").trim())
}

/** How many rows, items or lines the page draws of a block; none for a block not drawn by its parts. */
export function drawnOf(text: string, kind: string): number | undefined {
  return cachedUnits(text, kind)?.filter((unit) => unit.shown !== undefined).length
}

function cachedUnits(text: string, kind: string): Unit[] | undefined {
  const key = `${kind}\n${text}`

  if (UNITS.has(key)) {
    const held = UNITS.get(key)
    UNITS.delete(key)
    UNITS.set(key, held)
    return held
  }

  const units = unitsOf(text, kind)
  UNITS.set(key, units)

  for (const oldest of [...UNITS.keys()].slice(0, -UNITS_KEPT)) {
    UNITS.delete(oldest)
  }

  return units
}

function startsOf(units: Unit[]): string {
  return units.flatMap(({ start }) => (start === undefined ? [] : [start])).join()
}

function keyOf(units: Unit[]): string {
  return createHash("sha1")
    .update(units.map((unit) => unit.key).join("\n"))
    .digest("hex")
    .slice(0, 12)
}

function textOf(units: Unit[]): string {
  return units.map((unit) => unit.text).join("\n")
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k)
}
