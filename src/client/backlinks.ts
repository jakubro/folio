/** What links to the page: a list at its end, with the text around each link, and its sources in the outline. */

import type { Backlink } from "../server/model.ts"
import type { LinksState } from "./pages.ts"
import { href } from "./tree.ts"

export class Backlinks {
  readonly #end = document.createElement("section")
  readonly #side: HTMLElement
  #shown: string | undefined
  #version: string | null = null

  constructor(main: HTMLElement, side: HTMLElement) {
    this.#side = side
    this.#end.className = "backlinks"
    this.#end.hidden = true
    this.#side.className = "outline-backlinks"
    this.#side.hidden = true
    main.append(this.#end)
  }

  get version(): string | null {
    return this.#version
  }

  /** Fetch the links into a page again; false when another page was shown meanwhile. */
  async refresh(urlPath: string): Promise<boolean> {
    this.#shown = urlPath
    const response = await fetch(`${href(urlPath)}?links`)
    const state: LinksState | undefined = response.ok ? await response.json() : undefined

    if (this.#shown !== urlPath) {
      return false
    }

    this.show(urlPath, state)
    return true
  }

  /** Show the links into a page, or none for a folder. */
  show(urlPath: string | undefined, state: LinksState | undefined): void {
    this.#shown = urlPath
    const links = state?.links ?? []
    this.#version = state?.version ?? null
    this.#end.hidden = links.length === 0
    this.#side.hidden = links.length === 0
    this.#end.replaceChildren(title("h2"), list(links))
    this.#side.replaceChildren(
      title("p"),
      ...[...firstLinks(links).values()].map(({ source, block, title }) => {
        const link = document.createElement("a")
        link.href = `${href(source)}#^${encodeURIComponent(block)}`
        link.textContent = title ?? source.split("/").pop() ?? source
        link.title = source
        return link
      }),
    )
  }
}

/** Each linking document once, leading to the first of its blocks that links here. */
function firstLinks(links: Backlink[]): Map<string, Backlink> {
  const first = new Map<string, Backlink>()

  for (const link of links) {
    if (!first.has(link.source)) {
      first.set(link.source, link)
    }
  }

  return first
}

function title(tag: string): HTMLElement {
  return Object.assign(document.createElement(tag), {
    className: "backlinks-title",
    textContent: "Linked from",
  })
}

function list(links: Backlink[]): HTMLElement {
  const items = document.createElement("ul")

  items.append(
    ...links.map(({ source, block, context, part, title }) => {
      const item = document.createElement("li")
      const link = document.createElement("a")
      const around = document.createElement("p")

      link.href = `${href(source)}#^${encodeURIComponent(block)}`
      link.textContent = title ?? source
      link.title = source
      around.className = "backlink-context"
      around.textContent = context
      item.append(link)

      if (part) {
        item.append(
          Object.assign(document.createElement("span"), {
            className: "backlink-part",
            textContent: ` → ${part}`,
          }),
        )
      }

      item.append(around)
      return item
    }),
  )
  return items
}
