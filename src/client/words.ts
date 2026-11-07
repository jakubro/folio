/** A word holding a hyphen or dash stays whole on its line, breaking at it only when the line is too narrow. */

const DASHES = "\\-\\u2010-\\u2015"
const SPLIT = new RegExp(`[${DASHES}][^\\s${DASHES}]`)
const WORD = new RegExp(`\\S*[${DASHES}]+[^\\s${DASHES}]\\S*`, "g")
const SKIPPED = "pre, svg, math, .katex, script, style, textarea, input, select, button"
// Panels showing a block's past text set it in a pre, though it is prose.
const PROSE = ".history-text, .mark-panel-text"
const CELLS = "td, th"
const WATCHED = new Map<Element, number>()
let resized: ResizeObserver | undefined

/** Wrap each word holding a hyphen or dash, its punctuation included, in an element held unbroken. */
export function keepWhole(root: Node): void {
  const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  )
  const found: Text[] = []

  for (
    let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    node;
    node = walker.nextNode()
  ) {
    const text = node as Text

    if (SPLIT.test(text.data) && placing(text) !== "none") {
      found.push(text)
    }
  }

  for (const text of found) {
    const parts: (string | HTMLElement)[] = []
    let from = 0

    for (const match of text.data.matchAll(WORD)) {
      const whole = text.ownerDocument.createElement("span")
      whole.className = "whole"
      whole.textContent = match[0]
      parts.push(text.data.slice(from, match.index), whole)
      from = match.index + match[0].length
    }

    parts.push(text.data.slice(from))

    if (placing(text) === "run") {
      const run = text.ownerDocument.createElement("span")
      run.append(...parts)
      text.replaceWith(run)
    } else {
      text.replaceWith(...parts.filter((part) => part !== ""))
    }
  }
}

/**
 * A word held unbroken breaks again when wider than its block, or in a cell of a table that scrolls sideways.
 * Measured after layout, and again whenever the width of a root given here changes.
 */
export function fitWhole(root: Element): void {
  resized ??= new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      if (!target.isConnected) {
        resized?.unobserve(target)
        WATCHED.delete(target)
      } else if (WATCHED.get(target) !== contentRect.width) {
        WATCHED.set(target, contentRect.width)
        fitIn(target)
      }
    }
  })

  if (!WATCHED.has(root)) {
    WATCHED.set(root, -1)
    resized.observe(root)
  }

  fitIn(root)
}

export function keepAddedWhole(root: Element): void {
  new MutationObserver((records) => {
    const changed = new Set<Element>()

    for (const { addedNodes } of records) {
      for (const node of addedNodes) {
        const parent = node.parentElement

        if (
          node.isConnected &&
          parent &&
          (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE)
        ) {
          keepWhole(node)
          changed.add(parent)
        }
      }
    }

    for (const parent of changed) {
      fitIn(parent.closest("table")?.parentElement ?? parent)
    }
  }).observe(root, { childList: true, subtree: true })
  fitWhole(root)
}

function fitIn(root: Element): void {
  const tables = [...root.querySelectorAll<HTMLTableElement>("table")].filter((table) =>
    table.querySelector(".whole"),
  )
  const words = [...root.querySelectorAll<HTMLElement>(".whole")]

  for (const table of tables) {
    table.classList.remove("loose")
  }

  for (const word of words) {
    word.classList.remove("split")
  }

  // Each pass reads every size before it changes a class; words go first, so a word let break widens no table.
  const rooms = new Map<Element, number>()
  const blocks = new Map<Element, Element | null>()
  const split = words.filter((word) => {
    const block = blockOf(word, blocks)
    // A cell widens to hold its words; a table that then scrolls sideways is let loose instead.
    return (
      block !== null &&
      !block.matches(CELLS) &&
      word.getBoundingClientRect().width > roomIn(block, rooms) + 1
    )
  })

  for (const word of split) {
    word.classList.add("split")
  }

  const loose = tables.filter((table) => table.scrollWidth > table.clientWidth + 1)

  for (const table of loose) {
    table.classList.add("loose")
  }
}

function blockOf(word: Element, blocks: Map<Element, Element | null>): Element | null {
  const parent = word.parentElement

  if (!parent) {
    return null
  }

  let block = blocks.get(parent)

  if (block === undefined) {
    block = parent

    while (block && ["inline", "contents"].includes(getComputedStyle(block).display)) {
      block = block.parentElement
    }

    blocks.set(parent, block)
  }

  return block
}

function roomIn(block: Element, rooms: Map<Element, number>): number {
  let room = rooms.get(block)

  if (room === undefined) {
    const style = getComputedStyle(block)
    room =
      block.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight)
    rooms.set(block, room)
  }

  return room
}

/**
 * In a flex or grid parent each piece of a text cut around its words would become an item, so they keep one run.
 * A detached node has no style to read; only an article's own text is drawn detached.
 */
function placing(text: Text): "none" | "words" | "run" {
  const parent = text.parentElement

  if (!parent || parent.closest(".whole") || (parent.closest(SKIPPED) && !parent.closest(PROSE))) {
    return "none"
  }

  const { whiteSpace, display } = parent.isConnected
    ? getComputedStyle(parent)
    : { whiteSpace: "", display: "" }

  return whiteSpace === "nowrap" || whiteSpace === "pre"
    ? "none"
    : /flex|grid/.test(display)
      ? "run"
      : "words"
}
