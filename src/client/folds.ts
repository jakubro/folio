/** Sections folded away under their headings, remembered per tab and page. */

import { button, ICONS } from "./icons.ts"

const FOLDED = "folio.folded"
const HEADING = /^H([1-6])$/
const owners = new WeakMap<Element, HTMLElement>()
let page = ""

/** Give each heading its fold control once, and fold what this tab folded on this page. */
export function foldable(article: HTMLElement, pagePath: string): void {
  const folded = new Set(remembered()[pagePath])
  page = pagePath

  for (const heading of article.querySelectorAll<HTMLElement>(":is(h1, h2, h3, h4, h5, h6)[id]")) {
    if (!heading.querySelector(":scope > .fold-toggle")) {
      const control = button("", "", "fold-toggle")
      // Both icons stay in the button: replacing the one under the pointer would lose its leave events.
      control.innerHTML = ICONS.zoomOut + ICONS.zoomIn
      control.addEventListener("click", (event) => {
        const folding = !heading.classList.contains("folded")
        event.preventDefault()

        if (folding) {
          fold(heading)
        } else {
          unfold(heading)
        }

        remember(heading, folding)
      })
      heading.prepend(control)
      show(heading, false)
    }

    if (folded.has(heading.id)) {
      fold(heading)
    }
  }
}

/** Put every folded section back in line, leaving what this tab remembers folded as it was. */
export function unfoldAll(article: HTMLElement): void {
  for (const body of article.querySelectorAll(".fold")) {
    const heading = owners.get(body)

    if (heading) {
      unfold(heading)
    }
  }
}

/** The article's top-level blocks in reading order, as if no section were folded. */
export function blocksOf(article: HTMLElement): Node[] {
  return [...article.childNodes].flatMap((node) =>
    node instanceof HTMLElement && owners.has(node) ? blocksOf(node) : [node],
  )
}

export function reveal(element: Element): void {
  const headings: HTMLElement[] = []

  for (let node = element.parentElement; node; node = node.parentElement) {
    const heading = owners.get(node)

    if (heading) {
      headings.push(heading)
    }
  }

  for (const heading of headings) {
    unfold(heading)
    remember(heading, false)
  }
}

function remember(heading: HTMLElement, folding: boolean): void {
  const all = remembered()
  const ids = new Set(all[page])

  if (folding) {
    ids.add(heading.id)
  } else {
    ids.delete(heading.id)
  }

  all[page] = [...ids]
  sessionStorage.setItem(FOLDED, JSON.stringify(all))
}

/** A heading in a collapsible block's title folds the block's content; any other, its later siblings. */
function fold(heading: HTMLElement): void {
  const start = heading.closest("summary") ?? heading
  const level = levelOf(heading)
  const body = document.createElement("div")

  unwrap(heading)
  body.className = "fold"
  // Hidden this way the browser's find still searches the section, and reveals it on a match.
  body.setAttribute("hidden", "until-found")
  // The browser unhides the section itself; moving its nodes now would lose the match.
  body.addEventListener("beforematch", () => {
    show(heading, false)
    remember(heading, false)
  })
  owners.set(body, heading)

  while (start.nextSibling && levelOf(start.nextSibling) > level) {
    body.append(start.nextSibling)
  }

  start.after(body)
  show(heading, true)
}

function unfold(heading: HTMLElement): void {
  unwrap(heading)
  show(heading, false)
}

function unwrap(heading: HTMLElement): void {
  const body = (heading.closest("summary") ?? heading).nextElementSibling

  if (body && owners.get(body) === heading) {
    body.replaceWith(...body.childNodes)
  }
}

function show(heading: HTMLElement, folded: boolean): void {
  const control = heading.querySelector(":scope > .fold-toggle") as HTMLButtonElement
  const label = folded ? "Unfold section" : "Fold section"

  heading.classList.toggle("folded", folded)
  const [unfolded, closed] = control.querySelectorAll("svg")
  unfolded.style.display = folded ? "none" : ""
  closed.style.display = folded ? "" : "none"
  control.title = label
  control.setAttribute("aria-label", label)
  control.setAttribute("aria-expanded", String(!folded))
}

/** A collapsible block titled by a heading ranks as that heading, so a section ends before it. */
export function levelOf(node: Node): number {
  const element = node instanceof HTMLElement ? node : undefined
  const titled = element?.matches("details")
    ? element.querySelector(":scope > summary :is(h1, h2, h3, h4, h5, h6)")
    : element
  const level = HEADING.exec(titled?.tagName ?? "")?.[1]

  return level ? Number(level) : Number.POSITIVE_INFINITY
}

function remembered(): Record<string, string[]> {
  return JSON.parse(sessionStorage.getItem(FOLDED) ?? "{}")
}
