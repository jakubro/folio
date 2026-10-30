/** Links to any block: a mark beside the block under the pointer, and landing where such a link points. */

import { copyButton } from "./copy.ts"
import { reveal } from "./folds.ts"
import { ICONS } from "./icons.ts"
import { href } from "./tree.ts"

const MARGIN_PX = 24

export class BlockLinks {
  readonly #main: HTMLElement
  readonly #mark = document.createElement("a")
  readonly #past = document.createElement("a")
  readonly #why = document.createElement("button")
  readonly #gone = document.createElement("p")
  readonly #copy = copyButton(
    () => (this.#block && this.copyOf(this.#block)) ?? "",
    "Copy this block as markdown",
    "block-copy",
  )
  #block: HTMLElement | undefined
  /** Opens where the block under the pointer came from. */
  onProvenance: (block: HTMLElement) => void = () => {}
  copies: (block: HTMLElement) => boolean = () => false
  copyOf: (block: HTMLElement) => string | undefined = () => undefined

  constructor(main: HTMLElement) {
    this.#main = main
    this.#mark.className = "block-link"
    this.#mark.hidden = true
    this.#gone.className = "block-gone"
    this.#gone.textContent = "The block this link points to is no longer on this page."
    this.#gone.hidden = true
    main.prepend(this.#gone)
    this.#past.className = "block-history"
    this.#past.innerHTML = ICONS.clock
    this.#past.title = "This block's past versions"
    this.#past.hidden = true
    this.#why.className = "block-provenance"
    this.#why.type = "button"
    this.#why.innerHTML = ICONS.info
    this.#why.title = "Where this block came from"
    this.#why.hidden = true
    this.#why.addEventListener("click", () => this.#block && this.onProvenance(this.#block))
    this.#copy.hidden = true
    main.append(this.#mark, this.#past, this.#why, this.#copy)
    main.addEventListener("pointerover", (event) => this.#over(event.target as Element))
    main.addEventListener("pointerleave", () => this.#hide())
    // A leave is lost when the element under the pointer is replaced while it is there.
    document.addEventListener("pointerover", (event) => {
      if (!main.contains(event.target as Node)) {
        this.#hide()
      }
    })
    document.addEventListener("folio:redraw", () => this.#hide())
    this.#mark.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return
      }

      event.preventDefault()
      this.gone(false)

      if (this.#block) {
        history.replaceState(history.state, "", this.#mark.hash)
        landOn(this.#block)
      }
    })
  }

  /** The block an address's `#^<id>` names: null when it is gone, undefined for any other address. */
  find(hash: string): HTMLElement | null | undefined {
    const id = fragmentOf(hash)

    return id.startsWith("^")
      ? this.#main.querySelector<HTMLElement>(
          `.markdown-body [data-folio-id="${CSS.escape(id.slice(1))}"]`,
        )
      : undefined
  }

  gone(shown: boolean): void {
    this.#gone.hidden = !shown
  }

  #over(target: Element): void {
    if (
      target === this.#mark ||
      this.#past.contains(target) ||
      this.#why.contains(target) ||
      this.#copy.contains(target)
    ) {
      return
    }

    const block = target.closest<HTMLElement>(".markdown-body [data-folio-id]")

    if (!block) {
      this.#hide()
      return
    }

    const article = block.closest(".markdown-body") as Element
    // A heading carries its own link mark, so only its provenance is offered here.
    const heading = block.matches("h1, h2, h3, h4, h5, h6")

    // Placed against the document: a positioned ancestor would change how the article's text is drawn.
    this.#block = block
    this.#mark.href = `#^${encodeURIComponent(block.dataset.folioId ?? "")}`
    this.#mark.setAttribute("aria-label", "Link to this block")
    this.#mark.style.top = `${block.getBoundingClientRect().top + scrollY}px`
    this.#mark.style.left = `${article.getBoundingClientRect().left + scrollX - MARGIN_PX}px`
    this.#mark.hidden = heading
    this.#past.href = `${href(block.dataset.folioSource ?? "")}?history&block=${encodeURIComponent(block.dataset.folioId ?? "")}`
    this.#past.style.top = this.#mark.style.top
    this.#past.style.left = `${article.getBoundingClientRect().right + scrollX}px`
    this.#past.hidden = heading
    this.#why.style.top = `calc(${this.#mark.style.top} + 1.25em)`
    this.#why.style.left = this.#past.style.left
    this.#why.hidden = false
    this.#copy.style.top = `calc(${this.#mark.style.top} + 2.5em)`
    this.#copy.style.left = this.#past.style.left
    this.#copy.hidden = !this.copies(block)
  }

  #hide(): void {
    this.#block = undefined
    this.#mark.hidden = true
    this.#past.hidden = true
    this.#why.hidden = true
    this.#copy.hidden = true
  }
}

/** The forced reflow between removing and adding the class replays the fade on a second landing. */
export function landOn(block: HTMLElement): void {
  reveal(block)
  block.scrollIntoView()
  block.classList.remove("landed")
  void block.offsetWidth
  block.classList.add("landed")
  block.addEventListener("animationend", () => block.classList.remove("landed"), { once: true })
}

/** An address's fragment as text: one holding an escape that does not decode is read as written. */
export function fragmentOf(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return hash.slice(1)
  }
}
