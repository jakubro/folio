/** What a file reaches: the documents that include it or embed or query its data, listed below its page. */

import type { Dependent } from "../server/impact.ts"
import { href } from "./tree.ts"

const RETRY_MS = 2000
const HOW = { includes: "includes it", embeds: "embeds or queries its data" }

export class UsedBy {
  readonly #section = document.createElement("section")
  #shown: string | undefined

  constructor(main: HTMLElement) {
    this.#section.className = "backlinks used-by"
    this.#section.hidden = true
    main.append(this.#section)
  }

  async show(urlPath: string | undefined): Promise<void> {
    this.#shown = urlPath

    if (urlPath === undefined) {
      this.#section.hidden = true
      return
    }

    const response = await fetch(`${href(urlPath)}?used-by`)
    const { ready = true, documents: found = [] }: { ready?: boolean; documents?: Dependent[] } =
      response.ok ? await response.json() : {}

    if (this.#shown !== urlPath) {
      return
    }

    // While folio still reads the folder the list is not known: nothing shows, and it asks again.
    if (!ready) {
      this.#section.hidden = true
      setTimeout(() => this.#shown === urlPath && void this.show(urlPath), RETRY_MS)
      return
    }

    const list = document.createElement("ul")

    list.append(
      ...found.map(({ source, how }) => {
        const item = document.createElement("li")
        item.append(
          Object.assign(document.createElement("a"), { href: href(source), textContent: source }),
          Object.assign(document.createElement("span"), {
            className: "used-by-how",
            textContent: ` ${HOW[how]}`,
          }),
        )
        return item
      }),
    )
    this.#section.replaceChildren(
      Object.assign(document.createElement("h2"), {
        className: "backlinks-title",
        textContent: "Used by",
      }),
      list,
    )
    this.#section.hidden = found.length === 0
  }
}
