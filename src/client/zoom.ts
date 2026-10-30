/** Full-window mermaid viewer: wheel zoom at the pointer, drag to pan, buttons and keys for both, fit. */

import { button, ICONS } from "./icons.ts"

const ZOOM_STEP_RATIO = 1.25
/** Of the viewport's own width or height, per button or key press. */
const PAN_FRACTION = 0.2
const MIN_SCALE_RATIO = 0.25
const MAX_SCALE_RATIO = 8
const DRAG_THRESHOLD_PX = 5

interface View {
  scale: number
  x: number
  y: number
}

let overlay: Overlay | undefined

/** A button opening a rendered diagram full-window; the diagram itself stays clickable. */
export function expandable(figure: HTMLElement): HTMLButtonElement {
  const svg = figure.querySelector("svg")
  const expand = button(ICONS.expand, "Expand diagram", "icon-button mermaid-expand")

  expand.addEventListener("click", () => {
    if (svg) {
      overlay ??= new Overlay()
      overlay.open(svg)
    }
  })

  return expand
}

export function closeExpanded(): void {
  overlay?.close()
}

class Overlay {
  readonly #root = document.createElement("div")
  readonly #viewport = document.createElement("div")
  readonly #inner = document.createElement("div")
  readonly #zoomIn = button(ICONS.zoomIn, "Zoom in")
  readonly #zoomOut = button(ICONS.zoomOut, "Zoom out")
  #view: View | undefined
  #fit: View | undefined
  #bounds = { min: 0, max: Number.POSITIVE_INFINITY }
  #drag:
    | { startX: number; startY: number; originX: number; originY: number; moved: boolean }
    | undefined
  /** Set by a drag that ends over the backdrop, so the click a drag-release synthesizes does not close. */
  #dragged = false

  constructor() {
    const controls = document.createElement("div")
    const fit = button(ICONS.fit, "Fit to view")
    const pans: [string, string, number, number][] = [
      [ICONS.left, "Pan left", 1, 0],
      [ICONS.up, "Pan up", 0, 1],
      [ICONS.down, "Pan down", 0, -1],
      [ICONS.right, "Pan right", -1, 0],
    ]
    const close = button(ICONS.close, "Close", "icon-button mermaid-zoom-close")

    this.#root.className = "mermaid-zoom"
    this.#viewport.className = "mermaid-zoom-viewport"
    this.#inner.className = "mermaid-zoom-inner"
    controls.className = "mermaid-zoom-controls"
    controls.append(this.#zoomOut, this.#zoomIn, fit, document.createElement("span"))

    for (const [icon, label, dx, dy] of pans) {
      const pan = button(icon, label)
      pan.addEventListener("click", () => this.#pan(dx, dy))
      controls.append(pan)
    }

    this.#viewport.append(this.#inner, controls)
    this.#root.append(close, this.#viewport)
    // Appended last so a cloned diagram's duplicate ids never outrank the originals:
    // their markers and scoped styles resolve to the first match in document order.
    document.body.append(this.#root)

    this.#zoomIn.addEventListener("click", () => this.#zoomAtCentre(ZOOM_STEP_RATIO))
    this.#zoomOut.addEventListener("click", () => this.#zoomAtCentre(1 / ZOOM_STEP_RATIO))
    fit.addEventListener("click", () => this.#fitView())
    close.addEventListener("click", () => this.close())
    this.#root.addEventListener("click", (event) => {
      if (this.#dragged) {
        this.#dragged = false
      } else if (event.target === this.#root || event.target === this.#viewport) {
        this.close()
      }
    })
    this.#viewport.addEventListener("wheel", (event) => this.#wheel(event), { passive: false })
    this.#viewport.addEventListener("pointerdown", (event) => this.#pointerDown(event))
    this.#viewport.addEventListener("pointermove", (event) => this.#pointerMove(event))
    this.#viewport.addEventListener("pointerup", () => this.#pointerUp())
    document.addEventListener("keydown", (event) => this.#key(event))
    // A resize changes what fitting means, but leaves the current view alone.
    window.addEventListener("resize", () => {
      if (this.#root.classList.contains("visible")) {
        this.#measure()
      }
    })
  }

  open(svg: SVGSVGElement): void {
    this.#inner.replaceChildren(svg.cloneNode(true))
    this.#root.classList.add("visible")
    // Measured only once the overlay is laid out - a hidden viewport has no client box.
    this.#measure()
    this.#fitView()
  }

  close(): void {
    this.#root.classList.remove("visible")
    this.#inner.replaceChildren()
    this.#view = undefined
    this.#fit = undefined
    this.#drag = undefined
  }

  #measure(): void {
    this.#fit = this.#computeFit()

    if (this.#fit) {
      this.#bounds = {
        min: this.#fit.scale * MIN_SCALE_RATIO,
        max: this.#fit.scale * MAX_SCALE_RATIO,
      }
    }
  }

  #computeFit(): View | undefined {
    const svg = this.#inner.querySelector("svg")
    const vw = this.#viewport.clientWidth
    const vh = this.#viewport.clientHeight
    // viewBox is the diagram's intrinsic size, unaffected by any CSS cap on the rendered box.
    const box = svg?.viewBox.baseVal
    const w = box?.width || svg?.getBoundingClientRect().width || 0
    const h = box?.height || svg?.getBoundingClientRect().height || 0

    if (!svg || !vw || !vh || !w || !h) {
      return undefined
    }

    // mermaid's width="100%" has nothing to resolve against here, so the SVG is pinned to its viewBox.
    svg.style.width = `${w}px`
    svg.style.height = `${h}px`
    svg.style.maxWidth = "none"

    const scale = Math.min(vw / w, vh / h, 1)
    return { scale, x: (vw - w * scale) / 2, y: (vh - h * scale) / 2 }
  }

  #apply(): void {
    if (!this.#view) {
      this.#inner.style.visibility = "hidden"
      return
    }

    this.#inner.style.visibility = ""
    this.#inner.style.transform = `translate(${this.#view.x}px, ${this.#view.y}px) scale(${this.#view.scale})`
    this.#zoomOut.disabled = this.#view.scale <= this.#bounds.min
    this.#zoomIn.disabled = this.#view.scale >= this.#bounds.max
  }

  #fitView(): void {
    this.#view = this.#fit && { ...this.#fit }
    this.#apply()
  }

  /** Whatever sits under the anchor before the scale change sits under it after. */
  #zoomAt(factor: number, anchorX: number, anchorY: number): void {
    if (!this.#view) {
      return
    }

    const scale = Math.min(this.#bounds.max, Math.max(this.#bounds.min, this.#view.scale * factor))
    const ratio = scale / this.#view.scale

    this.#view = {
      scale,
      x: anchorX - (anchorX - this.#view.x) * ratio,
      y: anchorY - (anchorY - this.#view.y) * ratio,
    }
    this.#apply()
  }

  #zoomAtCentre(factor: number): void {
    this.#zoomAt(factor, this.#viewport.clientWidth / 2, this.#viewport.clientHeight / 2)
  }

  /** (dx, dy) is how the content moves: panning left reveals what was to the left, so it moves right. */
  #pan(dx: number, dy: number): void {
    if (this.#view) {
      this.#view.x += dx * this.#viewport.clientWidth * PAN_FRACTION
      this.#view.y += dy * this.#viewport.clientHeight * PAN_FRACTION
      this.#apply()
    }
  }

  #wheel(event: WheelEvent): void {
    event.preventDefault()
    const rect = this.#viewport.getBoundingClientRect()
    const factor = event.deltaY < 0 ? ZOOM_STEP_RATIO : 1 / ZOOM_STEP_RATIO
    this.#zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top)
  }

  #pointerDown(event: PointerEvent): void {
    // A press on a control is not a drag on the diagram; capturing it would swallow the click.
    if (
      event.button !== 0 ||
      !this.#view ||
      (event.target as Element).closest(".mermaid-zoom-controls")
    ) {
      return
    }

    this.#viewport.setPointerCapture(event.pointerId)
    this.#drag = {
      startX: event.clientX,
      startY: event.clientY,
      originX: this.#view.x,
      originY: this.#view.y,
      moved: false,
    }
  }

  #pointerMove(event: PointerEvent): void {
    if (!this.#drag || !this.#view) {
      return
    }

    const dx = event.clientX - this.#drag.startX
    const dy = event.clientY - this.#drag.startY
    this.#drag.moved ||= Math.hypot(dx, dy) > DRAG_THRESHOLD_PX

    if (this.#drag.moved) {
      this.#view.x = this.#drag.originX + dx
      this.#view.y = this.#drag.originY + dy
      this.#apply()
    }
  }

  #pointerUp(): void {
    if (this.#drag?.moved) {
      this.#dragged = true
      // Only the click synthesized right after this pointerup is a drag-release, never a later one.
      setTimeout(() => {
        this.#dragged = false
      }, 0)
    }

    this.#drag = undefined
  }

  #key(event: KeyboardEvent): void {
    if (!this.#root.classList.contains("visible")) {
      return
    }

    const actions: Record<string, () => void> = {
      Escape: () => this.close(),
      "+": () => this.#zoomAtCentre(ZOOM_STEP_RATIO),
      "=": () => this.#zoomAtCentre(ZOOM_STEP_RATIO),
      "-": () => this.#zoomAtCentre(1 / ZOOM_STEP_RATIO),
      ArrowLeft: () => this.#pan(1, 0),
      ArrowUp: () => this.#pan(0, 1),
      ArrowDown: () => this.#pan(0, -1),
      ArrowRight: () => this.#pan(-1, 0),
    }
    const action = actions[event.key]

    if (action) {
      // Consumed so the page behind never scrolls.
      event.preventDefault()
      action()
    }
  }
}
