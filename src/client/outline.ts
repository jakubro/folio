/** The outline beside every page: its headings, the one being read highlighted, its problems. */

import type { Problem } from "../server/health.ts"

const PANELS = new WeakMap<HTMLElement, HTMLElement>()
const PROBLEMS_SHOWN = 5
const SCROLL_KEYS = new Set([" ", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"])

/** A page drawing a side panel of its own shows it in place of its headings. */
export function panelOf(article: HTMLElement, panel: HTMLElement): void {
  PANELS.set(article, panel)
}

export class Outline {
  readonly element = document.createElement("aside")
  readonly header = document.createElement("div")
  readonly footer = document.createElement("div")
  readonly related = document.createElement("div")
  readonly #problems = document.createElement("div")
  #headings: HTMLElement[] = []
  #section: HTMLElement | undefined
  #links: HTMLAnchorElement[] = []
  #scheduled = false
  #following = true
  onSection: (heading: HTMLElement | undefined) => void = () => {}

  constructor() {
    this.element.className = "outline"
    this.element.setAttribute("aria-label", "Outline")
    this.#problems.className = "outline-problems"
    this.#problems.hidden = true
    window.addEventListener("scroll", () => this.#schedule(), { passive: true })
    window.addEventListener("resize", () => this.#schedule())
    new ResizeObserver(() => this.#schedule()).observe(document.body)
    const stay = () => {
      this.#following = false
    }

    for (const type of ["wheel", "touchmove"]) {
      this.element.addEventListener(type, stay, { passive: true })
    }

    // A press on the panel itself past its content's width is a press on its scrollbar.
    this.element.addEventListener("pointerdown", (event) => {
      if (event.target === this.element && event.offsetX >= this.element.clientWidth) {
        stay()
      }
    })
    this.element.addEventListener("keydown", (event) => {
      if (SCROLL_KEYS.has(event.key) && !(event.target as Element).closest("button")) {
        stay()
      }
    })
    this.element.addEventListener("click", (event) => {
      const plain =
        event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey

      if (plain && (event.target as Element).closest("a[href]")) {
        this.follow()
      }
    })
  }

  follow(): void {
    this.#following = true
    this.#schedule()
  }

  build(article: HTMLElement): void {
    const panel = PANELS.get(article)

    if (panel) {
      this.#headings = []
      this.#links = []
      this.element.replaceChildren(this.header, panel, this.footer, this.related)
      return
    }

    this.#headings = [
      ...article.querySelectorAll<HTMLElement>(
        "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], summary[id][data-outline]",
      ),
    ].filter((heading) => !folded(heading))
    this.#links = this.#headings.map((heading) => {
      const link = document.createElement("a")
      const details = heading.matches("summary") ? heading.parentElement : null
      link.href = `#${encodeURIComponent(heading.id)}`
      link.textContent = ownText(heading)
      link.className = `outline-${details ? `h${heading.dataset.outline}` : heading.tagName.toLowerCase()}`

      if (details instanceof HTMLDetailsElement) {
        link.addEventListener("click", () => {
          details.open = true
        })
      }

      return link
    })

    if (this.#links.length === 0) {
      const empty = document.createElement("p")
      empty.className = "panel-empty"
      empty.textContent = "No headings"
      this.element.replaceChildren(this.header, empty, this.#problems, this.footer, this.related)
    } else {
      this.element.replaceChildren(
        this.header,
        ...this.#links,
        this.#problems,
        this.footer,
        this.related,
      )
    }

    this.#highlight()
  }

  showProblems(problems: Problem[], land: (problem: Problem) => void): void {
    const links = problems.map((problem) => {
      const link = document.createElement("a")
      link.className = "outline-problem"
      link.href = problem.anchor
        ? `#${encodeURIComponent(problem.anchor)}`
        : problem.block
          ? `#^${encodeURIComponent(problem.block)}`
          : `#L${problem.line}`
      link.append(
        Object.assign(document.createElement("span"), {
          className: "outline-problem-line",
          textContent: String(problem.line),
        }),
        ` ${problem.what}`,
      )
      link.addEventListener("click", (event) => {
        event.preventDefault()
        land(problem)
      })
      return link
    })
    const rest = links.slice(PROBLEMS_SHOWN)
    const more = Object.assign(document.createElement("button"), {
      type: "button",
      className: "outline-problems-more",
      textContent: `${rest.length} more`,
    })

    more.addEventListener("click", () => more.replaceWith(...rest))
    this.#problems.hidden = links.length === 0
    this.#problems.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "outline-problems-title",
        textContent: "Problems",
      }),
      ...links.slice(0, PROBLEMS_SHOWN),
      ...(rest.length > 0 ? [more] : []),
    )
  }

  #schedule(): void {
    if (!this.#scheduled) {
      this.#scheduled = true
      requestAnimationFrame(() => {
        this.#scheduled = false
        this.#highlight()
      })
    }
  }

  /**
   * The current section is the last shown heading scrolled past the toolbar; at the very bottom of
   * the page it is the last shown heading, which may never reach the top.
   */
  #highlight(): void {
    const line = (document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0) + 16
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2
    const shown = [...this.#headings.entries()].filter(([, heading]) => heading.checkVisibility())
    let current = (atBottom ? shown.at(-1) : shown[0])?.[0] ?? -1

    if (!atBottom) {
      for (const [index, heading] of shown) {
        if (heading.getBoundingClientRect().top > line) {
          break
        }

        current = index
      }
    }

    for (const [index, link] of this.#links.entries()) {
      link.classList.toggle("current", index === current)
    }

    if (this.#headings[current] !== this.#section) {
      this.#section = this.#headings[current]
      this.onSection(this.#section)
    }

    this.#reveal(this.#links[current])
  }

  /** Scrolls only the outline itself; scrollIntoView would also scroll the page being read. */
  #reveal(link: HTMLAnchorElement | undefined): void {
    if (!link || !this.#following) {
      return
    }

    const top =
      link.getBoundingClientRect().top -
      this.element.getBoundingClientRect().top -
      this.element.clientTop +
      this.element.scrollTop
    const bottom = top + link.offsetHeight

    if (top < this.element.scrollTop) {
      this.element.scrollTop = top
    } else if (bottom > this.element.scrollTop + this.element.clientHeight) {
      this.element.scrollTop = bottom - this.element.clientHeight
    }
  }
}

/** A block's title stays in view while it is closed, so only a heading in its content is folded away. */
function folded(heading: Element): boolean {
  for (
    let details = heading.closest("details");
    details;
    details = details.parentElement?.closest("details") ?? null
  ) {
    if (!details.querySelector(":scope > summary")?.contains(heading)) {
      return true
    }
  }

  return false
}

/** A tied figure the data contradicts shows the data's value beside it; the heading's text is what was typed. */
function ownText(heading: HTMLElement): string {
  const copy = heading.cloneNode(true) as HTMLElement

  for (const live of copy.querySelectorAll(".claim-live")) {
    live.remove()
  }

  return copy.textContent ?? ""
}
