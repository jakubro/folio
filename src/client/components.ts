/** Components: a fence drawn by a script from a folder named when Folio started, kept current with its data. */

import type { Embedded } from "../server/data.ts"
import { componentName, missingComponent, readComponent } from "./component.ts"
import { drawHanded, type Theme } from "./render.ts"
import { rowsOf } from "./rows.ts"
import { Waiting } from "./waiting.ts"

interface Context {
  data: Record<string, unknown>
  options: Record<string, unknown>
  theme: Theme
  act: (action: string, details?: unknown) => Promise<void>
  markdown: (text: string) => Promise<HTMLSlotElement>
}

interface Instance {
  update?: (context: Context) => unknown
  destroy?: () => unknown
}

type Drawn = Instance | string | undefined
type Draw = (element: HTMLElement, context: Context) => Drawn | Promise<Drawn>

export interface Script {
  name: string
  version: string | null
}

interface Listing {
  folders: string[]
  components: Record<string, { path: string; version: string }>
}

const ANSWERS = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
let slots = 0

class Host extends HTMLElement {
  readonly #root = this.attachShadow({ mode: "open", serializable: true } as ShadowRootInit)
  #live = deferred()
  #script: string | undefined
  #instance: Instance | undefined
  #element: HTMLElement | undefined
  readonly #drawings = new Map<HTMLSlotElement, { drawing: Element; placed: boolean }>()

  constructor() {
    super()
    // A drawing goes once its slot, placed, leaves the shadow root; one not placed yet waits to be.
    new MutationObserver(() => this.#prune()).observe(this.#root, {
      childList: true,
      subtree: true,
    })
  }

  // Pages are drawn in a document of their own first: nothing runs until the host joins the page.
  connectedCallback(): void {
    if (this.ownerDocument === document) {
      this.#live.resolve()
    }
  }

  // Folding a section moves its blocks, leaving and joining at once; only a host still gone has left.
  disconnectedCallback(): void {
    setTimeout(() => {
      if (!this.isConnected) {
        this.#live = deferred()
        this.#destroy()
      }
    })
  }

  async show(draw: Draw, script: string, context: Context): Promise<void> {
    await this.#live.promise

    if (this.#instance?.update && this.#script === script) {
      await this.#output(await this.#instance.update(context), context.theme)
      return
    }

    this.#destroy()
    const element = document.createElement("div")
    this.#root.replaceChildren(element)
    const drawn = await draw(element, context)
    this.#instance = typeof drawn === "string" ? {} : (drawn ?? {})
    this.#script = script
    this.#element = element
    await this.#output(drawn, context.theme)
  }

  /**
   * Draw markdown as the page draws its own, outside the shadow root so the page's styles and passes
   * reach it, and answer with the slot that shows it wherever the component places that slot.
   */
  async markdown(text: unknown, theme: Theme): Promise<HTMLSlotElement> {
    if (typeof text !== "string") {
      throw new Error("markdown(text) draws a text of markdown.")
    }

    const article = await drawHanded(text, theme)
    const drawing = document.createElement("div")
    const slot = document.createElement("slot")

    slot.name = drawing.slot = `markdown-${++slots}`
    drawing.className = "component-markdown"
    drawing.append(...article.childNodes)
    this.append(drawing)
    this.#drawings.set(slot, { drawing, placed: false })
    return slot
  }

  async #output(drawn: unknown, theme: Theme): Promise<void> {
    if (typeof drawn === "string" && this.#element) {
      this.#element.replaceChildren(await this.markdown(drawn, theme))
    }
  }

  #prune(): void {
    for (const [slot, held] of this.#drawings) {
      if (this.#root.contains(slot)) {
        held.placed = true
      } else if (held.placed) {
        held.drawing.remove()
        this.#drawings.delete(slot)
      }
    }
  }

  #destroy(): void {
    const instance = this.#instance

    this.#instance = undefined
    this.#script = undefined
    this.#element = undefined
    this.#root.replaceChildren()
    this.replaceChildren()
    this.#drawings.clear()

    try {
      instance?.destroy?.()
    } catch (error) {
      console.error(error)
    }
  }
}

if (!customElements.get("folio-component")) {
  customElements.define("folio-component", Host)
}

document.addEventListener("folio:answer", (event) => {
  const { id, reason } = ((event as CustomEvent).detail ?? {}) as { id?: unknown; reason?: unknown }
  const waiting = typeof id === "string" ? ANSWERS.get(id) : undefined

  if (waiting) {
    ANSWERS.delete(id as string)

    if (reason === undefined || reason === null) {
      waiting.resolve()
    } else {
      waiting.reject(new Error(String(reason)))
    }
  }
})

export async function drawComponent(
  element: HTMLElement,
  theme: Theme,
  fetchEmbed: (reference: string) => Promise<Embedded>,
  scripts: WeakMap<HTMLElement, Script>,
): Promise<{ partial: boolean }> {
  const code = element.querySelector(":scope > pre > code")

  // Drawn, the component would hide its source and the marker of the include it is missing.
  if (code?.querySelector(".include-missing")) {
    throw new Error("An include in this component resolves to nothing.")
  }

  const name = componentName(element.dataset.ref ?? "")
  const { data: entries, options } = readComponent(code?.textContent ?? "")
  const reading = Promise.all(
    Object.entries(entries).map(([entry, reference]) => dataOf(entry, reference, fetchEmbed)),
  )
  // Awaited only once the listing answers; a failure before then is not left unhandled.
  reading.catch(() => {})
  const listing = await listed().catch(async (error) => {
    await reading.catch(() => {})
    throw error
  })
  const script = Object.hasOwn(listing.components, name) ? listing.components[name] : undefined
  const version = script ? `${script.path}:${script.version}` : null

  // Known before the data is read, so a page whose data fails still hears its script change.
  scripts.set(element, { name, version })

  if (!script || !version) {
    await reading.catch(() => {})
    throw new Error(missingComponent(name, listing.folders.length))
  }

  const read = await reading

  const module = await import(
    `/?component=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`
  )

  if (typeof module.default !== "function") {
    throw new Error(`${name}.js exports no function to draw with as its default.`)
  }

  let host = element.querySelector<Host>(":scope > folio-component")

  if (!host) {
    host = document.createElement("folio-component") as Host
    element.append(host)
  }

  await host.show(module.default, version, {
    data: Object.fromEntries(read.map(({ entry, value }) => [entry, value])),
    options,
    theme,
    act: (action, details) => act(host, name, action, details),
    markdown: (text) => host.markdown(text, theme),
  })

  return { partial: read.some(({ partial }) => partial) }
}

async function listed(): Promise<Listing> {
  const response = await fetch("/?components")

  if (!response.ok) {
    throw new Error((await response.text()).trim())
  }

  return response.json()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

async function dataOf(
  entry: string,
  reference: string,
  fetchEmbed: (reference: string) => Promise<Embedded>,
): Promise<{ entry: string; value: unknown; partial: boolean }> {
  let embedded: Embedded

  try {
    embedded = await fetchEmbed(reference)
  } catch (error) {
    if (error instanceof Waiting) {
      throw error
    }

    throw new Error(`${reference}: ${(error as Error).message}`)
  }

  return {
    entry,
    value: embedded.grid ? rowsOf(embedded) : embedded.value,
    partial: embedded.grid?.partial === true,
  }
}

/** Dispatched before any await, so a handler still holds the reader's gesture and may open a tab. */
function act(
  host: HTMLElement,
  component: string,
  action: string,
  details: unknown,
): Promise<void> {
  if (typeof action !== "string" || !action) {
    return Promise.reject(new Error("An action is named by a text."))
  }

  let copied: unknown

  // A content script reads the details in a script world of its own, which only plain data reaches.
  try {
    copied = structuredClone(details ?? null)
  } catch (error) {
    return Promise.reject(
      new Error(`An action's details are plain data: ${(error as Error).message}`),
    )
  }

  const id = crypto.randomUUID()
  const answered = new Promise<void>((resolve, reject) => ANSWERS.set(id, { resolve, reject }))
  const taken = !host.dispatchEvent(
    new CustomEvent("folio:action", {
      bubbles: true,
      cancelable: true,
      detail: { id, component, action, details: copied },
    }),
  )

  if (!taken) {
    ANSWERS.get(id)?.reject(new Error(`Nothing on this page carries out ${action}.`))
    ANSWERS.delete(id)
  }

  return answered
}
