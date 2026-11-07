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
import { foldedUnder } from "./folds.ts"

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

interface Placed {
  element: HTMLElement
  target: () => DOMRect | undefined
  hiddenUnder: () => HTMLElement | undefined
}

const GUTTER_PX = 34
const CLEAR_MS = 600
/** Time on screen, its tab shown, a read mark gets before it goes; time away pauses the count. */
const SHOWN_MS = 5000
const TICK_MS = 100
const SHOWN = 0.5
const LABELS = {
  new: "New since you last read this page",
  changed: "Changed since you read it - show what it said",
  removed: "Removed since you read it - show what it said",
  folded: "Changed inside since you read it - unfold to see",
}

export class Marks {
  writtenRows: (table: HTMLTableElement) => HTMLTableRowElement[] | undefined = () => undefined
  readonly #layer = document.createElement("div")
  readonly #panel = document.createElement("div")
  readonly #upstream = document.createElement("p")
  #article: HTMLElement | undefined
  #marked: Marked | undefined
  #placed: Placed[] = []
  readonly #folded = new Map<HTMLElement, HTMLElement>()
  #open: { source: string; id: string; part?: string } | undefined
  #panelUnder: HTMLElement | undefined
  #scheduled = false
  /** Blocks marked part by part, which count as read only through their parts. */
  readonly #parted = new Set<HTMLElement>()
  readonly #subjects = new Map<HTMLElement, { unit?: HTMLElement; cells: Element[] }>()
  readonly #rows = new Set<HTMLElement>()
  #lingering: Pick<Marked, "marks" | "removed"> = { marks: [], removed: [] }
  readonly #readKeys = new Set<string>()
  readonly #seenMs = new Map<string, number>()
  readonly #onSince = new Map<string, number>()
  #ticking: ReturnType<typeof setInterval> | undefined

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
    document.addEventListener("folio:folds", () => this.#schedule())
    document.addEventListener("toggle", () => this.#schedule(), true)
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
    if (article !== this.#article) {
      this.#lingering = { marks: [], removed: [] }
      this.#readKeys.clear()
      this.#seenMs.clear()
      this.#onSince.clear()
    }

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

  markRead(read: { source: string; id: string; part?: string }[]): void {
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
    const partsRead = (mark: Mark) =>
      parts.filter((block) => same(block, mark)).map(({ part }) => part)

    for (const mark of this.#marked.marks) {
      const left = partsRead(mark)

      if (gone(mark)) {
        this.#lingering.marks.push(mark)
      } else if (mark.parts && left.length > 0) {
        this.#lingering.marks.push({
          ...mark,
          parts: {
            ...mark.parts,
            marked: mark.parts.marked.filter((shown) => left.includes(partKey(shown))),
            gone: mark.parts.gone.filter(({ key }) => left.includes(`gone:${key}`)),
          },
        })
      }
    }

    this.#lingering.removed.push(...this.#marked.removed.filter(gone))
    this.#marked = {
      ...this.#marked,
      marks: this.#marked.marks
        .filter((mark) => !gone(mark))
        .map((mark) => {
          const left = partsRead(mark)
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

    for (const { source, id, part } of read) {
      this.#readKeys.add(keyOf(source, id, part))
    }

    this.#tick()
  }

  /** Placed against the document, as the block link is, so no block element is touched. */
  place(): void {
    const left = (this.#article?.getBoundingClientRect().left ?? 0) + scrollX - GUTTER_PX
    const folded = new Set(this.#placed.flatMap(({ hiddenUnder }) => hiddenUnder() ?? []))

    for (const [heading, bar] of this.#folded) {
      if (!folded.has(heading)) {
        bar.remove()
        this.#folded.delete(heading)
      }
    }

    for (const heading of folded) {
      if (!this.#folded.has(heading)) {
        const bar = Object.assign(document.createElement("span"), {
          className: "read-mark mark-folded",
          title: LABELS.folded,
        })
        bar.setAttribute("aria-label", LABELS.folded)
        // Beneath every other mark, so a folded heading's own bar stays the one clicked.
        this.#layer.prepend(bar)
        this.#folded.set(heading, bar)
      }
    }

    for (const { element, target } of [
      ...this.#placed,
      ...[...this.#folded].map(([heading, element]) => ({
        element,
        target: () => rectOf(heading),
      })),
    ]) {
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
    this.#folded.clear()
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

    const marks = [...marked.marks, ...this.#stillLingering(marked).marks]
    const removed = [...marked.removed, ...this.#stillLingering(marked).removed]

    for (const mark of marks) {
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

        this.#put(
          bar,
          () => rectOf(block),
          () => foldedUnder(block),
        )
      }
    }

    for (const { source, id, text, after, before } of removed) {
      const next = before ? this.#find(source, before)[0] : undefined
      const found = after ? this.#find(source, after).at(-1) : undefined
      // The frontmatter is drawn last, so the block before a removed one in the file may sit after it.
      const previous =
        found && next && found.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_PRECEDING
          ? undefined
          : found
      const tick = this.#bar("removed", source, id)

      tick.dataset.folioVersion = "removed"
      tick.addEventListener("click", () =>
        this.#toggle({ source, id }, tick, "Removed since you read it", () => struck(text)),
      )
      this.#put(
        tick,
        () =>
          between(
            previous && !previous.contains(next ?? null) ? rectOf(previous) : undefined,
            next && rectOf(next),
            article.offsetTop,
          ),
        () => tickFolded(previous, next, before !== undefined && next === undefined),
      )
    }

    this.#layer.append(...this.#placed.map(({ element }) => element))
    this.place()
    clearInterval(this.#ticking)
    this.#ticking = this.#placed.length > 0 ? setInterval(() => this.#tick(), TICK_MS) : undefined
  }

  #stillLingering(marked: Marked): Pick<Marked, "marks" | "removed"> {
    const again = new Set([
      ...marked.marks.flatMap((mark) => [
        keyOf(mark.source, mark.id),
        ...(mark.parts?.marked ?? []).map((part) => keyOf(mark.source, mark.id, partKey(part))),
        ...(mark.parts?.gone ?? []).map(({ key }) => keyOf(mark.source, mark.id, `gone:${key}`)),
      ]),
      ...marked.removed.map(({ source, id }) => keyOf(source, id)),
    ])

    return {
      marks: this.#lingering.marks.flatMap((mark) => {
        if (!mark.parts) {
          return again.has(keyOf(mark.source, mark.id)) ? [] : [mark]
        }

        const marked = mark.parts.marked.filter(
          (part) => !again.has(keyOf(mark.source, mark.id, partKey(part))),
        )
        const gone = mark.parts.gone.filter(
          ({ key }) => !again.has(keyOf(mark.source, mark.id, `gone:${key}`)),
        )

        return marked.length + gone.length > 0
          ? [{ ...mark, parts: { ...mark.parts, marked, gone } }]
          : []
      }),
      removed: this.#lingering.removed.filter(({ source, id }) => !again.has(keyOf(source, id))),
    }
  }

  /** On screen as reading counts it: half the marked block or half the window, the tab shown. */
  #tick(): void {
    const now = performance.now()
    const shown = document.visibilityState === "visible"

    for (const { element, target } of this.#placed) {
      const key = keyOf(
        element.dataset.folioSource ?? "",
        element.dataset.folioId ?? "",
        element.dataset.folioPart,
      )
      const rect =
        element.isConnected && !element.classList.contains("clearing") ? target() : undefined
      const visible = rect ? Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0) : 0
      const on =
        shown &&
        rect !== undefined &&
        visible > 0 &&
        (visible >= rect.height * SHOWN || visible >= innerHeight * SHOWN)
      const since = this.#onSince.get(key)

      if (on && since !== undefined) {
        this.#seenMs.set(key, (this.#seenMs.get(key) ?? 0) + now - since)
      }

      if (on) {
        this.#onSince.set(key, now)
      } else {
        this.#onSince.delete(key)
      }

      if (
        this.#readKeys.has(key) &&
        (this.#seenMs.get(key) ?? 0) >= SHOWN_MS &&
        !this.holding(element) &&
        !element.classList.contains("clearing")
      ) {
        this.#fade(element, key)
      }
    }
  }

  #fade(element: HTMLElement, key: string): void {
    const cells = this.#subjects.get(element)?.cells ?? []

    for (const cell of cells) {
      cell.classList.add("cell-clearing")
    }

    element.classList.add("clearing")
    this.#readKeys.delete(key)
    this.#seenMs.delete(key)
    this.#onSince.delete(key)
    this.#forget(element)
    setTimeout(() => {
      this.#unmark(element)

      for (const cell of cells) {
        cell.classList.remove("cell-clearing")
      }

      element.remove()
      this.#placed = this.#placed.filter((placed) => placed.element !== element)
      this.#schedule()
    }, CLEAR_MS)
  }

  #forget(element: HTMLElement): void {
    const { folioSource: source = "", folioId: id = "", folioPart: part } = element.dataset
    const isIt = (item: { source: string; id: string }) => item.source === source && item.id === id

    if (part === undefined) {
      this.#lingering.marks = this.#lingering.marks.filter((mark) => !isIt(mark))
      this.#lingering.removed = this.#lingering.removed.filter((removed) => !isIt(removed))
      return
    }

    this.#lingering.marks = this.#lingering.marks.map((mark) =>
      isIt(mark) && mark.parts
        ? {
            ...mark,
            parts: {
              ...mark.parts,
              marked: mark.parts.marked.filter((shown) => partKey(shown) !== part),
              gone: mark.parts.gone.filter(({ key }) => `gone:${key}` !== part),
            },
          }
        : mark,
    )
  }

  /** Marks a block part by part only when the page draws as many parts as the mark counts. */
  #drawParts(block: HTMLElement, mark: Mark): boolean {
    const units = standsAlone(block, this.#article) ? unitsIn(block, this.writtenRows) : undefined
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

      this.#put(
        bar,
        () => units.rect(part.at, part.count),
        () => foldedUnder(block),
      )
    }

    for (const { key, text, after, before } of mark.parts?.gone ?? []) {
      const tick = this.#bar("removed", source, id)
      const part = `gone:${key}`

      tick.dataset.folioPart = part
      tick.dataset.folioVersion = version
      tick.addEventListener("click", () =>
        this.#toggle({ source, id, part }, tick, "Removed since you read it", () => struck(text)),
      )
      this.#put(
        tick,
        () => {
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
        () => foldedUnder(block),
      )
    }

    this.#parted.add(block)
    return true
  }

  /** A mark a fold hides has no place, so it is neither shown nor counted as on screen. */
  #put(
    element: HTMLElement,
    target: () => DOMRect | undefined,
    hiddenUnder: () => HTMLElement | undefined,
  ): void {
    this.#placed.push({
      element,
      hiddenUnder,
      target: () => (hiddenUnder() ? undefined : target()),
    })
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

/**
 * A block removed right after a folded heading was inside its section; one right after a `<details>`' opening was
 * inside it only when the block after it is drawn as no element of its own - the closing tag.
 */
function tickFolded(
  previous: HTMLElement | undefined,
  next: HTMLElement | undefined,
  closedAfter: boolean,
): HTMLElement | undefined {
  const opening = previous?.matches(".folded")
    ? previous
    : previous instanceof HTMLDetailsElement && closedAfter
      ? previous.open
        ? (previous.querySelector<HTMLElement>(":scope > summary .folded") ?? undefined)
        : (previous.querySelector<HTMLElement>(":scope > summary") ?? previous)
      : undefined

  return (next && foldedUnder(next)) ?? (previous && foldedUnder(previous)) ?? opening
}

/** A block drawn on its own - in the article, a folded section or a `<details>` - never in another's drawing. */
function standsAlone(block: HTMLElement, article: HTMLElement | undefined): boolean {
  for (let node = block.parentElement; node; node = node.parentElement) {
    if (node === article) {
      return true
    }

    if (!(node instanceof HTMLDetailsElement || node.classList.contains("fold"))) {
      return false
    }
  }

  return false
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

function keyOf(source: string, id: string, part?: string): string {
  return `${source}\0${id}\0${part ?? ""}`
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
