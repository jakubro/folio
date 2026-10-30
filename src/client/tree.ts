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
    this.element.append(this.#dataToggle)
  }

  /** Load the root, then reopen the current page's ancestors and the folders open before. */
  load(): Promise<void> {
    return this.#queue(async () => {
      if (await this.#open("", this.element)) {
        await this.#reopen([...remembered(), ...this.#ancestors()])
        this.#reveal()
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

    const folder: Folder = {
      list: document.createElement("ul"),
      version: listing.version,
      items: new Map(),
    }
    this.#folders.set(urlPath, folder)
    this.#fill(urlPath, folder, listing.entries)
    parent.append(folder.list)
    return true
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

    await this.#reopen(this.#ancestors())
    this.#reveal()
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

  async #reopen(paths: string[]): Promise<void> {
    for (const urlPath of [...new Set(paths)].sort()) {
      const item = this.#itemFor(urlPath)

      if (item && !this.#folders.has(urlPath)) {
        await this.#expand(urlPath, item)
      }
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
