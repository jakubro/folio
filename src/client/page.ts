/** The page: lays out toolbar, tree, content and outline, then renders the file or folder this address names. */

import type { DataPage } from "../server/data.ts"
import { Backlinks } from "./backlinks.ts"
import { BlockLinks, fragmentOf, landOn } from "./blocklinks.ts"
import { copyButton } from "./copy.ts"
import { reconcile } from "./drawings.ts"
import { embedVersions, redrawEmbeds } from "./embeds.ts"
import { blocksOf, foldable, reveal, unfoldAll } from "./folds.ts"
import { button, ICONS } from "./icons.ts"
import { type Change, Live, type Subscription } from "./live.ts"
import { blockMarkdown, copies, documentMarkdown } from "./markdown.ts"
import { type Marked, Marks } from "./marks.ts"
import { Outline } from "./outline.ts"
import { type Content, fetchPage, type Kind, kindOf, type LinksState, Prerender } from "./pages.ts"
import {
  dataShown,
  fullWidth,
  handOffOnLinks,
  type Panel,
  panelShown,
  setFullWidth,
  setPanelShown,
  setTheme,
  theme,
  toggleMaximized,
} from "./prefs.ts"
import { Provenance } from "./provenance.ts"
import { Reading } from "./reading.ts"
import { announce, blocksIn, type Redraw, sameBlock } from "./redraws.ts"
import { drawBlocks, keyOf, markup, moveSource, render, type Sources } from "./render.ts"
import type { Picked } from "./stats.ts"
import { TableViews, type View } from "./tableviews.ts"
import { type Entry, fetchListing, href, iconFor, Tree } from "./tree.ts"
import { unmarked } from "./unresolved.ts"
import { UsedBy } from "./usedby.ts"
import { type Changes, fetchChanges, loadView, sharing, type ViewPage, viewOf } from "./views.ts"
import { closeExpanded } from "./zoom.ts"

type Step = "previous" | "next"

interface Destination {
  pathname: string
  kind: Kind
  text: string
  sources: Sources
  links?: LinksState
  read?: Marked
  version: string | null
  entries: Entry[]
  data?: DataPage
  article?: HTMLElement
}

let urlPath = decodeURIComponent(location.pathname).slice(1)
let viewName = document.documentElement.hasAttribute("data-missing")
  ? "not-found"
  : viewOf(location.search, location.pathname)
let kind: Kind | "view" = viewName ? "view" : (kindOf(urlPath) ?? "markdown")
let folderPath = urlPath.replace(/\/$/, "")
const rootName = document.documentElement.dataset.root ?? ""
const build = document.documentElement.dataset.build
const TAB = crypto.randomUUID()
const SAVE_SCROLL_MS = 200
/** Keys typed into a filter this close together make one history entry; every other change makes its own. */
const VIEW_ENTRY_MS = 1000
const LOOK_MS = 250
/** Embeds drawn close together are subscribed to in one message. */
const EMBEDDED_MS = 50
const COUNTING_MS = 1000
const SCROLL_KEYS = new Set([" ", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"])
const STEP_KEYS: Record<string, Step> = { ArrowLeft: "previous", ArrowRight: "next" }
const PANEL_KEYS: Record<string, Panel> = { ArrowLeft: "tree", ArrowRight: "outline" }

const bar = document.createElement("header")
const layout = document.createElement("div")
const main = document.createElement("main")
const tree = new Tree(urlPath)
const outline = new Outline()
let article = document.createElement("article")
let text = ""
const NO_SOURCES: Sources = { blocks: [], layout: { instances: [], owners: [] } }
let sources = NO_SOURCES
let links: LinksState | undefined
let marked: Marked | undefined
let version: string | null = null
let entries: Entry[] = []
let dataPage: DataPage | undefined
let shownFilter = ""
let shownView: ViewPage | undefined
let pointed: HTMLElement | null = null
let looking: ReturnType<typeof setTimeout> | undefined
let told = ""
let changes: Changes | undefined
let images = new Map<string, string | null>()
const live = new Live(subscription, (change) => changed(change).catch(() => live.retry()), rebuilt)
const prerender = new Prerender(theme)
let saving: ReturnType<typeof setTimeout> | undefined
/** A position the page was too short to reach when restored; reapplied as each image loads. */
let restoring: number | undefined
let navigation = 0
/** A redraw drawn while block ids were still parsing, announced once they are known. */
let unannounced: { before: Element[]; cause: Redraw["cause"]; renamed: Set<Element> } | undefined
/** The text each article was drawn from: an update bringing the same text only gives blocks their ids. */
const DRAWN = new WeakMap<HTMLElement, string>()
let redraws = 0
let stepping = Promise.resolve()
let embedded: ReturnType<typeof setTimeout> | undefined
let viewWritten = 0
/** The browser scrolls the block a click last landed in with the arrow keys, so they stay its own. */
let scroller: Element | undefined
let pressedControl = false

// The browser restores a position before the content has rendered, so folio keeps its own.
history.scrollRestoration = "manual"

bar.className = "bar"
layout.className = "layout"
article.className = "markdown-body"
main.append(article)
const blockLinks = new BlockLinks(main)
const backlinks = new Backlinks(main, outline.footer)
const tables = new TableViews(main)
const reading = new Reading()
const marks = new Marks(main, outline.header)
const usedBy = new UsedBy(main)
const provenance = new Provenance(main)
layout.append(tree.element, main, outline.element)
document.body.prepend(bar, layout)

const toggles = {
  tree: button(ICONS.tree, "Show or hide the file tree"),
  outline: button(ICONS.outline, "Show or hide the outline"),
  width: button(ICONS.width, "Full width"),
  theme: button(ICONS.sun, "Switch theme"),
  live: button(ICONS.live, "Suspend live updates in this tab"),
  freeze: button(ICONS.download, "Freeze this page into one HTML file"),
  copy: copyButton(documentCopy, "Copy this document as markdown", "copy-document"),
}
const historyLink = Object.assign(document.createElement("a"), {
  className: "icon-button history-link",
  title: "History of this document",
  innerHTML: ICONS.clock,
})
const catchUpLink = Object.assign(document.createElement("a"), {
  className: "icon-button catch-up-link",
  href: "/?catch-up",
  title: "Catch up: what changed since you read it",
  innerHTML: ICONS.inbox,
})
const healthLink = Object.assign(document.createElement("a"), {
  className: "icon-button health-link",
  href: "/?health",
  title: "Health: everything wrong in the folder",
  innerHTML: ICONS.alert,
})
const steps: Record<Step, HTMLButtonElement> = {
  previous: button(ICONS.left, "Previous page (←)"),
  next: button(ICONS.right, "Next page (→)"),
}
const spacer = document.createElement("div")
spacer.className = "spacer"
let crumbs = breadcrumbs()
bar.append(
  toggles.tree,
  steps.previous,
  steps.next,
  crumbs,
  spacer,
  historyLink,
  catchUpLink,
  healthLink,
  toggles.freeze,
  toggles.copy,
  toggles.live,
  toggles.outline,
  toggles.width,
  toggles.theme,
)

toggles.freeze.addEventListener("click", async () => {
  const { freeze } = await import("./freeze.ts")
  await freeze(
    article,
    urlPath,
    kind === "folder" ? undefined : tables,
    theme(),
    kind === "view" ? `${viewName}` : undefined,
  )
})

tables.onChange = (typed) => {
  writeViews(typed)
  marks.place()
}
tables.marked = (row) => marks.marksRow(row)
marks.writtenRows = (table) => tables.viewed(table)?.written
document.addEventListener("folio:digested", (event) => {
  live.send({ type: "digested", to: (event as CustomEvent<{ to: number }>).detail.to })
})
document.addEventListener("folio:redraw", showMarks)
document.addEventListener("folio:redraw", () => provenance.flag(article))
blockLinks.onProvenance = (block) => void provenance.open(block)
blockLinks.copies = copies
blockLinks.copyOf = (block) =>
  blockMarkdown(shownText(), shownBlocks(), block, (table) => tables.viewed(table))
reading.held = (block) => marks.holding(block)
reading.embedsOf = (block) => embedVersions(marks.subjectOf(block) ?? block)
reading.changedSpan = (block) => marks.changedSpan(block)
reading.onRead = (blocks) => {
  const removed = blocks.filter((block) => block.version === "removed")
  const read = blocks
    .filter((block) => block.version !== "removed")
    .map(({ part, ...block }) =>
      part === undefined
        ? block
        : part.startsWith("gone:")
          ? { ...block, gone: [part.slice("gone:".length)] }
          : { ...block, parts: part.split(",").map(Number) },
    )

  for (const { source, id } of removed) {
    live.send({ type: "forget", source, ids: [id] })
  }

  if (read.length > 0) {
    live.send({ type: "read", page: urlPath, blocks: read })
  }

  marks.cleared(blocks)
  tables.refold(article)
}

for (const panel of ["tree", "outline"] as Panel[]) {
  toggles[panel].addEventListener("click", () => togglePanel(panel))
}

toggles.width.addEventListener("click", () => {
  setFullWidth(!fullWidth())
  showPrefs()
})

// A link's first click may redraw the breadcrumbs, so the second press lands on what replaced it.
bar.addEventListener("mousedown", (event) => {
  if (event.detail <= 1) {
    pressedControl = onControl(event)
  } else if (!pressedControl) {
    // The second press of a double-click would select the word under the pointer.
    event.preventDefault()
  }
})

bar.addEventListener("dblclick", (event) => {
  if (!pressedControl && !onControl(event)) {
    toggleMaximized()
    showPrefs()
  }
})

toggles.theme.addEventListener("click", () => {
  setTheme(theme() === "dark" ? "light" : "dark")
  showPrefs()

  if (kind !== "data") {
    void draw()
  }
})

toggles.live.addEventListener("click", () => {
  if (live.suspended) {
    live.start()
  } else {
    live.stop()
  }

  showLive()
})

for (const direction of ["previous", "next"] as Step[]) {
  steps[direction].disabled = true
  steps[direction].addEventListener("click", () => queueStep(direction))
}

handOffOnLinks()
showPrefs()
tree.onChange = () => {
  tree.mark(changedPaths())
  void live.resubscribe()
}
void tree.load()
void showChanges()
await load()
showTitle()
showHistoryLink()
await draw()
land()
void showSteps()
addEventListener("scroll", rememberScroll, { passive: true })
addEventListener("pagehide", saveScroll)

for (const type of ["load", "error"]) {
  document.addEventListener(type, () => restoring !== undefined && restore(), true)
}

for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) {
  addEventListener(
    type,
    (event) => {
      if (type !== "keydown" || SCROLL_KEYS.has((event as KeyboardEvent).key)) {
        restoring = undefined
      }
    },
    { passive: true },
  )
}
addEventListener("pointerdown", (event) => {
  scroller = sidewaysScroller(event.target as Element)
})
addEventListener("keydown", (event) => {
  const direction = STEP_KEYS[event.key]
  const panel = PANEL_KEYS[event.key]
  const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
  const altOnly = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey

  // Alt+arrows are the browser's back and forward, taken over so they never leave the page.
  if (panel && altOnly && !event.defaultPrevented) {
    event.preventDefault()

    if (!event.repeat) {
      togglePanel(panel)
    }
  } else if (direction && !modified && !event.defaultPrevented && !scroller?.isConnected) {
    event.preventDefault()
    queueStep(direction)
  }
})
addEventListener("popstate", returned)
document.addEventListener("folio:embedded", (event) => {
  if (article.contains(event.target as Node)) {
    tables.attach(article, urlPath)
    provenance.flag(article)
    clearTimeout(embedded)
    embedded = setTimeout(() => {
      live.resubscribe()
      void refreshMarks()
    }, EMBEDDED_MS)
  }
})
// A data page's filter lives in its address, so a copied link reopens it and back undoes it.
document.addEventListener("folio:filter", (event) => {
  const picked = (event as CustomEvent<Picked | undefined>).detail
  const url = new URL(location.href)

  if (picked) {
    url.searchParams.set("filter", JSON.stringify(picked))
  } else {
    url.searchParams.delete("filter")
  }

  history.pushState({ ...history.state, scroll: scrollY }, "", url.href)
  void load().then(async (current) => current && draw())
})
document.addEventListener("folio:sort", (event) => {
  const { column, descending } = (event as CustomEvent<{ column: string; descending: boolean }>)
    .detail
  tables.sort(event.target as HTMLTableElement, column, descending)
})
document.addEventListener("folio:tables", (event) => {
  if (article.contains(event.target as Node)) {
    tables.attach(article, urlPath)
  }
})
document.addEventListener("click", follow)
main.addEventListener("pointerover", (event) => {
  const block = (event.target as Element).closest<HTMLElement>(".markdown-body [data-folio-id]")

  if (block !== pointed) {
    pointed = block
    lookSoon()
  }
})
main.addEventListener("pointerleave", () => {
  pointed = null
  lookSoon()
})
document.addEventListener("visibilitychange", lookSoon)
sharing.toggle = (paused) => live.tell({ type: "share", paused })
live.onSharing = (paused) => {
  sharing.paused = paused
  told = ""
  lookSoon()

  if (kind === "view" && viewName === "needs") {
    void load().then(async (current) => {
      if (current) {
        await draw()
      }
    })
  }
}
live.start()
showLive()

function lookSoon(): void {
  clearTimeout(looking)
  looking = setTimeout(() => {
    const message = document.hidden
      ? { type: "presence" }
      : {
          type: "presence",
          tab: TAB,
          page: urlPath,
          ...(kind === "view" && viewName && location.search && { view: viewName }),
          ...(pointed?.isConnected && {
            source: pointed.dataset.folioSource,
            id: pointed.dataset.folioId,
          }),
        }
    const said = JSON.stringify(message)

    if (said !== told) {
      told = said
      live.tell(message)
    }
  }, LOOK_MS)
}

/** A server on another build than this page's lacks the chunks its script names, so the tab reloads. */
function rebuilt(served: string): void {
  if (served !== build) {
    clearTimeout(saving)
    saveScroll()
    location.reload()
  }
}

async function showChanges(): Promise<void> {
  changes = (await fetchChanges()) ?? changes
  const count = changes?.documents.length ?? 0

  catchUpLink.dataset.count = count > 0 ? String(count) : ""
  catchUpLink.title = `Catch up: ${count} ${count === 1 ? "document" : "documents"} changed since you read them`
  tree.mark(changedPaths())
  live.resubscribe()
}

function changedPaths(): Set<string> {
  return new Set(changes?.documents.map((document) => document.path))
}

async function refreshMarks(): Promise<void> {
  const shown = urlPath

  if (kind !== "markdown" && kind !== "mermaid") {
    return
  }

  const response = await fetch(`${href(shown)}?read`)
  const read: Marked | undefined = response.ok ? await response.json() : undefined

  if (read && shown === urlPath) {
    marked = read
    showMarks()
    live.resubscribe()
  }
}

function showMarks(): void {
  const textual = kind === "markdown" || kind === "mermaid"

  marks.show(article, textual ? marked : undefined)
  tables.refold(article)
  reading.watch(textual ? [...(blocksIn(article) as HTMLElement[]), ...marks.ownReads()] : [])
}

function togglePanel(panel: Panel): void {
  setPanelShown(panel, !panelShown(panel))
  showPrefs()
}

function showPrefs(): void {
  toggles.theme.innerHTML = theme() === "dark" ? ICONS.sun : ICONS.moon
  toggles.tree.setAttribute("aria-pressed", String(panelShown("tree")))
  toggles.outline.setAttribute("aria-pressed", String(panelShown("outline")))
  toggles.width.setAttribute("aria-pressed", String(fullWidth()))
}

function onControl(event: Event): boolean {
  return (event.target as Element).closest("button, a") !== null
}

function showLive(): void {
  toggles.live.innerHTML = live.suspended ? ICONS.pause : ICONS.live
  toggles.live.title = live.suspended
    ? "Resume live updates in this tab"
    : "Suspend live updates in this tab"
  toggles.live.setAttribute("aria-pressed", String(live.suspended))
  document.documentElement.classList.toggle("suspended", live.suspended)
}

/** False when the tab moved to another page while loading, so what arrived belongs to no page shown. */
async function load(resuming = false): Promise<boolean> {
  const shown = urlPath

  if (kind === "view" && viewName) {
    const found = await loadView(viewName, urlPath, location.search, theme())

    if (shown !== urlPath) {
      return false
    }

    shownView = found
    version = found?.version ?? null
    marked = undefined
    return true
  }

  if (kind === "folder") {
    const listing = await fetchListing(folderPath)

    if (shown !== urlPath) {
      return false
    }

    entries = listing?.entries ?? []
    version = listing?.version ?? null
    marked = undefined
    return true
  }

  if (kind === "data") {
    const { dataResume, fetchData } = await import("./data.ts")
    const rows = resuming ? dataResume(article)?.loaded : undefined
    const found = await fetchData(urlPath, tableOf(location), pickedOf(location)?.filter, rows)

    if (shown !== urlPath) {
      return false
    }

    document.documentElement.classList.toggle("missing", !found)
    dataPage = found
    shownFilter = JSON.stringify(pickedOf(location))
    version = found?.version ?? null
    marked = undefined

    if (found?.counting) {
      setTimeout(async () => {
        if (dataPage === found && (await load(true))) {
          await update()
        }
      }, COUNTING_MS)
    }

    return true
  }

  const response = await fetch(`${href(urlPath)}?page`)
  const content: Content | undefined = response.ok ? await response.json() : undefined

  if (shown !== urlPath) {
    return false
  }

  document.documentElement.classList.toggle("missing", response.status === 404)
  text = content?.text ?? text
  sources = content ?? sources
  links = content?.links ?? links
  marked = content?.read ?? marked
  version = content?.version ?? null
  return true
}

/** Renders off-page, then swaps in place: the scroll position, tree and outline state all survive. */
async function draw(resuming = false): Promise<void> {
  const shown = urlPath
  const token = ++redraws
  const next =
    kind === "folder"
      ? listingArticle()
      : kind === "view"
        ? ((await shownView?.article()) ?? listingArticle())
        : kind === "data"
          ? await dataDrawn(resuming)
          : await render(text, sources, kind, theme())
  const y = scrollY

  if (shown === urlPath && token === redraws) {
    await swap(next, () => scrollTo(0, y))
  }
}

async function dataDrawn(resuming: boolean): Promise<HTMLElement> {
  const { dataArticle, dataResume } = await import("./data.ts")
  const resume = resuming ? dataResume(article) : undefined
  return dataArticle(urlPath, dataPage, pickedOf(location), resume)
}

/** Replaces only changed blocks: the rest stay the same nodes, with their diagrams and other tools' additions. */
async function update(): Promise<void> {
  if (kind === "folder" || kind === "data" || kind === "view") {
    return draw(true)
  }

  const shown = article
  const token = ++redraws
  const parsing = version?.endsWith("-partial") ?? false
  const drawing = text
  const next = await markup(drawing, sources, kind, theme())
  const kept = matches(blocksOf(shown), [...next.childNodes])

  await drawBlocks(
    [...next.childNodes].filter((node) => !kept.has(node)),
    theme(),
  )

  if (shown !== article || token !== redraws) {
    return
  }

  const held = unannounced ?? { before: blocksIn(article), cause: "update", renamed: new Set() }

  for (const [fresh, old] of kept) {
    if (fresh instanceof Element && old instanceof Element && moveSource(fresh, old, parsing)) {
      held.renamed.add(old)
    }
  }

  if (DRAWN.get(article) !== drawing) {
    patch([...next.childNodes].map((node) => kept.get(node) ?? node))
    DRAWN.set(article, drawing)
  } else if (held.renamed.size > 0) {
    tables.attach(article, urlPath)
  }

  reconcile(article)

  unannounced = parsing ? held : undefined

  if (!parsing) {
    announce(urlPath, held.cause, held.before, blocksIn(article), [...held.renamed])
  }

  const versions = await imageVersions(article, images)

  if (shown === article && token === redraws) {
    images = versions
    showImages()
    void live.resubscribe()
  }
}

/** Blocks pair by key wherever they moved; blank text pairs only with the blank after its block's partner. */
function matches(current: Node[], next: Node[]): Map<Node, Node> {
  const blank = (node: Node) => node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()
  const position = new Map(current.map((node, index) => [node, index]))
  const old = new Map<string, Node[]>()
  const kept = new Map<Node, Node>()

  for (const node of current) {
    const key = keyOf(node)

    if (key !== undefined && !blank(node)) {
      old.set(key, [...(old.get(key) ?? []), node])
    }
  }

  for (const [index, node] of next.entries()) {
    const before = kept.get(next[index - 1])
    const after = before && current[(position.get(before) ?? -2) + 1]
    const same = blank(node)
      ? after && blank(after) && after.textContent === node.textContent && after
      : take(old.get(keyOf(node) ?? ""), node)

    if (same) {
      kept.set(node, same)
    }
  }

  return kept
}

/** Of blocks drawn alike, the one with the same id in the same file is kept, then one from the same file. */
function take(candidates: Node[] | undefined, node: Node): Node | undefined {
  const same = candidates?.findIndex((candidate) => sameBlock(candidate, node)) ?? -1
  const sameFile =
    candidates?.findIndex((candidate) => sourceOf(candidate) === sourceOf(node)) ?? -1
  return candidates?.splice(same >= 0 ? same : Math.max(sameFile, 0), 1)[0]
}

function sourceOf(node: Node): string | null {
  return node instanceof Element ? node.getAttribute("data-folio-source") : null
}

function patch(blocks: Node[]): void {
  const anchor = readingBlock(blocks)
  const top = anchor?.getBoundingClientRect().top
  const wanted = new Set(blocks)
  unfoldAll(article)

  for (const node of [...article.childNodes]) {
    if (!wanted.has(node)) {
      node.remove()
    }
  }

  for (const [index, node] of blocks.entries()) {
    if (article.childNodes[index] !== node) {
      article.insertBefore(node, article.childNodes[index] ?? null)
    }
  }

  foldable(article, urlPath)
  tables.attach(article, urlPath)
  outline.build(article)
  provenance.flag(article)

  if (anchor && top !== undefined) {
    scrollBy(0, anchor.getBoundingClientRect().top - top)
  }
}

function readingBlock(kept: Node[]): Element | undefined {
  const line = bar.getBoundingClientRect().bottom
  const keeping = new Set(kept)

  return blocksOf(article).find(
    (node): node is Element =>
      node instanceof Element &&
      keeping.has(node) &&
      node.getClientRects().length > 0 &&
      node.getBoundingClientRect().bottom > line,
  )
}

async function swap(next: HTMLElement, position: () => void): Promise<void> {
  const before = unannounced?.before ?? blocksIn(article)
  unannounced = undefined
  article.replaceWith(next)
  article = next
  DRAWN.set(article, text)
  foldable(article, urlPath)
  tables.attach(article, urlPath)
  position()
  outline.build(article)
  provenance.flag(article)
  backlinks.show(kind === "folder" || kind === "view" ? undefined : urlPath, links)
  void usedBy.show(kind === "folder" || kind === "view" ? undefined : urlPath)

  if (version?.endsWith("-partial")) {
    unannounced = { before, cause: "load", renamed: new Set() }
  } else {
    announce(urlPath, "load", before, blocksIn(article))
  }
  const versions = await imageVersions(article, images)

  if (article === next) {
    images = versions
    showImages()
    void live.resubscribe()
  }
}

/** Plain clicks to another page or folder, or on a heading's mark, are folio's; the rest stay the browser's. */
function follow(event: MouseEvent): void {
  const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
  const url = link && URL.canParse(link.href) && new URL(link.href)
  const plain =
    event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey

  if (
    !url ||
    !plain ||
    event.defaultPrevented ||
    link.target ||
    link.hasAttribute("download") ||
    url.origin !== location.origin ||
    url.search
  ) {
    return
  }

  if (link.classList.contains("heading-link")) {
    event.preventDefault()
    blockLinks.gone(false)
    history.replaceState(history.state, "", url.hash)
    link.parentElement?.scrollIntoView()
    return
  }

  if (url.pathname === location.pathname && url.hash) {
    clearTimeout(saving)
    saveScroll()
    return
  }

  event.preventDefault()
  void go(url, url.href === location.href ? "replace" : "push")
}

function returned(): void {
  clearTimeout(saving)

  if (decodeURIComponent(location.pathname).slice(1) === urlPath) {
    navigation++

    if (kind === "data" && JSON.stringify(pickedOf(location)) !== shownFilter) {
      void load().then(async (current) => {
        if (current) {
          await draw()
          land()
        }
      })
    } else {
      land()
    }
  } else {
    void go(new URL(location.href), "pop")
  }
}

/** The old content stays until the new is ready; what folio cannot show in place loads as a new page. */
async function go(url: URL, mode: "push" | "replace" | "pop"): Promise<void> {
  const token = ++navigation
  const next = await destination(url).catch(() => undefined)

  if (token !== navigation) {
    return
  }

  if (!next) {
    location[mode === "push" ? "assign" : "replace"](url.href)
    return
  }

  clearTimeout(saving)

  if (mode !== "pop") {
    saveScroll()
    history[mode === "push" ? "pushState" : "replaceState"](null, "", next.pathname + url.hash)
  }

  urlPath = decodeURIComponent(next.pathname).slice(1)
  kind = next.kind
  pointed = null
  lookSoon()
  viewName = undefined
  shownView = undefined
  folderPath = urlPath.replace(/\/$/, "")
  text = next.text
  sources = next.sources
  links = next.links
  marked = next.read
  version = next.version
  entries = next.entries
  dataPage = next.data
  shownFilter = JSON.stringify(pickedOf(location))
  document.documentElement.classList.remove("missing")
  document.documentElement.removeAttribute("data-missing")
  prerender.clear()
  closeExpanded()
  showTitle()
  showHistoryLink()
  const trail = breadcrumbs()
  crumbs.replaceWith(trail)
  crumbs = trail
  void tree.show(urlPath)
  void showSteps()
  await swap(next.article ?? listingArticle(), land)

  if (next.article && kind !== "data" && next.article.dataset.theme !== theme()) {
    void draw()
  }

  if (live.suspended) {
    live.start()
    showLive()
  }
}

async function destination(url: URL): Promise<Destination | undefined> {
  const target = decodeURIComponent(url.pathname).slice(1)
  const known = kindOf(target)

  if (viewOf(url.search, url.pathname)) {
    return undefined
  }

  if (known === "markdown" || known === "mermaid") {
    const content = await fetchPage(url.pathname)
    return (
      content && {
        pathname: url.pathname,
        kind: known,
        ...content,
        sources: content,
        entries: [],
        article: await prerender.take(url.pathname, content, known),
      }
    )
  }

  if (known === "data") {
    const { dataArticle, fetchData } = await import("./data.ts")
    const found = await fetchData(target, tableOf(url), pickedOf(url)?.filter)
    return (
      found && {
        pathname: url.pathname,
        kind: known,
        text: "",
        sources: NO_SOURCES,
        version: found.version,
        entries: [],
        data: found,
        article: dataArticle(target, found, pickedOf(url)),
      }
    )
  }

  const folder = target.replace(/\/$/, "")
  const listing = await fetchListing(folder)
  return (
    listing && {
      pathname: href(folder, true),
      kind: "folder",
      text: "",
      sources: NO_SOURCES,
      version: listing.version,
      entries: listing.entries,
    }
  )
}

let pageUpdating = Promise.resolve()

async function changed(change: Change): Promise<void> {
  if (
    viewName === "not-found" &&
    change.kind === "page" &&
    change.path === urlPath &&
    change.version !== null
  ) {
    return appeared()
  }

  if (change.kind === "folder") {
    void showSteps()
    await tree.refresh(change.path)
  }

  if (change.kind === "image") {
    images.set(change.path, change.version)

    showImages()
  }

  const own =
    kind === "folder"
      ? change.kind === "folder" && change.path === folderPath
      : change.kind === (kind === "data" ? "data" : "page") && change.path === urlPath

  if (own) {
    const updating = (async () => {
      if (await load(true)) {
        await update()
        showMarks()
      }
    })()
    pageUpdating = updating.catch(() => {})
    await updating
  }

  if (change.kind === "reads" && change.path === urlPath) {
    await refreshMarks()
  }

  if (change.kind === "changes") {
    await showChanges()

    if (kind === "view" && viewName === "catch-up" && (await load())) {
      await draw()
    }
  }

  if (change.kind === "stale" && kind === "view" && viewName === "stale" && (await load())) {
    await draw()
  }

  if (change.kind === "needs" && kind === "view" && viewName === "needs" && (await load())) {
    await draw()
  }

  if (change.kind === "health" && kind === "view" && viewName === "health") {
    const { updateHealth } = await import("./health.ts")
    version = (await updateHealth()) ?? version
    live.resubscribe()
  }

  if (change.kind === "embed" && kind !== "folder" && kind !== "data" && kind !== "view") {
    // A page update told just before may replace the embed, and draws it at its version itself.
    await pageUpdating
    const shown = article
    await Promise.all(redrawEmbeds(article, change.path, theme(), change.version))

    if (shown === article) {
      tables.attach(article, urlPath)
      live.resubscribe()
    }
  }

  if (change.kind === "links" && change.path === urlPath) {
    if (await backlinks.refresh(urlPath)) {
      live.resubscribe()
    }
  }
}

async function appeared(): Promise<void> {
  kind = kindOf(urlPath) ?? "markdown"
  viewName = undefined
  shownView = undefined
  document.documentElement.removeAttribute("data-missing")

  if (await load()) {
    showTitle()
    showHistoryLink()
    await draw()
    void showSteps()
  }
}

/** Each step starts from the page the one before it reached, so repeated presses keep moving. */
function queueStep(direction: Step): void {
  const work = async () => {
    const target = (await neighbours())?.[direction]

    if (target) {
      await go(new URL(href(target), location.href), "push")
    }
  }
  stepping = stepping.then(work, work)
}

async function showSteps(): Promise<void> {
  const shown = urlPath
  const around = await neighbours().catch(() => undefined)

  if (shown === urlPath) {
    steps.previous.disabled = !around?.previous
    steps.next.disabled = !around?.next
  }
}

async function neighbours(): Promise<Record<Step, string | null> | undefined> {
  if (kind === "folder" || kind === "data" || kind === "view") {
    return undefined
  }

  const response = await fetch(`${href(urlPath)}?step`)
  return response.ok ? response.json() : undefined
}

function sidewaysScroller(target: Element): Element | undefined {
  if (!article.contains(target)) {
    return undefined
  }

  for (
    let element: Element | null = target;
    element && element !== article;
    element = element.parentElement
  ) {
    if (
      /auto|scroll/.test(getComputedStyle(element).overflowX) &&
      element.scrollWidth > element.clientWidth
    ) {
      return element
    }
  }

  return undefined
}

function subscription(): Subscription {
  const folders: Record<string, string | null> = tree.folders()

  if (kind === "folder") {
    folders[folderPath] = version
  }

  const textual = kind === "markdown" || kind === "mermaid"
  const awaited = viewName === "not-found" && /^(markdown|mermaid)$/.test(kindOf(urlPath) ?? "")

  return {
    page: textual ? { [urlPath]: version } : awaited ? { [urlPath]: null } : {},
    data: kind === "data" ? { [urlPath]: version } : {},
    embeds: textual ? embedVersions(article) : {},
    images: Object.fromEntries(images),
    folders,
    withData: dataShown(),
    links: textual ? { [urlPath]: backlinks.version } : {},
    reads: textual ? { [urlPath]: marks.version } : {},
    changes: { "": changes?.version ?? null },
    health: kind === "view" && viewName === "health" ? { "": version } : {},
    needs: kind === "view" && viewName === "needs" ? { "": version } : {},
    stale: kind === "view" && viewName === "stale" ? { "": version } : {},
  }
}

/** An image's version is its ETag; each local image is asked once, then kept current by changes. */
async function imageVersions(
  element: HTMLElement,
  known: Map<string, string | null>,
): Promise<Map<string, string | null>> {
  const paths = [...element.querySelectorAll("img")]
    .map((image) => localPath(image.src))
    .filter((p) => p !== undefined)
  const versions = new Map<string, string | null>()

  for (const imagePath of new Set(paths)) {
    if (known.has(imagePath)) {
      versions.set(imagePath, known.get(imagePath) ?? null)
    } else {
      const response = await fetch(href(imagePath), { method: "HEAD" })
      versions.set(imagePath, response.headers.get("ETag")?.replaceAll('"', "") ?? null)
    }
  }

  return versions
}

/** A version in every local image's address: a re-render then never falls back to an earlier copy. */
function showImages(): void {
  for (const image of article.querySelectorAll("img")) {
    const imagePath = localPath(image.src)
    const imageVersion = imagePath === undefined ? null : images.get(imagePath)

    if (imagePath !== undefined && imageVersion) {
      image.src = `${href(imagePath)}?v=${imageVersion}`
    }
  }
}

function localPath(src: string): string | undefined {
  const url = URL.canParse(src, location.href) && new URL(src, location.href)

  if (!url || url.origin !== location.origin) {
    return undefined
  }

  try {
    return decodeURIComponent(url.pathname).slice(1)
  } catch {
    return undefined
  }
}

function listingArticle(): HTMLElement {
  const element = document.createElement("article")
  const heading = document.createElement("h1")
  const list = document.createElement("ul")

  element.className = "markdown-body listing"
  heading.textContent = folderPath.split("/").pop() || rootName
  list.append(
    ...entries.map((entry) => {
      const item = document.createElement("li")
      const link = document.createElement("a")
      const entryPath = folderPath ? `${folderPath}/${entry.name}` : entry.name
      link.href = href(entryPath, entry.kind === "folder")
      link.innerHTML = iconFor(entry.kind)
      link.append(document.createTextNode(entry.kind === "folder" ? `${entry.name}/` : entry.name))
      item.append(link)
      return item
    }),
  )
  element.append(
    heading,
    entries.length
      ? list
      : Object.assign(document.createElement("p"), { textContent: "Nothing to show." }),
  )
  return element
}

/** Greyed rather than hidden where there is no document, as the step buttons are, so the bar keeps its shape. */
function showHistoryLink(): void {
  const textual = kind === "markdown" || kind === "mermaid"

  historyLink.setAttribute("aria-disabled", String(!textual))
  toggles.copy.hidden = !textual

  if (textual) {
    historyLink.href = `${href(urlPath)}?history`
  } else {
    historyLink.removeAttribute("href")
  }
}

function shownBlocks(): Element[] {
  return blocksOf(article).filter((node): node is Element => node instanceof Element)
}

/** The text the shown blocks were drawn from: a save sets the page's text before its redraw lands. */
function shownText(): string {
  return DRAWN.get(article) ?? text
}

function documentCopy(): string {
  return kind === "mermaid"
    ? unmarked(shownText()).trimEnd()
    : documentMarkdown(shownText(), shownBlocks(), (table) => tables.viewed(table))
}

function showTitle(): void {
  document.title =
    (kind === "view"
      ? shownView?.title
      : kind === "folder"
        ? folderPath.split("/").pop() || rootName
        : urlPath.split("/").pop()) ?? "folio"
}

function breadcrumbs(): HTMLElement {
  const nav = document.createElement("nav")
  const parts = urlPath.split("/").filter(Boolean)

  nav.className = "breadcrumbs"
  nav.setAttribute("aria-label", "Breadcrumbs")

  for (const [index, name] of [rootName, ...parts].entries()) {
    const last = index === parts.length
    const crumb = document.createElement(last ? "span" : "a")

    if (index > 0) {
      nav.append(
        Object.assign(document.createElement("span"), { className: "separator", textContent: "/" }),
      )
    }

    crumb.textContent = name

    if (!last) {
      ;(crumb as HTMLAnchorElement).href = href(parts.slice(0, index).join("/"), true)
    }

    nav.append(crumb)
  }

  return nav
}

function land(): void {
  const saved = (history.state as { scroll?: number } | null)?.scroll
  const id = fragmentOf(location.hash)
  const heading = id
    ? (document.getElementById(id) ??
      document.getElementById(`user-content-${id}`) ??
      document.getElementById(id.replace(/^user-content-/, "")))
    : null
  const block = blockLinks.find(location.hash)

  restoring = saved
  blockLinks.gone(block === null)

  if (kind !== "folder") {
    tables.restore(article, urlPath, viewsIn(location.search))
    marks.place()
  }

  if (saved !== undefined) {
    restore()
  } else if (heading?.classList.contains("include-missing")) {
    landOn(heading)
  } else if (heading) {
    reveal(heading)
    heading.scrollIntoView()
  } else if (block) {
    landOn(block)
  } else {
    scrollTo(0, 0)
  }
}

function restore(): void {
  scrollTo(0, restoring ?? scrollY)
  const loading = [...article.querySelectorAll("img")].some((image) => !image.complete)

  if (restoring !== undefined && (scrollY >= restoring - 1 || !loading)) {
    restoring = undefined
  }
}

function rememberScroll(): void {
  clearTimeout(saving)
  saving = setTimeout(saveScroll, SAVE_SCROLL_MS)
}

/** Held while restoring, and while back or forward has moved the address ahead of the page shown. */
function saveScroll(): void {
  if (restoring !== undefined || decodeURIComponent(location.pathname).slice(1) !== urlPath) {
    return
  }

  history.replaceState({ ...history.state, scroll: scrollY }, "")
}

function pickedOf(address: { search: string }): Picked | undefined {
  try {
    const picked = JSON.parse(new URLSearchParams(address.search).get("filter") ?? "null")
    return typeof picked?.label === "string" && typeof picked.filter?.field === "string"
      ? picked
      : undefined
  } catch {
    return undefined
  }
}

function tableOf(address: { search: string }): string | undefined {
  return new URLSearchParams(address.search).get("table") ?? undefined
}

/** The views of the page's tables live in its address, so a copied address reopens them and back undoes them. */
function writeViews(typed: boolean): void {
  const views = tables.views(article)
  const url = new URL(location.href)
  const now = Date.now()

  if (Object.keys(views).length > 0) {
    url.searchParams.set("view", encodeView(views))
  } else {
    url.searchParams.delete("view")
  }

  if (url.href !== location.href) {
    history[typed && now - viewWritten < VIEW_ENTRY_MS ? "replaceState" : "pushState"](
      { ...history.state, scroll: scrollY },
      "",
      url.href,
    )
  }

  viewWritten = now
}

function viewsIn(search: string): Record<string, View> {
  const encoded = new URLSearchParams(search).get("view")

  try {
    const text = encoded && atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))
    const views = text
      ? JSON.parse(new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0))))
      : {}
    return views !== null && typeof views === "object" && !Array.isArray(views) ? views : {}
  } catch {
    return {}
  }
}

function encodeView(views: Record<string, View>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(views))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}
