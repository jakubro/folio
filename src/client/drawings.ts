/** A drawing's corner controls: a switch between the drawing and its source, and a copy of the source. */

import { copyButton } from "./copy.ts"
import { button, ICONS } from "./icons.ts"

type Kind = keyof typeof KINDS

const KINDS = {
  chart: { drawn: '[data-embed="chart"]', fence: "code.language-vega-lite" },
  diagram: { drawn: ".mermaid", fence: "code.language-mermaid" },
  map: { drawn: ".geo-map", fence: ":is(code.language-geojson, code.language-topojson)" },
  model: { drawn: ".stl-model", fence: "code.language-stl" },
}
/** Keyed by the block's id, which a save keeps for an edited block; a block mid-parse has none yet. */
const SHOWING = new Set<string>()
const SWITCHES = new WeakMap<Element, (shown: boolean) => Promise<void>>()
const SOURCES = new WeakMap<Element, () => string>()
const DECIDED = new WeakMap<Element, string>()

export function withSource(
  drawing: HTMLElement,
  source: () => string,
  prepare: () => void | Promise<void>,
  controls: HTMLElement[] = [],
): void {
  const toolbar = document.createElement("div")
  const toggle = button(ICONS.code, "Show source", "icon-button source-switch")
  const show = async (shown: boolean) => {
    if (shown) {
      await prepare()
    }

    const label = shown ? "Show the drawing" : "Show source"
    const { key, block } = placeOf(drawing)
    drawing.classList.toggle("showing-source", shown)
    toggle.setAttribute("aria-pressed", String(shown))
    toggle.title = label
    toggle.setAttribute("aria-label", label)
    DECIDED.set(drawing, block)

    if (shown) {
      SHOWING.add(key)
    } else {
      SHOWING.delete(key)
    }
  }

  SWITCHES.set(drawing, show)
  SOURCES.set(drawing, source)
  drawing.querySelector(":scope > .drawn-toolbar")?.remove()
  toolbar.className = "drawn-toolbar"
  toggle.addEventListener("click", () => void show(!drawing.classList.contains("showing-source")))
  toolbar.append(...controls, toggle, copyButton(source, "Copy source", "source-copy"))
  drawing.append(toolbar)
  void show(SHOWING.has(placeOf(drawing).key))
}

/** After a save, a drawing now standing for another block, or given its block's id at last, takes its state. */
export function reconcile(article: Element): void {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    for (const drawing of drawingsIn(article, kind)) {
      const show = SWITCHES.get(drawing)
      const { key, block } = placeOf(drawing, kind)

      if (show && DECIDED.get(drawing) !== block) {
        void show(SHOWING.has(key))
      } else if (show && drawing.classList.contains("showing-source")) {
        SHOWING.add(key)
      } else if (show) {
        SHOWING.delete(key)
      }
    }
  }
}

/**
 * A block shown twice - a section included twice - numbers its copies, so each keeps its own state.
 * A drawing inside a block - a list item's - is told by its source, as items come and go around it.
 */
function placeOf(drawing: Element, kind = kindOf(drawing)): { key: string; block: string } {
  const page = drawing.closest("article") ?? drawing
  const top = topOf(drawing, page) ?? drawing
  const file = fileOf(top)
  const id = top.getAttribute("data-folio-id")
  const lines = top.getAttribute("data-folio-lines")
  const copies = [...page.children].filter(
    (other) =>
      fileOf(other) === file &&
      other.getAttribute("data-folio-id") === id &&
      other.getAttribute("data-folio-lines") === lines,
  )
  const place = id ?? (lines ? `lines ${lines}` : `at ${drawingsIn(page, kind).indexOf(drawing)}`)

  const written = SOURCES.get(drawing)?.() ?? ""
  const within =
    top === drawing
      ? ""
      : `${written}\0${drawingsIn(top, kind)
          .filter((other) => (SOURCES.get(other)?.() ?? "") === written)
          .indexOf(drawing)}`

  return {
    key: [file, kind, place, copies.indexOf(top), within].join("\0"),
    block: `${file}\0${id ?? ""}`,
  }
}

function kindOf(drawing: Element): Kind {
  return (
    (Object.keys(KINDS) as Kind[]).find((kind) => drawing.matches(KINDS[kind].drawn)) ?? "diagram"
  )
}

/** A drawn map or model holds its fence: each drawing counts once, drawn or not. */
function drawingsIn(root: Element, kind: Kind): Element[] {
  const { drawn, fence } = KINDS[kind]
  const selector = `${drawn}, pre:not(${drawn} pre):has(> ${fence})`

  return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]
}

function fileOf(element: Element): string {
  return (
    element.closest("[data-folio-source]")?.getAttribute("data-folio-source") ??
    element.getAttribute("data-from") ??
    `${location.pathname}${location.search}`
  )
}

function topOf(element: Element, root: Element): Element | undefined {
  let node = element

  while (node.parentElement && node.parentElement !== root) {
    node = node.parentElement
  }

  return node.parentElement === root ? node : undefined
}
