/** How a data page's fields are spread: strips under a table's headers, the side panel of fields, and filters. */

import type { ColumnStats, DataStats, Filter } from "../server/data.ts"
import { copyButton } from "./copy.ts"

export interface Profile {
  kind: ColumnStats["kind"]
  total: number
  filled: number
  distinct: number
  top: [string, number][]
  bins?: Bin[]
  low?: string
  high?: string
  lengths?: [number, number]
}

interface Bin {
  from: number
  to: number
  count: number
  label: string
  one?: boolean
}

export interface Picked {
  filter: Filter
  label: string
}

type OnPick = (picked: Picked | undefined) => void

const BINS = 20
const TOP = 8
const STRIP_TOP = 3
const CATEGORIES = 12
const COMPARED_GROUPS = 8
const DATE_TEXT =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const NUMBER = new Intl.NumberFormat("en")
const COMPACT_FORMAT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
})
const SMALL_FORMAT = new Intl.NumberFormat("en", { maximumSignificantDigits: 2 })
const SVG = "http://www.w3.org/2000/svg"
const DAY_MS = 86_400_000

export function profilesOf(stats: DataStats): Map<string, Profile> {
  return new Map(stats.columns.map((column) => [column.name, fromStats(column, stats.total)]))
}

export function profilesIn(names: string[], rows: Record<string, unknown>[]): Map<string, Profile> {
  return new Map(names.map((name) => [name, profile(rows.map((row) => row[name]))]))
}

export function keeps(filter: Filter, value: unknown): boolean {
  if (value === null || value === undefined) {
    return false
  }

  if ("eq" in filter) {
    return keyOf(value) === filter.eq
  }

  const n = typeof value === "string" && DATE_TEXT.test(value) ? timeOf(value) : Number(value)
  return n >= filter.from && (filter.last ? n <= filter.to : n < filter.to)
}

/** Every name quoted: the browser has no list of the engine's keywords, and a column named `at` fails bare. */
export function conditionOf(filter: Filter, kind: Profile["kind"] | undefined): string {
  const named = `"${filter.field.replaceAll('"', '""')}"`

  if ("eq" in filter) {
    return kind === "boolean"
      ? `${named} = ${filter.eq}`
      : `${named} = '${filter.eq.replaceAll("'", "''")}'`
  }

  const end = (n: number) =>
    kind === "date"
      ? `timestamp '${new Date(n).toISOString().replace("T", " ").replace("Z", "")}'`
      : String(n)
  return `${named} >= ${end(filter.from)} and ${named} ${filter.last ? "<=" : "<"} ${end(filter.to)}`
}

export function strips(
  table: HTMLTableElement,
  names: string[],
  keyed: boolean,
  profiles: Map<string, Profile> | undefined,
  pick?: OnPick,
  failed?: string,
): void {
  const head = table.tHead as HTMLTableSectionElement
  const row = head.querySelector<HTMLTableRowElement>(":scope > tr.data-stats") ?? head.insertRow()

  row.className = "data-stats"
  row.replaceChildren()

  if (keyed) {
    row.append(document.createElement("td"))
  }

  for (const name of names) {
    const cell = row.insertCell()
    const found = profiles?.get(name)
    const shown = found
      ? spreadOf(name, found, 96, 22, pick)
      : note(failed === undefined ? "counting..." : "cannot count")

    shown.title ||= failed ?? ""
    cell.append(shown)
  }
}

export function hideEmpty(
  rows: Iterable<HTMLTableRowElement>,
  names: string[],
  keyed: boolean,
  profiles: Map<string, Profile>,
): void {
  const empty = [
    ...(keyed ? [false] : []),
    ...names.map((name) => profiles.get(name)?.filled === 0),
  ]

  for (const row of rows) {
    if (!row.hasAttribute("data-follows")) {
      for (const [index, cell] of [...row.cells].entries()) {
        cell.classList.toggle("data-gone", empty[index] === true)
      }
    }
  }
}

export class FieldsPanel {
  readonly element = document.createElement("div")
  onPick: OnPick = () => {}
  onSort: (field: string, descending: boolean) => void = () => {}
  onCompare: ((field: string) => void) | undefined
  readonly #names: string[]
  readonly #query: string | undefined
  readonly #open = new Set<string>()
  #profiles: Map<string, Profile> | undefined
  #total: number | undefined
  #picked: Picked | undefined
  #where: string | undefined
  #failed: string | undefined

  /** Without `query` the panel shows none: a query of a map of records returns other rows. */
  constructor(names: string[], query?: string) {
    this.#names = names
    this.#query = query
    this.element.className = "data-panel"
    this.#draw()
  }

  update(
    profiles: Map<string, Profile> | undefined,
    total: number | undefined,
    picked: Picked | undefined,
    where?: string,
    failed?: string,
  ): void {
    this.#profiles = profiles
    this.#total = total
    this.#picked = picked
    this.#where = where
    this.#failed = failed
    this.#draw()
  }

  #draw(): void {
    const head = document.createElement("p")
    const list = document.createElement("ul")
    const shown = this.#names.filter((name) => this.#profiles?.get(name)?.filled !== 0)
    const empty = this.#names.filter((name) => this.#profiles?.get(name)?.filled === 0)

    head.className = "data-panel-head"
    head.textContent =
      this.#failed !== undefined
        ? `${this.#names.length} fields · cannot count`
        : this.#total === undefined
          ? `${this.#names.length} fields · counting...`
          : `${NUMBER.format(this.#total)} ${this.#total === 1 ? "record" : "records"} · ${shown.length} fields`
    list.className = "data-fields"
    list.append(...shown.map((name) => this.#field(name)))
    this.element.replaceChildren(head, list)

    if (this.#failed !== undefined) {
      head.after(
        Object.assign(document.createElement("p"), {
          className: "data-panel-error",
          textContent: this.#failed,
        }),
      )
    }

    if (this.#picked) {
      const chip = document.createElement("p")
      chip.className = "data-panel-filter"
      chip.append(this.#picked.label, " ", clear(this.onPick))
      head.after(chip)
    }

    if (empty.length > 0) {
      const fold = document.createElement("details")
      const title = document.createElement("summary")
      fold.className = "data-panel-empties"
      title.textContent = `${empty.length} ${empty.length === 1 ? "field" : "fields"} empty in every record counted`
      fold.append(title, empty.join(", "))
      this.element.append(fold)
    }

    if (this.#query) {
      const title = document.createElement("p")
      const pre = document.createElement("pre")
      const code = pre.appendChild(document.createElement("code"))
      const text = `select *\nfrom '${this.#query.replaceAll("'", "''")}'${this.#picked && this.#where ? `\nwhere ${this.#where}` : ""}`
      const box = document.createElement("div")

      box.className = "data-panel-query"
      title.className = "data-panel-head"
      title.textContent = "As a query"
      code.className = "language-sql"
      code.textContent = text
      pre.append(copyButton(() => text, "Copy the query", "code-copy"))
      box.append(title, pre)
      this.element.append(box)
    }
  }

  #field(name: string): HTMLElement {
    const item = document.createElement("li")
    const toggle = document.createElement("button")
    const label = document.createElement("span")
    const count = document.createElement("span")
    const found = this.#profiles?.get(name)

    toggle.type = "button"
    toggle.className = "data-field"
    toggle.setAttribute("aria-expanded", String(this.#open.has(name)))
    label.className = "data-field-name"
    label.textContent = name
    count.className = "data-field-count"

    if (found?.bins && found.bins.length > 1) {
      count.append(histogram(name, found, 48, 12))
    } else if (found?.kind === "nested") {
      count.textContent = found.lengths ? `[${found.lengths[0]}..${found.lengths[1]}]` : "{}"
    } else if (found) {
      count.textContent = compact(found.distinct)
      count.title = `${NUMBER.format(found.distinct)} distinct`
    }

    toggle.append(label, count)

    if (found && found.filled < found.total) {
      toggle.append(meter(found))
    }

    toggle.addEventListener("click", () => {
      if (this.#open.delete(name)) {
        this.#draw()
        return
      }

      this.#open.add(name)
      this.#draw()
      reveal(name)
    })
    item.append(toggle)

    if (this.#open.has(name) && found) {
      const detail = document.createElement("div")
      const order = document.createElement("div")

      detail.className = "data-field-detail"
      order.className = "data-order"
      detail.append(
        note(`${found.kind} · ${NUMBER.format(found.distinct)} distinct`),
        spreadOf(name, found, 196, 40, this.onPick, TOP),
        order,
      )

      for (const descending of [false, true]) {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "data-switch"
        button.textContent = descending ? "Largest first" : "Smallest first"
        button.addEventListener("click", () => this.onSort(name, descending))
        order.append(button)
      }

      const compare = this.onCompare

      if (
        compare &&
        (found.kind === "text" || found.kind === "boolean" || found.kind === "number") &&
        found.top.length >= 2 &&
        found.distinct <= COMPARED_GROUPS
      ) {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "data-switch data-compare-by"
        button.textContent = `Compare every field by ${name}`
        button.addEventListener("click", () => compare(name))
        detail.append(button)
      }

      item.append(detail)
    }

    return item
  }
}

export function keysPanel(value: Record<string, unknown>, article: HTMLElement): HTMLElement {
  const element = document.createElement("div")
  const head = document.createElement("p")
  const list = document.createElement("ul")
  const keys = Object.keys(value)

  element.className = "data-panel"
  head.className = "data-panel-head"
  head.textContent = `${NUMBER.format(keys.length)} ${keys.length === 1 ? "key" : "keys"}`
  list.className = "data-fields"

  for (const key of keys) {
    const item = list.appendChild(document.createElement("li"))
    const link = item.appendChild(document.createElement("button"))
    const label = document.createElement("span")
    const kind = document.createElement("span")
    const entry = value[key]

    link.type = "button"
    link.className = "data-field"
    label.className = "data-field-name"
    label.textContent = key
    kind.className = "data-field-count"
    kind.textContent = Array.isArray(entry)
      ? `[${entry.length}]`
      : entry !== null && typeof entry === "object"
        ? `{${Object.keys(entry).length}}`
        : String(entry).slice(0, 24)
    link.append(label, kind)
    link.addEventListener("click", () => {
      const place = [
        ...article.querySelectorAll<HTMLElement>(":scope > .data-tree > [data-key]"),
      ].find((node) => node.dataset.key === key)

      if (place instanceof HTMLDetailsElement) {
        place.open = true
      }

      place?.scrollIntoView({ block: "start" })
    })
  }

  element.append(head, list)
  return element
}

export function filterBar(
  picked: Picked,
  kept: number | undefined,
  all: number | undefined,
  pick: OnPick,
  failed?: string,
): HTMLElement {
  const bar = document.createElement("span")
  bar.className = "data-filter"
  bar.title = failed ?? ""
  bar.append(
    failed !== undefined
      ? `${picked.label} · cannot count `
      : `${picked.label} · ${kept === undefined ? "..." : NUMBER.format(kept)} of ${all === undefined ? "..." : NUMBER.format(all)} records `,
    clear(pick),
  )
  return bar
}

function fromStats(column: ColumnStats, total: number): Profile {
  const base = {
    total,
    filled: column.filled,
    distinct: column.distinct ?? 0,
    top: column.top ?? [],
  }
  const { low, high } = column

  if (
    (column.kind === "number" || column.kind === "date") &&
    low !== undefined &&
    high !== undefined
  ) {
    const format = column.kind === "date" ? dateFormat(high - low) : compact
    const counts = column.bins ?? [column.filled]
    const width = column.whole ? 1 : (high - low) / counts.length || 1
    const span = column.unit ? Math.log1p((high - low) / column.unit) : 0
    const edge = (index: number) =>
      index >= counts.length
        ? high
        : column.unit
          ? low + column.unit * Math.expm1((index * span) / counts.length)
          : low + index * width
    const bins = counts.map((count, index) => {
      const from = column.whole ? low + index : edge(index)
      const to = column.whole ? from + 1 : edge(index + 1)
      return {
        from,
        to,
        count,
        label: column.whole ? format(from) : `${format(from)} to ${format(to)}`,
        one: column.whole === true,
      }
    })

    return { kind: column.kind, ...base, bins, low: format(low), high: format(high) }
  }

  return { kind: column.kind, ...base, ...(column.lengths && { lengths: column.lengths }) }
}

function profile(values: unknown[]): Profile {
  const present = values.filter((value) => value !== null && value !== undefined)
  const counts = new Map<string, number>()

  for (const value of present) {
    const key = keyOf(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const base = {
    total: values.length,
    filled: present.length,
    distinct: counts.size,
    top: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP),
  }

  if (present.length === 0) {
    return { kind: "empty", ...base }
  }

  if (present.every((value) => typeof value === "boolean")) {
    return { kind: "boolean", ...base }
  }

  if (present.every((value) => typeof value === "number")) {
    return { kind: "number", ...base, ...binned(present as number[], compact, true) }
  }

  if (present.every((value) => typeof value === "string" && DATE_TEXT.test(value))) {
    const times = present.map((value) => timeOf(value as string))
    const [low, high] = ends(times)
    return { kind: "date", ...base, ...binned(times, dateFormat(high - low)) }
  }

  if (present.every((value) => typeof value !== "object")) {
    return { kind: "text", ...base }
  }

  const sizes = present.filter(Array.isArray).map((value) => value.length)
  return {
    kind: "nested",
    ...base,
    ...(sizes.length === present.length && { lengths: ends(sizes) }),
  }
}

/** Binned as the server bins, long tails on a log scale, so a page counting its own reads alike. */
function binned(
  numbers: number[],
  format: (n: number) => string,
  tails = false,
): Required<Pick<Profile, "bins" | "low" | "high">> {
  const [low, high] = ends(numbers)
  const whole = numbers.every(Number.isInteger) && high - low < BINS
  const count = whole ? high - low + 1 : low === high ? 1 : BINS
  const width = whole ? 1 : (high - low) / count || 1
  const pivot = tails && !whole && count > 1 ? pivotOf(numbers, low) : undefined
  const unit = pivot !== undefined && high - pivot > 5 * (pivot - low) ? (pivot - low) / 4 : 0
  const span = unit ? Math.log1p((high - low) / unit) : 0
  const edge = (index: number) =>
    index >= count
      ? high
      : unit
        ? low + unit * Math.expm1((index * span) / count)
        : low + index * width
  const bins = Array.from({ length: count }, (_, index) => {
    const from = whole ? low + index : edge(index)
    const to = whole ? from + 1 : edge(index + 1)
    return {
      from,
      to,
      count: 0,
      label: whole ? format(from) : `${format(from)} to ${format(to)}`,
      one: whole,
    }
  })

  for (const n of numbers) {
    const at = unit ? (Math.log1p((n - low) / unit) / span) * count : (n - low) / width
    bins[Math.min(count - 1, Math.floor(at))].count++
  }

  return { bins, low: format(low), high: format(high) }
}

/** The median, or the first higher share above a mass at the least value, as the server takes them. */
function pivotOf(numbers: number[], low: number): number | undefined {
  const sorted = Float64Array.from(numbers).sort()

  for (const share of [0.5, 0.75, 0.9]) {
    const at = (sorted.length - 1) * share
    const below = Math.floor(at)
    const value =
      sorted[below] +
      (sorted[Math.min(below + 1, sorted.length - 1)] - sorted[below]) * (at - below)

    if (value > low) {
      return value
    }
  }

  return undefined
}

/** A loop, not Math.min(...numbers): spreading a page's hundred thousand values overflows the stack. */
function ends(numbers: number[]): [number, number] {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY

  for (const n of numbers) {
    low = Math.min(low, n)
    high = Math.max(high, n)
  }

  return [low, high]
}

function spreadOf(
  field: string,
  found: Profile,
  width: number,
  height: number,
  pick: OnPick | undefined,
  top = STRIP_TOP,
): HTMLElement {
  const box = document.createElement("div")

  box.className = "data-spread"

  if (found.distinct === 1 && found.kind !== "nested") {
    const value = found.top[0]?.[0] ?? found.low ?? ""
    const only = note(`all ${value}`)
    only.title = value
    box.append(only)
  } else if (found.bins && found.bins.length > 1) {
    const ends = document.createElement("div")
    ends.className = "data-ends"
    ends.append(
      Object.assign(document.createElement("span"), { textContent: found.low ?? "" }),
      Object.assign(document.createElement("span"), { textContent: found.high ?? "" }),
    )
    box.append(histogram(field, found, width, height, pick), ends)
  } else if (
    found.top.length > 0 &&
    (found.kind === "boolean" || (found.kind === "text" && found.distinct <= CATEGORIES))
  ) {
    box.append(values(field, found, top, pick, top > STRIP_TOP))
  } else if (found.kind === "text") {
    box.append(
      note(
        found.distinct === found.filled
          ? `all ${NUMBER.format(found.distinct)} distinct`
          : `${NUMBER.format(found.distinct)} distinct`,
      ),
    )

    if (top > STRIP_TOP && found.top.length > 0) {
      box.append(values(field, found, top, pick, true))
    }
  } else if (found.kind === "nested") {
    box.append(
      note(
        !found.lengths
          ? "nested"
          : found.lengths[1] === 0
            ? "empty lists"
            : `lists of ${found.lengths[0]}${found.lengths[1] > found.lengths[0] ? ` to ${found.lengths[1]}` : ""}`,
      ),
    )
  } else {
    box.append(note("empty"))
  }

  if (found.filled < found.total && found.kind !== "empty") {
    const missing = (100 * (found.total - found.filled)) / found.total
    box.append(note(`${missing < 1 ? "<1" : Math.round(missing)}% missing`))
  }

  return box
}

function histogram(
  field: string,
  found: Profile,
  width: number,
  height: number,
  pick?: OnPick,
): SVGSVGElement {
  const bins = found.bins ?? []
  const chart = document.createElementNS(SVG, "svg")
  const gap = width / bins.length > 6 ? 2 : 1
  const bar = (width - gap * (bins.length - 1)) / bins.length
  const most = Math.max(1, ...bins.map(({ count }) => count))
  const radius = Math.min(4, bar / 2)
  const base = document.createElementNS(SVG, "line")

  chart.setAttribute("class", "data-chart")
  chart.setAttribute("width", String(width))
  chart.setAttribute("height", String(height + 1))
  chart.setAttribute("viewBox", `0 0 ${width} ${height + 1}`)

  for (const [index, bin] of bins.entries()) {
    const group = document.createElementNS(SVG, "g")
    const hit = document.createElementNS(SVG, "rect")
    const title = document.createElementNS(SVG, "title")
    const x = index * (bar + gap)
    const tall = bin.count === 0 ? 0 : Math.max(1.5, (bin.count / most) * height)

    hit.setAttribute("x", String(x - gap / 2))
    hit.setAttribute("width", String(bar + gap))
    hit.setAttribute("height", String(height + 1))
    hit.setAttribute("class", "data-hit")
    title.textContent = `${NUMBER.format(bin.count)} · ${bin.label}`
    group.append(title, hit)

    if (tall > 0) {
      const mark = document.createElementNS(SVG, "path")
      const r = Math.min(radius, tall)
      const y = height - tall
      mark.setAttribute(
        "d",
        `M${x},${height}V${y + r}Q${x},${y} ${x + r},${y}H${x + bar - r}Q${x + bar},${y} ${x + bar},${y + r}V${height}Z`,
      )
      mark.setAttribute("class", "data-bar")
      group.append(mark)
    }

    if (bin.count > 0 && pick) {
      group.setAttribute("tabindex", "0")
      group.setAttribute("class", "data-pick")
      group.addEventListener("click", (event) => {
        event.stopPropagation()
        pick(binPicked(field, bin, found.kind, index === bins.length - 1))
      })
    }

    chart.append(group)
  }

  base.setAttribute("x1", "0")
  base.setAttribute("x2", String(width))
  base.setAttribute("y1", String(height + 0.5))
  base.setAttribute("y2", String(height + 0.5))
  base.setAttribute("class", "data-base")
  chart.append(base)
  return chart
}

function values(
  field: string,
  found: Profile,
  shown: number,
  pick: OnPick | undefined,
  counts: boolean,
): HTMLElement {
  const list = document.createElement("div")
  const most = Math.max(1, ...found.top.map(([, count]) => count))

  list.className = "data-top"

  for (const [key, count] of found.top.slice(0, shown)) {
    const line = document.createElement(pick ? "button" : "div")
    const label = document.createElement("span")
    const track = document.createElement("span")
    const fill = document.createElement("span")
    const share = document.createElement("span")

    line.className = "data-top-line"
    line.title = `${NUMBER.format(count)} of ${NUMBER.format(found.filled)}`
    label.className = "data-top-label"
    label.textContent = key
    track.className = "data-track"
    fill.className = "data-fill"
    fill.style.width = `${(100 * count) / most}%`
    share.className = "data-top-share"
    share.textContent = counts
      ? NUMBER.format(count)
      : `${Math.round((100 * count) / Math.max(1, found.filled))}%`
    track.append(fill)
    line.append(label, track, share)

    if (line instanceof HTMLButtonElement && pick) {
      line.type = "button"
      line.addEventListener("click", (event) => {
        event.stopPropagation()
        pick({ filter: { field, eq: key }, label: `${field} = ${key}` })
      })
    }

    list.append(line)
  }

  if (found.distinct > shown) {
    const more = document.createElement("span")
    more.className = "data-more-values"
    more.textContent = `${NUMBER.format(found.distinct - shown)} more`
    list.append(more)
  }

  return list
}

function binPicked(field: string, bin: Bin, kind: Profile["kind"], last: boolean): Picked {
  const whole = kind === "number" && bin.one === true
  return {
    filter: { field, from: bin.from, to: bin.to, ...(last && !whole && { last }) },
    label: whole ? `${field} = ${bin.label}` : `${field} ${bin.label}`,
  }
}

function meter(found: Profile): HTMLElement {
  const bar = document.createElement("span")
  const fill = document.createElement("span")

  bar.className = "data-meter"
  bar.title = `${NUMBER.format(found.filled)} of ${NUMBER.format(found.total)} filled`
  fill.style.width = `${(100 * found.filled) / Math.max(1, found.total)}%`
  bar.append(fill)
  return bar
}

function reveal(name: string): void {
  const header = [
    ...document.querySelectorAll<HTMLTableCellElement>(
      ".data-page > table.data-records:not([hidden]) > thead > tr:first-child > th",
    ),
  ].find((cell) => cell.textContent === name)

  if (header) {
    header.scrollIntoView({ inline: "center", block: "nearest" })
    header.classList.remove("data-flash")
    void header.offsetWidth
    header.classList.add("data-flash")
  }
}

function clear(pick: OnPick): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "data-switch"
  button.textContent = "Clear"
  button.addEventListener("click", () => pick(undefined))
  return button
}

function note(text: string): HTMLElement {
  const line = document.createElement("div")
  line.className = "data-stat-note"
  line.textContent = text
  return line
}

/** Zone-less times as UTC, as the engine reads them: Date.parse reads them in local time, a date in UTC. */
function timeOf(text: string): number {
  return Date.parse(
    text.length === 10 || /(?:Z|[+-]\d{2}:?\d{2})$/.test(text)
      ? text
      : `${text.replace(" ", "T")}Z`,
  )
}

function keyOf(value: unknown): string {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)
}

/** Compact from a thousand up; below one, two significant digits, so 0.0037 does not read as 0. */
function compact(n: number): string {
  return (Math.abs(n) < 1 && n !== 0 ? SMALL_FORMAT : COMPACT_FORMAT).format(n)
}

function dateFormat(span: number): (n: number) => string {
  return (n) =>
    new Date(n)
      .toISOString()
      .slice(0, span < 2 * DAY_MS ? 16 : 10)
      .replace("T", " ")
}
