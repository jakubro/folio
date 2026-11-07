/** What elsewhere in the folder says the same as the section in view, or the block pointed at, in the outline. */

import type { Neighbour, RelatedAnswer } from "../server/related.ts"
import { href } from "./tree.ts"

const WAIT_MS = 150
const MAX_BLOCKS = 60
const HEADINGS = "h1, h2, h3, h4, h5, h6"
const NUMBER = new Intl.NumberFormat("en")

export class Related {
  readonly #side: HTMLElement
  #article: HTMLElement | undefined
  #urlPath: string | undefined
  #section: HTMLElement | undefined
  #pointed: HTMLElement | undefined
  #selected: HTMLElement | undefined
  #asked = ""
  #timer: ReturnType<typeof setTimeout> | undefined
  #version: string | null = null

  constructor(main: HTMLElement, side: HTMLElement) {
    this.#side = side
    side.className = "outline-related"
    side.hidden = true
    main.addEventListener("pointerover", (event) => {
      this.#pointed = this.#blockAt(event.target as Node)
      this.#soon()
    })
    main.addEventListener("pointerleave", () => {
      this.#pointed = undefined
      this.#soon()
    })
    document.addEventListener("selectionchange", () => {
      const selection = document.getSelection()
      this.#selected =
        selection && !selection.isCollapsed ? this.#blockAt(selection.anchorNode) : undefined
      this.#soon()
    })
  }

  get version(): string | null {
    return this.#version
  }

  show(urlPath: string | undefined, article: HTMLElement): void {
    this.#urlPath = urlPath
    this.#article = article
    this.#pointed = undefined
    this.#selected = undefined
    this.#asked = ""
    this.#version = null
    this.#side.hidden = true

    if (urlPath) {
      this.#soon()
    }
  }

  section(heading: HTMLElement | undefined): void {
    this.#section = heading
    this.#soon()
  }

  refresh(): void {
    this.#asked = ""
    this.#soon()
  }

  #soon(): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.#ask(), WAIT_MS)
  }

  async #ask(): Promise<void> {
    const urlPath = this.#urlPath
    const blocks = this.#blocks()

    if (!urlPath || blocks.length === 0) {
      this.#asked = ""
      this.#side.hidden = true
      return
    }

    const query = new URLSearchParams({ api: "related" })

    for (const block of blocks) {
      query.append("block", `${block.dataset.folioSource ?? urlPath}#${block.dataset.folioId}`)
    }

    if (query.toString() === this.#asked) {
      return
    }

    this.#asked = query.toString()
    const response = await fetch(`${href(urlPath)}?${query}`)
    const answer: RelatedAnswer | undefined = response.ok ? await response.json() : undefined

    if (this.#urlPath === urlPath && this.#asked === query.toString()) {
      this.#draw(answer)
    }
  }

  /**
   * A heading pointed at stands for its section: alone it is too short to relate to anything. A section
   * is the text under its heading, or under the first heading below it when it has none of its own.
   */
  #blocks(): HTMLElement[] {
    const tops = topBlocks(this.#article)
    const chosen = this.#selected ?? this.#pointed

    if (chosen && !chosen.matches(HEADINGS)) {
      return [chosen]
    }

    const heading = chosen ?? this.#section
    const section: HTMLElement[] = []

    for (const block of tops.slice((heading ? tops.indexOf(heading) : -1) + 1)) {
      if (!block.matches(HEADINGS)) {
        section.push(block)
      } else if (section.length > 0) {
        break
      }
    }

    return section.slice(0, MAX_BLOCKS)
  }

  #blockAt(node: Node | null): HTMLElement | undefined {
    const element = node instanceof Element ? node : node?.parentElement
    let block = element?.closest<HTMLElement>("[data-folio-id]")

    if (!block || !this.#article?.contains(block)) {
      return undefined
    }

    for (
      let outer = block.parentElement?.closest<HTMLElement>("[data-folio-id]");
      outer;
      outer = outer.parentElement?.closest<HTMLElement>("[data-folio-id]")
    ) {
      block = outer
    }

    return block
  }

  #draw(answer: RelatedAnswer | undefined): void {
    this.#side.hidden = !answer?.asked

    if (!answer?.asked) {
      this.#version = null
      return
    }

    this.#version = answer.version
    const { state, related } = answer
    const title = Object.assign(document.createElement("p"), {
      className: "related-title",
      textContent: "Related by meaning",
    })
    const said = (text: string) =>
      Object.assign(document.createElement("p"), { className: "related-state", textContent: text })

    if (state.status !== "ready") {
      this.#side.replaceChildren(title, said(progress(state)))
    } else if (related.length === 0) {
      this.#side.replaceChildren(title, said("Nothing close enough"))
    } else {
      this.#side.replaceChildren(title, ...related.map(entry))
    }
  }
}

function topBlocks(article: HTMLElement | undefined): HTMLElement[] {
  return [...(article?.querySelectorAll<HTMLElement>("[data-folio-id]") ?? [])].filter(
    (block) => !block.parentElement?.closest("[data-folio-id]"),
  )
}

function progress(state: Exclude<RelatedAnswer, { asked: false }>["state"]): string {
  if (state.status === "installing") {
    return "Installing the model's runtime"
  }

  if (state.status === "downloading") {
    const megabytes = (bytes = 0) => NUMBER.format(Math.round(bytes / 1e6))
    return `Downloading the model: ${megabytes(state.done)} of ${megabytes(state.total)} MB`
  }

  if (state.status === "indexing") {
    return `Relating the folder: ${NUMBER.format(state.done)} of ${NUMBER.format(state.total)} blocks`
  }

  return state.status === "failed" ? `Not available: ${state.message}` : ""
}

function entry({ path, block, lines, title, text, closeness }: Neighbour): HTMLElement {
  const link = document.createElement("a")
  const name = path.split("/").pop() ?? path

  link.className = "related-entry"
  link.href = `${href(path)}#^${encodeURIComponent(block)}`
  link.title = path
  link.append(
    Object.assign(document.createElement("span"), {
      className: "related-name",
      textContent: title ?? name,
    }),
    Object.assign(document.createElement("span"), {
      className: "related-where",
      textContent: `${title === null ? "" : `${name} `}lines ${lines[0]}-${lines[1]} - ${Math.round(closeness * 100)}%`,
    }),
    Object.assign(document.createElement("span"), { className: "related-text", textContent: text }),
  )
  return link
}
