/** A block's origin or latest versions, opened from its margin, and a flag beside each block holding a problem. */

import type { Provenance as Traced } from "../server/provenance.ts"
import { ICONS } from "./icons.ts"
import { href } from "./tree.ts"

const HEADINGS = "h1, h2, h3, h4, h5, h6"
const LATEST = 3
const GAP_PX = 4
const MARGIN_PX = 8
const WIDTH_PX = 600
const PROBLEMS = ".claim-contradicted, .embed-missing, .diagram-failed, .include-missing"
const SPACING_MS = 200
const STATES = {
  matching: "matches its data",
  contradicted: "contradicted",
  unchecked: "unchecked",
}

export class Provenance {
  readonly #layer = document.createElement("div")
  readonly #panel = document.createElement("div")
  #article: HTMLElement | undefined
  #under: HTMLElement | undefined
  #shown: "provenance" | "versions" | undefined
  /** Measured at the click: the margin buttons move on with the pointer. */
  #button = { offset: 0, height: 0 }
  #offset = 0
  readonly #flagged = new Map<HTMLElement, HTMLElement>()
  /** Folding moves blocks into a hidden section, and finding text in it unhides it: neither resizes the page. */
  readonly #folds = new MutationObserver(() => this.#request(false))
  #asked = 0
  #pending = false
  #rebuild = false
  #placed = 0

  constructor(main: HTMLElement) {
    this.#layer.className = "problem-flags"
    this.#panel.className = "mark-panel provenance-panel"
    this.#panel.hidden = true
    main.append(this.#layer, this.#panel)
    new ResizeObserver(() => this.#request(false)).observe(document.body)
    new ResizeObserver(() => this.#settle()).observe(this.#panel)
    addEventListener("resize", () => this.#settle())
    addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close()
      }
    })
  }

  flag(article: HTMLElement): void {
    if (this.#article !== article) {
      this.#folds.disconnect()
      this.#folds.observe(article, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden"],
      })
    }

    this.#article = article

    if (this.#under && !article.contains(this.#under)) {
      this.close()
    }

    this.#request(true)
  }

  async open(block: HTMLElement, from: HTMLElement): Promise<void> {
    const page = decodeURIComponent(location.pathname).slice(1)
    const { folioId: id = "", folioSource: source = page } = block.dataset
    const asked = ++this.#asked

    if (this.#under === block && this.#shown === "provenance") {
      this.close()
      return
    }

    this.#show(block, from, "provenance", [
      ...this.#top("Where this block came from"),
      waiting("Finding where this block came from"),
    ])
    const twins = [
      ...(this.#article?.querySelectorAll(
        `[data-folio-source="${CSS.escape(source)}"][data-folio-id="${CSS.escape(id)}"]`,
      ) ?? []),
    ]
    const response = await fetch(
      `${href(page)}?provenance=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}&at=${Math.max(0, twins.indexOf(block))}`,
    ).catch(() => undefined)
    const traced: Partial<Traced> = response?.ok ? await response.json() : {}

    if (asked === this.#asked) {
      this.#fill(this.#body(traced))
    }
  }

  async versions(block: HTMLElement, from: HTMLElement): Promise<void> {
    const page = decodeURIComponent(location.pathname).slice(1)
    const { folioId: id = "", folioSource: source = page } = block.dataset
    const asked = ++this.#asked

    if (this.#under === block && this.#shown === "versions") {
      this.close()
      return
    }

    this.#show(block, from, "versions", [
      ...this.#top("This block's past versions"),
      waiting("Reading this block's past versions"),
    ])
    const { blockVersions, versionList } = await import("./history.ts")
    const versions = await blockVersions(source, id).catch(() => [])

    if (asked !== this.#asked) {
      return
    }

    const shown = Object.assign(document.createElement("div"), { className: "markdown-body" })
    const all = document.createElement("p")

    all.append(
      Object.assign(document.createElement("a"), {
        href: `${href(source)}?history&block=${encodeURIComponent(id)}`,
        textContent: `All ${versions.length} version${versions.length === 1 ? "" : "s"}`,
      }),
    )
    shown.append(versionList(source, versions, LATEST), ...(versions.length > 0 ? [all] : []))
    this.#fill([...this.#top("This block's past versions"), shown])
  }

  close(): void {
    this.#asked++
    this.#under = undefined
    this.#shown = undefined
    this.#panel.hidden = true
  }

  #show(
    block: HTMLElement,
    from: HTMLElement,
    shown: "provenance" | "versions",
    nodes: Node[],
  ): void {
    const top = block.getBoundingClientRect().top
    const button = from.getBoundingClientRect()

    this.#under = block
    this.#shown = shown
    this.#button = { offset: button.top - top, height: button.height }
    this.#panel.hidden = false
    this.#fill(nodes)
  }

  #fill(nodes: Node[]): void {
    this.#panel.replaceChildren(...nodes)
    this.#settle()
  }

  /** Flipped and kept inside the window as its content or size changes, never as the page moves. */
  #settle(): void {
    const block = this.#under?.getBoundingClientRect()
    const right = this.#article?.getBoundingClientRect().right

    if (!block || right === undefined || this.#panel.hidden) {
      return
    }

    this.#panel.style.maxWidth = `${Math.min(WIDTH_PX, right - GAP_PX - MARGIN_PX)}px`
    const height = this.#panel.offsetHeight
    const top = block.top + this.#button.offset
    const floor = (document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0) + MARGIN_PX
    const ceiling = innerHeight - MARGIN_PX
    const seen = top >= floor && top + this.#button.height <= ceiling
    const placed = seen && top + height > ceiling ? top + this.#button.height - height : top

    this.#offset = (seen ? Math.max(floor, Math.min(placed, ceiling - height)) : placed) - block.top
    this.#place()
  }

  #top(text: string): [HTMLParagraphElement, HTMLButtonElement] {
    const close = Object.assign(document.createElement("button"), {
      className: "mark-panel-close",
      type: "button",
      textContent: "Close",
    })

    close.addEventListener("click", () => this.close())
    return [
      Object.assign(document.createElement("p"), {
        className: "mark-panel-title",
        textContent: text,
      }),
      close,
    ]
  }

  /** Every embed drawn asks again and each answer lays the page out, so asks are answered once per spacing. */
  #request(rebuild: boolean): void {
    this.#rebuild ||= rebuild

    if (this.#pending) {
      return
    }

    this.#pending = true
    setTimeout(
      () =>
        requestAnimationFrame(() => {
          this.#pending = false
          this.#placed = performance.now()

          if (this.#rebuild) {
            this.#rebuild = false
            this.#flagAll()
          }

          this.#place()
        }),
      Math.max(0, this.#placed + SPACING_MS - performance.now()),
    )
  }

  #flagAll(): void {
    const article = this.#article as HTMLElement
    const blocks = [...article.querySelectorAll<HTMLElement>("[data-folio-id]")].filter(
      (block) =>
        !block.parentElement?.closest("[data-folio-id]") &&
        (block.matches(PROBLEMS) || block.querySelector(PROBLEMS)),
    )

    this.#flagged.clear()
    this.#layer.replaceChildren(
      ...blocks.map((block) => {
        const flag = Object.assign(document.createElement("button"), {
          type: "button",
          className: "problem-flag",
          innerHTML: ICONS.alert,
          title: "Something here is wrong - see where it came from",
        })
        flag.dataset.folioId = block.dataset.folioId
        flag.dataset.folioSource = block.dataset.folioSource
        flag.addEventListener("click", () => void this.open(block, flag))
        this.#flagged.set(flag, block)
        return flag
      }),
    )
  }

  #body(traced: Partial<Traced>): Node[] {
    const [title, close] = this.#top("Where this block came from")

    if (!traced.source || !traced.lines) {
      return [title, close, line("Not known yet: Folio is still reading this file.")]
    }

    const { source, lines, changed, included, data = [], claims = [], conventions } = traced
    const nodes: Node[] = [title, close]
    const file = line("")

    file.append(
      link(source, `${source}`),
      ` lines ${lines[0]}-${lines[1]}`,
      ...(changed ? [", changed ", when(changed)] : []),
    )
    nodes.push(file)

    if (included) {
      nodes.push(
        line(
          included.section === undefined
            ? `Included: the whole of ${source}`
            : `Included: the section "${included.section}" of ${source}`,
        ),
      )
    }

    for (const { reference, files, query, error } of data) {
      const item = line(reference ? `Data: ${reference}` : "Query")

      if (files.length > 0) {
        item.append(" - reads ")
        files.forEach((found, index) => {
          item.append(
            index > 0 ? ", " : "",
            link(found.path, found.path),
            " (changed ",
            when(found.changed),
            ")",
          )
        })
      }

      if (error) {
        item.append(` - ${error}`)
      }

      nodes.push(item)

      if (query) {
        nodes.push(
          Object.assign(document.createElement("pre"), {
            className: "mark-panel-text",
            textContent: query,
          }),
        )
      }
    }

    if (conventions && conventions.declarations.length > 0) {
      const declared = line("Declared by ")
      conventions.declarations.forEach((found, index) => {
        declared.append(index > 0 ? ", " : "", link(found, found))
      })
      nodes.push(declared)
    }

    if (conventions?.kind && conventions.declaredIn) {
      const kind = line(`Kind: ${conventions.kind}, from `)
      kind.append(link(conventions.declaredIn, conventions.declaredIn))
      nodes.push(kind)

      for (const [name, value] of Object.entries(conventions.fields ?? {})) {
        nodes.push(
          line(`${name}: ${Array.isArray(value) ? value.join(", ") : String(value ?? "")}`),
        )
      }
    }

    for (const { figure, reference, state, live, reason } of claims) {
      const item = line(`Figure ${figure} (${reference}): ${STATES[state]}`)

      item.classList.add(`claim-${state}`)
      item.append(
        state === "contradicted" ? ` - the data says ${live}` : "",
        state === "unchecked" && reason ? ` - ${reason}` : "",
      )
      nodes.push(item)
    }

    return nodes
  }

  /**
   * Placed against the document, as the block link is, so no block element is touched. Every block is
   * measured before any flag moves: a write between two reads lays the whole page out again.
   */
  #place(): void {
    const article = this.#article?.getBoundingClientRect()

    if (!article) {
      return
    }

    // A folded section keeps its blocks laid out but skipped, so only this tells they are not shown.
    const rects = [...this.#flagged.values()].map((block) =>
      block.checkVisibility() ? block.getBoundingClientRect() : undefined,
    )

    for (const [index, [flag, block]] of [...this.#flagged].entries()) {
      const rect = rects[index]
      const top = `calc(${(rect?.top ?? 0) + scrollY}px + ${block.matches(HEADINGS) ? 0 : 1.25}em)`
      const left = `${article.right + scrollX}px`

      // A write that changes nothing still marks the page for layout again.
      if (flag.hidden !== !rect || flag.style.top !== top || flag.style.left !== left) {
        flag.hidden = !rect
        flag.style.top = top
        flag.style.left = left
      }
    }

    const under = this.#under?.getBoundingClientRect()

    if (under && !this.#panel.hidden) {
      const left = Math.max(MARGIN_PX, article.right - GAP_PX - this.#panel.offsetWidth)
      this.#panel.style.top = `${under.top + this.#offset + scrollY}px`
      this.#panel.style.left = `${left + scrollX}px`
    }
  }
}

function waiting(text: string): HTMLParagraphElement {
  const shown = Object.assign(document.createElement("p"), { className: "panel-waiting" })

  shown.append(Object.assign(document.createElement("span"), { className: "spinner" }), text)
  return shown
}

function line(text: string): HTMLParagraphElement {
  return Object.assign(document.createElement("p"), {
    className: "provenance-line",
    textContent: text,
  })
}

function link(target: string, text: string): HTMLAnchorElement {
  return Object.assign(document.createElement("a"), { href: href(target), textContent: text })
}

function when(at: string): HTMLTimeElement {
  return Object.assign(document.createElement("time"), {
    dateTime: at,
    textContent: new Date(at).toLocaleString(),
  })
}
