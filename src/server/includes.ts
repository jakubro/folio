/** Include expansion: every {include: <path>} is replaced by that file's text before the page renders. */

import fs from "node:fs"
import path from "node:path"
import { marked } from "../client/unresolved.ts"
import type { Block } from "./blocks.ts"
import { confine, isInside } from "./files.ts"

export interface Expansion {
  text: string
  /** Every file the text depends on, the page first, including missing targets a save could create. */
  files: string[]
  /** Each file's text as read, once per place it was included, the page first. */
  instances: Instance[]
  /** For each expanded line, 1-based, the instance whose text it starts with. */
  owners: number[]
  /** Whether a part include waited on blocks not parsed yet, and so expanded to nothing for now. */
  partial: boolean
  /** Each include that found nothing or would hold itself, by the file and line holding it. */
  problems: IncludeProblem[]
}

interface IncludeProblem {
  file: string
  line: number
  column: number
  target: string
  why: "missing" | "loop"
}

export interface Instance {
  file: string
  text: string
  /** The file's line the included part starts on: 1 for a whole file. */
  first: number
  /** The part's last line with text: the line break closing a part opens no line of its own. */
  last: number
  /** For each line of the part, the expanded lines it starts and ends on, 1-based. */
  starts: number[]
  ends: number[]
}

/** A file's blocks for this text, or undefined while they are still being parsed. */
export type BlocksOf = (file: string, text: string) => Block[] | undefined

/** Where an expansion stands: the part being expanded, and the line of its file holding the include. */
interface Frame {
  key: string
  file: string
  line: number
  /** Where on its line the include holding the expansion stands, from 0. */
  column: number
}

interface Output {
  chunks: string[]
  line: number
  files: Set<string>
  instances: Instance[]
  owners: number[]
  partial: boolean
  problems: IncludeProblem[]
}

/**
 * A target holds no brackets, braces, quotes or commas, so a YAML flow map opening with an include key
 * is no include.
 */
const TOKEN = /(\\?)\{include:\s*([^}\n[\]{"',]*?)\s*\}/g

/**
 * Expand includes in a real file inside root, recursively, wherever they stand, code included. Paths
 * resolve against the including file's folder, or against root when they start with a slash. A path
 * ending in `#<anchor>` takes only that heading's section, and one ending in `#^<id>` only that block,
 * found among the blocks given. An include that finds nothing, lies outside root or would hold itself
 * stays as written, marked; one escaped with a backslash stays as written, unmarked and unresolved.
 */
export function expand(root: string, file: string, blocksOf?: BlocksOf): Expansion {
  return expandText(root, file, read(file), blocksOf)
}

/** Expand a text as if it stood in a file, as `expand` expands that file's own. */
export function expandText(
  root: string,
  file: string,
  text: string | undefined,
  blocksOf?: BlocksOf,
): Expansion {
  const out: Output = {
    chunks: [],
    line: 1,
    files: new Set(),
    instances: [],
    owners: [],
    partial: false,
    problems: [],
  }

  if (text !== undefined) {
    expandPart(root, instance(file, text, 1, text), text, [], out, blocksOf)
  }

  const { chunks, files, instances, owners, partial, problems } = out
  return { text: chunks.join(""), files: [...files], instances, owners, partial, problems }
}

function expandPart(
  root: string,
  instance: Instance,
  part: string,
  stack: Frame[],
  out: Output,
  blocksOf: BlocksOf | undefined,
): void {
  const key = partKey(instance.file, instance.first, part)
  let last = 0

  instance.starts.push(out.line)
  out.files.add(instance.file)
  out.instances.push(instance)

  for (const match of part.matchAll(TOKEN)) {
    emit(part.slice(last, match.index), instance, out)
    last = match.index + match[0].length

    if (match[1]) {
      emit(match[0].slice(1), instance, out)
      continue
    }

    const line = instance.first + (part.slice(0, match.index).match(/\n/g)?.length ?? 0)
    const column = match.index - (part.lastIndexOf("\n", match.index - 1) + 1)
    include(
      root,
      instance,
      match[2],
      match[0],
      [...stack, { key, file: instance.file, line, column }],
      out,
      blocksOf,
    )
  }

  emit(part.slice(last), instance, out)
  instance.ends.push(out.line)
}

/**
 * A target that names a file whole is that file, even when its name holds a `#`. A part is a cycle
 * only when some include leading to it sits inside it, so a document may include its own sections.
 */
function include(
  root: string,
  from: Instance,
  target: string,
  written: string,
  chain: Frame[],
  out: Output,
  blocksOf: BlocksOf | undefined,
): void {
  const hash = target.lastIndexOf("#")
  const whole = resolve(root, from.file, target)
  const [address, fragment] =
    whole.file || hash < 0 ? [target, ""] : [target.slice(0, hash), target.slice(hash + 1)]
  const { file, missing } = whole.file ? whole : resolve(root, from.file, address)
  const text = file ? read(file) : undefined

  const holder = chain[chain.length - 1]
  const problem = (why: IncludeProblem["why"]) => {
    const { line, column } = holder
    out.problems.push({ file: holder.file, line, column, target, why })
    const file = path.relative(root, holder.file).split(path.sep).join("/")
    emit(marked({ why, line, column, file }, written), from, out)
  }

  if (missing) {
    out.files.add(missing)
  }

  if (!fragment) {
    if (!file || text === undefined) {
      problem("missing")
      return
    }

    if (chain.some((frame) => frame.key === partKey(file, 1, text))) {
      problem("loop")
      return
    }

    // A whole file holds every include in it, so one reached from a part of that file holds itself.
    if (chain.some((frame) => frame.file === file)) {
      problem("loop")
    } else {
      expandPart(root, instance(file, text, 1, text), text, chain, out, blocksOf)
    }

    return
  }

  const found = file && text !== undefined ? blocksOf?.(file, text) : []

  if (file && text !== undefined && !found) {
    out.files.add(file)
    out.partial = true
    return
  }

  const lines = file && text !== undefined && section(found ?? [], text, fragment)
  const all = text?.split("\n") ?? []
  // A part ends in a line break even at the end of its file, so what follows the include stays apart.
  const part = lines ? `${all.slice(lines[0] - 1, lines[1]).join("\n")}\n` : ""
  const key = file && lines ? partKey(file, lines[0], part) : ""
  const loops =
    !!lines &&
    chain.some(
      (frame) =>
        frame.key === key ||
        (frame.file === file && lines[0] <= frame.line && frame.line <= lines[1]),
    )

  if (!file || text === undefined || !lines || loops) {
    problem(loops ? "loop" : "missing")

    if (file && text !== undefined) {
      out.files.add(file)
    }

    return
  }

  expandPart(root, instance(file, text, lines[0], part), part, chain, out, blocksOf)
}

function instance(file: string, text: string, first: number, part: string): Instance {
  const lines = part.split("\n").length - (part.endsWith("\n") ? 1 : 0)
  return { file, text, first, last: first + Math.max(lines, 1) - 1, starts: [], ends: [] }
}

function partKey(file: string, first: number, part: string): string {
  return `${file}\0${first}\0${part.length}`
}

function resolve(root: string, from: string, target: string): { file?: string; missing?: string } {
  const relative = target.startsWith("/")
    ? target
    : path.relative(root, path.join(path.dirname(from), target))
  const file = confine(root, relative)
  const missing = path.join(root, relative)

  return file ? { file } : isInside(root, missing) ? { missing } : {}
}

/** A section runs from its heading to the next heading of the same or a higher level. */
function section(found: Block[], text: string, fragment: string): [number, number] | undefined {
  if (fragment.startsWith("^")) {
    return found.find(({ id }) => id === fragment.slice(1))?.lines
  }

  const anchor = fragment.replace(/^user-content-/, "")
  const index = found.findIndex(({ slug }) => slug === anchor)

  if (index < 0) {
    return undefined
  }

  const level = levelOf(found[index])
  const next = found
    .slice(index + 1)
    .find((block) => block.slug !== undefined && levelOf(block) <= level)
  const end = next ? next.lines[0] - 1 : text.replace(/\n$/, "").split("\n").length

  return [found[index].lines[0], end]
}

function levelOf(heading: Block): number {
  const atx = /^#{1,6}/.exec(heading.text)?.[0].length
  return atx ?? (/\n=+\s*$/.test(heading.text) ? 1 : 2)
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function emit(segment: string, instance: Instance, out: Output): void {
  const index = out.instances.lastIndexOf(instance)

  out.chunks.push(segment)

  for (let at = 0; at < segment.length; ) {
    const newline = segment.indexOf("\n", at)
    out.owners[out.line] ??= index

    if (newline < 0) {
      return
    }

    instance.ends.push(out.line)
    out.line++
    instance.starts.push(out.line)
    at = newline + 1
  }
}
