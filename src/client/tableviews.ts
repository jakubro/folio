/** Tables sorted, filtered, narrowed and folded in the view, leaving the file as written. */

import { button, ICONS } from "./icons.ts"
import { follow, pinHeaders } from "./pins.ts"

/** A table's view: its rows as written, the rows it shows in order - folded ones too - and its hidden columns. */
export interface Viewed {
  written: HTMLTableRowElement[]
  rows: HTMLTableRowElement[]
  hidden: number[]
}

/** How one table is shown; columns are named by their header, or `#<n>` without one. */
export interface View {
  sort?: { column: string; descending: boolean }
  filter: string
  columns: Record<string, string>
  hidden: string[]
  expanded: boolean
}

const FOLD_OVER = 100
const FOLDED_ROWS = 50
const MARGIN_PX = 4
const PANEL_GAP_PX = 6
const BELOW_EDGE_PX = 1
const TABLES =
  ".markdown-body table:not(.frontmatter, .history-compare-table, [data-follows] table)"
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
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

export interface Asking {
  order?: { column: number; descending: boolean }
  search?: { text: string; columns: [number, string][]; hidden: number[] }
}

export type Served = (
  asking: Asking,
) => Promise<{ rows: HTMLTableRowElement[]; kept: number } | undefined>

interface Serving {
  fetch: Served
  asked: string
  rows: HTMLTableRowElement[]
  matching: number
  whole: number
  refresh?: () => void
  landed?: () => void
  eager: boolean
}

const SERVED = new WeakMap<HTMLTableElement, Serving>()

/** `landed` runs once the rows a sort or search asked for are in the table. */
export function serve(
  table: HTMLTableElement,
  fetch: Served,
  total: number,
  landed?: () => void,
  eager = false,
): void {
  SERVED.set(table, {
    fetch,
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
  readonly #views = new Map<string, View>()
  readonly #unplaced = new Map<string, View>()
  readonly #keys = new WeakMap<HTMLTableElement, string[]>()
  readonly #written = new WeakMap<HTMLTableElement, HTMLTableRowElement[]>()
  readonly #viewed = new WeakMap<HTMLTableElement, Viewed>()
  readonly #folds = new WeakMap<HTMLTableElement, () => void>()
  #page = ""
  #target: HTMLTableElement | undefined
  #open: HTMLTableElement | undefined

  constructor(main: HTMLElement) {
    this.#control = button(
      ICONS.filter,
      "Sort, filter and hide columns",
      "icon-button table-control",
    )
    this.#control.hidden = true
    this.#panel.className = "table-panel"
    this.#panel.hidden = true
    main.append(this.#control, this.#panel)
    main.addEventListener("pointerover", (event) => this.#over(event.target as Element))
    main.addEventListener("pointerleave", () => this.#hideControl())
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

      if (!this.#panel.hidden && !this.#panel.contains(target) && target !== this.#control) {
        this.#close()
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
        const fitted = fit(view, columnNames(table))
        delete view.sort
        Object.assign(view, fitted)
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

  /** Sort a table by one of its columns as its header would, as a reader's own change of its view. */
  sort(table: HTMLTableElement, column: string, descending: boolean): void {
    this.#viewOf(table).sort = { column, descending }
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

  /** Typed into, the panel keeps its fields as they are, so a word being composed is never cut short. */
  #changed(table: HTMLTableElement, typed = false): void {
    this.#apply(table, this.#viewOf(table), !typed)
    this.onChange(typed)
  }

  #apply(table: HTMLTableElement, view: View, refill = true): void {
    const names = columnNames(table)
    const sortAt = view.sort ? names.indexOf(view.sort.column) : -1
    const serving = SERVED.get(table)

    // A hidden view asks once shown: views of one file's rows each asking would undo one another.
    if (serving) {
      serving.refresh = () => this.#apply(table, this.#viewOf(table))

      if (serving.eager || !table.closest("[hidden]")) {
        serving.eager = false
        this.#ask(table, serving, askingOf(view, names, sortAt))
      }
    }

    const followers = followersOf(table)
    const written =
      serving?.rows ??
      this.#written.get(table) ??
      [...(table.tBodies[0]?.rows ?? [])].filter((row) => !row.hasAttribute("data-follows"))
    const hidden = new Set(view.hidden.map((name) => names.indexOf(name)))
    const filters = names.map((name) => filterOf(view, name).toLowerCase())
    const filter = view.filter.toLowerCase()
    const orderAt = serving ? -1 : sortAt
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
    const hits = written.filter(
      (row) =>
        serving ||
        ((!filter ||
          [...spans(placed.get(row) ?? [])].some(
            ([cell, columns]) =>
              !columns.every((column) => hidden.has(column)) &&
              (cell.textContent ?? "").toLowerCase().includes(filter),
          )) &&
          filters.every(
            (wanted, index) => !wanted || text(row, index).toLowerCase().includes(wanted),
          )),
    )
    const matching = written.filter((row) =>
      (groups.get(row) ?? [row]).some((member) => hits.includes(member)),
    )
    const ordered =
      orderAt < 0
        ? matching
        : [...new Set(matching.map((row) => groups.get(row)?.[0] ?? row))]
            .sort((a, b) => compareCells(text(a, orderAt), text(b, orderAt), view.sort?.descending))
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
      const sorted = columnOf(table, cell) === sortAt

      cell.tabIndex = 0
      cell.classList.toggle("sorted", sorted)
      cell.classList.toggle("descending", sorted && !!view.sort?.descending)

      if (sorted) {
        cell.setAttribute("aria-sort", view.sort?.descending ? "descending" : "ascending")
      } else {
        cell.removeAttribute("aria-sort")
      }
    }

    const plain = isPlain(view) && (serving !== undefined || written.length <= FOLD_OVER)
    table.classList.toggle("viewed", !plain)
    status(
      table,
      plain
        ? undefined
        : summary(
            view,
            columnLabels(table)[sortAt],
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

    if (this.#target === table) {
      this.#place(table)
    }

    if (this.#open === table && refill) {
      this.#fill(table)
    }
  }

  /** The server's rows land after the view may have moved on: only those for the view still asked show. */
  #ask(table: HTMLTableElement, serving: Serving, asking: Asking): void {
    const asked = JSON.stringify(asking)

    if (asked === serving.asked) {
      return
    }

    serving.asked = asked
    void serving.fetch(asking).then((answer) => {
      if (answer && serving.asked === asked && table.isConnected) {
        serving.rows = answer.rows
        serving.matching = answer.kept
        table.tBodies[0]?.replaceChildren(...answer.rows)
        this.#apply(table, this.#viewOf(table))
        serving.landed?.()
      }
    })
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

    this.#cycle(table, columnNames(table)[columnOf(table, cell)])
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

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      this.#cycle(table, columnNames(table)[columnOf(table, cell)])
    } else if (event.key === "Tab" && !event.shiftKey && cell === lastHeader(table)) {
      event.preventDefault()
      this.#control.focus()
    }
  }

  #cycle(table: HTMLTableElement, column: string): void {
    const view = this.#viewOf(table)

    view.sort =
      view.sort?.column !== column
        ? { column, descending: false }
        : view.sort.descending
          ? undefined
          : { column, descending: true }
    this.#changed(table)
  }

  #over(target: Element): void {
    if (
      target === this.#control ||
      this.#control.contains(target) ||
      this.#panel.contains(target)
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

  /** Beside the table's top right corner, so it never covers a cell; inside it when the table fills the width. */
  #place(table: HTMLTableElement): void {
    const box = table.getBoundingClientRect()
    const width = this.#control.offsetWidth
    const room = table.parentElement?.getBoundingClientRect().right ?? box.right
    const left =
      box.right + width <= room ? box.right : Math.min(box.right, room) - MARGIN_PX - width

    this.#control.style.top = `${box.top + scrollY + BELOW_EDGE_PX}px`
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
    const all = input("Filter rows", view.filter, "all", (value) => {
      view.filter = value
      this.#changed(table, true)
    })
    const list = document.createElement("ul")

    for (const [index, name] of names.entries()) {
      const item = document.createElement("li")
      const shown = document.createElement("input")
      const label = document.createElement("label")
      const sort = button(
        view.sort?.column === name ? (view.sort.descending ? ICONS.down : ICONS.up) : ICONS.sort,
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
      sort.setAttribute("aria-pressed", String(view.sort?.column === name))
      sort.addEventListener("click", () => this.#cycle(table, name))
      item.append(
        label,
        sort,
        input(`Filter ${labels[index]}`, filterOf(view, name), `column:${name}`, (value) => {
          view.columns[name] = value
          this.#changed(table, true)
        }),
      )
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
    this.#panel.replaceChildren(all, list, reset)

    const refocus =
      focusKey && this.#panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)

    if (refocus) {
      refocus.focus()

      if (refocus instanceof HTMLInputElement && refocus.type === "text") {
        refocus.setSelectionRange(caret, caret)
      }
    }
  }
}

/**
 * Whatever of a view still names a column of the table, or all of it without columns to check, and is
 * well formed; the rest is dropped quietly.
 */
function fit(view: Partial<View>, names: string[] | undefined): View {
  const known = (name: unknown): name is string =>
    typeof name === "string" && (names === undefined || names.includes(name))
  const sort = view.sort
  const columns = view.columns !== null && typeof view.columns === "object" ? view.columns : {}

  return {
    ...(sort &&
      known(sort.column) && {
        sort: { column: sort.column, descending: sort.descending === true },
      }),
    filter: typeof view.filter === "string" ? view.filter : "",
    columns: Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.entries(columns).filter(([name, text]) => known(name) && typeof text === "string"),
      ),
    ),
    hidden: Array.isArray(view.hidden) ? view.hidden.filter(known) : [],
    expanded: view.expanded === true,
  }
}

function askingOf(view: View, names: string[], sortAt: number): Asking {
  const columns = names.flatMap((name, index): [number, string][] => {
    const text = filterOf(view, name)
    return text ? [[index, text]] : []
  })
  const search = view.filter || columns.length > 0

  return {
    ...(sortAt >= 0 && { order: { column: sortAt, descending: view.sort?.descending === true } }),
    ...(search && {
      search: {
        text: view.filter,
        columns,
        hidden: view.hidden.map((name) => names.indexOf(name)).filter((index) => index >= 0),
      },
    }),
  }
}

function isPlain(view: View): boolean {
  return (
    !view.sort &&
    !view.filter &&
    Object.values(view.columns).every((text) => !text) &&
    view.hidden.length === 0 &&
    !view.expanded
  )
}

function emptyView(): View {
  return { filter: "", columns: Object.create(null), hidden: [], expanded: false }
}

/**
 * Columns are named by their headers, and a header may read `constructor` or `__proto__`: the filters
 * live in an object with no prototype and are read only as its own entries.
 */
function filterOf(view: View, name: string): string {
  return Object.hasOwn(view.columns, name) ? view.columns[name] : ""
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

  if (view.sort && sortedBy) {
    parts.push(`sorted by ${sortedBy}${view.sort.descending ? ", descending" : ""}`)
  }

  if (view.hidden.length > 0) {
    parts.push(`${view.hidden.length} hidden ${view.hidden.length === 1 ? "column" : "columns"}`)
  }

  return parts.join(" · ")
}

function status(table: HTMLTableElement, text: string | undefined): void {
  const caption = table.querySelector<HTMLTableCaptionElement>(":scope > caption.table-status")

  if (text === undefined) {
    caption?.remove()
    return
  }

  const shown = caption ?? document.createElement("caption")
  shown.className = "table-status"
  shown.textContent = text
  table.prepend(shown)
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
  field.placeholder = label
  field.value = value
  field.dataset.key = key
  field.setAttribute("aria-label", label)
  field.addEventListener("input", () => onInput(field.value))
  return field
}
