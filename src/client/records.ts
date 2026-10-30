/** Records drawn to be read: tables wherever they sit, nested values inline, a row opened into its record. */

import type { Grid } from "../server/data.ts"

export type Row = Record<string, unknown>

export interface Collection {
  keyed: boolean
  entries: [string, Row][]
  names: string[]
  total: number
  types?: string[]
  /** Every record, where the page holds them all and counts and filters them itself. */
  all?: [string, Row][]
}

const RECORDS_AT_MOST = 5000

const MIXED = 0.5
const NESTED_TYPE = /^(STRUCT|MAP|UNION)\b|\]$|^JSON$/
const TOKEN_CHARS = 40
const PROSE_CHARS = 22
const DEPTH = 4
const RECORDS = new WeakMap<HTMLTableRowElement, Row>()
const FITTED = new WeakMap<Element, ResizeObserver>()

export function fromGrid(grid: Grid): Collection {
  const names = grid.columns.map(({ name }) => name)
  const types = grid.columns.map(({ type }) => type)

  return {
    keyed: false,
    entries: grid.rows.map((cells, index) => [
      String(index),
      Object.fromEntries(names.map((name, at) => [name, parsed(cells[at], types[at])])),
    ]),
    names,
    total: grid.total ?? grid.rows.length,
    types,
  }
}

/** A list of records, or a map of mostly plain records sharing most fields; a map of sections is none. */
export function collectionOf(value: unknown): Collection | undefined {
  if (Array.isArray(value)) {
    const all = value.map((row, index) => [String(index), row] as [string, Row])
    return value.length > 0 && value.every(isRow)
      ? {
          keyed: false,
          entries: all.slice(0, RECORDS_AT_MOST),
          names: namesOf(value),
          total: value.length,
          all,
        }
      : undefined
  }

  if (!isRow(value)) {
    return undefined
  }

  const items = Object.entries(value)

  if (items.length < 2 || !items.every(([, item]) => isRow(item) && mostlyPlain(item))) {
    return undefined
  }

  const rows = items.map(([, item]) => item as Row)
  const names = namesOf(rows)
  const fields = rows.reduce((sum, row) => sum + Object.keys(row).length, 0) / rows.length

  return names.length >= 2 * fields
    ? undefined
    : {
        keyed: true,
        entries: items.slice(0, RECORDS_AT_MOST) as [string, Row][],
        names,
        total: items.length,
        all: items as [string, Row][],
      }
}

export function kept(found: Collection, test: (row: Row) => boolean): Collection {
  const all = (found.all ?? found.entries).filter(([, row]) => test(row))
  return { ...found, entries: all.slice(0, RECORDS_AT_MOST), total: all.length, all }
}

export function mixed({ entries, names }: Collection): boolean {
  const present = entries.reduce(
    (sum, [, row]) =>
      sum + names.filter((name) => row[name] !== null && row[name] !== undefined).length,
    0,
  )
  return present < MIXED * entries.length * names.length
}

export function collectionTable(found: Collection): HTMLTableElement {
  const table = recordsTable(found.keyed ? ["", ...found.names] : found.names)

  for (const [index, cell] of [...(table.tHead?.rows[0].cells ?? [])].entries()) {
    cell.title = found.types?.[found.keyed ? index - 1 : index] ?? ""
  }

  for (const [key, row] of found.entries) {
    const line = table.tBodies[0].insertRow()

    if (found.keyed) {
      keyCell(line, key)
    }

    for (const name of found.names) {
      line.insertCell().append(cellView(row[name]))
    }

    RECORDS.set(line, row)
  }

  return table
}

/** Without `common`, as for a page holding part of its file, no field is said once for every record. */
export function recordList(found: Collection, headed = true, common = true): HTMLElement {
  const table = recordsTable(found.keyed ? ["", "record"] : ["record"])
  const same = common && found.entries.length > 1 ? alike(found) : {}

  table.classList.add("data-list")

  if (!headed) {
    table.tHead?.remove()
  }

  for (const [key, row] of found.entries) {
    const line = table.tBodies[0].insertRow()
    const cell = document.createElement("div")

    if (found.keyed) {
      keyCell(line, key)
    }

    cell.className = "data-cell data-wide"
    cell.append(
      compact(
        Object.fromEntries(Object.entries(row).filter(([name]) => !Object.hasOwn(same, name))),
        0,
      ),
    )
    line.insertCell().append(cell)
    RECORDS.set(line, row)
  }

  if (Object.keys(same).length === 0) {
    return table
  }

  const list = document.createElement("div")
  const shared = document.createElement("p")

  shared.className = "data-info data-shared"
  shared.append("Every record: ", compact(same, 0))
  list.append(shared, table)
  return list
}

function cellView(value: unknown): HTMLElement {
  const cell = document.createElement("div")

  cell.className = "data-cell"

  if (value === null || value === undefined) {
    return cell
  }

  if (typeof value !== "object") {
    const shown = String(value)
    cell.textContent = shown

    if (shown.length <= TOKEN_CHARS && !/\s/.test(shown)) {
      cell.classList.add("data-token")
    } else {
      cell.style.minWidth = `${Math.min(shown.length, PROSE_CHARS)}ch`
    }

    return cell
  }

  cell.style.minWidth = `${PROSE_CHARS}ch`
  cell.append(compact(value, 0))
  return cell
}

function parsed(value: unknown, type: string): unknown {
  if (typeof value !== "string" || !NESTED_TYPE.test(type)) {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mostlyPlain(row: Row): boolean {
  const values = Object.values(row)
  return (
    2 * values.filter((value) => value === null || typeof value !== "object").length >=
    values.length
  )
}

function namesOf(rows: Row[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))]
}

function alike({ entries, names }: Collection): Row {
  const found: Row = {}

  for (const name of names) {
    const value = entries[0][1][name]
    const written = JSON.stringify(value)

    if (
      value !== null &&
      value !== undefined &&
      entries.every(([, row]) => JSON.stringify(row[name]) === written)
    ) {
      found[name] = value
    }
  }

  return found
}

function recordsTable(header: string[]): HTMLTableElement {
  const table = document.createElement("table")
  const head = table.createTHead().insertRow()

  table.className = "data-records data-opens"
  table.createTBody()
  table.addEventListener("click", (event) => toggle(table, event))

  for (const name of header) {
    head.appendChild(document.createElement("th")).textContent = name
  }

  return table
}

function keyCell(line: HTMLTableRowElement, key: string): void {
  const cell = line.insertCell()
  cell.className = "data-key"
  cell.textContent = key
}

/** Records open in the view, each known by what it holds, plus those remembered its rows lack. */
export function opened(view: HTMLElement, remembered: Iterable<string> = []): string[] {
  const lines = linesOf(view)
  const held = new Set(lines.map((line) => JSON.stringify(RECORDS.get(line))))

  return [
    ...[...remembered].filter((record) => !held.has(record)),
    ...lines.flatMap((line) =>
      line.classList.contains("open") ? [JSON.stringify(RECORDS.get(line))] : [],
    ),
  ]
}

export function reopen(view: HTMLElement, records: Iterable<string>): void {
  const wanted = new Set(records)
  const lines = linesOf(view)
  const table = lines[0]?.closest("table")

  for (const line of lines) {
    if (
      table &&
      !line.classList.contains("open") &&
      wanted.has(JSON.stringify(RECORDS.get(line)))
    ) {
      flip(table, line)
    }
  }
}

function linesOf(view: HTMLElement): HTMLTableRowElement[] {
  const table =
    view instanceof HTMLTableElement ? view : view.querySelector<HTMLTableElement>(":scope > table")
  return [...(table?.tBodies[0]?.rows ?? [])].filter((line) => !line.hasAttribute("data-follows"))
}

function toggle(table: HTMLTableElement, event: MouseEvent): void {
  const target = event.target as Element
  const line = target.closest("tr")

  if (
    line &&
    RECORDS.has(line) &&
    line.closest("table") === table &&
    !target.closest("a, button, input, summary") &&
    document.getSelection()?.isCollapsed
  ) {
    flip(table, line)
  }
}

/** The record is as wide as the table's visible width, so a table scrolled sideways shows it in view. */
function flip(table: HTMLTableElement, line: HTMLTableRowElement): void {
  const row = RECORDS.get(line) as Row
  const next = line.nextElementSibling

  if (next?.hasAttribute("data-follows")) {
    FITTED.get(next)?.disconnect()
    next.remove()
    line.classList.remove("open")
    return
  }

  const record = document.createElement("tr")
  const cell = record.insertCell()
  const body = document.createElement("div")

  record.className = "data-record"
  record.setAttribute("data-follows", "")
  cell.colSpan = line.cells.length
  body.className = "data-record-body"
  fit(table, record, body)
  body.append(fields(row))
  cell.append(body)
  line.after(record)
  line.classList.add("open")
}

function fit(table: HTMLTableElement, record: HTMLTableRowElement, body: HTMLElement): void {
  const fitted = () => {
    body.style.width = `${Math.max(table.clientWidth - 2, 0)}px`
  }
  const sized = new ResizeObserver(fitted)

  fitted()
  sized.observe(table)
  FITTED.set(record, sized)
}

function fields(row: Row): HTMLElement {
  const list = document.createElement("dl")
  const empty: string[] = []

  list.className = "record-fields"

  for (const [name, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      empty.push(name)
      continue
    }

    list.appendChild(document.createElement("dt")).textContent = name
    list.appendChild(document.createElement("dd")).append(whole(value))
  }

  if (empty.length > 0) {
    const named = list.appendChild(document.createElement("dd"))
    named.className = "data-empty"
    named.textContent = `Empty: ${empty.join(", ")}`
  }

  return list
}

function whole(value: unknown): Node {
  if (value === null || typeof value !== "object") {
    const shown = document.createElement("span")
    shown.className = typeof value === "string" ? "data-text" : `data-${typeof value}`
    shown.textContent = String(value)
    return shown
  }

  const found = collectionOf(value)

  if (found && !found.keyed && found.entries.length === 1) {
    return fields(found.entries[0][1])
  }

  if (found) {
    return mixed(found) ? recordList(found, false) : collectionTable(found)
  }

  if (!Array.isArray(value)) {
    return fields(value as Row)
  }

  if (value.every((item) => item === null || typeof item !== "object")) {
    return document.createTextNode(value.map(String).join(", "))
  }

  const list = document.createElement("ol")
  list.className = "data-items"
  list.start = 0

  for (const item of value) {
    list.appendChild(document.createElement("li")).append(whole(item))
  }

  return list
}

function compact(value: unknown, depth: number): Node {
  if (value === null || typeof value !== "object") {
    const shown = document.createElement("span")
    shown.className =
      typeof value === "string" ? "" : `data-${value === null ? "null" : typeof value}`
    shown.textContent = String(value)
    return shown
  }

  const list = Array.isArray(value)
  const items: [string | undefined, unknown][] = list
    ? value.map((item) => [undefined, item])
    : Object.entries(value).filter(([, item]) => item !== null && item !== undefined)
  const mark = (text: string) => {
    const shown = document.createElement("span")
    shown.className = "data-k"
    shown.textContent = text
    return shown
  }

  if (depth >= DEPTH) {
    return mark(list ? `[${items.length}]` : `{${items.length}}`)
  }

  const fragment = document.createDocumentFragment()

  if (list && depth === 0 && items.length !== 1) {
    const count = document.createElement("span")
    count.className = "data-count"
    count.textContent = String(items.length)
    fragment.append(count)
  }

  if (depth > 0) {
    fragment.append(mark(list ? "[" : "{"))
  }

  for (const [index, [key, item]] of items.entries()) {
    const pair = document.createElement("span")
    pair.className = key === undefined ? "data-item" : "data-pair"

    if (key !== undefined) {
      pair.append(mark(key), " ")
    }

    pair.append(compact(item, item !== null && typeof item === "object" ? depth + 1 : depth))

    if (list && index < items.length - 1) {
      pair.append(mark(","))
    }

    fragment.append(pair, " ")
  }

  if (depth > 0) {
    fragment.append(mark(list ? "]" : "}"))
  }

  return fragment
}
