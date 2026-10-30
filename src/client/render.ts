/**
 * Renders markdown: frontmatter, GFM, sanitized inline HTML, math, highlighted code and mermaid
 * diagrams, with heading anchors for the outline and deep links.
 */

import type { ElementContent, Nodes as HastNodes, Root as HastRoot } from "hast"
import { toString as textOf } from "hast-util-to-string"
import type { Nodes as MdastNodes, Root as MdastRoot } from "mdast"
import rehypeSanitize from "rehype-sanitize"
import rehypeSlug from "rehype-slug"
import rehypeStringify from "rehype-stringify"
import remarkFrontmatter from "remark-frontmatter"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import type { PageBlock } from "../server/model.ts"
import type { PageLayout } from "../server/versions.ts"
import { ALERTS, alerts } from "./alerts.ts"
import { backticks } from "./backticks.ts"
import { copyButton } from "./copy.ts"
import { withSource } from "./drawings.ts"
import { drawEmbeds, markEmbeds } from "./embeds.ts"
import { ICONS } from "./icons.ts"
import { byteOrderMark, moveSpan, type Span, setSpan, sitesIn } from "./markdown.ts"
import { SCHEMA } from "./schema.ts"
import { table, tables } from "./tables.ts"
import { MARKED, markers, shown, spelledIn, unmarked, unmarkedAddress } from "./unresolved.ts"
import { expandable } from "./zoom.ts"

export type Theme = "light" | "dark"
type Rgb = [number, number, number]
type Rgba = [number, number, number, number]
type OwnBackgrounds = [HTMLElement, string][]

export interface Sources {
  blocks: PageBlock[]
  layout: PageLayout
}

interface Source {
  id?: string
  version?: string
  source: string
  lines?: [number, number]
}

const MARKDOWN = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkMath)
  .use(backticks)
  .use(tables)
  .use(alerts)
const MATH_CLASSES = ["language-math", "math-display", "math-inline"]
const PLAIN_CODE = new Set(["mermaid", "math", "vega-lite", "stl"])
const SOURCE_ATTRIBUTES = [
  "data-folio-id",
  "data-folio-source",
  "data-folio-lines",
  "data-folio-version",
]

const DIAGRAM_FONT =
  '"Arimo", "KaTeX_Main", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'
const DIAGRAM_THEMES = {
  light: {
    theme: "default",
    themeVariables: { fontFamily: DIAGRAM_FONT },
  },
  dark: {
    theme: "dark",
    themeVariables: {
      fontFamily: DIAGRAM_FONT,
      primaryColor: "#2d2d30",
      primaryTextColor: "#cccccc",
      primaryBorderColor: "#3c3c3c",
      lineColor: "#808080",
      secondaryColor: "#212122",
      tertiaryColor: "#1a1a1a",
      background: "#1a1a1a",
      mainBkg: "#2d2d30",
      nodeBorder: "#3c3c3c",
      clusterBkg: "#212122",
      clusterBorder: "#3c3c3c",
      titleColor: "#cccccc",
      edgeLabelBackground: "#212122",
      nodeTextColor: "#cccccc",
      dropShadow: "none",
    },
  },
} as const
const INKS: Rgb[] = [
  [51, 51, 51],
  [204, 204, 204],
]
const PAGES: Record<Theme, Rgb> = { light: [255, 255, 255], dark: [26, 26, 26] }
const FILLS = /fill\s*:\s*([a-z]+\([^)]*\)|[^\s,;]+)/gi
const HEX = /^#[0-9a-fA-F]{6}$/
const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/
const HSL = /^hsl\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*\)$/
const SOLID = /\bsolid\b[\s\S]*\bendsolid\b/

let diagrams = 0
let canvas: CanvasRenderingContext2D | undefined
let webglFound: boolean | undefined
/** Keyed before drawing: drawn markup carries per-render diagram ids, so it would never match itself. */
const KEYS = new WeakMap<Node, string>()

/** Render a markdown or mermaid file's text into a detached element, ready to swap into the page. */
export async function render(
  text: string,
  sources: Sources,
  kind: "markdown" | "mermaid",
  theme: Theme,
  owner: Document = document,
  still = false,
): Promise<HTMLElement> {
  const element = await markup(text, sources, kind, theme, owner, still)
  await drawBlocks([...element.childNodes], theme, owner)
  return element
}

/**
 * Render a file's text into a detached element whose blocks carry their keys but are not drawn yet.
 * A still rendering, of text that is not the file's own today, leaves embeds as written.
 */
export async function markup(
  text: string,
  sources: Sources,
  kind: "markdown" | "mermaid",
  theme: Theme,
  owner: Document = document,
  still = false,
): Promise<HTMLElement> {
  const element = owner.createElement("article")
  element.className = "markdown-body"
  element.dataset.theme = theme

  if (kind === "markdown") {
    const { html, spans } = await markdownHtml(text, sources, still)
    element.innerHTML = html

    for (const block of element.querySelectorAll(":scope > [data-folio-span]")) {
      setSpan(block, spans[Number(block.getAttribute("data-folio-span"))])
      block.removeAttribute("data-folio-span")
    }
  } else {
    const pre = element.appendChild(owner.createElement("pre"))
    const fence = pre.appendChild(owner.createElement("code"))
    fence.className = "language-mermaid"
    fence.textContent = shown(text)
    setSource(pre, sourceOf(sources, 1, text.trimEnd().split("\n").length))
    setSpan(pre, { parts: [[0, text.length]], sites: [] })
  }

  markIncludes(element)

  for (const node of element.childNodes) {
    KEYS.set(node, node instanceof Element ? keyed(node) : `${node.nodeType}:${node.textContent}`)
  }

  return element
}

/**
 * Give a block kept through an update the source its new rendering carries, telling whether its
 * identity changed. A rendering still parsing keeps the id of a block that stays in the same file.
 */
export function moveSource(from: Element, to: Element, parsing: boolean): boolean {
  const identity = () =>
    `${to.getAttribute("data-folio-id")}\0${to.getAttribute("data-folio-source")}`
  const was = identity()
  moveSpan(from, to)
  const keep =
    parsing &&
    !from.hasAttribute("data-folio-id") &&
    from.getAttribute("data-folio-source") === to.getAttribute("data-folio-source")

  for (const name of SOURCE_ATTRIBUTES) {
    const value = from.getAttribute(name)

    if (value !== null) {
      to.setAttribute(name, value)
    } else if (!(keep && name === "data-folio-id")) {
      to.removeAttribute(name)
    }
  }

  return identity() !== was
}

/** Tell the key a block was rendered with, if it is a top-level block of a rendered article. */
export function keyOf(node: Node): string | undefined {
  return KEYS.get(node)
}

/** Draw blocks made by markup: links out open a tab, headings get their mark, diagrams draw. */
export async function drawBlocks(
  blocks: Node[],
  theme: Theme,
  owner: Document = document,
): Promise<void> {
  for (const link of within<HTMLAnchorElement>(blocks, "a[href]")) {
    const href = link.getAttribute("href") ?? ""

    if (
      URL.canParse(href, location.href) &&
      new URL(href, location.href).origin !== location.origin
    ) {
      link.target = "_blank"
      link.rel = "noopener noreferrer"
    }
  }

  for (const heading of within(blocks, ":is(h1, h2, h3, h4, h5, h6)[id]")) {
    const mark = owner.createElement("a")
    mark.className = "heading-link"
    mark.href = `#${encodeURIComponent(heading.id)}`
    mark.setAttribute("aria-label", `Link to ${heading.textContent}`)
    heading.append(mark)
  }

  for (const title of within(blocks, "blockquote.markdown-alert > p.markdown-alert-title")) {
    const kind = /\bmarkdown-alert-(\w+)/.exec(title.parentElement?.className ?? "")?.[1]

    if (kind && kind in ALERTS) {
      title.insertAdjacentHTML("afterbegin", ICONS[`alert_${kind as keyof typeof ALERTS}`])
    }
  }

  for (const code of within(blocks, "pre > code")) {
    const pre = code.parentElement as HTMLElement

    if (!pre.closest("td, th") && !pre.querySelector(":scope > .code-copy")) {
      pre.append(
        copyButton(() => code.textContent?.replace(/\n$/, "") ?? "", "Copy code", "code-copy"),
      )
    }
  }

  await drawEmbeds(blocks, theme)
  await drawMaps(blocks, owner)
  await drawModels(blocks, owner)

  const fences = within(blocks, "pre > code.language-mermaid")

  if (fences.length === 0) {
    return
  }

  const { default: mermaid } = await import("mermaid")

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    ...DIAGRAM_THEMES[theme],
  })

  for (const fence of fences) {
    const figure = owner.createElement("div")
    const source = fence.textContent ?? ""
    const pre = fence.parentElement as HTMLElement
    figure.className = "mermaid"

    // A diagram missing an include is not what its author wrote, and drawn its marker would be lost.
    if (fence.querySelector(".include-missing")) {
      pre.classList.add("diagram-failed")
      pre.setAttribute("title", "An include in this diagram resolves to nothing.")
      continue
    }

    try {
      // Mermaid sizes each box from its measured text, so the face must be loaded before it measures.
      await Promise.all(
        ["16px", "bold 16px"].map((font) => document.fonts.load(`${font} Arimo`, source)),
      )
      ;({ svg: figure.innerHTML } = await mermaid.render(`diagram-${++diagrams}`, source))
      inkLabels(figure, source, theme)

      if (theme === "dark") {
        // Sequence diagrams shade their boxes through an attribute the dropShadow theme value misses.
        for (const shaded of figure.querySelectorAll("[filter]")) {
          shaded.removeAttribute("filter")
        }
      }

      moveSource(pre, figure, false)
      pre.replaceWith(figure)
      const written = source.replace(/\n$/, "")

      withSource(
        figure,
        () => written,
        () => {
          if (!figure.querySelector(":scope > .drawn-source")) {
            const shown = owner.createElement("pre")
            shown.className = "drawn-source"
            shown.appendChild(owner.createElement("code")).textContent = written
            figure.prepend(shown)
          }
        },
        [expandable(figure)],
      )

      if (KEYS.has(pre)) {
        KEYS.set(figure, KEYS.get(pre) as string)
      }
    } catch (error) {
      pre.classList.add("diagram-failed")
      pre.setAttribute("title", (error as Error).message)
    }
  }
}

async function drawMaps(blocks: Node[], owner: Document): Promise<void> {
  const fences = within(blocks, "pre > code.language-geojson, pre > code.language-topojson")

  if (fences.length === 0) {
    return
  }

  const { mapOf } = await import("./maps.ts")

  for (const fence of fences) {
    const pre = fence.parentElement as HTMLElement
    const written = (fence.textContent ?? "").replace(/\n$/, "")

    if (fence.querySelector(".include-missing")) {
      pre.classList.add("diagram-failed")
      pre.setAttribute("title", "An include in this map resolves to nothing.")
      continue
    }

    try {
      const figure = await mapOf(
        written,
        fence.classList.contains("language-topojson") ? "topojson" : "geojson",
        owner,
      )
      replaceFence(pre, figure)
      withSource(
        figure,
        () => written,
        () => {},
      )
    } catch (error) {
      failedIn(pre, `Map failed to draw - ${(error as Error).message}`, owner)
    }
  }
}

async function drawModels(blocks: Node[], owner: Document): Promise<void> {
  const fences = within(blocks, "pre > code.language-stl")

  if (fences.length === 0) {
    return
  }

  let models: typeof import("./models.ts") | undefined

  for (const fence of fences) {
    const pre = fence.parentElement as HTMLElement
    const written = (fence.textContent ?? "").replace(/\n$/, "")
    const unfit = !SOLID.test(written)
      ? "it is not an ASCII STL model"
      : !webgl()
        ? "3D graphics are unavailable in this browser"
        : undefined

    if (fence.querySelector(".include-missing")) {
      pre.classList.add("diagram-failed")
      pre.setAttribute("title", "An include in this model resolves to nothing.")
      continue
    }

    if (unfit) {
      failedIn(pre, `Model failed to draw - ${unfit}`, owner)
      continue
    }

    models ??= await import("./models.ts")

    try {
      const figure = models.modelOf(written, owner)
      replaceFence(pre, figure)
      withSource(
        figure,
        () => written,
        () => {},
      )
    } catch (error) {
      failedIn(pre, `Model failed to draw - ${(error as Error).message}`, owner)
    }
  }
}

/** Asked once, its context let go at once: a page's WebGL contexts are few. */
function webgl(): boolean {
  if (webglFound === undefined) {
    const probe = document.createElement("canvas")
    const context = probe.getContext("webgl2") ?? probe.getContext("webgl")

    context?.getExtension("WEBGL_lose_context")?.loseContext()
    webglFound = context !== null
  }

  return webglFound
}

function replaceFence(pre: HTMLElement, figure: HTMLElement): void {
  moveSource(pre, figure, false)
  pre.replaceWith(figure)
  figure.append(pre)

  if (KEYS.has(pre)) {
    KEYS.set(figure, KEYS.get(pre) as string)
  }
}

function failedIn(pre: HTMLElement, reason: string, owner: Document): void {
  const block = owner.createElement("div")
  const notice = block.appendChild(owner.createElement("p"))

  block.className = "drawing-failed"
  notice.className = "drawing-reason"
  notice.textContent = reason
  pre.classList.add("diagram-failed")
  replaceFence(pre, block)
}

async function markdownHtml(
  text: string,
  sources: Sources,
  still: boolean,
): Promise<{ html: string; spans: Span[] }> {
  const mdast = MARKDOWN.runSync(MARKDOWN.parse(text), text)
  const queries = queryFences(mdast as MdastRoot)
  const { frontmatter } = some(mdast, (node) => node.type === "yaml")
    ? await import("./frontmatter.ts")
    : { frontmatter: undefined }
  let hast = await unified()
    .use(remarkRehype, {
      allowDangerousHtml: true,
      handlers: {
        table,
        yaml: (state, node: MdastNodes & { value: string }) => {
          const element = frontmatter?.(node.value)

          if (element) {
            state.patch(node, element)
          }

          return element
        },
      },
    })
    .run(mdast as MdastRoot, text)

  if (some(hast, (node) => node.type === "raw")) {
    const { default: rehypeRaw } = await import("rehype-raw")
    hast = await unified().use(rehypeRaw).run(hast, text)
  }

  showIncludes(hast as HastRoot)

  // Slugs are added after sanitizing, which would otherwise prefix them, so anchors match GitHub's.
  hast = await unified().use(rehypeSanitize, SCHEMA).use(rehypeSlug).run(hast, text)
  holdUnresolvedMath(hast as HastRoot)
  addSwatches(hast as HastRoot)

  // Added after sanitizing, which strips any an author writes, so a page cannot forge them.
  for (const node of (hast as HastRoot).children) {
    const found =
      node.type !== "element"
        ? undefined
        : node.properties.dataFootnotes !== undefined
          ? footnotesSource(sources)
          : node.position && sourceOf(sources, node.position.start.line, node.position.end.line)

    if (node.type === "element" && !still) {
      const from = found?.source ?? sources.layout.instances[0]?.source ?? ""
      const opens = node.position?.start.line ?? 0
      markEmbeds(node, from, queries, (line) => (found?.lines?.[0] ?? opens) + line - opens)
    }

    if (node.type === "element" && found) {
      Object.assign(node.properties, {
        dataFolioId: found.id,
        dataFolioSource: found.source,
        dataFolioLines: found.lines && `${found.lines[0]}-${found.lines[1]}`,
        dataFolioVersion: found.version,
      })
    }
  }

  keepMathBlocks(hast as HastRoot)
  const spans = placed(hast as HastRoot, mdast as MdastRoot, text)
  const [katex, highlight] = await Promise.all([
    some(hast, isMath) ? import("rehype-katex") : undefined,
    some(hast, isCode) ? import("rehype-highlight") : undefined,
  ])
  const html = unified().use(rehypeStringify)

  if (katex) {
    html.use(katex.default)
  }

  if (highlight) {
    html.use(highlight.default, {
      plainText: ["mermaid", "vega-lite", "stl"],
      aliases: { json: ["geojson", "topojson"] },
    })
  }

  return { html: html.stringify((await html.run(hast as HastRoot, text)) as HastRoot), spans }
}

/** Each top-level element's span, numbered on the element: parsing the HTML may regroup the tree's elements. */
function placed(hast: HastRoot, mdast: MdastRoot, text: string): Span[] {
  const shift = byteOrderMark(text)
  const starts = [0, ...[...text.matchAll(/\n/g)].map((found) => found.index + 1)]
  const offset = ({
    line,
    column,
    offset: at,
  }: {
    line: number
    column: number
    offset?: number
  }) => (at === undefined ? starts[line - 1] + column - 1 + (line === 1 ? shift : 0) : at + shift)
  const sites = sitesIn(mdast, text)
  const listed = listedNotes(mdast)
  const notes = mdast.children.flatMap((node): [number, number][] =>
    listed.has(node) && node.position
      ? [[offset(node.position.start), offset(node.position.end)]]
      : [],
  )
  const spans: Span[] = []

  for (const node of hast.children) {
    const parts: [number, number][] | undefined =
      node.type !== "element"
        ? undefined
        : node.properties.dataFootnotes !== undefined
          ? notes
          : node.position && [[offset(node.position.start), offset(node.position.end)]]

    if (node.type === "element" && parts) {
      node.properties.dataFolioSpan = spans.length
      spans.push({
        parts,
        sites: sites.filter((site) =>
          parts.some(([start, end]) => start <= site.start && site.end <= end),
        ),
      })
    }
  }

  return spans
}

/**
 * An include left as written arrives spelled in private-use characters, out of markdown's reach; its
 * literal is spelled back here, before anchors are made, so a heading holding it is named as written.
 * One in an attribute - a link's address, an image's source - is shown again just after its element.
 */
function showIncludes(node: HastNodes): void {
  if (node.type === "text") {
    node.value = shown(node.value)
  }

  if (!("children" in node)) {
    return
  }

  node.children = (node.children as ElementContent[]).flatMap((child): ElementContent[] => {
    showIncludes(child as HastNodes)

    if (child.type !== "element") {
      return [child]
    }

    const found: string[] = []

    for (const [name, value] of Object.entries(child.properties)) {
      if (typeof value === "string") {
        // A link's address arrives percent-encoded, the private-use characters with it.
        const plain = value.replace(/(?:%EE%80%[89A][0-9A-F])+/gi, (run) => decodeURIComponent(run))
        found.push(...spelledIn(plain))
        child.properties[name] =
          name === "href" || name === "src" ? unmarkedAddress(plain) : unmarked(plain)
      }
    }

    return [child, ...found.map((run) => ({ type: "text" as const, value: ` ${shown(run)}` }))]
  }) as typeof node.children
}

/** KaTeX replaces a display formula's `pre` whole, so the block's own attributes move to an element around it. */
/** As the footnotes section lists them: the first of each name, reached from the text or from a listed note. */
function listedNotes(tree: MdastRoot): Set<MdastNodes> {
  const first = new Map<string, MdastNodes>()
  const listed = new Set<MdastNodes>()
  const walk = (node: MdastNodes): void => {
    const note =
      node.type === "footnoteReference" ? first.get(node.identifier.toUpperCase()) : undefined

    if (note && !listed.has(note)) {
      listed.add(note)
      walk(note)
    } else if (node.type !== "footnoteReference" && "children" in node) {
      for (const child of node.children) {
        if (child.type !== "footnoteDefinition") {
          walk(child)
        }
      }
    }
  }

  for (const node of tree.children) {
    if (node.type === "footnoteDefinition" && !first.has(node.identifier.toUpperCase())) {
      first.set(node.identifier.toUpperCase(), node)
    }
  }

  walk(tree)
  return listed
}

function keepMathBlocks(root: HastRoot): void {
  root.children = root.children.map((node) =>
    node.type === "element" &&
    node.tagName === "pre" &&
    node.children[0]?.type === "element" &&
    isMath(node.children[0])
      ? {
          type: "element",
          tagName: "div",
          properties: node.properties,
          children: [{ ...node, properties: {} }],
          position: node.position,
        }
      : node,
  )
}

/** A formula missing an include is not what its author wrote, so it is shown as written, marked, not typeset. */
function holdUnresolvedMath(node: HastNodes): void {
  if (isMath(node) && node.type === "element" && some(node, hasMarker)) {
    node.properties.className = [
      ...classes(node).filter((name) => !MATH_CLASSES.includes(name)),
      "katex-error",
    ]
    node.properties.title = "An include in this formula resolves to nothing."
    return
  }

  if ("children" in node) {
    for (const child of node.children) {
      holdUnresolvedMath(child as HastNodes)
    }
  }
}

function addSwatches(node: HastNodes): void {
  if (!("children" in node) || (node.type === "element" && node.tagName === "pre")) {
    return
  }

  node.children = (node.children as ElementContent[]).flatMap((child): ElementContent[] => {
    const value =
      child.type === "element" && child.tagName === "code" && !isMath(child)
        ? colourOf(textOf(child))
        : undefined

    if (!(child.type === "element" && child.tagName === "code")) {
      addSwatches(child as HastNodes)
    }

    return value
      ? [
          child,
          {
            type: "element",
            tagName: "span",
            properties: { className: ["color-swatch"], style: `background-color: ${value}` },
            children: [],
          },
        ]
      : [child]
  }) as typeof node.children
}

/** Only GitHub's colour forms, validated, reach the style, which is written after sanitizing. */
function colourOf(text: string): string | undefined {
  const rgb = RGB.exec(text)
  const hsl = HSL.exec(text)

  if (HEX.test(text)) {
    return text
  }

  if (rgb?.slice(1).every((part) => Number(part) <= 255)) {
    return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})`
  }

  if (hsl && Number(hsl[1]) <= 360 && Number(hsl[2]) <= 100 && Number(hsl[3]) <= 100) {
    return `hsl(${hsl[1]}, ${hsl[2]}%, ${hsl[3]}%)`
  }

  return undefined
}

function hasMarker(node: MdastNodes | HastNodes): boolean {
  return node.type === "text" && node.value.includes(MARKED)
}

/**
 * A highlighter may split a marked include across its spans; the range it spans becomes one marker,
 * named by the file, line and column holding the include, so an address can land on it. The same
 * include shown twice - its file included twice - is named apart by a count after the first.
 */
function markIncludes(article: HTMLElement): void {
  if (!article.textContent?.includes(MARKED)) {
    return
  }

  const nodes: Text[] = []
  const starts: number[] = []
  const walker = article.ownerDocument.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  let length = 0

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
    starts.push(length)
    length += (node as Text).data.length
  }

  const place = (offset: number): [Text, number] => {
    let low = 0
    let high = starts.length - 1

    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      ;[low, high] = starts[middle] <= offset ? [middle, high] : [low, middle - 1]
    }

    return [nodes[low], offset - starts[low]]
  }
  const made: HTMLElement[] = []

  for (const found of markers(nodes.map((node) => node.data).join("")).reverse()) {
    const range = article.ownerDocument.createRange()
    const marker = article.ownerDocument.createElement("span")
    const { why, file, line, column } = found.where

    range.setStart(...place(found.at))
    range.setEnd(...place(found.at + found.length - 1))
    range.setEnd(range.endContainer, range.endOffset + 1)
    marker.className = "include-missing"
    marker.textContent = found.written
    marker.title =
      why === "loop" ? "This include leads back to itself" : "Nothing to include at this path"
    marker.dataset.include = `include-${file}:${line}:${column}`
    range.deleteContents()
    range.insertNode(marker)
    made.unshift(marker)
  }

  const seen = new Map<string, number>()

  for (const marker of made) {
    const name = marker.dataset.include as string
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    marker.id = count === 1 ? name : `${name}~${count}`
    delete marker.dataset.include
  }
}

/** A block belongs to the file its first line starts with, whatever later lines an include brings in. */
function sourceOf({ blocks, layout }: Sources, start: number, end: number): Source | undefined {
  const placement = layout.instances[layout.owners[start]]
  const from = placement?.starts.findIndex((at, k) => at <= start && start <= placement.ends[k])

  if (!placement || from === undefined || from < 0) {
    return undefined
  }

  const { source, first, last, starts } = placement
  let to = from

  while (to + 1 < starts.length && first + to + 1 <= last && starts[to + 1] <= end) {
    to++
  }

  const lines: [number, number] = [first + from, first + to]
  const block = blocks.find(
    (found) => found.source === source && found.lines[0] <= lines[0] && lines[0] <= found.lines[1],
  )

  return { id: block?.id, version: block?.version, source, lines }
}

/** The footnotes section gathers the page's footnotes at its end, so it stands for the page's own file. */
function footnotesSource({ blocks, layout }: Sources): Source | undefined {
  const source = layout.instances[0]?.source
  const notes = blocks.filter((block) => block.source === source && block.kind === "footnote")

  if (!source) {
    return undefined
  }

  const last = notes.at(-1)
  return {
    id: notes[0]?.id,
    version: notes[0]?.version,
    source,
    lines: last && [notes[0].lines[0], last.lines[1]],
  }
}

function setSource(element: Element, found: Source | undefined): void {
  for (const [name, value] of [
    ["data-folio-id", found?.id],
    ["data-folio-source", found?.source],
    ["data-folio-lines", found?.lines && `${found.lines[0]}-${found.lines[1]}`],
    ["data-folio-version", found?.version],
  ] as const) {
    if (value) {
      element.setAttribute(name, value)
    }
  }
}

/** A block that only moved keeps its key, so an update leaves it in place. */
function keyed(element: Element): string {
  const bare = element.cloneNode(true) as Element

  for (const name of SOURCE_ATTRIBUTES) {
    bare.removeAttribute(name)
  }

  return bare.outerHTML
}

function some(
  node: MdastNodes | HastNodes,
  test: (node: MdastNodes | HastNodes) => boolean,
): boolean {
  return (
    test(node) ||
    ("children" in node &&
      (node.children as (MdastNodes | HastNodes)[]).some((child) => some(child, test)))
  )
}

function isMath(node: MdastNodes | HastNodes): boolean {
  return node.type === "element" && classes(node).some((name) => MATH_CLASSES.includes(name))
}

/** Mirrors the highlighter's own selection, raw HTML included, or such code would stay unhighlighted. */
function isCode(node: MdastNodes | HastNodes): boolean {
  if (node.type !== "element" || node.tagName !== "pre") {
    return false
  }

  return node.children.some(
    (child) =>
      child.type === "element" &&
      child.tagName === "code" &&
      classes(child).some((name) => {
        const language = /^lang(?:uage)?-(.+)$/.exec(name)?.[1]
        return language !== undefined && !PLAIN_CODE.has(language)
      }),
  )
}

function classes(element: { properties: { className?: unknown } }): string[] {
  const names = element.properties.className
  return Array.isArray(names) ? names.map(String) : []
}

function within<T extends Element = HTMLElement>(blocks: Node[], selector: string): T[] {
  return blocks.flatMap((block) =>
    block instanceof Element
      ? [...(block.matches(selector) ? [block as T] : []), ...block.querySelectorAll<T>(selector)]
      : [],
  )
}

/** A `sql query [name]` fence at any depth, keyed by the line it opens on; an unnamed one maps to "". */
function queryFences(tree: MdastRoot): Map<number, string> {
  const found = new Map<number, string>()
  const visit = (node: MdastNodes) => {
    const match =
      node.type === "code" && node.lang === "sql" && /^query(?:\s+(\S+))?\s*$/.exec(node.meta ?? "")

    if (match && node.position) {
      found.set(node.position.start.line, match[1] ?? "")
    }

    if ("children" in node) {
      node.children.forEach(visit)
    }
  }

  visit(tree)
  return found
}

/**
 * Mermaid keeps a fill the document gives a node or box but colours its label from the theme.
 * Weighing a label against what is drawn under it needs layout, so the diagram is measured off-screen.
 */
function inkLabels(figure: Element, source: string, theme: Theme): void {
  const named = new Set(
    [...source.matchAll(FILLS)].flatMap(([, fill]) => colour(fill)?.join() ?? []),
  )

  if (!named.size) {
    return
  }

  const host = document.body.appendChild(document.createElement("div"))
  host.className = "markdown-body"
  host.style.cssText =
    "position: absolute; top: 0; left: -10000px; width: 2000px; visibility: hidden"
  host.append(figure)

  try {
    for (const [label, ink, kept] of inksOf(figure, named, theme)) {
      for (const part of [label, ...label.querySelectorAll("span, tspan")]) {
        if (part instanceof SVGTextContentElement) {
          part.style.fill = `rgb(${ink.join(" ")})`
        } else if (part instanceof HTMLElement) {
          part.style.color = `rgb(${ink.join(" ")})`
        }
      }

      for (const [part, color] of kept) {
        part.style.color = color
      }
    }
  } finally {
    figure.remove()
    host.remove()
  }
}

function inksOf(
  figure: Element,
  named: Set<string>,
  theme: Theme,
): [Element, Rgb, OwnBackgrounds][] {
  const order = new Map([...figure.querySelectorAll("*")].map((element, at) => [element, at]))
  const shapes = [
    ...figure.querySelectorAll<SVGGeometryElement>("rect, path, polygon, circle, ellipse"),
  ]
    .filter((shape) => !shape.closest(".label, defs, marker"))
    .map((shape) => ({
      shape,
      at: order.get(shape) as number,
      box: shape.getBoundingClientRect(),
      toShape: shape.getScreenCTM()?.inverse(),
      sketch: sketched(shape),
      ...painted(shape, sketched(shape)),
    }))

  return [
    ...figure.querySelectorAll(":is(.node, .rough-node, .cluster) :is(foreignObject, text)"),
  ].flatMap((label): [Element, Rgb, OwnBackgrounds][] => {
    const { x, y, width, height } = label.getBoundingClientRect()
    const [across, down] = [x + width / 2, y + height / 2]
    const at = order.get(label) as number
    let ground = PAGES[theme]
    let top: string | undefined

    for (const { shape, at: drawn, box, toShape, sketch, fill, paint } of shapes) {
      if (drawn > at) {
        break
      }

      if (
        paint &&
        toShape &&
        box.left <= across &&
        across <= box.right &&
        box.top <= down &&
        down <= box.bottom &&
        (sketch || shape.isPointInFill(new DOMPoint(across, down).matrixTransform(toShape)))
      ) {
        ground = paint
          .slice(0, 3)
          .map((part, i) => paint[3] * part + (1 - paint[3]) * ground[i]) as Rgb
        top = fill
      }
    }

    if (!top || !named.has(top) || colouredByDocument(label)) {
      return []
    }

    const ink = INKS.reduce((best, next) =>
      contrast(ground, next) > contrast(ground, best) ? next : best,
    )
    const drawn = drawnIn(label)

    if (drawn && contrast(ground, drawn) >= contrast(ground, ink)) {
      return []
    }

    const kept = [...label.querySelectorAll<HTMLElement>("*")]
      .filter((part) => colour(getComputedStyle(part).backgroundColor))
      .map((part): [HTMLElement, string] => [part, getComputedStyle(part).color])

    return [[label, ink, kept]]
  })
}

/** Mermaid's hand-drawn look sketches a fill as strokes - the first of a shape's paths - across its box. */
function sketched(shape: Element): boolean {
  const paths = shape.parentElement?.querySelectorAll(":scope > path") ?? []

  return (
    paths.length > 1 &&
    paths[0] === shape &&
    getComputedStyle(shape).fill === "none" &&
    Boolean(shape.closest('[data-look="handDrawn"]'))
  )
}

function painted(shape: Element, sketch: boolean): { fill?: string; paint?: Rgba } {
  const style = getComputedStyle(shape)
  const fill = colour(sketch ? style.stroke : style.fill)
  const alpha =
    fill &&
    fill[3] * Number(sketch ? style.strokeOpacity : style.fillOpacity) * Number(style.opacity)

  return fill && alpha ? { fill: fill.join(), paint: [fill[0], fill[1], fill[2], alpha] } : {}
}

function drawnIn(label: Element): Rgb | undefined {
  const text = label instanceof SVGTextContentElement ? label : label.querySelector("span")

  if (!text) {
    return undefined
  }

  const style = getComputedStyle(text)
  const drawn = colour(text instanceof SVGTextContentElement ? style.fill : style.color)

  return drawn && [drawn[0], drawn[1], drawn[2]]
}

function colouredByDocument(label: Element): boolean {
  const own = [label, ...label.querySelectorAll("*")]

  for (
    let up = label.parentElement;
    up && !up.matches(".node, .rough-node, .cluster");
    up = up.parentElement
  ) {
    own.push(up)
  }

  return own.some(
    (element) =>
      (element as HTMLElement).style.color ||
      (element instanceof SVGTextContentElement && element.style.fill),
  )
}

/** Painted and read back: fillStyle keeps oklch(), lab() and color() as written, so only pixels give sRGB. */
function colour(value: string): Rgba | undefined {
  canvas ??= document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D
  // A value the canvas cannot read leaves its previous one, so it starts from one that shows nothing.
  canvas.fillStyle = "transparent"
  canvas.fillStyle = value
  canvas.clearRect(0, 0, 1, 1)
  canvas.fillRect(0, 0, 1, 1)
  const [r, g, b, alpha] = canvas.getImageData(0, 0, 1, 1).data

  return alpha ? [r, g, b, alpha / 255] : undefined
}

function contrast(one: Rgb, other: Rgb): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

function luminance(color: Rgb): number {
  const [r, g, b] = color.map((part) => {
    const s = part / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
