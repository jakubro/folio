/**
 * Data a document embeds: `{table: ...}` on a line of its own, `{value: ...}` in a sentence, a
 * `vega-lite` fence, and a figure tied to data by `<data value="...">`, each drawn from the folder's
 * data once the page has rendered.
 */

import type { ElementContent, Element as HastElement, Nodes as HastNodes, Text } from "hast"
import type { Embedded } from "../server/data.ts"
import { singleValue, type Verdict, verdict } from "./claims.ts"
import { withSource } from "./drawings.ts"
import type { Theme } from "./render.ts"
import { literal } from "./unresolved.ts"

export const TABLE = /^\s*\{table:\s*([^}\n]+?)\s*\}\s*$/
/** A format follows a pipe set apart by spaces, so a key may hold a bare one. */
export const VALUE = /\{value:\s*([^}\n]+?)(?:\s+\|\s+([^}\n]*?))?\s*\}/g
const CHART = "language-vega-lite"
const WAIT_MS = 300
const VERSIONS = new WeakMap<HTMLElement, Map<string, string>>()
const FLIGHT = new WeakMap<HTMLElement, Promise<void>>()

/**
 * Turn the embeds in a top-level block, at any depth, into placeholders; run after sanitizing, so a page
 * cannot forge one. `queries` holds the page lines `sql query` fences open on; `lineIn` maps a page line
 * to its line in `from`.
 */
export function markEmbeds(
  node: HastElement,
  from: string,
  queries: Map<number, string>,
  lineIn: (line: number) => number,
): void {
  if (!mark(node, from, queries, lineIn)) {
    values(node, from, (child) => mark(child, from, queries, lineIn))
  }
}

function mark(
  node: HastElement,
  from: string,
  queries: Map<number, string>,
  lineIn: (line: number) => number,
): boolean {
  const alone = node.children.length === 1 && node.children[0]
  const table = alone && alone.type === "text" ? TABLE.exec(alone.value) : null

  // A tight list item holds its text without a paragraph, so the table goes inside the item.
  if (table && (node.tagName === "p" || node.tagName === "li")) {
    const embed: HastElement = {
      type: "element",
      tagName: "div",
      properties: placeholder("table", table[1], from),
      children: [{ type: "text", value: table[0].trim() }],
    }

    if (node.tagName === "li") {
      node.children = [embed]
    } else {
      Object.assign(node, { ...embed, properties: { ...node.properties, ...embed.properties } })
    }

    return true
  }

  if (node.tagName === "data") {
    const reference = String(node.properties.value ?? "").trim()

    if (reference && textOf(node).trim()) {
      Object.assign(node, {
        tagName: "span",
        properties: { ...placeholder("claim", reference, from), dataFigure: literal(textOf(node)) },
      })
    }

    return true
  }

  const line = node.position?.start.line
  const query = node.tagName === "pre" && line !== undefined ? queries.get(line) : undefined

  if (query !== undefined && line !== undefined) {
    markQuery(node, from, query || `@${lineIn(line)}`)
    return true
  }

  const code = node.tagName === "pre" ? node.children[0] : undefined

  if (code?.type === "element" && classes(code).includes(CHART)) {
    Object.assign(node, {
      tagName: "div",
      properties: { ...node.properties, ...placeholder("chart", "", from) },
      children: [{ ...node, tagName: "pre", properties: {} }],
    })
    return true
  }

  return false
}

function markQuery(node: HastElement, from: string, key: string): void {
  Object.assign(node, {
    tagName: "div",
    properties: { ...node.properties, ...placeholder("query", `#${key}`, from) },
    children: [
      {
        type: "element",
        tagName: "details",
        properties: { className: ["query-text"] },
        children: [
          {
            type: "element",
            tagName: "summary",
            properties: {},
            children: [{ type: "text", value: "Query" }],
          },
          { ...node, properties: {} },
        ],
      },
    ],
  })
}

/** The version of every reference each embed in an element read, keyed by its document and reference. */
export function embedVersions(within: HTMLElement): Record<string, string> {
  const found: Record<string, string> = {}
  const embeds = [
    ...(within.matches("[data-embed]") ? [within] : []),
    ...within.querySelectorAll<HTMLElement>("[data-embed]"),
  ]

  for (const element of embeds) {
    for (const [reference, version] of VERSIONS.get(element) ?? []) {
      found[`${element.dataset.from}\n${reference}`] = version
    }
  }

  return found
}

/**
 * Draw again each embed of an article reading a changed reference, once any draw of it under way has
 * ended, and only while it does not already show the version the change names.
 */
export function redrawEmbeds(
  article: HTMLElement,
  key: string,
  theme: Theme,
  version: string | null,
): Promise<void>[] {
  const [from, reference] = key.split("\n")

  return [...article.querySelectorAll<HTMLElement>("[data-embed]")]
    .filter(
      (element) =>
        element.dataset.from === from &&
        (VERSIONS.get(element)?.has(reference) ||
          (FLIGHT.has(element) && element.dataset.ref === reference)),
    )
    .map(async (element) => {
      while (FLIGHT.has(element)) {
        await FLIGHT.get(element)
      }

      if (VERSIONS.get(element)?.get(reference) !== version) {
        await draw(element, theme)
      }
    })
}

export async function drawEmbeds(blocks: Node[], theme: Theme): Promise<void> {
  const found = blocks.flatMap((block) =>
    block instanceof Element
      ? [
          ...(block.matches("[data-embed]") ? [block] : []),
          ...block.querySelectorAll("[data-embed]"),
        ]
      : [],
  ) as HTMLElement[]

  const drawn = Promise.all(found.map((element) => draw(element, theme)))

  // Most embeds answer at once and draw with the page; a slow one draws later, never holding it up.
  await Promise.race([drawn, new Promise((resolve) => setTimeout(resolve, WAIT_MS))])
}

/** Every draw of an element is known while it runs, so a change told meanwhile waits for it. */
function draw(element: HTMLElement, theme: Theme): Promise<void> {
  const running = drawing(element, theme).finally(() => {
    if (FLIGHT.get(element) === running) {
      FLIGHT.delete(element)
    }
  })
  FLIGHT.set(element, running)
  return running
}

async function drawing(element: HTMLElement, theme: Theme): Promise<void> {
  const { embed: kind, ref = "", from = "", format } = element.dataset

  try {
    if (kind === "query") {
      const { gridTable } = await import("./data.ts")
      const embedded = await fetchEmbed(element, from, ref)
      const grid = embedded.grid as NonNullable<Embedded["grid"]>
      const notes = grid.partial
        ? [note(`The first ${grid.rows.length} rows of a longer result.`)]
        : []

      const result = Object.assign(document.createElement("div"), { className: "query-result" })
      result.append(...notes, gridTable(grid))
      steady(element, () => {
        element.querySelector(":scope > .query-result")?.remove()
        element.append(result)
        element.classList.remove("embed-missing")
      })
      return
    }

    if (kind === "chart") {
      // Drawn, the chart would hide its source and the marker of the include it is missing.
      if (element.querySelector(".include-missing")) {
        throw new Error("An include in this chart resolves to nothing.")
      }

      const { chartOf } = await import("./charts.ts")
      let partial = false
      const chart = await chartOf(element, theme, async (reference: string) => {
        const embedded = await fetchEmbed(element, from, reference)
        partial ||= embedded.grid?.partial === true
        return embedded
      })

      if (partial) {
        chart.append(note("Drawn from the first rows of a longer result."))
      }

      steady(element, () => {
        element.querySelector(":scope > .chart")?.remove()
        element.querySelector(":scope > .chart-reason")?.remove()
        element.append(chart)
        element.classList.add("drawn")
        element.classList.remove("embed-missing")
        withSource(
          element,
          () => element.querySelector(":scope > pre > code")?.textContent?.replace(/\n$/, "") ?? "",
          () => highlighted(element.querySelector(":scope > pre > code")),
        )
      })
      return
    }

    if (kind === "claim") {
      if (element.querySelector(".include-missing")) {
        unchecked(element, "An include in this figure resolves to nothing.")
        return
      }

      const value = singleValue(await fetchEmbed(element, from, ref))
      let checked: Verdict

      try {
        checked = verdict(element.dataset.figure ?? "", value)
      } catch (error) {
        unchecked(element, (error as Error).message)
        return
      }

      const { state, live } = checked

      steady(element, () => {
        element.querySelector(":scope > .claim-live")?.remove()
        element.classList.remove("embed-missing", "claim-contradicted")
        element.removeAttribute("title")

        if (state === "contradicted") {
          element.classList.add("claim-contradicted")
          element.title = `The data says ${live}`
          element.append(
            Object.assign(document.createElement("span"), {
              className: "claim-live",
              textContent: live,
            }),
          )
        }
      })
      return
    }

    const embedded = await fetchEmbed(element, from, ref)
    let shown: Node

    if (kind === "value") {
      const value = singleValue(embedded)
      shown = document.createTextNode(
        format && typeof value === "number"
          ? (await import("d3-format")).format(format)(value)
          : String(value ?? ""),
      )
    } else {
      const { gridTable, recordsTable } = await import("./data.ts")
      const records = embedded.grid ? undefined : recordsTable(listOf(embedded.value))
      const rows = embedded.grid?.rows.length ?? records?.shown
      shown = document.createDocumentFragment()
      shown.appendChild(
        embedded.grid
          ? gridTable(embedded.grid)
          : (records?.table ??
              Object.assign(document.createElement("p"), {
                textContent: String(singleValue(embedded)),
              })),
      )

      if (embedded.grid?.partial || (records && records.shown < records.total)) {
        shown.insertBefore(note(`The first ${rows} rows of a longer result.`), shown.firstChild)
      }
    }

    steady(element, () => {
      element.replaceChildren(shown)
      element.classList.remove("embed-missing")
      element.removeAttribute("title")
    })
  } catch (error) {
    const reason = (error as Error).message

    steady(element, () => {
      element.classList.add("embed-missing")
      element.title = reason

      if (kind === "query") {
        element.querySelector(":scope > .query-result")?.remove()
        element.append(
          Object.assign(document.createElement("p"), {
            className: "query-result",
            textContent: reason,
          }),
        )
        element.querySelector("details")?.setAttribute("open", "")
      } else if (kind === "chart") {
        element.querySelector(":scope > .chart")?.remove()
        element.querySelector(":scope > .chart-reason")?.remove()
        element.querySelector(":scope > .drawn-toolbar")?.remove()
        element.classList.remove("drawn", "showing-source")
        element.append(
          Object.assign(document.createElement("p"), {
            className: "chart-reason",
            textContent: reason,
          }),
        )
      } else if (kind === "claim") {
        element.querySelector(":scope > .claim-live")?.remove()
        element.classList.remove("claim-contradicted")
      } else {
        element.textContent = reason.includes(ref) ? reason : `${ref}: ${reason}`
      }
    })
  }
}

async function highlighted(code: HTMLElement | null): Promise<void> {
  if (!code || code.classList.contains("hljs")) {
    return
  }

  const [{ default: hljs }, { default: json }, { default: yaml }] = await Promise.all([
    import("highlight.js/lib/core"),
    import("highlight.js/lib/languages/json"),
    import("highlight.js/lib/languages/yaml"),
  ])
  const text = code.textContent ?? ""
  const language = /^\s*[[{]/.test(text) ? "json" : "yaml"

  hljs.registerLanguage("json", json)
  hljs.registerLanguage("yaml", yaml)
  code.innerHTML = hljs.highlight(text, { language }).value
  code.classList.add("hljs")
}

function unchecked(element: HTMLElement, reason: string): void {
  steady(element, () => {
    element.querySelector(":scope > .claim-live")?.remove()
    element.classList.remove("embed-missing", "claim-contradicted")
    element.title = reason
  })
}

/**
 * A change above where the reader is reading would push the text away; the page scrolls to follow it.
 * Announced in the same task, so a table drawn anew has its view back before the browser paints.
 */
function steady(element: HTMLElement, change: () => void): void {
  const line = document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0
  const before = element.getBoundingClientRect()

  change()
  element.dispatchEvent(new CustomEvent("folio:embedded", { bubbles: true }))

  if (element.isConnected && before.bottom <= line) {
    scrollBy(0, element.getBoundingClientRect().height - before.height)
  }
}

export function rowsOf(embedded: Embedded): Record<string, unknown>[] {
  if (embedded.grid) {
    const { columns, rows } = embedded.grid
    return rows.map((row) => Object.fromEntries(columns.map(({ name }, i) => [name, row[i]])))
  }

  if (Array.isArray(embedded.value)) {
    return embedded.value.map((item) =>
      item !== null && typeof item === "object" ? item : { value: item },
    )
  }

  throw new Error("Not a list of rows.")
}

/** The server answers a missing reference with its reason in the body; that reason rejects. */
async function fetchEmbed(
  element: HTMLElement,
  from: string,
  reference: string,
): Promise<Embedded> {
  const address = from.split("/").map(encodeURIComponent).join("/")
  const response = await fetch(`/${address}?embed=${encodeURIComponent(reference)}`)
  const embedded: Embedded = response.ok
    ? await response.json()
    : { version: "", error: "Not found." }

  VERSIONS.set(element, (VERSIONS.get(element) ?? new Map()).set(reference, embedded.version))

  if (embedded.error) {
    throw new Error(embedded.error)
  }

  return embedded
}

function listOf(value: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    return value
  }

  const entries = Object.entries(value)

  if (
    entries.every(([, item]) => item !== null && typeof item === "object" && !Array.isArray(item))
  ) {
    return entries.map(([key, item]) => ({ key, ...(item as object) }))
  }

  return entries.map(([key, item]) => ({ key, value: item }))
}

function values(node: HastNodes, from: string, marked: (node: HastElement) => boolean): void {
  if (node.type !== "element" && node.type !== "root") {
    return
  }

  if (node.type === "element" && ["code", "pre", "kbd", "samp"].includes(node.tagName)) {
    return
  }

  node.children = node.children.flatMap((child): ElementContent[] => {
    if (child.type !== "text") {
      if (child.type !== "element" || !marked(child)) {
        values(child, from, marked)
      }

      return [child as ElementContent]
    }

    return split(child, from)
  }) as typeof node.children
}

function split(text: Text, from: string): ElementContent[] {
  const parts: ElementContent[] = []
  let last = 0

  for (const match of text.value.matchAll(VALUE)) {
    parts.push({ type: "text", value: text.value.slice(last, match.index) })
    parts.push({
      type: "element",
      tagName: "span",
      properties: {
        ...placeholder("value", match[1], from),
        ...(match[2] && { dataFormat: match[2] }),
      },
      children: [{ type: "text", value: match[0] }],
    })
    last = match.index + match[0].length
  }

  if (last === 0) {
    return [text]
  }

  parts.push({ type: "text", value: text.value.slice(last) })
  return parts.filter((part) => part.type !== "text" || part.value)
}

function textOf(node: HastNodes): string {
  return node.type === "text"
    ? node.value
    : "children" in node
      ? node.children.map((child) => textOf(child as HastNodes)).join("")
      : ""
}

function note(text: string): HTMLParagraphElement {
  return Object.assign(document.createElement("p"), { className: "data-info", textContent: text })
}

function placeholder(kind: string, reference: string, from: string): HastElement["properties"] {
  return {
    className: ["embed", `embed-${kind}`],
    dataEmbed: kind,
    ...(reference && { dataRef: reference }),
    dataFrom: from,
  }
}

function classes(element: HastElement): string[] {
  const names = element.properties.className
  return Array.isArray(names) ? names.map(String) : []
}
