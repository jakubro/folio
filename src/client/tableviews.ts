/** Tables sorted, filtered, narrowed and folded in the view, leaving the file as written. */

import { button, ICONS } from "./icons.ts"
import { follow, pinHeaders } from "./pins.ts"
import { fitWhole } from "./words.ts"

/** A table's view: its rows as written, the rows it shows in order - folded ones too - and its hidden columns. */
export interface Viewed {
  written: HTMLTableRowElement[]
  rows: HTMLTableRowElement[]
  hidden: number[]
}

/** How one table is shown; columns are named by their header, or `#<n>` without one. */
export interface View {
  sort: Level[]
  filters: Badge[]
  joins: Join[]
  hidden: string[]
  expanded: boolean
}

export const CATEGORIES = 12
const FOLD_OVER = 100
const FOLDED_ROWS = 50
const MARGIN_PX = 4
const PANEL_GAP_PX = 6
const LIST_GAP_PX = 2
const BELOW_EDGE_PX = 1
const NOTE = ['"in quotes" = whole cell', "* any text", "? one character", "| or", "\\ escapes"]
const ESCAPED = '"\\*?|'
const TABLES =
  ".markdown-body table:not(.frontmatter, .history-compare-table, [data-follows] table)"
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const COUNTS = new Intl.NumberFormat("en")
const NUMBER = /^([-+]?)[$\u20ac\u00a3\u00a5]?((?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?)%?$/i
const SEPARATOR = /[\s,_]/
const GROUPED = /^([-+]?[$\u20ac\u00a3\u00a5]?)(\d{1,3}(?:([\s,_])\d{3})(?:\3\d{3})*)(\.\d+)?(%?)$/

/**
 * Read a cell as a number when it is written as one: signs, `%`, currency and thousands set apart by
 * commas, spaces or underscores, each group of three digits; `3 4` or `1,5` is text.
 */
export function numberOf(text: string): number | undefined {
  const signed = text
    .trim()
    .replace(/^\u2212/, "-")
    .replace(/^([-+]?)\s*([$\u20ac\u00a3\u00a5]?)\s*/, "$1$2")
  const trimmed = signed.endsWith("%") ? `${signed.slice(0, -1).trimEnd()}%` : signed
  const grouped = SEPARATOR.test(trimmed) ? GROUPED.exec(trimmed) : undefined

  if (grouped === null) {
    return undefined
  }

  const plain = grouped
    ? `${grouped[1]}${grouped[2].replace(/[\s,_]/g, "")}${grouped[4] ?? ""}${grouped[5]}`
    : trimmed
  const match = NUMBER.exec(plain)

  return match ? Number(match[1] + match[2]) : undefined
}

/** Order two cells: numbers by value and before text, text as people read it, blanks always last. */
export function compareCells(a: string, b: string, descending = false): number {
  const [left, right] = [a.trim(), b.trim()]

  if (!left || !right) {
    return Number(!left) - Number(!right)
  }

  const [x, y] = [numberOf(left), numberOf(right)]
  const order =
    x !== undefined && y !== undefined
      ? x - y
      : x !== undefined
        ? -1
        : y !== undefined
          ? 1
          : COLLATOR.compare(left, right)

  return descending ? -order : order
}

export interface Wanted {
  pieces: (string | { wild: "*" | "?" })[]
  whole: boolean
}

/**
 * What a filter keeps, value by value. A backslash makes the next `"`, `\`, `*`, `?` or `|` itself, and a
 * `|` parts values, dropping the spaces around it. A value in quotes is a whole cell, as written; one
 * holding `*` or `?` a pattern of the whole cell; any other is found anywhere in a cell. An unclosed
 * opening quote is left out, and quotes followed by more text, as in a piece of JSON, are characters.
 */
export function wanted(typed: string): Wanted[] {
  const values: Typed[][] = [[]]

  for (let at = 0; at < typed.length; at++) {
    const char = typed[at]
    const next = typed[at + 1]

    if (char === "\\" && next !== undefined && ESCAPED.includes(next)) {
      values[values.length - 1].push({ char: next, escaped: true })
      at++
    } else if (char === "|") {
      values.push([])
    } else {
      values[values.length - 1].push({ char, escaped: false })
    }
  }

  return values.flatMap((value) => wantedOf(values.length > 1 ? trimmed(value) : value))
}

export function inQuotes(value: string): string {
  return `"${value.replace(/["\\*?|]/g, "\\$&")}"`
}

/** Cells' values as quotes tell them apart, each in its commonest spelling, most common first. */
export function valuesIn(cells: string[]): [string, number][] {
  const found = new Map<string, Map<string, number>>()

  for (const value of cells.map((cell) => cell.trim()).filter(Boolean)) {
    const spellings = found.get(value.toLowerCase()) ?? new Map<string, number>()

    spellings.set(value, (spellings.get(value) ?? 0) + 1)
    found.set(value.toLowerCase(), spellings)
  }

  return [...found.values()]
    .map((spellings): [string, number] => [
      [...spellings].reduce((most, one) => (one[1] > most[1] ? one : most))[0],
      [...spellings.values()].reduce((sum, count) => sum + count, 0),
    ])
    .sort((a, b) => b[1] - a[1] || compareCells(a[0], b[0]))
}

/** A term's column is its place, `-1` for any shown column. */
export interface Asking {
  order?: { column: number; descending: boolean }[]
  search?: { terms: [number, string][]; joins: Join[]; hidden: number[]; literal?: boolean }
}

export type Served = (
  asking: Asking,
) => Promise<{ rows: HTMLTableRowElement[]; kept: number } | undefined>

export type Valued = (
  search: Asking["search"],
  column: number,
) => Promise<[string, number][] | undefined>

interface Serving {
  fetch: Served
  values: Valued
  asked: string
  rows: HTMLTableRowElement[]
  matching: number
  whole: number
  refresh?: () => void
  landed?: () => void
  eager: boolean
  pending?: Promise<void>
}

interface Offered {
  table: HTMLTableElement
  index: number
  field: HTMLInputElement
  pick: (written: string) => void
  values?: [string, number][]
  shown: [string, number][]
  narrowed: boolean
  active: number
}

type Matcher = (cell: string) => boolean

interface Level {
  column: string
  descending: boolean
}

/** Without a column, a badge filters any column. */
interface Badge {
  column?: string
  text: string
}

type Join = "and" | "or"

interface Term {
  at: number
  matcher: Matcher
}

interface Typed {
  char: string
  escaped: boolean
}

const SERVED = new WeakMap<HTMLTableElement, Serving>()

/** `landed` runs once the rows a sort or search asked for are in the table. */
export function serve(
  table: HTMLTableElement,
  fetch: Served,
  values: Valued,
  total: number,
  landed?: () => void,
  eager = false,
): void {
  SERVED.set(table, {
    fetch,
    values,
    asked: "{}",
    rows: [...(table.tBodies[0]?.rows ?? [])].filter((row) => !row.hasAttribute("data-follows")),
    matching: total,
    whole: total,
    landed,
    eager,
  })
}

/**
 * Rows another view of the same records asked for: a table asking for rows as written takes them.
 * Any other, or one given none, asks for its own again when next shown.
 */
export function mirror(
  table: HTMLTableElement,
  rows: HTMLTableRowElement[] | undefined,
  kept: number,
): void {
  const serving = SERVED.get(table)

  if (!serving) {
    return
  }

  if (!rows || serving.asked !== "{}") {
    serving.asked = ""
    return
  }

  serving.rows = rows
  serving.matching = kept
  table.tBodies[0]?.replaceChildren(...rows)
  serving.refresh?.()
  serving.landed?.()
}

/** Settles once every served table in an element has the rows it asked for; none when none is waiting. */
export function asking(element: Element): Promise<void> | undefined {
  const pending = [...element.querySelectorAll("table")].flatMap(
    (table) => SERVED.get(table)?.pending ?? [],
  )

  return pending.length > 0 ? Promise.all(pending).then(() => {}) : undefined
}

export function stale(table: HTMLTableElement): boolean {
  return SERVED.get(table)?.asked === ""
}

/** Rows loaded after a served table's first, in the order and with the filters it last asked for. */
export function extend(table: HTMLTableElement, rows: HTMLTableRowElement[]): void {
  const serving = SERVED.get(table)

  if (serving) {
    serving.rows.push(...rows)
    table.tBodies[0]?.append(...rows)
    serving.refresh?.()
  }
}

export class TableViews {
  /** Called when the reader changes a view, `typed` when by typing into a filter; never by restore(). */
  onChange: (typed: boolean) => void = () => {}
  marked: (row: HTMLTableRowElement) => boolean = () => false
  readonly #control: HTMLButtonElement
  readonly #panel = document.createElement("div")
  readonly #list = document.createElement("div")
  readonly #cellFilter: HTMLButtonElement
  #cell: HTMLTableCellElement | undefined
  readonly #views = new Map<string, View>()
  readonly #unplaced = new Map<string, View>()
  readonly #keys = new WeakMap<HTMLTableElement, string[]>()
  readonly #written = new WeakMap<HTMLTableElement, HTMLTableRowElement[]>()
  readonly #viewed = new WeakMap<HTMLTableElement, Viewed>()
  readonly #folds = new WeakMap<HTMLTableElement, () => void>()
  #page = ""
  #target: HTMLTableElement | undefined
  #open: HTMLTableElement | undefined
  #offered: Offered | undefined
  #offers = 0
  #editing: { table: HTMLTableElement; badge: Badge } | undefined
  #choosing: HTMLTableElement | undefined
  #dragged: { table: HTMLTableElement; at: number } | undefined
  #redrawing = false

  constructor(main: HTMLElement) {
    this.#control = button(
      ICONS.filter,
      "Sort, filter and hide columns",
      "icon-button table-control",
    )
    this.#control.hidden = true
    this.#cellFilter = button(
      ICONS.filter,
      "Filter by this value; Alt+click adds it to the column's filter",
      "icon-button table-cell-filter",
    )
    this.#cellFilter.hidden = true
    this.#panel.className = "table-panel"
    this.#panel.hidden = true
    this.#list.className = "table-values"
    this.#list.id = "table-values"
    this.#list.hidden = true
    this.#list.setAttribute("role", "listbox")
    // A press on an option keeps focus in its field, whose blur would close the list before the click.
    this.#list.addEventListener("pointerdown", (event) => event.preventDefault())
    this.#panel.addEventListener("scroll", () => this.#placeList())
    main.append(this.#control, this.#panel, this.#list, this.#cellFilter)
    main.addEventListener("pointerover", (event) => this.#over(event.target as Element))
    main.addEventListener("pointermove", (event) => this.#overCell(event.target as Element))
    main.addEventListener("pointerleave", () => {
      this.#hideControl()
      this.#overCell(main)
    })
    // Pointer only: focused, it would blur as it hides, and the blur would hide the table's control too.
    this.#cellFilter.tabIndex = -1
    this.#cellFilter.addEventListener("pointerdown", (event) => event.preventDefault())
    this.#cellFilter.addEventListener("click", (event) => this.#filterBy(event.altKey))
    document.addEventListener("scroll", () => this.#overCell(main), {
      capture: true,
      passive: true,
    })
    main.addEventListener("click", (event) => this.#clicked(event))
    main.addEventListener("keydown", (event) => this.#keyed(event))
    main.addEventListener("focusin", (event) => {
      if (!this.#panel.contains(event.target as Node)) {
        this.#over(event.target as Element)
      }
    })
    main.addEventListener("focusout", (event) => {
      const next = event.relatedTarget as Node | null

      if (!next || (next !== this.#control && !this.#target?.contains(next))) {
        this.#hideControl()
      }
    })
    this.#control.addEventListener("click", () => {
      if (this.#target) {
        this.#toggle(this.#target)
      }
    })
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node

      if (
        !this.#panel.hidden &&
        !this.#panel.contains(target) &&
        !this.#list.contains(target) &&
        target !== this.#control &&
        !stripOf(this.#open)?.contains(target)
      ) {
        this.#close()
      }

      if (this.#choosing && !stripOf(this.#choosing)?.contains(target)) {
        const table = this.#choosing
        this.#choosing = undefined
        this.#apply(table, this.#viewOf(table), false)
      }
    })
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.#panel.hidden) {
        this.#close()
      }
    })
  }

  attach(article: HTMLElement, page: string): void {
    if (page !== this.#page) {
      this.#page = page
      this.#views.clear()
      this.#unplaced.clear()
    }

    // A save draws the table anew: its panel stays open on the table drawn in its place, focus kept.
    const open = this.#open && !this.#open.isConnected ? this.#keys.get(this.#open) : undefined

    for (const [table, keys] of keyed(article)) {
      const held = this.#keys.get(table) ?? []

      if (open?.some((key) => keys.includes(key))) {
        this.#open = table
        this.#target = table
      }
      const view = [...held, ...keys].map((key) => this.#views.get(key)).find(Boolean)

      this.#keys.set(table, keys)

      for (const key of keys) {
        this.#unplaced.delete(key)
      }

      if (view) {
        Object.assign(view, fit(view, columnNames(table)))
        this.#store(keys, view)
        this.#apply(table, view)
      } else if (
        table.tBodies[0]?.rows.length > FOLD_OVER ||
        this.#written.has(table) ||
        SERVED.has(table)
      ) {
        this.#apply(table, emptyView())
      } else {
        for (const cell of headerCells(table)) {
          cell.tabIndex = 0
        }
      }
    }

    if (!this.#open?.isConnected) {
      this.#close()
    } else if (open) {
      this.#fill(this.#open)
      this.#place(this.#open)
    }

    fitWhole(article)
    pinHeaders(article)
  }

  /**
   * The view of every table that differs from the table as written, by its address key, and the views an
   * address named for tables not drawn yet, such as an embed still loading.
   */
  views(article: HTMLElement): Record<string, View> {
    const found: Record<string, View> = Object.fromEntries(this.#unplaced)

    for (const [, keys] of keyed(article)) {
      const view = this.#views.get(keys[0])

      if (view && !isPlain(view)) {
        found[addressKey(keys)] = view
      }
    }

    return found
  }

  /** Sort a table by one of its columns in a direction, as a reader's own change of its view. */
  sort(table: HTMLTableElement, column: string, descending: boolean, adding = false): void {
    const view = this.#viewOf(table)

    view.sort = !adding
      ? [{ column, descending }]
      : view.sort.some((level) => level.column === column)
        ? view.sort.map((level) => (level.column === column ? { column, descending } : level))
        : [...view.sort, { column, descending }]
    this.#changed(table)
  }

  viewed(table: HTMLTableElement): Viewed | undefined {
    return this.#viewed.get(table)
  }

  refold(article: HTMLElement): void {
    for (const table of article.querySelectorAll<HTMLTableElement>(TABLES)) {
      this.#folds.get(table)?.()
    }
  }

  /** Replace every view with those given, as an address names them; a table not named shows as written. */
  restore(article: HTMLElement, page: string, views: Record<string, View>): void {
    this.#page = page
    this.#views.clear()
    this.#unplaced.clear()

    for (const [key, view] of Object.entries(views)) {
      if (view !== null && typeof view === "object") {
        this.#views.set(key, fit(view, undefined))
        this.#unplaced.set(key, this.#views.get(key) as View)
      }
    }

    for (const [table, keys] of keyed(article)) {
      const view = keys.map((key) => this.#views.get(key)).find(Boolean)

      this.#keys.set(table, keys)

      for (const key of keys) {
        this.#unplaced.delete(key)
      }

      if (view) {
        Object.assign(view, fit(view, columnNames(table)))
        this.#store(keys, view)
      }

      this.#apply(table, view ?? emptyView())
    }

    pinHeaders(article)
  }

  #store(keys: string[], view: View): void {
    for (const key of keys) {
      this.#views.set(key, view)
    }
  }

  #viewOf(table: HTMLTableElement): View {
    const keys = this.#keys.get(table) ?? []
    const view = keys.map((key) => this.#views.get(key)).find(Boolean) ?? emptyView()

    this.#store(keys, view)
    return view
  }

  /** Typed into, the panel keeps its fields, and the strip too when typed there: no word composed is cut. */
  #changed(table: HTMLTableElement, typed = false, inStrip = false): void {
    this.#apply(table, this.#viewOf(table), !typed, inStrip)
    this.onChange(typed)
  }

  #apply(table: HTMLTableElement, view: View, refill = true, keepStrip = false): void {
    const names = columnNames(table)
    const levels = view.sort
      .map(({ column, descending }) => ({ at: names.indexOf(column), descending }))
      .filter(({ at }) => at >= 0)
    const serving = SERVED.get(table)

    // A hidden view asks once shown: views of one file's rows each asking would undo one another.
    if (serving) {
      serving.refresh = () => this.#apply(table, this.#viewOf(table))

      if (serving.eager || !table.closest("[hidden]")) {
        serving.eager = false
        this.#ask(table, serving, askingOf(view, names, levels))
      }
    }

    const followers = followersOf(table)
    const written =
      serving?.rows ??
      this.#written.get(table) ??
      [...(table.tBodies[0]?.rows ?? [])].filter((row) => !row.hasAttribute("data-follows"))
    const hidden = new Set(view.hidden.map((name) => names.indexOf(name)))
    const head = [...(table.tHead?.rows ?? [])]
    const placed = new Map([...zip(head, layoutOf(head)), ...zip(written, layoutOf(written))])

    this.#written.set(table, written)

    // A cell spanning columns spans only those still shown, so the columns after it stay in place.
    for (const row of [...head, ...written]) {
      for (const [cell, columns] of spans(placed.get(row) ?? [])) {
        const shown = columns.filter((column) => !hidden.has(column)).length
        const across = Number(cell.dataset.span ?? cell.colSpan)

        cell.hidden = shown === 0

        if (across > 1) {
          cell.dataset.span = String(across)
          cell.colSpan = Math.max(1, shown)
        }
      }
    }

    const text = (row: HTMLTableRowElement, index: number) =>
      placed.get(row)?.[index]?.textContent ?? ""
    // Rows a cell spans down filter and move together, ordered by the first of them.
    const groups = groupsOf(written, placed)
    const hits = serving
      ? written
      : keptBy(written, placed, hidden, lineOf(view, names, readsQuotes(table)))
    const matching = written.filter((row) =>
      (groups.get(row) ?? [row]).some((member) => hits.includes(member)),
    )
    const ordered =
      serving || levels.length === 0
        ? matching
        : [...new Set(matching.map((row) => groups.get(row)?.[0] ?? row))]
            .sort((a, b) =>
              levels.reduce(
                (order, { at, descending }) =>
                  order || compareCells(text(a, at), text(b, at), descending),
                0,
              ),
            )
            .flatMap((first) => groups.get(first) ?? [first])
    const shown =
      serving || view.expanded || ordered.length <= FOLD_OVER
        ? ordered
        : ordered.slice(0, FOLDED_ROWS)

    if (isPlain(view)) {
      this.#viewed.delete(table)
    } else {
      this.#viewed.set(table, {
        written,
        rows: ordered,
        hidden: [...hidden].filter((column) => column >= 0),
      })
    }
    const visible = new Set(shown)
    const body = table.tBodies[0]

    if (body && table.tBodies.length === 1) {
      const order = [...ordered, ...written.filter((row) => !matching.includes(row))].flatMap(
        (row) => [row, ...(followers.has(row) ? [followers.get(row) as HTMLTableRowElement] : [])],
      )

      for (const [index, row] of order.entries()) {
        if (body.rows[index] !== row) {
          body.insertBefore(row, body.rows[index] ?? null)
        }
      }
    }

    for (const row of written) {
      row.hidden = !visible.has(row)
      row.classList.toggle("banded", false)

      if (followers.has(row)) {
        ;(followers.get(row) as HTMLTableRowElement).hidden = row.hidden
      }
    }

    for (const [index, row] of shown.entries()) {
      row.classList.toggle("banded", index % 2 === 1)
    }

    for (const cell of headerCells(table)) {
      const level = levels.findIndex(({ at }) => at === columnOf(table, cell))

      cell.tabIndex = 0
      cell.classList.toggle("sorted", level >= 0)
      cell.classList.toggle("descending", level >= 0 && levels[level].descending)

      if (level >= 0 && levels.length > 1) {
        cell.dataset.level = String(level + 1)
      } else {
        delete cell.dataset.level
      }

      // Only one header may say how the rows are sorted: the first level's.
      if (level === 0) {
        cell.setAttribute("aria-sort", levels[0].descending ? "descending" : "ascending")
      } else {
        cell.removeAttribute("aria-sort")
      }
    }

    const plain = isPlain(view) && (serving !== undefined || written.length <= FOLD_OVER)
    table.classList.toggle("viewed", !plain)
    this.#status(
      table,
      view,
      keepStrip,
      plain
        ? undefined
        : summary(
            view,
            levels
              .map(
                ({ at, descending }) =>
                  `${columnLabels(table)[at]}${descending ? ", descending" : ""}`,
              )
              .join(", then "),
            serving?.matching ?? matching.length,
            serving?.whole ?? written.length,
          ),
    )
    const folding = () =>
      fold(
        table,
        !serving && written.length > FOLD_OVER && matching.length > FOLD_OVER,
        shown,
        matching,
        this.marked,
        () => {
          this.#viewOf(table).expanded = !this.#viewOf(table).expanded
          this.#changed(table)
        },
      )

    this.#folds.set(table, folding)
    folding()

    if (plain) {
      this.#written.delete(table)
    }

    // The open panel's table too, wherever the pointer is, so a new count line moves the panel.
    if (this.#target === table || this.#open === table) {
      this.#target = table
      this.#place(table)
    }

    if (this.#open === table && refill) {
      this.#fill(table)
    }
  }

  #status(table: HTMLTableElement, view: View, keepStrip: boolean, text: string | undefined): void {
    const caption = table.querySelector<HTMLTableCaptionElement>(":scope > caption.table-status")

    if (text === undefined) {
      caption?.remove()
      return
    }

    const shown = caption ?? document.createElement("caption")
    const count =
      shown.querySelector(":scope > .table-count") ??
      Object.assign(document.createElement("span"), { className: "table-count" })

    shown.className = "table-status"
    count.textContent = text

    if (!keepStrip || !count.isConnected) {
      const focused = document.activeElement
      const key =
        focused instanceof HTMLElement && shown.contains(focused) ? focused.dataset.key : undefined
      const caret = focused instanceof HTMLInputElement ? focused.selectionStart : null
      const strip = readsQuotes(table) && view.filters.length > 0 ? this.#strip(table, view) : []

      this.#redrawing = true
      shown.replaceChildren(count, ...[strip].flat())
      this.#redrawing = false
      const refocus = key && shown.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)

      if (refocus) {
        refocus.focus()

        if (refocus instanceof HTMLInputElement) {
          refocus.setSelectionRange(caret, caret)
        }
      }
    }

    if (table.firstElementChild !== shown) {
      table.prepend(shown)
    }
  }

  #strip(table: HTMLTableElement, view: View): HTMLElement {
    const strip = document.createElement("div")
    const names = columnNames(table)
    const labels = columnLabels(table)
    const nameOf = (column: string | undefined) =>
      column === undefined ? "Any column" : (labels[names.indexOf(column)] ?? column)

    strip.className = "table-filters"

    for (const [at, { column }] of view.filters.entries()) {
      if (at > 0) {
        const join = view.joins[at - 1]
        const word = textButton(join, "table-join", `join:${at - 1}`)

        word.title = `Join by ${join === "and" ? "or" : "and"} instead`
        word.addEventListener("click", () => {
          view.joins[at - 1] = join === "and" ? "or" : "and"
          this.#changed(table)
        })
        strip.append(word)
      }

      strip.append(this.#badge(table, view, at, nameOf(column)))
    }

    if (this.#choosing === table) {
      const choose = document.createElement("span")

      choose.className = "table-choose"
      choose.append(
        ...[undefined, ...names].map((column) => {
          const choice = textButton(nameOf(column), "table-choice", `choose:${column ?? ""}`)
          choice.addEventListener("click", () => this.#add(table, column))
          return choice
        }),
      )
      choose.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          this.#choosing = undefined
          this.#apply(table, this.#viewOf(table), false)
        }
      })
      strip.append(choose)
    } else {
      const add = textButton("+", "table-add", "add")

      add.setAttribute("aria-label", "Add a filter")
      add.title = "Add a filter"
      add.addEventListener("click", () => {
        this.#choosing = table
        this.#apply(table, this.#viewOf(table), false)
        stripOf(table)?.querySelector<HTMLElement>(".table-choice")?.focus()
      })
      strip.append(add)
    }

    this.#draggable(table, strip)
    return strip
  }

  #badge(table: HTMLTableElement, view: View, at: number, name: string): HTMLElement {
    const shown = document.createElement("span")
    const badge = view.filters[at]
    const { text } = badge
    const remove = button(ICONS.close, `Remove ${name}: ${text}`, "icon-button table-badge-remove")

    shown.className = "table-badge"
    shown.dataset.at = String(at)
    remove.dataset.key = `remove:${at}`
    remove.addEventListener("click", () => {
      const now = view.filters.indexOf(badge)

      if (now >= 0) {
        Object.assign(view, removed(view, now))
        this.#changed(table)
      }
    })

    if (this.#editing?.table === table && this.#editing.badge === badge) {
      const field = document.createElement("input")

      field.type = "text"
      field.value = text
      field.dataset.key = "editor"
      field.setAttribute("aria-label", `Filter ${name}`)
      field.addEventListener("input", () => {
        badge.text = field.value
        this.#changed(table, true, true)
      })
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          field.blur()
        }
      })
      // A press elsewhere in the strip blurs first: ending the edit after the click lets that click land.
      field.addEventListener("blur", () => {
        if (!this.#redrawing) {
          setTimeout(() => this.#edited(table, badge))
        }
      })
      shown.append(
        Object.assign(document.createElement("span"), { textContent: `${name}:` }),
        field,
      )
    } else {
      const edit = textButton("", "table-badge-edit", `edit:${at}`)

      shown.draggable = true
      edit.title = `${name}: ${text}`
      edit.append(
        Object.assign(document.createElement("span"), { textContent: `${name}: ` }),
        Object.assign(document.createElement("span"), {
          className: "table-badge-text",
          textContent: text,
        }),
      )
      edit.addEventListener("click", () => {
        this.#editing = { table, badge }
        this.#apply(table, this.#viewOf(table), false)
        this.#focusEditor(table)
      })
      shown.append(edit)
    }

    shown.append(remove)
    return shown
  }

  #add(table: HTMLTableElement, column: string | undefined): void {
    const view = this.#viewOf(table)

    this.#choosing = undefined
    this.#editing = { table, badge: appended(view, column, "") }
    this.#apply(table, view, false)
    this.#focusEditor(table)
  }

  #focusEditor(table: HTMLTableElement): void {
    const field = stripOf(table)?.querySelector<HTMLInputElement>('[data-key="editor"]')

    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  }

  #edited(table: HTMLTableElement, badge: Badge): void {
    const view = this.#viewOf(table)
    const at = view.filters.indexOf(badge)
    const editing = this.#editing?.badge === badge
    const empty = at >= 0 && !badge.text

    if (
      editing &&
      stripOf(table)?.querySelector('[data-key="editor"]') === document.activeElement
    ) {
      return
    }

    if (editing) {
      this.#editing = undefined
    }

    if (empty) {
      Object.assign(view, removed(view, at))
    }

    if (editing || empty) {
      this.#changed(table)
    }
  }

  /** A badge dragged along the line slides between the words, which stay where they are. */
  #draggable(table: HTMLTableElement, strip: HTMLElement): void {
    const badges = () => [...strip.querySelectorAll<HTMLElement>(":scope > .table-badge")]
    const target = (event: DragEvent) => {
      const at = badges().findIndex((badge) => {
        const box = badge.getBoundingClientRect()
        return (
          event.clientY < box.top ||
          (event.clientY < box.bottom && event.clientX < box.left + box.width / 2)
        )
      })
      return at < 0 ? badges().length : at
    }
    const unmark = () => {
      for (const badge of badges()) {
        badge.classList.remove("table-drop")
      }

      strip.classList.remove("table-drop-end")
    }

    strip.addEventListener("dragstart", (event) => {
      const badge = (event.target as Element).closest<HTMLElement>(".table-badge")

      if (badge && event.dataTransfer) {
        this.#dragged = { table, at: Number(badge.dataset.at) }
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", badge.textContent ?? "")
      }
    })
    strip.addEventListener("dragover", (event) => {
      if (this.#dragged?.table !== table) {
        return
      }

      const at = target(event)

      event.preventDefault()
      unmark()
      ;(badges()[at] ?? strip).classList.add(at < badges().length ? "table-drop" : "table-drop-end")
    })
    strip.addEventListener("dragleave", (event) => {
      if (!strip.contains(event.relatedTarget as Node | null)) {
        unmark()
      }
    })
    strip.addEventListener("drop", (event) => {
      if (this.#dragged?.table !== table) {
        return
      }

      const from = this.#dragged.at

      const view = this.#viewOf(table)
      const to = target(event)
      const filters = [...view.filters]
      const [moved] = filters.splice(from, 1)

      event.preventDefault()
      filters.splice(to > from ? to - 1 : to, 0, moved)
      view.filters = filters
      this.#dragged = undefined
      this.#changed(table)
    })
    strip.addEventListener("dragend", () => {
      this.#dragged = undefined
      unmark()
    })
  }

  #overCell(target: Element): void {
    if (target === this.#cellFilter || this.#cellFilter.contains(target)) {
      return
    }

    const cell = target.closest<HTMLTableCellElement>("td")
    const table = cell?.closest<HTMLTableElement>(TABLES)
    const row = cell?.parentElement

    if (
      !cell ||
      !table ||
      !readsQuotes(table) ||
      row?.parentElement !== table.tBodies[0] ||
      row.hasAttribute("data-follows")
    ) {
      this.#cell = undefined
      this.#cellFilter.hidden = true
      return
    }

    const box = cell.getBoundingClientRect()
    // A table scrolls sideways in its own box, which may cut the cell's right edge off.
    const right = Math.min(box.right, table.getBoundingClientRect().right)

    this.#cell = cell
    this.#cellFilter.hidden = false
    this.#cellFilter.style.top = `${box.top + scrollY + 1}px`
    this.#cellFilter.style.left = `${right + scrollX - this.#cellFilter.offsetWidth - 1}px`
  }

  #filterBy(adding: boolean): void {
    const cell = this.#cell
    const table = cell?.closest<HTMLTableElement>(TABLES)

    if (!cell || !table) {
      return
    }

    const view = this.#viewOf(table)
    const names = columnNames(table)
    const written =
      this.#written.get(table) ??
      [...(table.tBodies[0]?.rows ?? [])].filter((row) => !row.hasAttribute("data-follows"))
    const placed =
      layoutOf(written)[written.indexOf(cell.parentElement as HTMLTableRowElement)] ?? []
    const column = placed.findIndex(
      (standing, at) => standing === cell && !view.hidden.includes(names[at]),
    )
    const value = (cell.textContent ?? "").trim()

    if (column < 0) {
      return
    }

    setFirst(
      view,
      names[column],
      adding ? withValue(textOfFirst(view, names[column]), value) : inQuotes(value),
    )
    // The rows move under the button: it shows again on the cell the pointer next moves over.
    this.#cell = undefined
    this.#cellFilter.hidden = true
    this.#changed(table)
  }

  /** The server's rows land after the view may have moved on: only those for the view still asked show. */
  #ask(table: HTMLTableElement, serving: Serving, asking: Asking): void {
    const asked = JSON.stringify(asking)

    if (asked === serving.asked) {
      return
    }

    serving.asked = asked
    const request = serving
      .fetch(asking)
      .then((answer) => {
        if (answer && serving.asked === asked && table.isConnected) {
          serving.rows = answer.rows
          serving.matching = answer.kept
          table.tBodies[0]?.replaceChildren(...answer.rows)
          this.#apply(table, this.#viewOf(table))
          serving.landed?.()
        }
      })
      .finally(() => {
        if (serving.pending === request) {
          serving.pending = undefined
        }
      })
    serving.pending = request
  }

  #clicked(event: MouseEvent): void {
    const target = event.target as Element
    const cell = target.closest("th")
    const table = cell?.closest<HTMLTableElement>(TABLES)

    if (
      !cell ||
      !table ||
      target.closest("a, button, input") ||
      cell.parentElement?.parentElement !== table.tHead
    ) {
      return
    }

    this.#cycle(table, columnNames(table)[columnOf(table, cell)], event.altKey)
  }

  /**
   * A header sorts on Enter or Space. The control is the tab stop after a table's headers, though it sits
   * at the end of the page: Tab from it goes on from the last header, Shift+Tab goes back to it.
   */
  #keyed(event: KeyboardEvent): void {
    const target = event.target as Element

    if (target === this.#control && event.key === "Tab" && this.#target) {
      const last = lastHeader(this.#target)

      if (last) {
        if (event.shiftKey) {
          event.preventDefault()
        }

        last.focus()
      }

      return
    }

    // Tab from the panel's last field goes on after the table, as if the panel sat beside it.
    if (
      this.#open &&
      event.key === "Tab" &&
      !event.shiftKey &&
      target === focusable(this.#panel).at(-1)
    ) {
      const table = this.#open

      this.#close()
      ;(focusable(table).at(-1) ?? lastHeader(table))?.focus()
      return
    }

    const cell = target.closest("th")
    const table = cell?.closest<HTMLTableElement>(TABLES)

    if (!cell || !table || cell !== target || cell.parentElement?.parentElement !== table.tHead) {
      return
    }

    if (event.key === "Enter" || event.key === " " || event.code === "Space") {
      event.preventDefault()
      this.#cycle(table, columnNames(table)[columnOf(table, cell)], event.altKey)
    } else if (event.key === "Tab" && !event.shiftKey && cell === lastHeader(table)) {
      event.preventDefault()
      this.#control.focus()
    }
  }

  #cycle(table: HTMLTableElement, column: string, adding: boolean): void {
    const view = this.#viewOf(table)
    const at = view.sort.findIndex((level) => level.column === column)
    const stepped =
      at < 0
        ? [{ column, descending: false }]
        : view.sort[at].descending
          ? []
          : [{ column, descending: true }]

    view.sort = adding
      ? at < 0
        ? [...view.sort, ...stepped]
        : view.sort.flatMap((level, index) => (index === at ? stepped : [level]))
      : view.sort.length === 1 && at === 0
        ? stepped
        : [{ column, descending: false }]
    this.#changed(table)
  }

  #over(target: Element): void {
    if (
      target === this.#control ||
      this.#control.contains(target) ||
      this.#panel.contains(target) ||
      this.#list.contains(target)
    ) {
      return
    }

    const table = target.closest<HTMLTableElement>(TABLES)

    if (!table) {
      this.#hideControl()
      return
    }

    this.#target = table
    this.#control.hidden = false
    this.#place(table)
  }

  /** Beside the header's top right corner, clear of the cells; inside it on a full-width table. */
  #place(table: HTMLTableElement): void {
    const box = table.getBoundingClientRect()
    const header = headerEdges(table)
    // A count line wider than the columns widens the table's box past the header's corner.
    const right = Math.min(box.right, header.right)
    const width = this.#control.offsetWidth
    const room = table.parentElement?.getBoundingClientRect().right ?? right
    const left = right + width <= room ? right : Math.min(right, room) - MARGIN_PX - width

    this.#control.style.top = `${header.top + scrollY + BELOW_EDGE_PX}px`
    this.#control.style.left = `${left + scrollX}px`
    follow(this.#control, table)

    if (this.#open === table) {
      this.#placePanel()
    }
  }

  /** Placed where the control stands unmoved: the panel moves with the pinned header too. */
  #placePanel(): void {
    // Beside the table, so its rows stay in sight while they are filtered; below the control when narrow.
    const control = this.#control.getBoundingClientRect()
    const top = Number.parseFloat(this.#control.style.top)

    if (this.#open) {
      follow(this.#panel, this.#open)
    }

    const beside = control.right + PANEL_GAP_PX + this.#panel.offsetWidth <= innerWidth
    this.#panel.style.top = `${top + (beside ? 0 : control.height + PANEL_GAP_PX)}px`
    this.#panel.style.left = `${(beside ? control.right + PANEL_GAP_PX : control.right - this.#panel.offsetWidth) + scrollX}px`
    this.#placeList()
  }

  /** Outside the panel, so opening and closing it never scrolls the panel under a click. */
  #placeList(): void {
    const offer = this.#offered

    if (!offer || this.#list.hidden) {
      return
    }

    const panel = this.#panel.getBoundingClientRect()
    const field = offer.field.getBoundingClientRect()

    this.#list.style.top = `${Number.parseFloat(this.#panel.style.top) + field.bottom - panel.top + LIST_GAP_PX}px`
    this.#list.style.left = `${Number.parseFloat(this.#panel.style.left) + field.left - panel.left}px`
    this.#list.style.width = `${field.width}px`
    follow(this.#list, offer.table)
  }

  #hideControl(): void {
    const focused = document.activeElement
    const target = this.#target
    const kept =
      target?.isConnected &&
      focused?.matches(":focus-visible") &&
      (focused === this.#control || target.contains(focused))

    if (this.#panel.hidden && !kept) {
      this.#target = undefined
      this.#control.hidden = true
    }
  }

  #toggle(table: HTMLTableElement): void {
    if (this.#open === table) {
      this.#close()
      return
    }

    this.#open = table
    this.#fill(table)
    this.#panel.hidden = false
    this.#placePanel()
    // Its transform lands a frame later: scrolling to the field now would pull the page back up.
    this.#panel.querySelector("input")?.focus({ preventScroll: true })
  }

  /** Focus left in the panel goes back to the table's first header, which shows the control again. */
  #close(): void {
    const table = this.#open
    const within = this.#panel.contains(document.activeElement)

    this.#open = undefined
    this.#panel.hidden = true
    this.#withdraw()
    this.#hideControl()

    if (table && within) {
      headerCells(table)
        .find((cell) => !cell.hidden)
        ?.focus()
    }
  }

  /** Rebuilt on every change but typing; the focused field gets its caret back. */
  #fill(table: HTMLTableElement): void {
    const view = this.#viewOf(table)
    const names = columnNames(table)
    const labels = columnLabels(table)
    const focused = document.activeElement
    const focusKey =
      focused instanceof HTMLElement && this.#panel.contains(focused)
        ? focused.dataset.key
        : undefined
    const caret = focused instanceof HTMLInputElement ? focused.selectionStart : null
    // Copied first: the field losing focus as it is replaced closes the list and forgets its values.
    const offered = this.#offered && { ...this.#offered }
    const offers = new Map<string, Offered>()
    const quoted = readsQuotes(table)
    let anyBadge: Badge | undefined = view.filters[firstOf(view, undefined)]
    const all = input("Filter rows", anyBadge?.text ?? "", "all", (value) => {
      anyBadge = typedInto(view, undefined, anyBadge, value)
      this.#changed(table, true)
    })
    const any = document.createElement("div")
    const list = document.createElement("ul")

    any.className = "table-any"
    any.append(Object.assign(document.createElement("span"), { textContent: "Any column" }), all)

    for (const [index, name] of names.entries()) {
      const item = document.createElement("li")
      const shown = document.createElement("input")
      const label = document.createElement("label")
      const level = view.sort.find((sorted) => sorted.column === name)
      const sort = button(
        level ? (level.descending ? ICONS.down : ICONS.up) : ICONS.sort,
        `Sort by ${labels[index]}`,
        "icon-button table-sort",
      )

      shown.type = "checkbox"
      shown.dataset.key = `shown:${name}`
      sort.dataset.key = `sort:${name}`
      shown.checked = !view.hidden.includes(name)
      shown.addEventListener("change", () => {
        view.hidden = shown.checked
          ? view.hidden.filter((hidden) => hidden !== name)
          : [...view.hidden, name]
        this.#changed(table)
      })
      label.append(shown, document.createTextNode(labels[index]))
      sort.setAttribute("aria-pressed", String(level !== undefined))
      sort.addEventListener("click", (event) => this.#cycle(table, name, event.altKey))
      let edited: Badge | undefined = view.filters[firstOf(view, name)]
      const field = input(
        `Filter ${labels[index]}`,
        edited?.text ?? "",
        `column:${name}`,
        (value) => {
          edited = typedInto(view, name, edited, value)
          this.#changed(table, true)
        },
      )

      if (quoted) {
        const pick = (written: string) => {
          setFirst(view, name, written)
          this.#changed(table)
        }
        offers.set(`column:${name}`, this.#offering({ table, index, field, pick }))
      }

      item.append(label, sort, field)
      list.append(item)
    }

    const reset = document.createElement("button")
    reset.type = "button"
    reset.className = "table-reset"
    reset.dataset.key = "reset"
    reset.textContent = "Show as written"
    reset.addEventListener("click", () => {
      Object.assign(view, emptyView())
      this.#changed(table)
    })
    this.#panel.replaceChildren(...(quoted ? [note()] : []), any, list, reset)

    const refocus =
      focusKey && this.#panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)

    if (refocus) {
      refocus.focus()

      if (refocus instanceof HTMLInputElement && refocus.type === "text") {
        refocus.setSelectionRange(caret, caret)
      }
    }

    const reoffered = offered && offers.get(offered.field.dataset.key ?? "")

    if (offered && reoffered && document.activeElement === reoffered.field) {
      this.#offered = reoffered

      // A save draws a new table, whose values the old list may no longer count.
      if (reoffered.table === offered.table) {
        Object.assign(reoffered, { values: offered.values, narrowed: offered.narrowed })
        reoffered.active = offered.active
        this.#show()
      } else {
        void this.#offer(reoffered, offered.narrowed)
      }
    } else {
      this.#withdraw()
    }
  }

  #offering(offer: Omit<Offered, "shown" | "narrowed" | "active">): Offered {
    const offered: Offered = { ...offer, shown: [], narrowed: false, active: -1 }
    const { field } = offered

    field.setAttribute("role", "combobox")
    field.setAttribute("aria-autocomplete", "list")
    field.setAttribute("aria-controls", this.#list.id)
    field.setAttribute("aria-expanded", "false")
    field.addEventListener("click", () => void this.#offer(offered, false))
    field.addEventListener("input", () => void this.#offer(offered, true))
    field.addEventListener("keydown", (event) => this.#choose(offered, event))
    field.addEventListener("blur", () => {
      if (this.#offered === offered) {
        this.#withdraw()
      }
    })
    return offered
  }

  async #offer(offer: Offered, narrowed: boolean): Promise<void> {
    offer.narrowed = narrowed
    offer.active = -1
    this.#offered = offer

    if (!offer.values) {
      const asked = ++this.#offers
      const values = await this.#valuesOf(offer.table, offer.index)
      const current = this.#offered

      if (asked !== this.#offers || current?.field.dataset.key !== offer.field.dataset.key) {
        return
      }

      current.values = values ?? []
    }

    this.#show()
  }

  #show(): void {
    const offer = this.#offered

    if (!offer?.values) {
      return
    }

    const { field, values } = offer
    const matching = offer.narrowed && field.value ? matcherOf(field.value, true) : () => true

    offer.shown = values.length > CATEGORIES ? [] : values.filter(([value]) => matching(value))
    offer.active = Math.min(offer.active, offer.shown.length - 1)
    this.#list.replaceChildren(
      ...offer.shown.map(([value, count], at) => {
        const option = document.createElement("div")
        const shown = document.createElement("span")
        const counted = document.createElement("span")

        option.className = "table-value"
        option.id = `table-value-${at}`
        option.setAttribute("role", "option")
        option.setAttribute("aria-selected", String(at === offer.active))
        option.classList.toggle("active", at === offer.active)
        shown.textContent = value
        counted.textContent = COUNTS.format(count)
        option.append(shown, counted)
        option.addEventListener("click", (event) => this.#pick(offer, value, event.altKey))
        return option
      }),
    )

    const open = offer.shown.length > 0

    this.#list.hidden = !open
    field.setAttribute("aria-expanded", String(open))

    if (open && offer.active >= 0) {
      field.setAttribute("aria-activedescendant", `table-value-${offer.active}`)
    } else {
      field.removeAttribute("aria-activedescendant")
    }

    this.#placeList()
  }

  /** The first Escape closes the list, leaving the second to close the panel. */
  #choose(offer: Offered, event: KeyboardEvent): void {
    const open = this.#offered === offer && !this.#list.hidden

    if (event.key === "Escape" && open) {
      event.preventDefault()
      event.stopPropagation()
      this.#withdraw()
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
      void this.#offer(offer, false)
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const count = offer.shown.length
      offer.active =
        event.key === "ArrowDown"
          ? (offer.active + 1) % count
          : (offer.active <= 0 ? count : offer.active) - 1
      this.#show()
    } else if (event.key === "Enter" && open && offer.active >= 0) {
      event.preventDefault()
      this.#pick(offer, offer.shown[offer.active][0], event.altKey)
    }
  }

  #pick(offer: Offered, value: string, adding: boolean): void {
    const written = adding ? withValue(offer.field.value.trim(), value) : inQuotes(value)

    offer.field.value = written
    offer.field.setSelectionRange(written.length, written.length)

    if (!adding) {
      this.#withdraw()
    }

    offer.pick(written)
  }

  #withdraw(): void {
    const offer = this.#offered

    this.#offered = undefined
    this.#list.hidden = true

    if (offer) {
      offer.values = undefined
      offer.field.setAttribute("aria-expanded", "false")
      offer.field.removeAttribute("aria-activedescendant")
    }
  }

  #valuesOf(table: HTMLTableElement, index: number): Promise<[string, number][] | undefined> {
    const view = this.#viewOf(table)
    const names = columnNames(table)
    const edited = firstOf(view, names[index])
    const others: View = { ...view, ...(edited < 0 ? {} : removed(view, edited)) }
    const serving = SERVED.get(table)

    if (serving) {
      return serving.values(askingOf(others, names, []).search, index)
    }

    const written =
      this.#written.get(table) ??
      [...(table.tBodies[0]?.rows ?? [])].filter((row) => !row.hasAttribute("data-follows"))
    const placed = new Map(zip(written, layoutOf(written)))
    const hidden = new Set(view.hidden.map((name) => names.indexOf(name)))
    const kept = keptBy(written, placed, hidden, lineOf(others, names, true))

    return Promise.resolve(valuesIn(kept.map((row) => placed.get(row)?.[index]?.textContent ?? "")))
  }
}

/**
 * Whatever of a view still names a column of the table, or all of it without columns to check, and is
 * well formed; the rest is dropped quietly.
 */
function fit(
  view: Partial<Omit<View, "sort">> & { sort?: unknown; filter?: unknown; columns?: unknown },
  names: string[] | undefined,
): View {
  const known = (name: unknown): name is string =>
    typeof name === "string" && (names === undefined || names.includes(name))
  // An address written before sorts had levels holds one sorted column.
  const levels: unknown[] = Array.isArray(view.sort) ? view.sort : view.sort ? [view.sort] : []
  const sort = levels.flatMap((level) => {
    const { column, descending } = (level ?? {}) as Partial<Level>
    return known(column) ? [{ column, descending: descending === true }] : []
  })
  const line = Array.isArray(view.filters)
    ? lineFitted(view.filters, view.joins, known)
    : earlier(view, known)

  return {
    sort: sort.filter(
      (level, at) => sort.findIndex(({ column }) => column === level.column) === at,
    ),
    ...line,
    hidden: Array.isArray(view.hidden) ? view.hidden.filter(known) : [],
    expanded: view.expanded === true,
  }
}

function lineFitted(
  filters: unknown[],
  joins: unknown,
  known: (name: unknown) => name is string,
): Pick<View, "filters" | "joins"> {
  let line: Pick<View, "filters" | "joins"> = {
    filters: filters.map((badge) => {
      const { column, text } = (badge ?? {}) as Partial<Badge>
      return { ...(column !== undefined && { column }), text: typeof text === "string" ? text : "" }
    }),
    joins: filters
      .slice(1)
      .map((_, at) => (Array.isArray(joins) && joins[at] === "or" ? "or" : "and")),
  }

  for (let at = line.filters.length - 1; at >= 0; at--) {
    const { column, text } = line.filters[at]

    if (!text || (column !== undefined && !known(column))) {
      line = removed(line, at)
    }
  }

  return line
}

/** An address written before badges holds Filter rows' text and one filter per column, all applying. */
function earlier(
  view: { filter?: unknown; columns?: unknown },
  known: (name: unknown) => name is string,
): Pick<View, "filters" | "joins"> {
  const columns =
    view.columns !== null && typeof view.columns === "object" ? Object.entries(view.columns) : []
  const filters = [
    ...(typeof view.filter === "string" && view.filter ? [{ text: view.filter }] : []),
    ...columns.flatMap(([column, text]) =>
      known(column) && typeof text === "string" && text ? [{ column, text }] : [],
    ),
  ]

  return { filters, joins: filters.slice(1).map(() => "and") }
}

function askingOf(
  view: View,
  names: string[],
  levels: { at: number; descending: boolean }[],
): Asking {
  const { filters, joins } = shownLine(view)

  return {
    ...(levels.length > 0 && {
      order: levels.map(({ at, descending }) => ({ column: at, descending })),
    }),
    ...(filters.length > 0 && {
      search: {
        terms: filters.map(({ column, text }): [number, string] => [
          column === undefined ? -1 : names.indexOf(column),
          text,
        ]),
        joins,
        hidden: view.hidden.map((name) => names.indexOf(name)).filter((index) => index >= 0),
      },
    }),
  }
}

function isPlain(view: View): boolean {
  return (
    view.sort.length === 0 &&
    view.filters.length === 0 &&
    view.hidden.length === 0 &&
    !view.expanded
  )
}

function emptyView(): View {
  return { sort: [], filters: [], joins: [], hidden: [], expanded: false }
}

function firstOf(view: Pick<View, "filters">, column: string | undefined): number {
  return view.filters.findIndex((badge) => badge.column === column)
}

function withValue(held: string, value: string): string {
  const one = inQuotes(value)
  const same = (wanting: Wanted) => JSON.stringify(wanting).toLowerCase()
  const picked = same(wanted(one)[0])

  return !held
    ? one
    : wanted(held).some((each) => same(each) === picked)
      ? held
      : `${held} | ${one}`
}

function textOfFirst(view: View, column: string | undefined): string {
  return view.filters[firstOf(view, column)]?.text ?? ""
}

/** A line without one of its badges: the word before it goes with it, or the one after for the first. */
function removed<T extends Pick<View, "filters" | "joins">>(line: T, at: number): T {
  return {
    ...line,
    filters: line.filters.filter((_, index) => index !== at),
    joins: line.joins.filter((_, index) => index !== Math.max(0, at - 1)),
  }
}

function shownLine(view: Pick<View, "filters" | "joins">): Pick<View, "filters" | "joins"> {
  let line = { filters: view.filters, joins: view.joins }

  for (let at = line.filters.length - 1; at >= 0; at--) {
    if (!line.filters[at].text) {
      line = removed(line, at)
    }
  }

  return line
}

function setFirst(view: View, column: string | undefined, text: string): void {
  typedInto(view, column, view.filters[firstOf(view, column)], text)
}

/** Set a badge's text, or add it anew once gone, so an emptied field never takes over its column's next badge. */
function typedInto(
  view: View,
  column: string | undefined,
  badge: Badge | undefined,
  text: string,
): Badge | undefined {
  const at = badge ? view.filters.indexOf(badge) : -1

  if (at >= 0 && !text) {
    Object.assign(view, removed(view, at))
    return undefined
  }

  if (badge && at >= 0) {
    badge.text = text
    return badge
  }

  return text ? appended(view, column, text) : undefined
}

function appended(view: View, column: string | undefined, text: string): Badge {
  const badge = { ...(column !== undefined && { column }), text }

  view.filters = [...view.filters, badge]
  view.joins = [...view.joins, ...(view.filters.length > 1 ? ["and" as const] : [])]
  return badge
}

/**
 * A table is known by its block, and while its block's id is still parsing by its file, columns and
 * place among its file's tables of the same columns, so an edit to it or elsewhere keeps its view.
 */
function keyed(article: HTMLElement): [HTMLTableElement, string[]][] {
  const shapes = new Map<string, number>()
  const places = new Map<string, number>()

  return [
    ...article.querySelectorAll<HTMLTableElement>(
      "table:not(.frontmatter, .history-compare-table, [data-follows] table)",
    ),
  ].map((table) => {
    const block = table.closest("[data-folio-source]")
    const source = block?.getAttribute("data-folio-source") ?? ""
    const id = block?.getAttribute("data-folio-id")
    const shape = `${source}~${columnNames(table).join("|")}`
    const seen = shapes.get(shape) ?? 0
    const within = block ? [...block.querySelectorAll("table")].indexOf(table) : 0

    const place = places.get(source) ?? 0

    shapes.set(shape, seen + 1)
    places.set(source, place + 1)
    return [
      table,
      [
        ...(id ? [`${source}#^${id}${block === table ? "" : `/${within}`}`] : []),
        `${shape}~${seen}`,
        `${source}~@${place}`,
      ],
    ]
  })
}

/** A row marked `data-follows` belongs to the row above it, which it follows wherever that row moves. */
function followersOf(table: HTMLTableElement): Map<HTMLTableRowElement, HTMLTableRowElement> {
  const found = new Map<HTMLTableRowElement, HTMLTableRowElement>()
  let owner: HTMLTableRowElement | undefined

  for (const row of table.tBodies[0]?.rows ?? []) {
    if (!row.hasAttribute("data-follows")) {
      owner = row
    } else if (owner) {
      found.set(owner, row)
    }
  }

  return found
}

/** An address names a table by its block when it has one, else by its place, which survives new columns. */
function addressKey(keys: string[]): string {
  return keys.length === 3 ? keys[0] : keys[1]
}

function columnLabels(table: HTMLTableElement): string[] {
  const header = headerRow(table).map((cell) => headerText(cell))
  const width = Math.max(
    header.length,
    ...layoutOf([...(table.tBodies[0]?.rows ?? [])]).map((row) => row.length),
  )

  return Array.from({ length: width }, (_, index) => header[index] || `Column ${index + 1}`)
}

/** Columns named by their header text while it tells them apart, by position otherwise. */
function columnNames(table: HTMLTableElement): string[] {
  const labels = columnLabels(table)
  const header = headerRow(table).map((cell) => headerText(cell))
  const unique = header.length === labels.length && new Set(header).size === header.length

  return labels.map((label, index) => (unique && header[index] ? label : `#${index + 1}`))
}

/** Groups joined by or of badges joined by and: and binds first. */
function lineOf(view: View, names: string[], quoted: boolean): Term[][] {
  const { filters, joins } = shownLine(view)
  const groups: Term[][] = []

  for (const [at, { column, text }] of filters.entries()) {
    if (at === 0 || joins[at - 1] === "or") {
      groups.push([])
    }

    groups[groups.length - 1].push({
      at: column === undefined ? -1 : names.indexOf(column),
      matcher: matcherOf(text, quoted),
    })
  }

  return groups
}

function keptBy(
  rows: HTMLTableRowElement[],
  placed: Map<HTMLTableRowElement, HTMLTableCellElement[]>,
  hidden: Set<number>,
  groups: Term[][],
): HTMLTableRowElement[] {
  const keeps = (row: HTMLTableRowElement, { at, matcher }: Term) =>
    at < 0
      ? [...spans(placed.get(row) ?? [])].some(
          ([cell, columns]) =>
            !columns.every((column) => hidden.has(column)) && matcher(cell.textContent ?? ""),
        )
      : matcher(placed.get(row)?.[at]?.textContent ?? "")

  return groups.length === 0
    ? rows
    : rows.filter((row) => groups.some((group) => group.every((term) => keeps(row, term))))
}

export function matcherOf(typed: string, quoted: boolean): Matcher {
  const tests = (quoted ? wanted(typed) : [{ pieces: [typed], whole: false }]).map(testOf)

  return tests.length === 0 ? () => true : (cell) => tests.some((test) => test(cell))
}

function testOf({ pieces, whole }: Wanted): Matcher {
  if (!whole) {
    const lower = String(pieces[0]).toLowerCase()
    return (cell) => cell.toLowerCase().includes(lower)
  }

  const pattern = new RegExp(
    `^${pieces
      .map((piece) =>
        typeof piece === "string"
          ? piece.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
          : piece.wild === "*"
            ? ".*"
            : ".",
      )
      .join("")}$`,
    "su",
  )

  return (cell) => pattern.test(cell.trim().toLowerCase())
}

function wantedOf(value: Typed[]): Wanted[] {
  const shown = trimmed(value)
  const quote = (typed: Typed | undefined) => typed?.char === '"' && !typed.escaped
  const closing = shown.findIndex((typed, at) => at > 0 && quote(typed))

  if (quote(shown[0]) && closing === shown.length - 1) {
    return [{ pieces: [textOf(trimmed(shown.slice(1, -1)))], whole: true }]
  }

  const kept = quote(shown[0]) && closing < 0 ? value.filter((typed) => typed !== shown[0]) : value

  if (
    kept === value &&
    kept.some(({ char, escaped }) => !escaped && (char === "*" || char === "?"))
  ) {
    return [{ pieces: piecesOf(shown), whole: true }]
  }

  return textOf(kept) ? [{ pieces: [textOf(kept)], whole: false }] : []
}

function piecesOf(value: Typed[]): Wanted["pieces"] {
  const pieces: Wanted["pieces"] = []

  for (const { char, escaped } of value) {
    const last = pieces.length - 1

    if (!escaped && (char === "*" || char === "?")) {
      pieces.push({ wild: char })
    } else if (typeof pieces[last] === "string") {
      pieces[last] += char
    } else {
      pieces.push(char)
    }
  }

  return pieces
}

function trimmed(value: Typed[]): Typed[] {
  const solid = (typed: Typed) => !/\s/.test(typed.char)
  const first = value.findIndex(solid)

  return first < 0 ? [] : value.slice(first, value.findLastIndex(solid) + 1)
}

function textOf(value: Typed[]): string {
  return value.map(({ char }) => char).join("")
}

// A list of records holds each whole record in one cell, which no quoted text equals.
function readsQuotes(table: HTMLTableElement): boolean {
  return !table.classList.contains("data-list")
}

// Read from the rows, which never move: a pinned header's own box carries its pinning transform.
// A collapsed border lies half outside the rows' boxes, so the right edge takes that half in.
function headerEdges(table: HTMLTableElement): { top: number; right: number } {
  const head = table.tHead?.getBoundingClientRect()
  const body = table.tBodies[0]?.getBoundingClientRect()
  const rows = head ?? body
  const cells = [...((table.tHead ?? table.tBodies[0])?.rows[0]?.cells ?? [])]
  const last = cells.filter((cell) => !cell.hidden).at(-1)

  if (!rows) {
    return table.getBoundingClientRect()
  }

  return {
    top: head && body ? body.top - head.height : rows.top,
    right: rows.right + (last ? Number.parseFloat(getComputedStyle(last).borderRightWidth) / 2 : 0),
  }
}

function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  return [...(table.tHead?.rows[0]?.cells ?? [])]
}

function headerRow(table: HTMLTableElement): HTMLTableCellElement[] {
  const head = [...(table.tHead?.rows ?? [])]
  return head.length > 0 ? layoutOf(head)[0] : []
}

function columnOf(table: HTMLTableElement, cell: HTMLTableCellElement): number {
  const head = [...(table.tHead?.rows ?? [])]
  const row = head.indexOf(cell.parentElement as HTMLTableRowElement)
  return row < 0 ? cell.cellIndex : layoutOf(head)[row].indexOf(cell)
}

/** Each row's cells by the columns they stand in, a cell standing in every column and row it spans. */
function layoutOf(rows: HTMLTableRowElement[]): HTMLTableCellElement[][] {
  const grid: HTMLTableCellElement[][] = rows.map(() => [])

  for (const [index, row] of rows.entries()) {
    let column = 0

    for (const cell of row.cells) {
      while (grid[index][column]) {
        column++
      }

      const down = cell.rowSpan === 0 ? rows.length - index : Math.max(1, cell.rowSpan)
      const across = Math.max(1, Number(cell.dataset.span ?? cell.colSpan))

      for (let below = 0; below < down && index + below < rows.length; below++) {
        for (let beside = 0; beside < across; beside++) {
          grid[index + below][column + beside] = cell
        }
      }

      column += across
    }
  }

  return grid
}

/** Each row with the run of rows it shares a cell spanning down with, a row of its own when none. */
function groupsOf(
  rows: HTMLTableRowElement[],
  placed: Map<HTMLTableRowElement, HTMLTableCellElement[]>,
): Map<HTMLTableRowElement, HTMLTableRowElement[]> {
  const groups = new Map<HTMLTableRowElement, HTMLTableRowElement[]>()
  let group: HTMLTableRowElement[] = []

  for (const [index, row] of rows.entries()) {
    const above = rows[index - 1]
    const joined =
      above !== undefined &&
      (placed.get(row) ?? []).some(
        (cell) => cell && cell.parentElement !== row && placed.get(above)?.includes(cell),
      )
    group = joined ? group : []
    group.push(row)
    groups.set(row, group)
  }

  return groups
}

/** Each cell standing in one row of a layout, with the columns it stands in there. */
function spans(cells: HTMLTableCellElement[]): Map<HTMLTableCellElement, number[]> {
  const found = new Map<HTMLTableCellElement, number[]>()

  for (const [column, cell] of cells.entries()) {
    if (cell) {
      found.set(cell, [...(found.get(cell) ?? []), column])
    }
  }

  return found
}

function zip<A, B>(left: A[], right: B[]): [A, B][] {
  return left.map((item, index) => [item, right[index]])
}

/** The control follows the last header still shown, so it stays reachable when the last column is hidden. */
function lastHeader(table: HTMLTableElement): HTMLTableCellElement | undefined {
  return headerCells(table)
    .filter((cell) => !cell.hidden)
    .at(-1)
}

function focusable(root: Element): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      element.getClientRects().length > 0,
  )
}

function headerText(cell: HTMLTableCellElement): string {
  return (cell.textContent ?? "").trim()
}

function summary(
  view: View,
  sortedBy: string | undefined,
  matching: number,
  total: number,
): string {
  const parts = [matching === total ? `${total} rows` : `${matching} of ${total} rows`]

  if (sortedBy) {
    parts.push(`sorted by ${sortedBy}`)
  }

  if (view.hidden.length > 0) {
    parts.push(`${view.hidden.length} hidden ${view.hidden.length === 1 ? "column" : "columns"}`)
  }

  return parts.join(" · ")
}

function stripOf(table: HTMLTableElement | undefined): HTMLElement | null | undefined {
  return table?.querySelector<HTMLElement>(":scope > caption.table-status > .table-filters")
}

function textButton(text: string, className: string, key: string): HTMLButtonElement {
  const shown = Object.assign(document.createElement("button"), {
    type: "button",
    className,
    textContent: text,
  })

  shown.dataset.key = key
  return shown
}

function fold(
  table: HTMLTableElement,
  long: boolean,
  shown: HTMLTableRowElement[],
  matching: HTMLTableRowElement[],
  marked: (row: HTMLTableRowElement) => boolean,
  toggle: () => void,
): void {
  const foot = table.querySelector<HTMLTableSectionElement>(":scope > tfoot.table-fold")

  if (!long) {
    foot?.remove()
    return
  }

  const section = foot ?? table.appendChild(document.createElement("tfoot"))
  const cell = document.createElement("td")
  const control = document.createElement("button")

  section.className = "table-fold"
  cell.colSpan = Math.max(1, columnNames(table).length)
  control.type = "button"
  const hidden = matching.filter((row) => !shown.includes(row) && marked(row)).length
  control.textContent =
    shown.length < matching.length
      ? `Show all ${matching.length} rows${hidden > 0 ? `, ${hidden} marked` : ""}`
      : `Show the first ${FOLDED_ROWS} rows`
  control.addEventListener("click", toggle)
  cell.append(control)
  section.replaceChildren(document.createElement("tr"))
  section.rows[0].append(cell)
}

function input(
  label: string,
  value: string,
  key: string,
  onInput: (value: string) => void,
): HTMLInputElement {
  const field = document.createElement("input")

  field.type = "text"
  field.value = value
  field.dataset.key = key
  field.setAttribute("aria-label", label)
  field.addEventListener("input", () => onInput(field.value))
  return field
}

function note(): HTMLParagraphElement {
  const shown = document.createElement("p")

  shown.className = "table-note"
  shown.append(
    ...NOTE.flatMap((rule, at) => [
      ...(at > 0 ? [" · "] : []),
      Object.assign(document.createElement("span"), { textContent: rule }),
    ]),
  )
  return shown
}
