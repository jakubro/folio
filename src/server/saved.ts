/**
 * Views saved into the markdown: the region between `<!-- folio view: REF -->` and `<!-- /folio view -->`
 * in a document a declaration's `save` places holds REF's result as plain markdown, rewritten as it moves.
 */

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { conventionsOf, type Digest } from "./conventions.ts"
import type { Cell, Data, Embedded } from "./data.ts"
import { digest } from "./digest.ts"
import { confine } from "./files.ts"
import type { Model } from "./model.ts"
import { alive, startOf } from "./processes.ts"

export interface ViewProblem {
  line: number
  what: string
}

interface Region {
  reference: string
  /** Lines of the markers, from 0. */
  start: number
  end: number
  body: string[]
  next?: string[]
}

interface DigestAsked {
  period: "day" | "week"
  from: number
  /** The end of a period already over; a current period runs to now. */
  to?: number
  /** Every declared digest path as a pattern, so no digest lists another. */
  digests: RegExp
}

interface Mend {
  target: string
  old: string
}

type Journal = Record<string, { pid: number; start: string; mend?: Mend }>

interface Kept {
  writtenText?: string
  writtenBodies: Record<string, string>
  replaced: ViewProblem[]
}

const START = /^<!--\s*folio view:\s*(.+?)\s*-->\s*$/
const END = /^<!--\s*\/folio view\s*-->\s*$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const BOM = "\u00ef\u00bb\u00bf"
const MARK = "<!-- folio view:"
/** Copies an earlier folio left carry their document's name before the id, and are swept as well. */
const TEMPORARY = /^\.(?:.+\.)?[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.folio$/
const SETTLE_MS = 100
/** Longer than the pauses of a program writing a file in pieces, so its write is never cut short. */
const QUIET_MS = 1000
const OWN_MS = 5000
const ECHOES = 3
const DIGEST_MS = 60_000
const DAY_MS = 86_400_000
const SAVED = new WeakMap<Model, Saved>()

export function savedOf(model: Model, data: Data): Saved {
  let saved = SAVED.get(model)

  if (!saved) {
    saved = new Saved(model, data)
    SAVED.set(model, saved)
  }

  return saved
}

/**
 * A document is handled as its bytes, one character each, so bytes that are not UTF-8 pass through as
 * they were; a result is written as UTF-8.
 */
export class Saved {
  readonly #model: Model
  readonly #data: Data
  readonly #file: string
  readonly #journal: string
  readonly #listeners = new Set<(urlPath: string) => void>()
  readonly #failed = new Map<string, ViewProblem[]>()
  readonly #refused = new Map<string, ViewProblem[]>()
  readonly #echoes = new Map<string, number>()
  readonly #digested = new Map<string, { from: number; at: number; body: string }>()
  #othersHeard = 0
  readonly #own = new Map<string, number>()
  readonly #ownFolders = new Map<string, { until: number; seen: string }>()
  readonly #wroteAt = new Map<string, number>()
  readonly #wrote = new Map<string, string>()
  #later: NodeJS.Timeout | undefined
  #retry: NodeJS.Timeout | undefined
  #boundary: NodeJS.Timeout | undefined
  #digestPaths = /(?!)/
  #kept: Record<string, Kept> | undefined
  #timer: NodeJS.Timeout | undefined
  #running: Promise<void> | undefined
  #again = false

  readonly #digestMs: number
  readonly #now: () => number

  constructor(model: Model, data: Data, digestMs = DIGEST_MS, now = Date.now) {
    this.#model = model
    this.#data = data
    this.#digestMs = digestMs
    this.#now = now
    this.#file = path.join(model.store, "views.json")
    this.#journal = path.join(model.store, "writing.json")
  }

  start(): void {
    this.#sweep()
    this.#model.listen((changed) => {
      this.#heard(changed)
      this.#schedule()
    })
    this.#model.listenFolders((dir) => {
      const own = this.#ownFolders.get(dir)
      const seen = own && own.until >= Date.now() ? folderState(dir) : undefined

      if (seen === undefined || seen !== own?.seen) {
        this.#othersHeard++
      }

      if (own && seen !== undefined) {
        own.seen = seen
      }

      this.#schedule()
    })
    this.#schedule()
  }

  listen(listener: (urlPath: string) => void): void {
    this.#listeners.add(listener)
  }

  problems(urlPath: string): ViewProblem[] {
    return [
      ...(this.#refused.get(urlPath) ?? []),
      ...(this.#failed.get(urlPath) ?? []),
      ...(this.#kept?.[urlPath]?.replaced ?? []),
    ]
  }

  async settled(): Promise<void> {
    while (this.#timer || this.#running || this.#retry) {
      await (this.#running ?? new Promise((resolve) => setTimeout(resolve, SETTLE_MS)))
    }
  }

  #schedule(): void {
    if (this.#running) {
      this.#again = true
      return
    }

    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#running = this.#pass()
        .catch((error: Error) => this.#model.log(`views: ${error.message}`))
        .finally(() => {
          this.#running = undefined

          if (this.#again) {
            this.#again = false
            this.#schedule()
          }
        })
    }, SETTLE_MS)
  }

  #heard(changed: readonly string[] | undefined): void {
    for (const urlPath of changed ?? [undefined]) {
      if (urlPath !== undefined && (this.#own.get(urlPath) ?? 0) >= Date.now()) {
        this.#own.delete(urlPath)
      } else {
        this.#othersHeard++
      }
    }
  }

  async #pass(): Promise<void> {
    if (!this.#model.ready) {
      return
    }

    const heard = this.#othersHeard
    this.#kept ??= await readKept(this.#file)
    const conventions = conventionsOf(this.#model)
    const seen = new Set<string>()
    const digests = this.#digests(conventions.digests())

    for (const urlPath of new Set([...digests.keys(), ...this.#model.paths()])) {
      const file = path.join(this.#model.root, urlPath)
      const text =
        (digests.has(urlPath) || conventions.saves(urlPath)) &&
        confine(this.#model.root, urlPath) !== undefined
          ? readRaw(file)
          : undefined

      if (text?.includes(MARK)) {
        seen.add(urlPath)
        await this.#document(urlPath, file, text, heard, digests.get(urlPath))
      }
    }

    for (const urlPath of [...this.#failed.keys(), ...Object.keys(this.#kept)]) {
      if (!seen.has(urlPath)) {
        this.#failed.delete(urlPath)
        delete this.#kept[urlPath]
        this.#tell(urlPath)
      }
    }
  }

  #digests(declared: Digest[]): Map<string, DigestAsked> {
    const found = new Map<string, DigestAsked>()
    const refused = new Map<string, ViewProblem[]>()
    const root = this.#model.root
    const all = new RegExp(
      `^(?:${
        declared
          .map(({ path: at }) =>
            at
              .split(/\{(?:day|week)\}/)
              .map(literal)
              .join("[^/]+"),
          )
          .join("|") || "(?!)"
      })$`,
    )

    const now = this.#now()
    let boundary = Number.POSITIVE_INFINITY
    this.#digestPaths = all

    for (const { path: at, period, declaredIn, line } of declared) {
      const from = periodStart(period, now)
      const named = (start: number) =>
        at.replaceAll("{day}", dayOf(start)).replaceAll("{week}", weekOf(start))
      const urlPath = named(from)
      const file = path.join(root, urlPath)
      const before = periodStart(period, from - 1)
      boundary = Math.min(boundary, nextStart(period, from))

      if (!inside(root, path.dirname(file)) || !placeable(root, urlPath)) {
        refused.set(declaredIn, [
          ...(refused.get(declaredIn) ?? []),
          {
            line,
            what: `The digest ${urlPath} is not written: its path is a link that leads nowhere inside the served folder.`,
          },
        ])
        continue
      }

      // The period just over is written once more after it ends, so its last changes are kept.
      if (named(before) !== urlPath && confine(root, named(before)) !== undefined) {
        found.set(named(before), { period, from: before, to: from, digests: all })
      }

      let failed: string | undefined

      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const there = fs.statSync(file, { throwIfNoEntry: false })

        if (!there) {
          this.#replace(file, Buffer.from(`# Digest\n\n${MARK} digest -->\n<!-- /folio view -->\n`))
        } else if (!there.isFile()) {
          failed = there.isDirectory() ? "EISDIR" : "EEXIST"
        }
      } catch (error) {
        const { code, message } = error as NodeJS.ErrnoException
        failed = code ?? message
      }

      if (failed) {
        refused.set(declaredIn, [
          ...(refused.get(declaredIn) ?? []),
          { line, what: `The digest ${urlPath} cannot be created: ${failed}.` },
        ])
        continue
      }

      found.set(urlPath, { period, from, digests: all })
    }

    for (const urlPath of new Set([...this.#refused.keys(), ...refused.keys()])) {
      if (JSON.stringify(this.#refused.get(urlPath)) !== JSON.stringify(refused.get(urlPath))) {
        this.#tell(urlPath)
      }
    }

    this.#refused.clear()

    for (const [urlPath, problems] of refused) {
      this.#refused.set(urlPath, problems)
    }

    clearTimeout(this.#boundary)

    if (Number.isFinite(boundary)) {
      this.#boundary = setTimeout(() => this.#schedule(), Math.max(0, boundary - now) + 1000)
      this.#boundary.unref()
    }

    return found
  }

  async #digest(urlPath: string, asked: DigestAsked): Promise<string> {
    const held = this.#digested.get(urlPath)
    const now = this.#now()
    const to = Math.min(asked.to ?? now, now)
    const final = asked.to !== undefined && held?.at !== undefined && held.at >= asked.to

    if (held?.from === asked.from && final) {
      return held.body
    }

    if (held?.from === asked.from && asked.to === undefined && now - held.at < this.#digestMs) {
      clearTimeout(this.#later)
      this.#later = setTimeout(() => this.#schedule(), held.at + this.#digestMs - now)
      this.#later.unref()
      return held.body
    }

    const { documents, values } = await digest(this.#model.root, this.#model, asked.from, to)
    const folder = path.posix.dirname(urlPath)
    const link = (at: string) =>
      `[${path.posix.basename(at)}](${encodeURI(path.posix.relative(folder, at))})`
    const listed = documents.filter(({ path: at }) => !asked.digests.test(at))
    const lines = [
      "",
      `Changes ${asked.period === "day" ? `on ${dayOf(asked.from)}` : `in the week of ${dayOf(asked.from)}`}.`,
      "",
    ]
    let heading = ""

    for (const { path: at, status } of listed.sort((a, b) => a.path.localeCompare(b.path))) {
      const dir = path.posix.dirname(at)

      if (dir !== heading) {
        heading = dir
        lines.push(`### ${dir === "." ? "/" : `${dir}/`}`, "")
      }

      lines.push(`- ${link(at)} - ${status}`)
    }

    if (values.length > 0) {
      lines.push("", "### Values", "")

      for (const { document, reference, before, after } of values) {
        lines.push(`- \`${reference}\` in ${link(document)}: ${before} -> ${after}`)
      }
    }

    if (listed.length + values.length === 0) {
      lines.push("Nothing has changed yet.")
    }

    const body = [...lines, ""].join("\n")
    this.#digested.set(urlPath, { from: asked.from, at: now, body })
    return body
  }

  async #document(
    urlPath: string,
    file: string,
    text: string,
    heard: number,
    asked?: DigestAsked,
  ): Promise<void> {
    const kept = this.#kept as Record<string, Kept>
    const was = kept[urlPath] ?? { writtenBodies: {}, replaced: [] }
    const before = JSON.stringify([this.problems(urlPath)])
    const real = confine(this.#model.root, urlPath) ?? file
    const folderBefore = folderState(path.dirname(real), real)
    const lines = text.split("\n")
    const { regions, open } = regionsOf(lines)
    const failed: ViewProblem[] = open.map((line) => ({
      line: line + 1,
      what: "This view has no closing <!-- /folio view --> line, so folio writes nothing into it.",
    }))
    const replaced: ViewProblem[] = []
    const written: Record<string, string> = {}
    let changed = false

    // The document changed since folio last wrote it, without touching a view: earlier reports are spent.
    const spent = was.writtenText !== undefined && hash(text) !== was.writtenText
    // Only folio's own last write of the document was heard since the pass that wrote it began.
    const unheard = this.#wroteAt.get(urlPath) === heard

    for (const [index, region] of regions.entries()) {
      const key = `${index}\0${region.reference}`
      const now = region.body.map((line) => line.replace(/\r$/, "")).join("\n")

      // A digest of an earlier period rests as it was last written.
      if (region.reference === "digest" && !asked && this.#digestPaths.test(urlPath)) {
        written[key] = hash(now)
        continue
      }

      const result: Embedded =
        region.reference !== "digest"
          ? await this.#data.embedReference(file, region.reference)
          : asked
            ? { version: "", value: await this.#digest(urlPath, asked) }
            : {
                version: "",
                error: "a digest is written only into a document declared under digests.",
              }
      const body =
        result.error !== undefined
          ? undefined
          : region.reference === "digest"
            ? String(result.value)
            : markdown(result)

      if (body === undefined) {
        failed.push({
          line: region.start + 1,
          what: `The view ${region.reference} cannot be written: ${result.error ?? "it holds nothing to write."}`,
        })

        if (was.writtenBodies[key] !== undefined) {
          written[key] = was.writtenBodies[key]
        }

        continue
      }

      const next = raw(contained(body)).split("\n")
      const moved = next.join("\n") !== now

      // A view whose result moves with each of its own writes would rewrite its document forever.
      const echoed = `${urlPath}\0${key}`
      const echo =
        moved &&
        unheard &&
        was.writtenText !== undefined &&
        !spent &&
        region.reference !== "digest" &&
        (await this.#readsItself(file, region.reference))
      const echoes = echo ? (this.#echoes.get(echoed) ?? 0) + 1 : 0
      this.#echoes.set(echoed, echoes)

      if (echoes >= ECHOES) {
        failed.push({
          line: region.start + 1,
          what: `The view ${region.reference} changes with every write into this document, which its query reads, so folio stopped writing it.`,
        })

        if (was.writtenBodies[key] !== undefined) {
          written[key] = was.writtenBodies[key]
        }

        continue
      }

      if (was.writtenBodies[key] !== undefined && hash(now) !== was.writtenBodies[key]) {
        replaced.push({
          line: region.start + 1,
          what: `A hand edit of the view ${region.reference} was replaced; the edit is kept in the document's history.`,
        })
      }

      written[key] = hash(next.join("\n"))

      if (moved) {
        region.next = next
        changed = true
      }
    }

    if (changed) {
      const next = rebuild(lines, regions)

      let wrote: boolean

      try {
        wrote = await this.#write(urlPath, text, next, folderBefore)
      } catch (error) {
        const { code, message } = error as NodeJS.ErrnoException
        wrote = false
        failed.push({
          line: regions[0].start + 1,
          what: `The views cannot be written into this document: ${code ?? message}.`,
        })
        this.#failed.set(urlPath, failed)

        if (JSON.stringify([this.problems(urlPath)]) !== before) {
          this.#tell(urlPath)
        }

        return
      }

      if (!wrote) {
        return
      }

      this.#wroteAt.set(urlPath, heard)
      kept[urlPath] = {
        writtenText: hash(next),
        writtenBodies: written,
        replaced: [...replaced, ...was.replaced],
      }
    } else {
      kept[urlPath] = {
        writtenText: was.writtenText,
        writtenBodies: written,
        replaced: spent && replaced.length === 0 ? [] : [...replaced, ...was.replaced],
      }
    }

    this.#failed.set(urlPath, failed)
    await writeKept(this.#file, kept)

    if (JSON.stringify([this.problems(urlPath)]) !== before) {
      this.#tell(urlPath)
    }
  }

  /**
   * Only a settled file is written - no other program holds it open to write, and it has been still for a
   * moment unless folio wrote it last - so a write under way is never cut short. Says whether it wrote; a
   * file its time places in the future counts as still.
   * folderBefore is the folder as the results were worked out, so a change landing since is counted.
   */
  async #write(
    urlPath: string,
    text: string,
    next: string,
    folderBefore: string,
  ): Promise<boolean> {
    const root = this.#model.root
    const file = confine(root, urlPath)

    if (!file) {
      this.#model.log(
        `views: ${urlPath} now leads outside the served folder, so it is not written.`,
        "warning",
      )
      return false
    }

    const stat = fs.statSync(file)
    const age = Date.now() - stat.mtimeMs
    const stirring = this.#wrote.get(file) !== stamp(stat) && age >= 0 && age < QUIET_MS

    if (stirring || heldForWriting(file, stat)) {
      this.#retryIn(stirring ? Math.max(SETTLE_MS, QUIET_MS - age) : QUIET_MS)
      return false
    }

    if (readRaw(file) !== text) {
      this.#schedule()
      return false
    }

    const until = Date.now() + OWN_MS
    this.#own.set(urlPath, until)
    this.#own.set(path.relative(root, file).split(path.sep).join("/"), until)
    this.#replace(file, Buffer.from(next, "latin1"), stat)
    this.#wrote.set(file, stamp(fs.statSync(file)))

    if (folderState(path.dirname(file), file) !== folderBefore) {
      this.#othersHeard++
    }

    this.#ownFolders.set(path.dirname(file), { until, seen: folderState(path.dirname(file)) })
    return true
  }

  #retryIn(ms: number): void {
    if (this.#retry) {
      return
    }

    this.#retry = setTimeout(() => {
      this.#retry = undefined
      this.#schedule()
    }, ms)
  }

  /**
   * A rename would part a file from its other hard links, or from an owner folio cannot give a new file,
   * so such a file is written over in place instead.
   */
  #replace(file: string, bytes: Buffer, stat?: fs.Stats): void {
    if (stat && stat.nlink > 1) {
      this.#inPlace(file, bytes)
      return
    }

    // Named apart from the document, so a document's name of any length leaves room for it.
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.folio`)
    this.#writing(temporary, true)
    let handle: number | undefined

    try {
      handle = fs.openSync(temporary, "wx")
      fs.writeFileSync(handle, bytes)

      if (stat) {
        fs.fchmodSync(handle, stat.mode & 0o7777)
        const made = fs.fstatSync(handle)

        if (made.uid !== stat.uid || made.gid !== stat.gid) {
          try {
            fs.fchownSync(handle, stat.uid, stat.gid)
          } catch {
            fs.closeSync(handle)
            handle = undefined
            this.#inPlace(file, bytes)
            return
          }
        }
      }

      fs.fsyncSync(handle)
      fs.closeSync(handle)
      handle = undefined
      fs.renameSync(temporary, file)
    } finally {
      if (handle !== undefined) {
        fs.closeSync(handle)
      }

      fs.rmSync(temporary, { force: true })
      this.#writing(temporary, false)
    }
  }

  /**
   * The document's old and new text are kept beside it, flushed, until the write is done, so a write cut short
   * by folio stopping is finished when it starts again.
   */
  #inPlace(file: string, bytes: Buffer): void {
    const id = randomUUID()
    const fresh = path.join(path.dirname(file), `.${id}.folio`)
    const old = path.join(path.dirname(file), `.old.${id}.folio`)
    this.#writing(fresh, true)
    this.#writing(old, true)

    try {
      durably(old, fs.readFileSync(file))
      durably(fresh, bytes)
      this.#writing(fresh, true, { target: file, old })
      inPlace(file, bytes)
    } finally {
      fs.rmSync(fresh, { force: true })
      fs.rmSync(old, { force: true })
      this.#writing(fresh, false)
      this.#writing(old, false)
    }
  }

  /** Noted before it is made, so one left by a folio killed before renaming it is removed, not committed. */
  #writing(temporary: string, made: boolean, mend?: Mend): void {
    const noted = readJournal(this.#journal)

    if (made) {
      noted[temporary] = { pid: process.pid, start: startOf("self"), ...(mend && { mend }) }
    } else {
      delete noted[temporary]
    }

    writeJournal(this.#journal, noted)
  }

  #sweep(): void {
    const noted = readJournal(this.#journal)
    const gone = Object.entries(noted).filter(([, { pid, start }]) => !alive(pid, start))

    for (const [fresh, { mend }] of gone) {
      if (mend) {
        this.#mend(mend.target, fresh, mend.old)
      }
    }

    for (const [temporary] of gone) {
      if (TEMPORARY.test(path.basename(temporary))) {
        fs.rmSync(temporary, { force: true })
      }

      delete noted[temporary]
    }

    writeJournal(this.#journal, noted)
  }

  #mend(file: string, fresh: string, old: string): void {
    try {
      const now = fs.readFileSync(file)
      const next = fs.readFileSync(fresh)
      const before = fs.readFileSync(old)

      if (cutShort(now, next, before)) {
        inPlace(file, next)
        this.#model.log(
          `views: ${file} was left half written when folio stopped; its write is finished.`,
          "info",
        )
      } else if (!now.equals(next) && !now.equals(before)) {
        this.#model.log(
          `views: ${file} changed after a write into it was cut short; it is left as it is.`,
          "warning",
        )
      }
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException
      this.#model.log(
        `views: ${file} was left half written and cannot be finished: ${code ?? message}.`,
      )
    }
  }

  async #readsItself(file: string, reference: string): Promise<boolean> {
    const { files, tables = [] } = await this.#data.reads(file, reference)
    return tables.length > 0 || files.includes(fs.realpathSync(file))
  }

  #tell(urlPath: string): void {
    for (const listener of this.#listeners) {
      listener(urlPath)
    }
  }
}

/** The lines, from 0, inside fenced code blocks, fences included. */
function fencedLines(lines: string[]): Set<number> {
  const inside = new Set<number>()
  let open: string | undefined

  for (const [index, line] of lines.entries()) {
    const fence = FENCE.exec(line)?.[1]

    if (open) {
      inside.add(index)

      if (
        fence &&
        fence[0] === open[0] &&
        fence.length >= open.length &&
        !line.trim().slice(fence.length)
      ) {
        open = undefined
      }
    } else if (fence) {
      open = fence
      inside.add(index)
    }
  }

  return inside
}

function regionsOf(lines: string[]): { regions: Region[]; open: number[] } {
  const regions: Region[] = []
  const open: number[] = []
  const marking = lines.map((line, index) => (index === 0 ? line.replace(BOM, "") : line))
  const fenced = fencedLines(marking)

  for (let at = 0; at < marking.length; at++) {
    const reference = fenced.has(at) ? undefined : START.exec(marking[at])?.[1]

    if (reference === undefined) {
      continue
    }

    const end = marking.findIndex(
      (line, index) => index > at && !fenced.has(index) && (END.test(line) || START.test(line)),
    )

    if (end < 0 || !END.test(marking[end])) {
      open.push(at)
      continue
    }

    regions.push({ reference: utf8(reference), start: at, end, body: lines.slice(at + 1, end) })
    at = end
  }

  return { regions, open }
}

function rebuild(lines: string[], regions: Region[]): string {
  const out: string[] = []
  let from = 0

  for (const { start, end, body, next } of regions) {
    const ending = lines[start].endsWith("\r") ? "\r" : ""
    out.push(...lines.slice(from, start + 1), ...(next?.map((line) => line + ending) ?? body))
    from = end
  }

  out.push(...lines.slice(from))
  return out.join("\n")
}

/** Blank lines around the result keep it a block of its own between the two comment lines. */
function markdown({ grid, value }: Embedded): string | undefined {
  if (grid) {
    const row = (cells: string[]) => `| ${cells.join(" | ")} |`
    return [
      "",
      row(grid.columns.map(({ name }) => escaped(name))),
      row(grid.columns.map(() => "---")),
      ...grid.rows.map((cells) => row(cells.map((cell) => escaped(cell)))),
      "",
    ].join("\n")
  }

  return value === undefined
    ? undefined
    : [
        "",
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
        "",
      ].join("\n")
}

function escaped(cell: Cell): string {
  return cell === null
    ? ""
    : String(cell)
        .replaceAll("|", "\\|")
        .replace(/\r\n|\r|\n/g, " ")
}

/**
 * A result line reading as a marker would end its region early, and one opening a fence would hide the
 * closing marker; a backslash before it shows the same text and reads as neither. A carriage return alone
 * ends a line in markdown too, so every line break is one here.
 */
function contained(body: string): string {
  return body
    .split(/\r\n|\r|\n/)
    .map((line) =>
      START.test(line) || END.test(line) || FENCE.test(line)
        ? line.replace(/^\s{0,3}/, "$&\\")
        : line,
    )
    .join("\n")
}

/**
 * Linux names every file a process holds open; elsewhere only the file's stillness tells. fdinfo names a
 * descriptor's mount and inode, so only one on the document's own filesystem is looked at - a hung mount
 * elsewhere cannot stall the check - and its device and inode decide, as btrfs subvolumes share a mount
 * device while repeating inode numbers. Another hard link counts too. Without a mount, its path decides.
 */
function heldForWriting(file: string, { dev, ino }: fs.Stats): boolean {
  let pids: string[]

  try {
    pids = fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid) && Number(pid) !== process.pid)
  } catch {
    return false
  }

  const mounts = new Map<string, string>()
  const device = ownDevice(file, mounts)

  for (const pid of pids) {
    let descriptors: string[]

    try {
      descriptors = fs.readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }

    for (const descriptor of descriptors) {
      try {
        const at = `/proc/${pid}/fd/${descriptor}`
        const info = fs.readFileSync(`/proc/${pid}/fdinfo/${descriptor}`, "utf8")
        const flags = Number.parseInt(/^flags:\s*(\d+)/m.exec(info)?.[1] ?? "0", 8)
        const held = /^ino:\s*(\d+)/m.exec(info)?.[1]

        // The access mode's two bits: write only or read and write.
        if ((flags & 3) === 0 || (held !== undefined && Number(held) !== ino)) {
          continue
        }

        if (device === undefined) {
          if (fs.readlinkSync(at) === file) {
            return true
          }
        } else if (deviceOf(pid, info, mounts) === device) {
          const target = fs.statSync(at)

          if (target.dev === dev && target.ino === ino) {
            return true
          }
        }
      } catch {
        // The process or its descriptor went meanwhile.
      }
    }
  }

  return false
}

/** Read from the mount table as another program's descriptor is, not from stat, whose device can differ. */
function ownDevice(file: string, mounts: Map<string, string>): string | undefined {
  let handle: number | undefined

  try {
    handle = fs.openSync(file, "r")
    return deviceOf("self", fs.readFileSync(`/proc/self/fdinfo/${handle}`, "utf8"), mounts)
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle)
    }
  }
}

function deviceOf(pid: string, info: string, mounts: Map<string, string>): string | undefined {
  const mount = /^mnt_id:\s*(\d+)/m.exec(info)?.[1]

  if (!mounts.has(pid)) {
    mounts.set(pid, fs.readFileSync(`/proc/${pid}/mountinfo`, "utf8"))
  }

  return (mounts.get(pid) as string)
    .split("\n")
    .find((line) => line.startsWith(`${mount} `))
    ?.split(" ")[2]
}

/**
 * What a folder holds, folio's own copies left out, so a later look tells another program's change apart.
 * Every name leading to the document is left out too: a hard link or a link to it moves with each write.
 */
function folderState(dir: string, document?: string): string {
  try {
    const own =
      document === undefined ? undefined : fs.statSync(document, { throwIfNoEntry: false })
    return fs
      .readdirSync(dir)
      .filter((name) => !TEMPORARY.test(name))
      .sort()
      .flatMap((name) => {
        const at = path.join(dir, name)
        const { dev, ino, mtimeMs, size } =
          fs.statSync(at, { throwIfNoEntry: false }) ?? fs.lstatSync(at)
        return own && dev === own.dev && ino === own.ino ? [] : [`${name}\0${mtimeMs}\0${size}`]
      })
      .join("\n")
  } catch {
    return ""
  }
}

function inPlace(file: string, bytes: Buffer): void {
  const handle = fs.openSync(file, "r+")

  try {
    fs.writeFileSync(handle, bytes)
    fs.ftruncateSync(handle, bytes.length)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

function stamp(stat: fs.Stats): string {
  return `${stat.ino}\0${stat.size}\0${stat.mtimeMs}`
}

function placeable(root: string, urlPath: string): boolean {
  try {
    fs.lstatSync(path.join(root, urlPath))
  } catch {
    return true
  }

  return confine(root, urlPath) !== undefined
}

function readRaw(file: string): string | undefined {
  try {
    return fs.readFileSync(file).toString("latin1")
  } catch {
    return undefined
  }
}

function raw(text: string): string {
  return Buffer.from(text, "utf8").toString("latin1")
}

function utf8(bytes: string): string {
  return Buffer.from(bytes, "latin1").toString("utf8")
}

async function readKept(file: string): Promise<Record<string, Kept>> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"))
  } catch {
    return {}
  }
}

async function writeKept(file: string, kept: Record<string, Kept>): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(kept))
  await fs.promises.rename(`${file}.tmp`, file)
}

function readJournal(file: string): Journal {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

function writeJournal(file: string, noted: Journal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  durably(`${file}.tmp`, Buffer.from(JSON.stringify(noted)), "w")
  fs.renameSync(`${file}.tmp`, file)
}

function durably(file: string, bytes: Buffer, flags = "wx"): void {
  const handle = fs.openSync(file, flags)

  try {
    fs.writeFileSync(handle, bytes)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * Written in place, the new text runs over the old from the front and the file is then cut to its length, so a
 * write cut short leaves the new text's start followed by the old text's rest.
 */
function cutShort(now: Buffer, next: Buffer, before: Buffer): boolean {
  if (now.equals(next) || now.equals(before)) {
    return false
  }

  let written = 0

  while (written < now.length && written < next.length && now[written] === next[written]) {
    written++
  }

  if (now.length !== before.length) {
    return now.length > before.length && written === now.length
  }

  let kept = now.length

  while (kept > 0 && now[kept - 1] === before[kept - 1]) {
    kept--
  }

  return kept <= written
}

/** Over the bytes, so a hash kept from when a document was read as UTF-8 text still matches. */
function hash(bytes: string): string {
  return createHash("sha1").update(Buffer.from(bytes, "latin1")).digest("hex").slice(0, 16)
}

function periodStart(period: "day" | "week", now: number): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)

  if (period === "week") {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  }

  return start.getTime()
}

function inside(root: string, dir: string): boolean {
  let at = dir

  while (!fs.existsSync(at)) {
    at = path.dirname(at)
  }

  return confine(root, path.relative(root, at)) !== undefined
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function dayOf(at: number): string {
  const day = new Date(at)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
}

/** The ISO week: weeks start on Monday, and a year's first week holds its first Thursday. */
function weekOf(at: number): string {
  const local = new Date(at)
  const thursday = Date.UTC(
    local.getFullYear(),
    local.getMonth(),
    local.getDate() + 3 - ((local.getDay() + 6) % 7),
  )
  const year = new Date(thursday).getUTCFullYear()
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1

  return `${year}-W${String(week).padStart(2, "0")}`
}

function nextStart(period: "day" | "week", from: number): number {
  const next = new Date(from)
  next.setDate(next.getDate() + (period === "day" ? 1 : 7))
  return next.getTime()
}
