/** A data file's page: its rows as a table, a nested document as a tree that folds, a database as its tables. */

import type {
  Compared,
  Comparison,
  DataPage,
  DataStats,
  DataTable,
  Filter,
  Grid,
} from "../server/data.ts"
import { comparedView, findingsOf } from "./compare.ts"
import { copyButton } from "./copy.ts"
import { panelOf } from "./outline.ts"
import {
  type Collection,
  collectionOf,
  collectionTable,
  fromGrid,
  kept,
  mixed,
  opened,
  recordList,
  reopen,
} from "./records.ts"
import {
  conditionOf,
  FieldsPanel,
  filterBar,
  hideEmpty,
  keeps,
  keysPanel,
  type Picked,
  type Profile,
  profilesIn,
  profilesOf,
  strips,
} from "./stats.ts"
import { type Asking, extend, mirror, serve, stale } from "./tableviews.ts"

const OPEN_DEPTH = 2
/** A table this short inside a document reads at a glance: its spreads would only repeat it. */
const SPREAD_ROWS = 20
/** The items of a longer list start folded, so opening the page builds one line per item. */
const CROWDED = 1000
const BATCH = 1000
const NUMBER = new Intl.NumberFormat("en")
const COMPARED_AT_LEAST = 20
const BRANCHES = new WeakMap<Element, string>()
const RESUMES = new WeakMap<HTMLElement, () => Resume>()

type Drawn = "Table" | "Records" | "Tree"
type View = Drawn | "Compare"

/** What a reader opened or folded, kept by the records it belongs to, not by place. */
interface Memory {
  records: Map<View, Set<string>>
  branches: Set<string>
  folded: Set<string>
}

export interface Resume {
  view: View
  drawn?: View[]
  compared?: { by: string; shows: boolean; view?: HTMLElement }
  loaded?: number
  size?: number
  asking?: Asking
  asker?: View
  stale?: View[]
  memory: Memory
}

type Counted =
  | { profiles: Map<string, Profile>; total: number; where?: string; error?: undefined }
  | { error: string; profiles?: undefined; total?: undefined; where?: undefined }

interface Counting {
  stats(filter?: Filter): Promise<Counted | undefined>
  query?: string
  compare?: (spec: Compared) => Promise<Comparison | undefined>
}

let statistics = true

export async function fetchData(
  urlPath: string,
  table?: string,
  filter?: Filter,
  rows?: number,
): Promise<DataPage | undefined> {
  const response = await fetch(
    `${address(urlPath)}?${asked(table, filter)}${rows ? `&rows=${rows}` : ""}`,
  )
  return response.ok ? response.json() : undefined
}

export function dataResume(article: HTMLElement): Resume | undefined {
  return RESUMES.get(article)?.()
}

export function dataArticle(
  urlPath: string,
  page: DataPage | undefined,
  picked?: Picked,
  resume?: Resume,
): HTMLElement {
  const article = document.createElement("article")
  const name = urlPath.split("/").pop() ?? urlPath

  article.className = "markdown-body data-page"
  article.append(heading("h1", page?.table ?? name))

  if (resume) {
    RESUMES.set(article, () => resume)
  }

  if (!page) {
    article.append(paragraph("Nothing to show.", "data-info"))
    return article
  }

  article.append(paragraph(about(page), "data-info"))

  if (page.table !== undefined) {
    const back = document.createElement("a")
    back.href = `/${urlPath.split("/").map(encodeURIComponent).join("/")}`
    back.textContent = `All tables of ${name}`
    article.append(paragraphOf(back, "data-info"))
  }

  if (page.format === "sql" && page.text !== undefined) {
    const query = page.text
    const pre = document.createElement("pre")
    const code = pre.appendChild(document.createElement("code"))
    code.className = "language-sql"
    code.textContent = query
    pre.append(copyButton(() => query.replace(/\r?\n$/, ""), "Copy code", "code-copy"))
    article.append(pre)
  }

  if (page.error) {
    article.append(paragraph(page.error, "data-error"))
  }

  if (page.grid) {
    const grid = page.grid
    const first = fromGrid(grid)
    const pager =
      (grid.partial || resume?.loaded !== undefined) && page.format !== "sql"
        ? new Pager(
            urlPath,
            page.table,
            picked?.filter,
            first,
            grid.total ?? grid.rows.length,
            resume?.size,
            resume?.asking,
            resume?.loaded,
          )
        : undefined
    const found = () => pager?.found ?? first
    const counting =
      page.format === "sql"
        ? undefined
        : {
            stats: (filter?: Filter) => fetchStats(urlPath, page.table, filter),
            query: `/${urlPath}${page.table === undefined ? "" : `#${page.table}`}`,
            compare: (spec: Compared) => fetchComparison(urlPath, page.table, spec),
          }

    const served = (
      label: Drawn,
      table: HTMLTableElement,
      memory: Memory,
      rowsOf: (found: Collection) => HTMLTableRowElement[],
      asked: (asking: Asking) => Asking = (asking) => asking,
    ) => {
      const reopened = () => reopen(table, memory.records.get(label) ?? [])

      reopened()

      if (pager) {
        serve(
          table,
          (asking) => {
            memory.records.set(label, new Set(opened(table, memory.records.get(label))))
            return pager.ask(asked(asking), table, rowsOf)
          },
          pager.total,
          reopened,
          label === resume?.asker,
        )

        // Drawn from rows another view asked for, it asks for its own once shown.
        if (resume?.stale?.includes(label) || !pager.plain) {
          mirror(table, undefined, pager.total)
        }
      }

      return table
    }

    article.append(
      ...views(
        first,
        {
          Table: (memory) =>
            served("Table", collectionTable(found()), memory, (rows) => [
              ...collectionTable(rows).tBodies[0].rows,
            ]),
          Records: (memory) => {
            const view = recordList(found(), true, !pager)
            const table = view instanceof HTMLTableElement ? view : tableIn(view)

            if (table) {
              served("Records", table, memory, (rows) => recordRows(rows), recordsAsking)
            }

            return view
          },
          Tree: (memory) =>
            tree(
              found().entries.map(([, row]) => row),
              0,
              undefined,
              false,
              true,
              { path: "", opened: memory.branches, folded: memory.folded },
            ),
        },
        "same",
        counting && { article, counting, picked },
        pager,
        resume,
        (getter) => RESUMES.set(article, getter),
      ),
    )
  }

  if (page.tables) {
    article.append(...databaseTables(urlPath, page.tables))
  }

  if (page.value !== undefined) {
    article.append(...nested(page.value, article, picked, `/${urlPath}`, resume))
  }

  if (page.text !== undefined && page.format !== "sql") {
    const pre = document.createElement("pre")
    pre.textContent = page.text
    article.append(pre)
  }

  return article
}

/** Rows drawn as a data page draws them, each opening its record beneath it. */
export function gridTable(grid: Grid): HTMLTableElement {
  return collectionTable(fromGrid(grid))
}

export function recordsTable(
  value: unknown,
): { table: HTMLTableElement; shown: number; total: number } | undefined {
  const found = collectionOf(value)
  return found && !found.keyed
    ? { table: collectionTable(found), shown: found.entries.length, total: found.total }
    : undefined
}

/** Each view is drawn when first shown: a page of 5,000 rows takes seconds per view drawn. */
function views(
  found: Collection,
  draw: Record<Drawn, (memory: Memory) => HTMLElement>,
  tree: "whole" | "same" = "same",
  counted?: { article: HTMLElement; counting: Counting; picked: Picked | undefined },
  pager?: Pager,
  resume?: Resume,
  keep?: (getter: () => Resume) => void,
): HTMLElement[] {
  const partial = tree === "whole" && found.entries.length < found.total
  const usual: View = partial ? "Tree" : mixed(found) ? "Records" : "Table"
  const first: View =
    resume && (resume.view in draw || (resume.view === "Compare" && resume.compared?.view))
      ? resume.view
      : usual
  const shown = new Map<View, HTMLElement>()
  const memory: Memory = resume?.memory ?? forgotten()
  let current = first
  let comparing: { by: string; shows: boolean } | undefined
  let restored: (() => void) | undefined
  const remember = () => {
    for (const [label, view] of shown) {
      if (label === "Tree") {
        Object.assign(memory, branchesOf(view, memory))
      } else if (label !== "Compare") {
        memory.records.set(label, new Set(opened(tableIn(view) ?? view, memory.records.get(label))))
      }
    }
  }
  const switcher = document.createElement("p")
  let counts: (() => void) | undefined
  const choiceOf = (label: View) => {
    const choice = document.createElement("button")
    choice.type = "button"
    choice.textContent = label
    choice.className = "data-switch"
    // Every time, as a served table another view's rows replaced asks for its own again once shown.
    choice.addEventListener("click", () => {
      choose(label)
      shown.get(label)?.dispatchEvent(new CustomEvent("folio:tables", { bubbles: true }))
    })
    return choice
  }
  const choices = (Object.keys(draw) as Drawn[]).map(choiceOf)
  const drawOnce = (label: Drawn) => {
    if (!shown.has(label)) {
      const view = partial && label !== "Tree" ? held(draw[label](memory)) : draw[label](memory)
      ;[...shown.values()].at(-1)?.after(view)
      shown.set(label, view)
    }
  }
  let choose = (label: View) => {
    current = label

    if (label !== "Compare") {
      drawOnce(label)
    }

    for (const [other, view] of shown) {
      view.hidden = other !== label
    }

    for (const choice of choices) {
      choice.setAttribute("aria-pressed", String(choice.textContent === label))
    }
  }
  const held = (view: HTMLElement) => {
    const part = document.createElement("div")
    part.append(
      paragraph(
        `The first ${NUMBER.format(found.entries.length)} of ${NUMBER.format(found.total)} records; the tree holds them all.`,
        "data-info",
      ),
      view,
    )
    return part
  }

  switcher.className = "data-info data-controls"
  switcher.append(...choices)

  if (counted) {
    const table = () => {
      const view = shown.get("Table")
      return view && (view.tagName === "TABLE" ? view : view.querySelector("table"))
    }
    const panel = new FieldsPanel(found.names, counted.counting.query)
    const keyed = found.keyed
    const pick = (next: Picked | undefined) =>
      counted.article.dispatchEvent(
        new CustomEvent("folio:filter", { bubbles: true, detail: next }),
      )
    let profiles: Map<string, Profile> | undefined
    let failed: string | undefined
    const hide = (rows: Iterable<HTMLTableRowElement>) => {
      if (counted.picked && profiles) {
        hideEmpty(rows, found.names, keyed, profiles)
      }
    }
    const recount = () => {
      const shownTable = table() as HTMLTableElement | null | undefined

      if (shownTable) {
        strips(shownTable, found.names, keyed, profiles, pick, failed)
        hide(shownTable.rows)
      }
    }

    counts = recount

    if (pager) {
      pager.dress = (rows, owner) => {
        if (owner === table()) {
          hide(rows)
        }
      }
    }

    panel.onPick = pick
    panel.onSort = (field, descending) => {
      if (!shown.has("Table")) {
        choose("Table")
        table()?.dispatchEvent(new CustomEvent("folio:tables", { bubbles: true }))
      }

      choose("Table")
      table()?.dispatchEvent(
        new CustomEvent("folio:sort", { bubbles: true, detail: { column: field, descending } }),
      )
    }
    panelOf(counted.article, panel.element)
    const statistics = statisticsSwitch(counted.article)
    const compare = counted.counting.compare
    switcher.append(statistics)

    const compared = (view: HTMLElement) => {
      const before = shown.get("Compare")

      if (before) {
        before.replaceWith(view)
      } else {
        const choice = choiceOf("Compare")
        choices.push(choice)
        statistics.before(choice)
        ;[...shown.values()].at(-1)?.after(view)
      }

      shown.set("Compare", view)
    }

    if (compare) {
      const compareBy = async (by: string, shows: boolean) => {
        comparing = { by, shows }
        const comparison = await compare({ by, filter: counted.picked?.filter })
        const view = comparison?.error
          ? paragraph(comparison.error, "data-error")
          : comparison && comparedView(comparison, by)

        if (view && switcher.isConnected && comparing.by === by) {
          comparing = { by, shows: false }
          compared(view)
          choose(shows ? "Compare" : current)
          view.dispatchEvent(new CustomEvent("folio:tables", { bubbles: true }))
        }
      }

      panel.onCompare = (by) => compareBy(by, true)

      if (resume?.compared) {
        const { by, shows, view } = resume.compared

        if (view) {
          restored = () => compared(view.cloneNode(true) as HTMLElement)
        }

        void compareBy(by, shows)
      }
    }

    if (counted.picked) {
      const bar = filterBar(counted.picked, undefined, undefined, pick)
      switcher.append(bar)
      void Promise.all([
        counted.counting.stats(counted.picked.filter),
        counted.counting.stats(),
      ]).then(async ([here, all]) => {
        const picked = counted.picked as Picked
        profiles = here?.profiles
        failed = here?.error ?? all?.error
        bar.replaceWith(filterBar(picked, here?.total, all?.total, pick, failed))
        panel.update(profiles, here?.total, picked, here?.where, failed)
        recount()

        if (
          compare &&
          here?.total !== undefined &&
          all?.total !== undefined &&
          here.total >= COMPARED_AT_LEAST &&
          all.total - here.total >= COMPARED_AT_LEAST
        ) {
          const comparison = await compare({ filter: picked.filter })

          if (comparison && !comparison.error && switcher.isConnected) {
            switcher.after(findingsOf(comparison, picked, pick))
          }
        }
      })
    } else {
      void counted.counting.stats().then((all) => {
        profiles = all?.profiles
        failed = all?.error
        panel.update(profiles, all?.total, undefined, undefined, failed)
        recount()
      })
    }

    const drawn = choose
    choose = (label: View) => {
      drawn(label)

      if (label === "Table") {
        recount()
      }
    }
  }

  // Drawn in the order the page before drew them, each table keeps the place its view is known by.
  for (const label of resume?.drawn ?? []) {
    if (label === "Compare") {
      restored?.()
    } else {
      drawOnce(label)
    }
  }

  choose(first === "Compare" && !shown.has(first) ? usual : first)
  keep?.(() => {
    remember()

    return {
      view: current,
      drawn: [...shown.keys()],
      ...(comparing && { compared: { ...comparing, view: shown.get("Compare") } }),
      ...(pager && {
        loaded: Math.max(pager.held, pager.size),
        stale: [...shown].flatMap(([label, view]) => {
          const table = label === "Compare" ? undefined : tableIn(view)
          return table && stale(table) ? [label] : []
        }),
        size: pager.size,
        ...(pager.plain
          ? pager.restoring && { asking: pager.restoring, asker: resume?.asker }
          : {
              asking: pager.asking,
              asker: [...shown].find(([, view]) => tableIn(view) === pager.askedBy)?.[0],
            }),
      }),
      memory: { ...memory, records: new Map(memory.records) },
    }
  })

  if (!pager) {
    return [switcher, ...shown.values()]
  }

  const bar = paragraph("", "data-info data-more-rows")
  const more = document.createElement("button")
  const told = () => {
    const loaded = pager.found.entries.length
    bar.hidden = loaded >= pager.total
    bar.replaceChildren(`${NUMBER.format(loaded)} of ${NUMBER.format(pager.total)} shown `, more)
    more.textContent = `Show ${NUMBER.format(Math.min(pager.size, pager.total - loaded))} more`
  }

  more.type = "button"
  more.className = "data-switch"
  more.addEventListener("click", () => {
    more.disabled = true
    void pager.more().finally(() => {
      more.disabled = false
    })
  })
  // A served table is never drawn again: the asker gets rows through its view, more via extend().
  // Another takes them when it asks for the same rows, and otherwise asks again once shown.
  pager.onChange = (added) => {
    remember()

    for (const [label, view] of [...shown]) {
      const table = tableIn(view)

      if (label === "Compare") {
        continue
      }

      if (label === "Tree") {
        if (view.hidden) {
          view.remove()
          shown.delete(label)
        } else {
          const next = draw.Tree(memory)
          view.replaceWith(next)
          shown.set(label, next)
          next.dispatchEvent(new CustomEvent("folio:tables", { bubbles: true }))
        }
      } else if (table && table === pager.askedBy) {
        if (added) {
          extend(
            table,
            label === "Records" ? recordRows(added) : [...collectionTable(added).tBodies[0].rows],
          )
          reopen(table, memory.records.get(label) ?? [])
        }
      } else if (table) {
        mirror(
          table,
          pager.plain || pager.restored
            ? label === "Records"
              ? recordRows(pager.found)
              : [...collectionTable(pager.found).tBodies[0].rows]
            : undefined,
          pager.total,
        )
      }
    }

    counts?.()
    told()
  }
  told()
  return [switcher, ...shown.values(), bar]
}

function statisticsSwitch(article: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button")

  button.type = "button"
  button.className = "data-switch"
  button.textContent = "Statistics"
  button.setAttribute("aria-pressed", String(statistics))
  article.classList.toggle("data-no-stats", !statistics)
  button.addEventListener("click", () => {
    statistics = !statistics
    button.setAttribute("aria-pressed", String(statistics))
    article.classList.toggle("data-no-stats", !statistics)
  })
  return button
}

async function fetchComparison(
  urlPath: string,
  table: string | undefined,
  spec: Compared,
): Promise<Comparison | undefined> {
  try {
    const response = await fetch(
      `${address(urlPath)}?${asked(table, undefined)}&compare=${encodeURIComponent(JSON.stringify(spec))}`,
    )
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

async function fetchStats(
  urlPath: string,
  table: string | undefined,
  filter?: Filter,
): Promise<Counted | undefined> {
  try {
    const response = await fetch(`${address(urlPath)}?${asked(table, filter)}&stats`)
    const stats: DataStats | undefined = response.ok ? await response.json() : undefined

    if (stats?.error) {
      return { error: stats.error }
    }

    return stats && { profiles: profilesOf(stats), total: stats.total, where: stats.where }
  } catch {
    return undefined
  }
}

function address(urlPath: string): string {
  return `/${urlPath.split("/").map(encodeURIComponent).join("/")}`
}

function asked(table: string | undefined, filter: Filter | undefined): string {
  const query = new URLSearchParams()

  if (table !== undefined) {
    query.set("table", table)
  }

  if (filter) {
    query.set("filter", JSON.stringify(filter))
  }

  return `data${query.size > 0 ? `&${query}` : ""}`
}

function forgotten(): Memory {
  return { records: new Map(), branches: new Set(), folded: new Set() }
}

function branchesOf(view: Element, memory: Memory): Pick<Memory, "branches" | "folded"> {
  const branches = new Set(memory.branches)
  const folded = new Set(memory.folded)

  for (const branch of [view, ...view.querySelectorAll("details.data-tree")]) {
    const path = BRANCHES.get(branch)

    if (path !== undefined && branch instanceof HTMLDetailsElement) {
      ;(branch.open ? branches : folded).add(path)
      ;(branch.open ? folded : branches).delete(path)
    }
  }

  return { branches, folded }
}

function reopened(view: HTMLElement, memory: Memory, label: Drawn): HTMLElement {
  const table = view instanceof HTMLTableElement ? view : tableIn(view)

  if (table) {
    reopen(table, memory.records.get(label) ?? [])
  }

  return view
}

function servesTable(
  table: HTMLTableElement,
  urlPath: string,
  part: string,
  rows: number,
  total: number,
): void {
  serve(
    table,
    async (asking) => {
      const sent = await fetchRows(urlPath, part, undefined, asking, 0, rows)
      return (
        sent && {
          rows: [...collectionTable(fromGrid(sent)).tBodies[0].rows],
          kept: sent.total ?? 0,
        }
      )
    },
    total,
  )
}

async function fetchRows(
  urlPath: string,
  part: string | undefined,
  filter: Filter | undefined,
  asking: Asking,
  offset: number,
  rows?: number,
): Promise<Grid | undefined> {
  const query = new URLSearchParams()

  if (asking.order) {
    query.set("sort", JSON.stringify(asking.order))
  }

  if (asking.search) {
    query.set("search", JSON.stringify(asking.search))
  }

  if (offset > 0) {
    query.set("offset", String(offset))
  }

  if (rows !== undefined) {
    query.set("rows", String(rows))
  }

  try {
    const response = await fetch(`${address(urlPath)}?${asked(part, filter)}&${query}`)
    const sent: DataPage | undefined = response.ok ? await response.json() : undefined
    return sent?.grid
  } catch {
    return undefined
  }
}

class Pager {
  found: Collection
  total: number
  askedBy: HTMLTableElement | undefined
  restored = false
  held: number
  readonly size: number
  onChange: (added?: Collection) => void = () => {}
  /** Runs on asked rows before the table takes them; onChange fires too early to reach them. */
  dress: (rows: HTMLTableRowElement[], owner: HTMLTableElement) => void = () => {}
  readonly #urlPath: string
  readonly #part: string | undefined
  readonly #filter: Filter | undefined
  #asking: Asking = {}
  #asked = 0
  #pending: Promise<unknown> = Promise.resolve()
  #restoring: Asking | undefined

  constructor(
    urlPath: string,
    part: string | undefined,
    filter: Filter | undefined,
    found: Collection,
    total: number,
    size = found.entries.length,
    restoring?: Asking,
    held = 0,
  ) {
    this.#urlPath = urlPath
    this.#part = part
    this.#filter = filter
    this.found = found
    this.total = total
    this.size = size
    this.#restoring = restoring
    this.held = Math.max(held, found.entries.length)
  }

  /** Rows as written, in the file's order: any view asking for them so can share them. */
  get plain(): boolean {
    return !this.#asking.order && !this.#asking.search
  }

  get asking(): Asking {
    return this.#asking
  }

  get restoring(): Asking | undefined {
    return this.#restoring
  }

  async ask(
    asking: Asking,
    owner: HTMLTableElement,
    rowsOf: (found: Collection) => HTMLTableRowElement[],
  ): Promise<{ rows: HTMLTableRowElement[]; kept: number } | undefined> {
    const asked = ++this.#asked
    const restored = JSON.stringify(this.#restoring) === JSON.stringify(asking)

    if (!restored) {
      this.#restoring = undefined
    }

    const fetching = fetchRows(
      this.#urlPath,
      this.#part,
      this.#filter,
      asking,
      0,
      restored ? this.held : undefined,
    )
    this.#pending = fetching
    const sent = await fetching

    if (asked === this.#asked) {
      this.#restoring = undefined
    }

    if (!sent || asked !== this.#asked) {
      return undefined
    }

    this.#asking = asking
    this.askedBy = owner
    this.found = fromGrid(sent)
    this.total = sent.total ?? sent.rows.length
    this.held = this.found.entries.length
    this.restored = restored
    this.onChange()
    this.restored = false
    const rows = rowsOf(this.found)
    this.dress(rows, owner)
    return { rows, kept: this.total }
  }

  /** Waits for a sort or search still loading, so the rows it adds follow the order asked for last. */
  async more(): Promise<void> {
    for (let pending = this.#pending; ; pending = this.#pending) {
      await pending.catch(() => {})

      if (pending === this.#pending) {
        break
      }
    }

    const asked = this.#asked
    const offset = this.found.entries.length
    const sent = await fetchRows(this.#urlPath, this.#part, this.#filter, this.#asking, offset)

    if (!sent || asked !== this.#asked) {
      return
    }

    const added = fromGrid(sent)
    added.entries = added.entries.map(([key, row]) => [String(offset + Number(key)), row])
    this.found = { ...this.found, entries: [...this.found.entries, ...added.entries] }
    this.total = sent.total ?? this.total
    this.held = this.found.entries.length
    this.onChange(added)
  }
}

function about(page: DataPage): string {
  const parts = [page.format.toUpperCase(), size(page.size)]
  const grid = page.grid

  if (page.count !== undefined) {
    parts.push(`${NUMBER.format(page.count)} ${page.count === 1 ? "row" : "rows"}`)
  } else if (grid?.partial && grid.total === undefined) {
    parts.push(`showing its first ${NUMBER.format(grid.rows.length)} rows`)
  } else if (grid?.partial && grid.total !== undefined) {
    parts.push(
      `showing the first ${NUMBER.format(grid.rows.length)} of ${NUMBER.format(grid.total)} rows`,
    )
  } else if (grid) {
    parts.push(`${NUMBER.format(grid.rows.length)} ${grid.rows.length === 1 ? "row" : "rows"}`)
  }

  if (page.tables) {
    parts.push(`${page.tables.length} ${page.tables.length === 1 ? "table" : "tables"}`)
  }

  if (page.text !== undefined && !page.error && page.format !== "sql") {
    parts.push(`too large to show whole; showing its start`)
  }

  if (page.counting) {
    parts.push("still counting")
  }

  if (page.note) {
    parts.push(page.note)
  }

  return parts.join(" · ")
}

function databaseTables(urlPath: string, tables: DataTable[]): HTMLElement[] {
  if (tables.length === 0) {
    return [paragraph("This database holds no tables.", "data-info")]
  }

  return tables.flatMap((found) => {
    const open = document.createElement("a")
    const columns = found.columns.map(({ name, type }) => `${name} ${type}`).join(", ")

    open.href = `/${urlPath.split("/").map(encodeURIComponent).join("/")}?table=${encodeURIComponent(found.name)}`
    open.textContent = "Open the whole table"

    const info = paragraph(
      `${NUMBER.format(found.total)} ${found.total === 1 ? "row" : "rows"} · ${columns} · `,
      "data-info",
    )
    info.append(open)
    if (found.error) {
      return [heading("h2", found.name), paragraph(found.error, "data-error")]
    }

    const table = collectionTable(fromGrid(found.first))

    if (found.total > found.first.rows.length) {
      servesTable(table, urlPath, found.name, found.first.rows.length, found.total)
    }

    return [heading("h2", found.name), info, table]
  })
}

/** Counted in the browser, not by the server: a JSON or YAML file's page holds all its records. */
function nested(
  value: unknown,
  article: HTMLElement,
  picked: Picked | undefined,
  query: string,
  resume: Resume | undefined,
): HTMLElement[] {
  const whole = collectionOf(value)

  if (!whole) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      panelOf(article, keysPanel(value as Record<string, unknown>, article))
    }

    const memory = resume?.memory ?? forgotten()
    const shown = tree(value, 0, undefined, false, false, {
      path: "",
      opened: memory.branches,
      folded: memory.folded,
    })
    RESUMES.set(article, () => ({
      view: "Tree",
      memory: { ...memory, ...branchesOf(shown, memory) },
    }))
    return [
      ...(hasSpreads(value)
        ? [paragraphOf(statisticsSwitch(article), "data-info data-controls")]
        : []),
      shown,
    ]
  }

  const filter = picked?.filter
  const found = filter ? kept(whole, (row) => keeps(filter, row[filter.field])) : whole
  const rows = (records: Collection) => (records.all ?? records.entries).map(([, row]) => row)

  return views(
    found,
    {
      Table: (memory) => reopened(collectionTable(found), memory, "Table"),
      Records: (memory) => reopened(recordList(found), memory, "Records"),
      Tree: (memory) =>
        tree(filter ? rows(found) : value, 0, undefined, false, true, {
          path: "",
          opened: memory.branches,
          folded: memory.folded,
        }),
    },
    "whole",
    {
      article,
      picked,
      counting: {
        stats: async (asked?: Filter) => {
          // Counted once the page has drawn: a hundred thousand records take a second or two.
          await new Promise((resolve) => setTimeout(resolve))
          const records = asked ? kept(whole, (row) => keeps(asked, row[asked.field])) : whole
          const profiles = profilesIn(whole.names, rows(records))
          return {
            profiles,
            total: records.total,
            where:
              asked &&
              conditionOf(asked, profilesIn([asked.field], rows(whole)).get(asked.field)?.kind),
          }
        },
        query: whole.keyed ? undefined : query,
      },
    },
    undefined,
    resume,
    (getter) => RESUMES.set(article, getter),
  )
}

function hasSpreads(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > OPEN_DEPTH + 2) {
    return false
  }

  const found = collectionOf(value)
  return found
    ? found.total >= SPREAD_ROWS
    : Object.values(value).some((item) => hasSpreads(item, depth + 1))
}

/**
 * A branch is known by its path; in a list of rows a record's path is what it holds.
 * So a branch opened or folded before a redraw is so again wherever its record then stands.
 */
function tree(
  value: unknown,
  depth: number,
  key?: string,
  crowded = false,
  root = false,
  at: { path: string; opened?: Set<string>; folded?: Set<string> } = { path: "" },
): HTMLElement {
  const label = key === undefined ? "" : `${key}: `
  const found = root ? undefined : collectionOf(value)

  if (value === null || typeof value !== "object") {
    const leaf = document.createElement("div")
    const shown = document.createElement("span")

    leaf.className = "data-leaf"
    shown.className = `data-${value === null ? "null" : typeof value}`
    shown.textContent = JSON.stringify(value) ?? String(value)
    leaf.append(document.createTextNode(label), shown)

    if (depth === 1 && key !== undefined) {
      leaf.dataset.key = key
    }
    return leaf
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value)
  const branch = document.createElement("details")
  const summary = document.createElement("summary")
  const count = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`

  // A branch draws its children when first opened, a batch at a time.
  // A list of a hundred thousand items is neither built at once nor spread into one call, overflowing the stack.
  let drawn = 0
  const more = document.createElement("button")
  const fill = () => {
    if (found && found.total > 1) {
      branch.append(...records(found))
      more.remove()
      branch.dispatchEvent(new CustomEvent("folio:tables", { bubbles: true }))
      return
    }

    const end = Math.min(entries.length, drawn + BATCH)

    for (; drawn < end; drawn++) {
      const [name, item] = entries[drawn]
      const path = root ? JSON.stringify(item) : `${at.path}/${name}`
      branch.insertBefore(
        tree(item, depth + 1, name, entries.length > CROWDED, false, {
          path,
          opened: at.opened,
          folded: at.folded,
        }),
        more,
      )
    }

    if (drawn === entries.length) {
      more.remove()
    } else {
      more.textContent = `Show ${NUMBER.format(Math.min(BATCH, entries.length - drawn))} more of ${NUMBER.format(entries.length)}`
    }
  }

  more.type = "button"
  more.className = "data-switch data-more"
  more.addEventListener("click", fill)

  branch.className = "data-tree"
  summary.textContent = `${label}${count}`
  branch.append(summary, more)
  BRANCHES.set(branch, at.path)

  if (depth === 1 && key !== undefined) {
    branch.dataset.key = key
  }

  if (at.opened?.has(at.path) || (depth < OPEN_DEPTH && !crowded && !at.folded?.has(at.path))) {
    branch.open = true
    fill()
  } else {
    branch.addEventListener("toggle", fill, { once: true })
  }

  return branch
}

function records(found: Collection): HTMLElement[] {
  const all = found.all ?? found.entries
  const profiles =
    found.total >= SPREAD_ROWS
      ? profilesIn(
          found.names,
          all.map(([, row]) => row),
        )
      : undefined
  const draw = (count: number) => {
    const shown = { ...found, entries: all.slice(0, count) }
    const view = mixed(shown) ? recordList(shown) : collectionTable(shown)

    if (profiles && !mixed(shown)) {
      strips(view as HTMLTableElement, found.names, found.keyed, profiles)
    }

    return view
  }
  let count = found.entries.length
  let view = draw(count)

  if (count >= found.total) {
    return [view]
  }

  const bar = paragraph("", "data-info data-more-rows")
  const button = document.createElement("button")
  const told = () => {
    bar.hidden = count >= found.total
    bar.replaceChildren(
      `${NUMBER.format(count)} of ${NUMBER.format(found.total)} records shown `,
      button,
    )
    button.textContent = `Show ${NUMBER.format(Math.min(BATCH, found.total - count))} more`
  }

  button.type = "button"
  button.className = "data-switch"
  button.addEventListener("click", () => {
    count = Math.min(found.total, count + BATCH)
    const next = draw(count)
    view.replaceWith(next)
    view = next
    told()
    next.dispatchEvent(new CustomEvent("folio:tables", { bubbles: true }))
  })
  told()
  return [view, bar]
}

function tableIn(view: HTMLElement): HTMLTableElement | undefined {
  return view instanceof HTMLTableElement
    ? view
    : (view.querySelector<HTMLTableElement>("table") ?? undefined)
}

function recordRows(found: Collection): HTMLTableRowElement[] {
  const table = tableIn(recordList(found, true, false)) as HTMLTableElement
  return [...table.tBodies[0].rows]
}

/** A record's line holds the whole record: its filters search every field, and it sorts by none. */
function recordsAsking({ search }: Asking): Asking {
  const texts = [search?.text, ...(search?.columns ?? []).map(([, text]) => text)].filter(
    (text): text is string => Boolean(text),
  )

  return texts.length > 0
    ? { search: { text: texts[0], columns: texts.slice(1).map((text) => [-1, text]), hidden: [] } }
    : {}
}

function size(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"]
  let scaled = bytes
  let unit = 0

  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit++
  }

  return unit === 0 ? `${bytes} bytes` : `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[unit]}`
}

function heading(tag: "h1" | "h2", content: string): HTMLElement {
  const element = document.createElement(tag)
  element.textContent = content
  element.id = content
  return element
}

function paragraph(content: string, className: string): HTMLParagraphElement {
  const element = document.createElement("p")
  element.className = className
  element.textContent = content
  return element
}

function paragraphOf(child: Node, className: string): HTMLParagraphElement {
  const element = document.createElement("p")
  element.className = className
  element.append(child)
  return element
}
