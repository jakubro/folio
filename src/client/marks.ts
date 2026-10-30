/**
 * What is new to the reader on a page: a bar beside each block added or changed since they read it - beside
 * each row, item or line that changed, in a table, list or code block - a tick where what they read was
 * removed, and the earlier text on demand.
 */

import type { Upstream } from "../server/impact.ts"
import type { PartMark } from "../server/parts.ts"
import type { LinkMark, Mark, Removed } from "../server/reads.ts"
import { drawDiff } from "./diff.ts"
import { embedVersions } from "./embeds.ts"

export interface Marked {
  marks: Mark[]
  removed: Removed[]
  links: LinkMark[]
  upstream: Upstream[]
  version: string
}

interface Units {
  count: number
  element: (at: number) => HTMLElement | undefined
  indexOf: (node: Element) => number
  rect: (at: number, count: number) => DOMRect | undefined
}

type Shown = PartMark & { data?: string[] }

const GUTTER_PX = 34
const CLEAR_MS = 600
const LABELS = {
  new: "New since you last read this page",
  changed: "Changed since you read it - show what it said",
  removed: "Removed since you read it - show what it said",
}

export class Marks {
  writtenRows: (table: HTMLTableElement) => HTMLTableRowElement[] | undefined = () => undefined
  readonly #layer = document.createElement("div")
  readonly #panel = document.createElement("div")
  readonly #upstream = document.createElement("p")
  #article: HTMLElement | undefined
  #marked: Marked | undefined
  #placed: { element: HTMLElement; target: () => DOMRect | undefined }[] = []
  #open: { source: string; id: string; part?: string } | undefined
  #panelUnder: HTMLElement | undefined
  #scheduled = false
  /** Blocks marked part by part, which count as read only through their parts. */
  readonly #parted = new Set<HTMLElement>()
  readonly #subjects = new Map<HTMLElement, { unit?: HTMLElement; cells: Element[] }>()
  readonly #rows = new Set<HTMLElement>()

  /** The note on what changed upstream sits beside the page, so its coming and going moves no text. */
  constructor(main: HTMLElement, beside: HTMLElement) {
    this.#layer.className = "read-marks"
    this.#panel.className = "mark-panel"
    this.#panel.hidden = true
    this.#upstream.className = "upstream-note"
    this.#upstream.hidden = true
    beside.append(this.#upstream)
    main.append(this.#layer, this.#panel)
    new ResizeObserver(() => this.#schedule()).observe(document.body)
    addEventListener("resize", () => this.#schedule())
    addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.#panel.hidden) {
        this.#close()
      }
    })
  }

  get version(): string | null {
    return this.#marked?.version ?? null
  }

  show(article: HTMLElement, marked: Marked | undefined): void {
    this.#article = article
    this.#marked = marked

    if (this.#open && !this.#find(this.#open.source, this.#open.id)) {
      this.#close()
    }

    this.#draw()
  }

  /** The marks read on their own rather than with a block: removed ticks and the bars of parts. */
  ownReads(): HTMLElement[] {
    return [...this.#layer.querySelectorAll<HTMLElement>(".mark-removed, [data-folio-part]")]
  }

  /** Tell whether a block or a part is not to be counted as read: its earlier text is open, or its parts are. */
  holding(element: HTMLElement): boolean {
    return (
      this.#parted.has(element) ||
      (this.#open?.source === element.dataset.folioSource &&
        this.#open?.id === element.dataset.folioId &&
        this.#open?.part === element.dataset.folioPart)
    )
  }

  subjectOf(bar: HTMLElement): HTMLElement | undefined {
    return this.#subjects.get(bar)?.unit
  }

  marksRow(row: HTMLElement): boolean {
    return this.#rows.has(row)
  }

  /** Where in a changed block, as fractions of its lines, its text differs from the text read. */
  changedSpan(block: HTMLElement): [number, number] | undefined {
    const mark = this.#marked?.marks.find(
      (found) =>
        found.mark === "changed" &&
        found.source === block.dataset.folioSource &&
        found.id === block.dataset.folioId,
    )

    if (mark?.before === undefined || mark.after === undefined) {
      return undefined
    }

    return changedShare(mark.before, mark.after)
  }

  cleared(read: { source: string; id: string; part?: string }[]): void {
    if (!this.#marked) {
      return
    }

    const same = (item: { source: string; id: string }, other: { source: string; id: string }) =>
      item.source === other.source && item.id === other.id
    const whole = read.filter(({ part }) => part === undefined)
    const parts = read.flatMap(({ part, ...block }) =>
      part === undefined ? [] : [{ ...block, part }],
    )
    const gone = (item: { source: string; id: string }) => whole.some((block) => same(block, item))

    this.#marked = {
      ...this.#marked,
      marks: this.#marked.marks
        .filter((mark) => !gone(mark))
        .map((mark) => {
          const left = parts.filter((block) => same(block, mark)).map(({ part }) => part)
          return mark.parts && left.length > 0
            ? {
                ...mark,
                parts: {
                  ...mark.parts,
                  marked: mark.parts.marked.filter((shown) => !left.includes(partKey(shown))),
                  gone: mark.parts.gone.filter(({ key }) => !left.includes(`gone:${key}`)),
                },
              }
            : mark
        }),
      removed: this.#marked.removed.filter((removed) => !gone(removed)),
    }

    for (const element of [...this.#layer.children] as HTMLElement[]) {
      const { folioSource: source = "", folioId: id = "", folioPart: part } = element.dataset
      const cleared =
        part === undefined
          ? gone({ source, id })
          : parts.some((block) => same(block, { source, id }) && block.part === part)

      if (cleared) {
        this.#unmark(element)
        element.classList.add("clearing")
        setTimeout(() => element.remove(), CLEAR_MS)
      }
    }
  }

  /** Placed against the document, as the block link is, so no block element is touched. */
  place(): void {
    const left = (this.#article?.getBoundingClientRect().left ?? 0) + scrollX - GUTTER_PX

    for (const { element, target } of this.#placed) {
      const rect = target()
      element.hidden = !rect

      if (rect) {
        element.style.top = `${rect.top + scrollY}px`
        element.style.height = `${rect.height}px`
        element.style.left = `${left}px`
      }
    }

    const under = this.#panelUnder && rectOf(this.#panelUnder)
    const article = this.#article?.getBoundingClientRect()

    if (under && article && !this.#panel.hidden) {
      this.#panel.style.top = `${under.bottom + scrollY + 4}px`
      this.#panel.style.left = `${article.left + scrollX}px`
      this.#panel.style.width = `${article.width}px`
    }
  }

  #draw(): void {
    const article = this.#article
    const marked = this.#marked

    for (const bar of this.#subjects.keys()) {
      this.#unmark(bar)
    }

    this.#layer.replaceChildren()
    this.#placed = []
    this.#parted.clear()
    this.#showUpstream(marked?.upstream ?? [])

    for (const link of document.querySelectorAll<HTMLElement>(".link-changed, .link-gone")) {
      link.classList.remove("link-changed", "link-gone")
      link.title = link.dataset.folioTitle ?? ""
      delete link.dataset.folioTitle
    }

    if (!article || !marked) {
      return
    }

    for (const { source, id, url, state } of marked.links) {
      for (const block of this.#find(source, id)) {
        for (const link of block.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          if (sameAddress(link.getAttribute("href") ?? "", url)) {
            link.dataset.folioTitle ??= link.title
            link.classList.add(`link-${state}`)
            link.title =
              state === "gone"
                ? "What this link points at is gone since you read it"
                : "What this link points at changed since you read it"
          }
        }
      }
    }

    for (const mark of marked.marks) {
      for (const block of this.#find(mark.source, mark.id)) {
        if (mark.mark === "changed" && this.#drawParts(block, mark)) {
          continue
        }

        const bar = this.#bar(mark.mark, mark.source, mark.id)

        if (mark.mark === "changed") {
          bar.addEventListener("click", () =>
            this.#toggle(mark, block, "What it said when you read it", () =>
              earlier(mark.before, mark.after, mark.data),
            ),
          )
        }

        this.#placed.push({ element: bar, target: () => rectOf(block) })
      }
    }

    for (const { source, id, text, after, before } of marked.removed) {
      const next = before ? this.#find(source, before)[0] : undefined
      const previous = after ? this.#find(source, after).at(-1) : undefined
      const tick = this.#bar("removed", source, id)

      tick.dataset.folioVersion = "removed"
      tick.addEventListener("click", () =>
        this.#toggle({ source, id }, tick, "Removed since you read it", () => struck(text)),
      )
      this.#placed.push({
        element: tick,
        target: () =>
          between(previous && rectOf(previous), next && rectOf(next), article.offsetTop),
      })
    }

    this.#layer.append(...this.#placed.map(({ element }) => element))
    this.place()
  }

  /** Marks a block part by part only when the page draws as many parts as the mark counts. */
  #drawParts(block: HTMLElement, mark: Mark): boolean {
    const units =
      block.parentElement === this.#article ? unitsIn(block, this.writtenRows) : undefined
    const shown = units && partsShown(block, mark, units)

    if (!units || !shown) {
      return false
    }

    const { source, id } = mark
    const version = block.dataset.folioVersion ?? ""

    for (const part of shown) {
      const key = partKey(part)
      const bar = this.#bar(part.mark, source, id)
      const unit = part.count === 1 ? units.element(part.at) : undefined
      const cells =
        unit instanceof HTMLTableRowElement
          ? (part.changedCells ?? []).flatMap((index) => unit.cells[index] ?? [])
          : []

      bar.dataset.folioPart = key
      bar.dataset.folioVersion = version
      this.#subjects.set(bar, { unit, cells })

      for (const cell of cells) {
        cell.classList.add("cell-changed")
      }

      if (unit instanceof HTMLTableRowElement) {
        this.#rows.add(unit)
      }

      if (part.mark === "changed") {
        bar.addEventListener("click", () =>
          this.#toggle({ source, id, part: key }, bar, "What it said when you read it", () =>
            earlier(part.before, part.after, part.data),
          ),
        )
      }

      this.#placed.push({ element: bar, target: () => units.rect(part.at, part.count) })
    }

    for (const { key, text, after, before } of mark.parts?.gone ?? []) {
      const tick = this.#bar("removed", source, id)
      const part = `gone:${key}`

      tick.dataset.folioPart = part
      tick.dataset.folioVersion = version
      tick.addEventListener("click", () =>
        this.#toggle({ source, id, part }, tick, "Removed since you read it", () => struck(text)),
      )
      this.#placed.push({
        element: tick,
        target: () => {
          const above = after === undefined ? undefined : units.rect(after, 1)
          const below = before === undefined ? undefined : units.rect(before, 1)
          const top = rectOf(block)?.top

          // Between rows folded or filtered away, a tick stays hidden with them, so it is not read unseen.
          return above ||
            below ||
            (after === undefined && before === undefined && top !== undefined)
            ? between(above, below, top ?? 0)
            : undefined
        },
      })
    }

    this.#parted.add(block)
    return true
  }

  #unmark(bar: HTMLElement): void {
    const subject = this.#subjects.get(bar)

    for (const cell of subject?.cells ?? []) {
      cell.classList.remove("cell-changed")
    }

    if (subject?.unit) {
      this.#rows.delete(subject.unit)
    }

    this.#subjects.delete(bar)
  }

  #showUpstream(upstream: Upstream[]): void {
    this.#upstream.hidden = upstream.length === 0
    this.#upstream.replaceChildren()

    if (upstream.length === 0) {
      return
    }

    this.#upstream.append("Changed since you last read this page: ")

    for (const [index, { path, how, at }] of upstream.entries()) {
      const link = Object.assign(document.createElement("a"), {
        href: `/${path.split("/").map(encodeURIComponent).join("/")}`,
        textContent: path,
        title: new Date(at).toLocaleString(),
      })
      this.#upstream.append(
        index > 0 ? "; " : "",
        link,
        ` (${how === "includes" ? "included" : "embedded data"}, ${new Date(at).toLocaleString()})`,
      )
    }
  }

  #bar(mark: keyof typeof LABELS, source: string, id: string): HTMLElement {
    const bar = document.createElement(mark === "new" ? "span" : "button")

    bar.className = `read-mark mark-${mark}`
    bar.title = LABELS[mark]
    bar.setAttribute("aria-label", LABELS[mark])
    bar.dataset.folioSource = source
    bar.dataset.folioId = id

    if (bar instanceof HTMLButtonElement) {
      bar.type = "button"
    }

    return bar
  }

  #toggle(
    { source, id, part }: { source: string; id: string; part?: string },
    under: HTMLElement,
    title: string,
    body: () => Node,
  ): void {
    if (this.#open?.source === source && this.#open.id === id && this.#open.part === part) {
      this.#close()
      return
    }

    const heading = Object.assign(document.createElement("p"), {
      className: "mark-panel-title",
      textContent: title,
    })
    const close = Object.assign(document.createElement("button"), {
      className: "mark-panel-close",
      type: "button",
      textContent: "Close",
    })
    const text = Object.assign(document.createElement("pre"), { className: "mark-panel-text" })

    close.addEventListener("click", () => this.#close())
    text.append(body())
    this.#panel.replaceChildren(heading, close, text)
    this.#panel.hidden = false
    this.#open = { source, id, ...(part !== undefined && { part }) }
    this.#panelUnder = under
    this.place()
  }

  #close(): void {
    this.#open = undefined
    this.#panelUnder = undefined
    this.#panel.hidden = true
  }

  #find(source: string, id: string): HTMLElement[] {
    return [
      ...(this.#article?.querySelectorAll<HTMLElement>(
        `[data-folio-source="${CSS.escape(source)}"][data-folio-id="${CSS.escape(id)}"]`,
      ) ?? []),
    ]
  }

  #schedule(): void {
    if (!this.#scheduled) {
      this.#scheduled = true
      requestAnimationFrame(() => {
        this.#scheduled = false
        this.place()
      })
    }
  }
}

/**
 * Where a text differs from the text it replaced, as fractions of its lines: from the first line that
 * differs to the last; undefined when every line is the same.
 */
export function changedShare(read: string, now: string): [number, number] | undefined {
  const before = read.split("\n")
  const after = now.split("\n")
  let first = 0
  let last = 0

  while (first < Math.min(before.length, after.length) && before[first] === after[first]) {
    first++
  }

  while (
    last < Math.min(before.length, after.length) - first &&
    before.at(-1 - last) === after.at(-1 - last)
  ) {
    last++
  }

  if (first === after.length && first === before.length) {
    return undefined
  }

  // Lines removed from the end leave no line of the text now differing: its last line stands for them.
  const start = Math.min(first, after.length - 1)
  return [start / after.length, Math.max(start + 1, after.length - last) / after.length]
}

/**
 * The parts to mark: those the server names, and each row or item holding an embed whose data changed.
 * Undefined when the page draws another count of parts, or a changed embed outside any part.
 */
function partsShown(block: HTMLElement, mark: Mark, units: Units): Shown[] | undefined {
  const parts = mark.parts

  if (!parts || parts.drawn !== units.count) {
    return undefined
  }

  const shown: Shown[] = parts.marked.map((part) => ({ ...part }))
  const data = dataIn(block, units, mark.data ?? [])

  if (!data) {
    return undefined
  }

  for (const [at, references] of data) {
    const holding = shown.find((part) => part.at <= at && at < part.at + part.count)

    if (holding) {
      holding.data = references
    } else {
      shown.push({ at, count: 1, mark: "changed", data: references })
    }
  }

  return shown.length > 0 || parts.gone.length > 0 ? shown : undefined
}

function dataIn(
  block: HTMLElement,
  units: Units,
  data: string[],
): Map<number, string[]> | undefined {
  const found = new Map<number, string[]>()
  const placed = new Set<string>()

  for (const embed of block.querySelectorAll<HTMLElement>("[data-embed]")) {
    const references = Object.keys(embedVersions(embed))
      .map((key) => key.slice(key.indexOf("\n") + 1))
      .filter((reference) => data.includes(reference))
    const at = references.length > 0 ? units.indexOf(embed) : -1

    if (at >= 0) {
      found.set(at, [...new Set([...(found.get(at) ?? []), ...references])])

      for (const reference of references) {
        placed.add(reference)
      }
    }
  }

  return data.every((reference) => placed.has(reference)) ? found : undefined
}

/** A table's rows - header first, body as written - a list's items in order, or a code block's lines. */
function unitsIn(
  block: HTMLElement,
  writtenRows: (table: HTMLTableElement) => HTMLTableRowElement[] | undefined,
): Units | undefined {
  if (block instanceof HTMLTableElement) {
    const body = writtenRows(block) ?? [...(block.tBodies[0]?.rows ?? [])]
    return elementUnits([...(block.tHead?.rows ?? []), ...body], "tr", rectOf)
  }

  if (block instanceof HTMLUListElement || block instanceof HTMLOListElement) {
    return elementUnits([...block.querySelectorAll<HTMLElement>("li")], "li", ownRect)
  }

  const code = block.matches("pre") ? block.querySelector<HTMLElement>(":scope > code") : null
  return code ? lineUnits(code) : undefined
}

function elementUnits(
  elements: HTMLElement[],
  selector: string,
  rect: (element: HTMLElement) => DOMRect | undefined,
): Units {
  return {
    count: elements.length,
    element: (at) => elements[at],
    indexOf: (node) => elements.indexOf(node.closest<HTMLElement>(selector) as HTMLElement),
    rect: (at, count) => union(elements.slice(at, at + count).map(rect)),
  }
}

/** A list item's own lines: a nested list below them is its own items'. */
function ownRect(item: HTMLElement): DOMRect | undefined {
  const whole = rectOf(item)
  const nested = item.querySelector(":scope > ul, :scope > ol")

  if (!whole || !nested) {
    return whole
  }

  const range = document.createRange()
  range.setStart(item, 0)
  range.setEndBefore(nested)
  const own = range.getBoundingClientRect()

  return own.height > 0 ? own : whole
}

/** A run of lines is measured with its line breaks, so an empty line has a height too. */
function lineUnits(code: HTMLElement): Units {
  const text = code.textContent ?? ""
  const starts = [0, ...[...text.matchAll(/\n/g)].map((found) => found.index + 1)]
  const count = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length
  const nodes: Text[] = []
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
  }

  const point = (offset: number): [Node, number] => {
    let left = offset

    for (const node of nodes) {
      if (left <= node.length) {
        return [node, left]
      }

      left -= node.length
    }

    return [code, code.childNodes.length]
  }

  return {
    count,
    element: () => undefined,
    indexOf: () => -1,
    rect: (at, lines) => {
      if (!rectOf(code) || at >= count) {
        return undefined
      }

      const range = document.createRange()
      range.setStart(...point(starts[at]))
      range.setEnd(...point(starts[at + lines] ?? text.length))
      return range.getBoundingClientRect()
    },
  }
}

function union(rects: (DOMRect | undefined)[]): DOMRect | undefined {
  const shown = rects.filter((rect) => rect !== undefined)

  if (shown.length === 0) {
    return undefined
  }

  const top = Math.min(...shown.map((rect) => rect.top))
  const bottom = Math.max(...shown.map((rect) => rect.bottom))
  const left = Math.min(...shown.map((rect) => rect.left))
  const right = Math.max(...shown.map((rect) => rect.right))

  return new DOMRect(left, top, right - left, bottom - top)
}

function between(above: DOMRect | undefined, below: DOMRect | undefined, top: number): DOMRect {
  return new DOMRect(0, above ? above.bottom + 2 : below ? below.top - 6 : top, 0, 4)
}

function earlier(
  before: string | undefined,
  after: string | undefined,
  data: string[] | undefined,
): Node {
  const shown = document.createDocumentFragment()

  if (before !== undefined) {
    shown.append(drawDiff(before, after ?? ""))
  }

  if (data) {
    shown.append(
      Object.assign(document.createElement("span"), {
        className: "mark-data",
        textContent: `${before === undefined ? "" : "\n\n"}Its data changed since you read it: ${data.join(", ")}`,
      }),
    )
  }

  return shown
}

function struck(text: string): Node {
  return Object.assign(document.createElement("del"), { textContent: text })
}

function partKey(part: { at: number; count: number }): string {
  return Array.from({ length: part.count }, (_, k) => part.at + k).join(",")
}

function rectOf(element: Element): DOMRect | undefined {
  return element.getClientRects().length > 0 ? element.getBoundingClientRect() : undefined
}

/** The page writes an address as the sanitizer leaves it, which may escape what the source wrote. */
function sameAddress(drawn: string, written: string): boolean {
  try {
    return drawn === written || decodeURI(drawn) === decodeURI(written)
  } catch {
    return false
  }
}
