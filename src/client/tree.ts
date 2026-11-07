/** The file tree beside every page: one folder level per request, loaded as folders are expanded. */

import { button, ICONS } from "./icons.ts"
import { dataShown, setDataShown } from "./prefs.ts"

export interface Entry {
  name: string
  kind: "folder" | "markdown" | "mermaid" | "image" | "data"
}

interface Listing {
  entries: Entry[]
  version: string
}

interface Folder {
  list: HTMLUListElement
  version: string
  items: Map<string, HTMLLIElement>
}

const EXPANDED = "folio.expanded"
const KIND_ICONS = {
  folder: ICONS.folder,
  markdown: ICONS.file,
  mermaid: ICONS.diagram,
  image: ICONS.image,
  data: ICONS.data,
}

export async function fetchListing(urlPath: string): Promise<Listing | undefined> {
  const response = await fetch(`${href(urlPath, true)}?tree${dataShown() ? "&data" : ""}`)
  return response.ok ? response.json() : undefined
}

export function href(urlPath: string, folder = false): string {
  const encoded = urlPath.split("/").map(encodeURIComponent).join("/")
  return `/${encoded}${folder && urlPath ? "/" : ""}`
}

export function iconFor(kind: Entry["kind"]): string {
  return KIND_ICONS[kind]
}

export class Tree {
  readonly element = document.createElement("nav")
  /** Called whenever the set of expanded folders, or one of their versions, changes. */
  onChange = () => {}
  #current: string
  readonly #folders = new Map<string, Folder>()
  readonly #dataToggle = button(ICONS.data, "Show or hide data files", "icon-button tree-data")
  /** Loading and moving the current page both open folders; one at a time, or a folder opens twice. */
  #opening = Promise.resolve()
  #changed = new Set<string>()
  #problems = new Map<string, number>()

  constructor(current: string) {
    this.#current = current
    this.element.className = "tree"
    this.element.setAttribute("aria-label", "Files")
    this.#dataToggle.setAttribute("aria-pressed", String(dataShown()))
    this.#dataToggle.addEventListener("click", () => {
      setDataShown(!dataShown())
      this.#dataToggle.setAttribute("aria-pressed", String(dataShown()))
      this.onChange()
    })
    const corner = document.createElement("div")
    corner.className = "tree-corner"
    corner.append(this.#dataToggle)
    this.element.append(corner)
  }

  /** Fetch every folder to open at once and show them in one step, scrolled as left or centred. */
  load(scroll?: number): Promise<void> {
    return this.#queue(async () => {
      const wanted = [...new Set([...remembered(), ...this.#ancestors()])].sort()
      const [root, ...listings] = await Promise.all(["", ...wanted].map((at) => fetchListing(at)))

      if (!root) {
        return
      }

      const folder = this.#folder("", root)
      this.#attachAll(wanted, listings)
      this.element.append(folder.list)
      remember(this.#folders.keys())
      this.onChange()

      if (scroll === undefined) {
        this.#reveal()
      } else {
        this.element.scrollTop = scroll
      }
    })
  }

  /** Mark another page as current, opening the folders down to it. */
  show(current: string): Promise<void> {
    this.#current = current
    return this.#queue(() => this.#mark())
  }

  /** Mark documents read before that changed since, and every folder holding one. */
  mark(changed: Set<string>): void {
    this.#changed = changed

    for (const item of this.element.querySelectorAll<HTMLLIElement>("li[data-path]")) {
      this.#show(item)
    }
  }

  /** Mark each file health lists problems for, by its count, and every folder holding one. */
  markProblems(counts: Map<string, number>): void {
    this.#problems = counts

    for (const item of this.element.querySelectorAll<HTMLLIElement>("li[data-path]")) {
      this.#show(item)
    }
  }

  /** Expanded folders mapped to the listing version each shows. */
  folders(): Record<string, string> {
    return Object.fromEntries(
      [...this.#folders].map(([urlPath, folder]) => [urlPath, folder.version]),
    )
  }

  /** Re-fetch a folder that changed, keeping whatever beneath it is expanded. */
  async refresh(urlPath: string): Promise<void> {
    const folder = this.#folders.get(urlPath)
    const listing = folder && (await fetchListing(urlPath))

    if (!folder) {
      return
    }

    if (!listing) {
      this.#collapse(urlPath)
      this.#itemFor(urlPath)?.remove()
      return
    }

    folder.version = listing.version
    this.#fill(urlPath, folder, listing.entries)
    this.onChange()
  }

  async #open(urlPath: string, parent: HTMLElement): Promise<boolean> {
    const listing = await fetchListing(urlPath)

    if (!listing) {
      return false
    }

    parent.append(this.#folder(urlPath, listing).list)
    return true
  }

  #folder(urlPath: string, listing: Listing): Folder {
    const folder: Folder = {
      list: document.createElement("ul"),
      version: listing.version,
      items: new Map(),
    }
    this.#folders.set(urlPath, folder)
    this.#fill(urlPath, folder, listing.entries)
    return folder
  }

  /** Paths must be sorted: a parent then comes before its children, whose items it creates. */
  #attachAll(paths: string[], listings: (Listing | undefined)[]): void {
    for (const [index, urlPath] of paths.entries()) {
      const listing = listings[index]
      const item = this.#itemFor(urlPath)

      if (listing && item && !this.#folders.has(urlPath)) {
        item.classList.add("expanded")
        item.append(this.#folder(urlPath, listing).list)
      }
    }
  }

  #fill(urlPath: string, folder: Folder, entries: Entry[]): void {
    const items = new Map<string, HTMLLIElement>()

    for (const entry of entries) {
      const key = `${entry.kind}:${entry.name}`
      items.set(
        key,
        folder.items.get(key) ??
          this.#item(urlPath ? `${urlPath}/${entry.name}` : entry.name, entry),
      )
    }

    for (const [key, item] of folder.items) {
      if (!items.has(key) && item.dataset.folder !== undefined) {
        this.#collapseUnder(item.dataset.path ?? "")
      }
    }

    folder.items = items
    folder.list.replaceChildren(...items.values())
  }

  #item(urlPath: string, entry: Entry): HTMLLIElement {
    const item = document.createElement("li")
    const row = document.createElement(entry.kind === "folder" ? "button" : "a")

    item.dataset.path = urlPath
    row.className = "tree-row"
    row.innerHTML = `${entry.kind === "folder" ? `<span class="chevron">${ICONS.chevron}</span>` : '<span class="chevron"></span>'}${iconFor(entry.kind)}`
    row.append(document.createTextNode(entry.name))
    row.title = entry.name
    row.dataset.name = entry.name

    if (entry.kind === "folder") {
      item.dataset.folder = ""
      ;(row as HTMLButtonElement).type = "button"
      row.addEventListener("click", () => {
        if (this.#folders.has(urlPath)) {
          this.#collapse(urlPath)
        } else {
          void this.#expand(urlPath, item)
        }
      })
    } else {
      ;(row as HTMLAnchorElement).href = href(urlPath)

      if (urlPath === this.#current) {
        row.classList.add("current")
        row.setAttribute("aria-current", "page")
      }
    }

    item.append(row)
    this.#show(item)
    return item
  }

  #show(item: HTMLLIElement): void {
    const at = item.dataset.path ?? ""
    const inside = item.dataset.folder !== undefined
    const changed = inside
      ? [...this.#changed].some((path) => path.startsWith(`${at}/`))
      : this.#changed.has(at)

    item.firstElementChild?.classList.toggle(inside ? "holds-changed" : "changed", changed)
    this.#showProblems(item, at, inside)
  }

  #showProblems(item: HTMLLIElement, at: string, inside: boolean): void {
    const row = item.firstElementChild as HTMLElement | null
    const count = inside
      ? [...this.#problems.keys()].some((path) => path.startsWith(`${at}/`))
        ? 1
        : 0
      : (this.#problems.get(at) ?? 0)
    let mark = row?.querySelector<HTMLElement>(":scope > .problem-mark")

    if (!row) {
      return
    }

    if (count === 0) {
      mark?.remove()
      row.title = row.dataset.name ?? row.title
      return
    }

    if (!mark) {
      mark = Object.assign(document.createElement("span"), { className: "problem-mark" })
      row.append(mark)
    }

    if (!inside) {
      row.title = `${row.dataset.name} - ${count} ${count === 1 ? "problem" : "problems"}`
    }
  }

  async #expand(urlPath: string, item: HTMLLIElement): Promise<void> {
    item.classList.add("expanded")

    if (await this.#open(urlPath, item)) {
      remember(this.#folders.keys())
      this.onChange()
    } else {
      item.classList.remove("expanded")
    }
  }

  #collapse(urlPath: string): void {
    this.#collapseUnder(urlPath)
    remember(this.#folders.keys())
    this.onChange()
  }

  #collapseUnder(urlPath: string): void {
    for (const [path, folder] of this.#folders) {
      if (path === urlPath || path.startsWith(`${urlPath}/`)) {
        folder.list.parentElement?.classList.remove("expanded")
        folder.list.remove()
        this.#folders.delete(path)
      }
    }
  }

  async #mark(): Promise<void> {
    const current = this.#current

    for (const row of this.element.querySelectorAll<HTMLAnchorElement>("a.tree-row")) {
      const isCurrent = row.parentElement?.dataset.path === current
      row.classList.toggle("current", isCurrent)

      if (isCurrent) {
        row.setAttribute("aria-current", "page")
      } else {
        row.removeAttribute("aria-current")
      }
    }

    const missing = this.#ancestors()
      .filter((at) => !this.#folders.has(at))
      .sort()

    if (missing.length > 0) {
      this.#attachAll(missing, await Promise.all(missing.map((at) => fetchListing(at))))
      remember(this.#folders.keys())
      this.onChange()
    }

    this.#revealHidden()
  }

  #queue(work: () => Promise<void>): Promise<void> {
    this.#opening = this.#opening.then(work, work)
    return this.#opening
  }

  #ancestors(): string[] {
    const parts = this.#current.split("/").filter(Boolean)
    const ancestors = parts.slice(0, this.#current.endsWith("/") ? parts.length : -1)

    return ancestors.map((_, i) => ancestors.slice(0, i + 1).join("/"))
  }

  #revealHidden(): void {
    const row = this.element.querySelector(".current")
    const panel = this.element.getBoundingClientRect()
    const box = row?.getBoundingClientRect()

    if (box && (box.top < panel.top || box.bottom > panel.bottom)) {
      this.#reveal()
    }
  }

  /** Centres the current file within the tree only; scrollIntoView would also scroll the page. */
  #reveal(): void {
    const row = this.element.querySelector(".current")

    if (row) {
      const panel = this.element.getBoundingClientRect()
      const box = row.getBoundingClientRect()
      this.element.scrollTop += box.top - panel.top - (panel.height - box.height) / 2
    }
  }

  #itemFor(urlPath: string): HTMLLIElement | undefined {
    const parent = urlPath.includes("/") ? urlPath.slice(0, urlPath.lastIndexOf("/")) : ""
    const name = urlPath.slice(parent ? parent.length + 1 : 0)
    return this.#folders.get(parent)?.items.get(`folder:${name}`)
  }
}

/** Remembered per tab, so following a link keeps the tree as it was without reaching other tabs. */
function remembered(): string[] {
  return JSON.parse(sessionStorage.getItem(EXPANDED) ?? "[]")
}

function remember(paths: Iterable<string>): void {
  sessionStorage.setItem(EXPANDED, JSON.stringify([...paths].filter(Boolean)))
}
