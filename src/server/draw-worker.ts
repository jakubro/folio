/** The drawing check's worker thread: tells whether a diagram or a chart would draw, away from requests. */

import { parentPort } from "node:worker_threads"

interface Request {
  id: number
  kind: "diagram" | "chart"
  source?: string
  spec?: Record<string, unknown>
}

type Mermaid = typeof import("mermaid")["default"]

/**
 * One valid diagram of each kind: a kind whose sample does not lay out on this stand-in page is only
 * parsed, so a valid diagram is never listed for what the stand-in lacks.
 */
const SAMPLES = [
  "flowchart TD\n  A[Start] --> B{Ok?}",
  "sequenceDiagram\n  A->>B: hi",
  "classDiagram\n  A <|-- B",
  "stateDiagram-v2\n  [*] --> S\n  S --> [*]",
  "erDiagram\n  A ||--o{ B : has",
  "gantt\n  dateFormat YYYY-MM-DD\n  section S\n  a : 2024-01-01, 3d",
  'pie\n  "a" : 5',
  "journey\n  title J\n  section S\n  a: 5: Me",
  "timeline\n  title T\n  2020 : a",
  "gitGraph\n  commit",
  "quadrantChart\n  x-axis a --> b",
  "xychart\n  x-axis [a, b]\n  line [1, 2]",
  "sankey\n  a,b,5",
  "mindmap\n  root\n    a",
  "requirementDiagram\n  requirement r {\n    id: 1\n  }",
  "block\n  a b",
  "packet\n  0-15: a",
  "kanban\n  todo\n    a",
  "architecture-beta\n  service a(server)[A]",
  "radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}",
  "C4Context\n  Person(a, A)",
]
const GLYPH_PX = 8
const LINE_PX = 16

let mermaid: Promise<{ mermaid: Mermaid; laidOut: Set<string> }> | undefined
let drawn = 0

parentPort?.on("message", async ({ id, kind, source, spec }: Request) => {
  try {
    if (kind === "diagram") {
      mermaid ??= load()
      const loaded = await mermaid
      const { diagramType } = (await loaded.mermaid.parse(source ?? "")) as { diagramType: string }

      if (loaded.laidOut.has(diagramType)) {
        await loaded.mermaid.render(`check-${++drawn}`, source ?? "")
      }
    } else {
      const [vegaLite, vega, { expressionInterpreter }] = await Promise.all([
        import("vega-lite"),
        import("vega"),
        import("vega-interpreter"),
      ])
      const runtime = vega.parse(vegaLite.compile(spec as never).spec, {}, { ast: true })
      const view = new vega.View(runtime, {
        renderer: "none",
        expr: expressionInterpreter as never,
      })
      await view.runAsync()
      view.finalize()
    }

    parentPort?.postMessage({ id })
  } catch (error) {
    parentPort?.postMessage({ id, error: reason(error) })
  }
})

/**
 * Mermaid lays a diagram out on a page; here a stand-in page measures every glyph alike, which is
 * enough to run the layout, though not to place it as a browser would.
 */
async function load(): Promise<{ mermaid: Mermaid; laidOut: Set<string> }> {
  const { Window } = await import("happy-dom")
  const window = new Window()
  const scope = globalThis as unknown as Record<string, unknown>
  const page = window as unknown as Record<string, unknown>
  const box = function (this: Element) {
    return { x: 0, y: 0, width: (this.textContent ?? "").length * GLYPH_PX, height: LINE_PX }
  }

  for (const name of ["SVGElement", "SVGGraphicsElement", "Element"]) {
    const prototype = (page[name] as { prototype: Record<string, unknown> } | undefined)?.prototype

    if (prototype) {
      prototype.getBBox = box
      prototype.getComputedTextLength = function (this: Element) {
        return (this.textContent ?? "").length * GLYPH_PX
      }
    }
  }

  ;(page.HTMLCanvasElement as { prototype: Record<string, unknown> }).prototype.getContext =
    () => ({
      measureText: (text: string) => ({ width: String(text).length * GLYPH_PX }),
      fillText() {},
    })

  scope.window = window

  for (const key of Object.getOwnPropertyNames(window)) {
    if (!(key in globalThis)) {
      scope[key] = page[key]
    }
  }

  for (const key of ["document", "navigator"]) {
    Object.defineProperty(globalThis, key, { value: page[key], configurable: true })
  }

  scope.getComputedStyle = window.getComputedStyle.bind(window)
  const { default: loaded } = await import("mermaid")
  const laidOut = new Set<string>()
  loaded.initialize({ startOnLoad: false, securityLevel: "strict" })

  for (const sample of SAMPLES) {
    try {
      const { diagramType } = (await loaded.parse(sample)) as { diagramType: string }
      await loaded.render(`sample-${++drawn}`, sample)
      laidOut.add(diagramType)
    } catch {
      // A kind the stand-in cannot lay out is only parsed.
    }
  }

  return { mermaid: loaded, laidOut }
}

/**
 * A parser's message quotes the source line and puts a caret under the fault; the lines naming the
 * fault and what was expected are kept, the quoted source and the caret are not.
 */
function reason(error: unknown): string {
  const lines = String((error as Error)?.message ?? error)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const caret = lines.findIndex((line) => /^-*\^$/.test(line))

  return (caret > 0 ? [...lines.slice(0, caret - 1), ...lines.slice(caret + 1)] : lines).join(" ")
}
