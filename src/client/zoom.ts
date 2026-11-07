/** Full-window viewer: diagrams, charts and images zoomed and panned, maps and models moved in live. */

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

export interface Live {
  parts: HTMLElement[]
  moved(intoViewer: boolean): void
}

interface Picture {
  element: HTMLElement | SVGSVGElement
  size: () => [number, number]
  fill: boolean
}

let overlay: Overlay | undefined
let anchors = 0

/** A button opening a drawn diagram or chart full-window, filling it; the drawing itself stays clickable. */
export function expandDrawing(
  what: string,
  drawn: () => SVGSVGElement | null | undefined,
): HTMLButtonElement {
  return expander(what, () => {
    const svg = drawn()

    if (svg) {
      // viewBox is the drawing's intrinsic size, unaffected by any CSS cap on the rendered box.
      const box = svg.viewBox.baseVal
      const { width, height } = svg.getBoundingClientRect()
      const size: [number, number] = [box?.width || width, box?.height || height]
      viewer().showPicture({
        element: svg.cloneNode(true) as SVGSVGElement,
        size: () => size,
        fill: true,
      })
    }
  })
}

/** A button moving a live map's or model's parts into the viewer, filling it, and back when it closes. */
export function expandLive(what: string, figure: HTMLElement, live: Live): HTMLButtonElement {
  return expander(what, () => viewer().showLive(figure, live))
}

/**
 * The corner of an image, to place right after it: a button opening it full-window. Anchored to the
 * image rather than wrapped around it, so an image its page sizes, floats or aligns keeps its layout.
 */
export function imageCorner(image: HTMLImageElement): HTMLElement {
  const corner = document.createElement("span")
  const anchor = `--image-${++anchors}`

  corner.className = "drawn-toolbar image-toolbar"
  image.style.setProperty("anchor-name", anchor)
  corner.style.setProperty("position-anchor", anchor)
  corner.append(expander("image", () => viewer().showPicture(pictureOf(image))))
  return corner
}

export function closeExpanded(): void {
  overlay?.close()
}

function expander(what: string, open: () => void): HTMLButtonElement {
  const expand = button(ICONS.expand, `Expand ${what}`, "icon-button drawn-expand")

  expand.addEventListener("click", () => {
    // The button keeps its focus behind the open viewer, where Space or Enter would open it again.
    if (!overlay?.shown) {
      open()
    }
  })

  return expand
}

function viewer(): Overlay {
  overlay ??= new Overlay()
  return overlay
}

function pictureOf(image: HTMLImageElement): Picture {
  const shown = new Image()
  const src = image.currentSrc || image.src
  const svg = URL.canParse(src) && /\.svg$/i.test(new URL(src).pathname)
  // An SVG without a width and height of its own reports a default natural size; its drawn box keeps its shape.
  const { width, height } = image.getBoundingClientRect()

  shown.src = src
  shown.alt = image.alt
  // A press on an image would start the browser's own drag of it, cancelling the pan.
  shown.draggable = false
  return {
    element: shown,
    size: () => (svg ? [width, height] : [shown.naturalWidth, shown.naturalHeight]),
    fill: svg,
  }
}

class Overlay {
  readonly #root = document.createElement("div")
  readonly #viewport = document.createElement("div")
  readonly #inner = document.createElement("div")
  readonly #stage = document.createElement("div")
  readonly #zoomIn = button(ICONS.zoomIn, "Zoom in")
  readonly #zoomOut = button(ICONS.zoomOut, "Zoom out")
  #picture: Picture | undefined
  #live: { figure: HTMLElement; live: Live } | undefined
  #view: View | undefined
  #fit: View | undefined
  #bounds = { min: 0, max: Number.POSITIVE_INFINITY }
  #drag:
    | { startX: number; startY: number; originX: number; originY: number; moved: boolean }
    | undefined

  constructor() {
    const controls = document.createElement("div")
    const fit = button(ICONS.fit, "Fit to view")
    const pans: [string, string, number, number][] = [
      [ICONS.left, "Pan left", 1, 0],
      [ICONS.up, "Pan up", 0, 1],
      [ICONS.down, "Pan down", 0, -1],
      [ICONS.right, "Pan right", -1, 0],
    ]
    const close = button(ICONS.close, "Close", "icon-button viewer-close")

    this.#root.className = "viewer"
    this.#viewport.className = "viewer-viewport"
    this.#inner.className = "viewer-inner"
    this.#stage.className = "viewer-stage"
    controls.className = "viewer-controls"
    controls.append(this.#zoomOut, this.#zoomIn, fit, document.createElement("span"))

    for (const [icon, label, dx, dy] of pans) {
      const pan = button(icon, label)
      pan.addEventListener("click", () => this.#pan(dx, dy))
      controls.append(pan)
    }

    this.#viewport.append(this.#inner, this.#stage, controls)
    this.#root.append(close, this.#viewport)
    // Appended last so a cloned diagram's duplicate ids never outrank the originals:
    // their markers and scoped styles resolve to the first match in document order.
    document.body.append(this.#root)

    this.#zoomIn.addEventListener("click", () => this.#zoomAtCentre(ZOOM_STEP_RATIO))
    this.#zoomOut.addEventListener("click", () => this.#zoomAtCentre(1 / ZOOM_STEP_RATIO))
    fit.addEventListener("click", () => this.#fitView())
    close.addEventListener("click", () => this.close())
    this.#viewport.addEventListener("wheel", (event) => this.#wheel(event), { passive: false })
    this.#viewport.addEventListener("pointerdown", (event) => this.#pointerDown(event))
    this.#viewport.addEventListener("pointermove", (event) => this.#pointerMove(event))
    this.#viewport.addEventListener("pointerup", () => this.#pointerUp())
    document.addEventListener("keydown", (event) => this.#key(event))
    // A resize changes what fitting means, but leaves the current view alone.
    window.addEventListener("resize", () => {
      if (this.shown) {
        this.#measure()
      }
    })
  }

  get shown(): boolean {
    return this.#root.classList.contains("visible")
  }

  showPicture(picture: Picture): void {
    this.#picture = picture
    this.#inner.replaceChildren(picture.element)
    this.#root.classList.add("visible")
    // Measured only once the overlay is laid out - a hidden viewport has no client box.
    this.#measure()
    this.#fitView()

    picture.element.addEventListener("load", () => {
      if (this.#picture === picture && !this.#view) {
        this.#measure()
        this.#fitView()
      }
    })
  }

  showLive(figure: HTMLElement, live: Live): void {
    this.#live = { figure, live }
    // Held at its height, so the page behind keeps its layout while the drawing is away.
    figure.style.height = `${figure.offsetHeight}px`
    this.#stage.replaceChildren(...live.parts)
    this.#root.classList.add("visible", "live")
    live.moved(true)
  }

  close(): void {
    if (this.#live) {
      const { figure, live } = this.#live
      figure.prepend(...live.parts)
      figure.style.height = ""
      live.moved(false)
    }

    this.#root.classList.remove("visible", "live")
    this.#inner.replaceChildren()
    this.#picture = undefined
    this.#live = undefined
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
    const vw = this.#viewport.clientWidth
    const vh = this.#viewport.clientHeight
    const [w, h] = this.#picture?.size() ?? [0, 0]

    if (!this.#picture || !vw || !vh || !w || !h) {
      return undefined
    }

    // mermaid's width="100%" has nothing to resolve against here, so a picture is pinned to its own size.
    const { style } = this.#picture.element
    style.width = `${w}px`
    style.height = `${h}px`
    style.maxWidth = "none"

    const scale = Math.min(vw / w, vh / h, this.#picture.fill ? Number.POSITIVE_INFINITY : 1)
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
      (event.target as Element).closest(".viewer-controls")
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
    this.#drag = undefined
  }

  #key(event: KeyboardEvent): void {
    if (!this.shown) {
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
