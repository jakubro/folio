/** Where the reader is on a page: the smallest thing at the reading line, found again after a redraw. */

export interface Place {
  spots: Spot[]
}

interface Spot {
  element: Element
  top: number
  path: Step[]
  codeLine?: Neighboured
}

interface Step extends Neighboured {
  tag: string
  id: string | null
  key: string
  sole: boolean
}

interface Neighboured {
  text: string
  at: number
  before: string | undefined
  after: string | undefined
}

const UNITS = new Set(["P", "TR", "PRE", "IMG", "HR", "SUMMARY", "DT", "DD", "FIGCAPTION", "A"])
/** A long table's header is pinned below the toolbar, so it stands at the line whatever is read. */
const PINNED = new Set(["THEAD", "CAPTION"])
const HEADING = /^H[1-6]$/
const HTML = "http://www.w3.org/1999/xhtml"
const AROUND = 4
const TEXT = 2000

/** The smallest unit read at a window line, what holds it, and the blocks nearest it, to stand in once it goes. */
export function hold(article: HTMLElement, line: number): Place {
  const path: Element[] = []

  for (let parent: Element = article; ; ) {
    const child = [...parent.children].find(
      (found) =>
        !PINNED.has(found.tagName) &&
        found.checkVisibility() &&
        found.getBoundingClientRect().bottom > line,
    )

    if (!child || (child.getBoundingClientRect().top > line && hasOwnText(parent, child))) {
      break
    }

    path.push(child)

    if (isUnit(child)) {
      break
    }

    parent = child
  }

  if (path.length === 0) {
    return { spots: [] }
  }

  const spots = path.toReversed().map((element) => spotOf(article, element))
  const unit = path.at(-1) as Element
  const code = unit.tagName === "PRE" ? unit.querySelector(":scope > code") : null
  const at = code ? lineAt(code, line) : undefined

  if (code && at !== undefined) {
    spots[0].codeLine = neighboured(linesOf(code), at)
    spots[0].top = lineTop(code, at) ?? spots[0].top
  }

  const block = path[0]
  const siblings = [...article.children].filter(
    (found) => found !== block && found.checkVisibility(),
  )
  const index = siblings.findIndex(
    (found) => block.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
  const near = (index < 0 ? siblings.slice(-AROUND) : siblings.slice(Math.max(0, index - AROUND)))
    .slice(0, AROUND * 2)
    .sort((a, b) => distance(a, line) - distance(b, line))

  return { spots: [...spots, ...near.map((element) => spotOf(article, element))] }
}

export function keep(place: Place, article: HTMLElement): void {
  for (const spot of place.spots) {
    const found = article.contains(spot.element) ? spot.element : follow(article, spot.path)

    if (!found?.checkVisibility()) {
      continue
    }

    const code =
      spot.codeLine && found.tagName === "PRE" ? found.querySelector(":scope > code") : null
    const at = code && spot.codeLine ? matching(linesOf(code), spot.codeLine) : undefined
    const top =
      (code && at !== undefined ? lineTop(code, at) : undefined) ??
      found.getBoundingClientRect().top

    scrollBy(0, top - spot.top)
    return
  }
}

function isUnit(element: Element): boolean {
  return (
    element.namespaceURI !== HTML ||
    UNITS.has(element.tagName) ||
    HEADING.test(element.tagName) ||
    (element.tagName === "LI" && !element.querySelector(":scope > :is(ul, ol)")) ||
    element.childElementCount === 0
  )
}

function spotOf(article: HTMLElement, element: Element): Spot {
  const path: Step[] = []

  for (let node: Element = element; node !== article && node.parentElement; ) {
    const parent: Element = node.parentElement
    const tag = node.tagName
    const alike = [...parent.children].filter((child) => child.tagName === tag)
    const key = keyOf(node)

    path.unshift({
      tag,
      id: identityOf(node),
      key,
      sole: key !== "" && alike.filter((child) => keyOf(child) === key).length === 1,
      ...neighboured(alike.map(textOf), alike.indexOf(node)),
    })
    node = parent
  }

  return { element, top: element.getBoundingClientRect().top, path }
}

/**
 * A step with an identity, or a key it alone held, finds only an element holding it, or for an identity one not
 * yet parsed (no id) or the one block now between its neighbours, never a stand-in for a removed block; one with
 * a shared key or neither finds itself among its kind by its neighbours, those holding the key first.
 */
function follow(article: HTMLElement, path: Step[]): Element | undefined {
  let node: Element = article

  for (const step of path) {
    const alike = [...node.children].filter((child) => child.tagName === step.tag)
    const texts = alike.map(textOf)
    const unparsed =
      alike[step.at] && identityOf(alike[step.at]) === null ? alike[step.at] : undefined
    const found =
      step.id !== null
        ? (alike.find((child) => identityOf(child) === step.id) ??
          alike.find((child) => identityOf(child) === null && textOf(child) === step.text) ??
          unparsed ??
          alike[rewritten(texts, step) ?? -1])
        : alike[(step.key ? keyed(alike, texts, step) : matching(texts, step)) ?? -1]

    if (!found) {
      return undefined
    }

    node = found
  }

  return node
}

/**
 * The same text nearest its place, its neighbours alike first; else the unit after its earlier neighbour or
 * before its later one; else its place.
 */
function matching(
  texts: string[],
  unit: Neighboured,
  fits: (at: number) => boolean = () => true,
): number | undefined {
  const near = nearest(texts, unit.at, fits)
  const same = texts.flatMap((text, at) => (text === unit.text ? [at] : []))
  const framed = same.filter((at) => texts[at - 1] === unit.before && texts[at + 1] === unit.after)
  const { before, after } = neighbours(texts, unit, fits)

  return (
    near(framed) ?? near(same) ?? before ?? after ?? near([Math.min(unit.at, texts.length - 1)])
  )
}

function keyed(alike: Element[], texts: string[], step: Step): number | undefined {
  const holders = alike.flatMap((child, at) => (keyOf(child) === step.key ? [at] : []))
  const held = matching(texts, step, (at) => holders.includes(at))

  return step.sole
    ? (held ?? (holders.length === 1 ? holders[0] : undefined))
    : (held ?? matching(texts, step))
}

/** A block gone from between neighbours that are both still there, one block now between them, was rewritten. */
function rewritten(texts: string[], unit: Neighboured): number | undefined {
  const { before, after } = neighbours(texts, unit)

  return unit.before === undefined
    ? after
    : unit.after === undefined || before === after
      ? before
      : undefined
}

function neighbours(
  texts: string[],
  unit: Neighboured,
  fits: (at: number) => boolean = () => true,
): { before: number | undefined; after: number | undefined } {
  const near = nearest(texts, unit.at, fits)

  return {
    before: near(
      texts.flatMap((text, at) =>
        unit.before !== undefined && text === unit.before ? [at + 1] : [],
      ),
    ),
    after: near(
      texts.flatMap((text, at) =>
        unit.after !== undefined && text === unit.after ? [at - 1] : [],
      ),
    ),
  }
}

function nearest(
  texts: string[],
  to: number,
  fits: (at: number) => boolean,
): (found: number[]) => number | undefined {
  return (found) =>
    found
      .filter((at) => at >= 0 && at < texts.length && fits(at))
      .sort((a, b) => Math.abs(a - to) - Math.abs(b - to))[0]
}

function neighboured(texts: string[], at: number): Neighboured {
  return { text: texts[at], at, before: texts[at - 1], after: texts[at + 1] }
}

/** What names an element no id does: its own id, a view's kind or folder, or for a unit what it links to. */
function keyOf(element: Element): string {
  const link = !isUnit(element)
    ? null
    : element.matches("a[href]")
      ? element
      : element.querySelector("a[href]")
  const { kind, folder } = (element as HTMLElement).dataset ?? {}

  return element.id || kind || folder || link?.getAttribute("href") || ""
}

function hasOwnText(parent: Element, child: Element): boolean {
  for (const node of parent.childNodes) {
    if (node === child) {
      return false
    }

    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      return true
    }
  }

  return false
}

function identityOf(element: Element): string | null {
  const id = element.getAttribute("data-folio-id")
  return id === null ? null : `${element.getAttribute("data-folio-source")}\0${id}`
}

function textOf(element: Element): string {
  return (element.textContent ?? "").slice(0, TEXT)
}

function distance(element: Element, line: number): number {
  const { top, bottom } = element.getBoundingClientRect()
  return top > line ? top - line : bottom < line ? line - bottom : 0
}

function linesOf(code: Element): string[] {
  return (code.textContent ?? "").replace(/\n$/, "").split("\n")
}

function lineAt(code: Element, line: number): number | undefined {
  const count = linesOf(code).length

  for (let at = 0; at < count; at++) {
    const top = lineTop(code, at + 1)

    if (top === undefined || top > line) {
      return at
    }
  }

  return undefined
}

function lineTop(code: Element, at: number): number | undefined {
  const starts = [
    0,
    ...[...(code.textContent ?? "").matchAll(/\n/g)].map((found) => found.index + 1),
  ]

  if (at >= starts.length) {
    return undefined
  }

  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let left = starts[at]

  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (left < node.length) {
      const range = document.createRange()
      range.setStart(node, left)
      range.setEnd(node, Math.min(node.length, left + 1))
      return range.getBoundingClientRect().top
    }

    left -= node.length
  }

  return undefined
}
