/** Headless Chromium run of fences drawn as maps and models: what each shows and fetches, and its source. */

import assert from "node:assert/strict"
import { test } from "node:test"
import type { Page } from "playwright"
import { base, context, open, write } from "./harness.ts"

const SHAPES = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Oslo", people: 709000 },
      geometry: { type: "Point", coordinates: [10.75, 59.91] },
    },
    {
      type: "Feature",
      properties: { name: "Area" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [10.6, 59.8],
            [10.9, 59.8],
            [10.9, 60.0],
            [10.6, 60.0],
            [10.6, 59.8],
          ],
        ],
      },
    },
  ],
})
const TOPOLOGY = JSON.stringify({
  type: "Topology",
  objects: { line: { type: "LineString", arcs: [0] } },
  arcs: [
    [
      [10.0, 59.0],
      [11.0, 60.0],
    ],
  ],
})
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

function maps(): void {
  write({
    "drawings/maps.md": [
      "# Maps",
      "",
      "```geojson",
      SHAPES,
      "```",
      "",
      "```topojson",
      TOPOLOGY,
      "```",
      "",
      "```geojson",
      "{not json",
      "```",
      "",
      "```geojson",
      '{"type": "Nope"}',
      "```",
    ].join("\n"),
    "drawings/plain.md": "# Plain\n\nNo map here.\n",
  })
}

async function chunks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.includes("?asset=/chunk-")),
  )
}

function shownSources(page: Page, selector: string): Promise<boolean[]> {
  return page.$$eval(`.markdown-body :is(${selector})`, (found) =>
    found.map((drawing) => drawing.classList.contains("showing-source")),
  )
}

async function switchSource(page: Page, selector: string, index: number): Promise<void> {
  const drawing = page.locator(`.markdown-body ${selector}`).nth(index)
  await drawing.hover()
  await drawing.locator(".source-switch").click()
}

async function redrawInTheOtherTheme(page: Page): Promise<void> {
  const was = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.click('button[title="Switch theme"]')
  await page.waitForFunction((t) => document.documentElement.dataset.theme !== t, was)
  await page.waitForFunction(() => document.querySelectorAll(".mermaid .drawn-toolbar").length > 0)
}

test("GeoJSON, TopoJSON, Properties, Offline, Tiles, Not a map: fences draw as maps, tiles only once asked for", async () => {
  maps()
  const page = await context.newPage()
  const outside: string[] = []
  page.on("request", (request) => {
    if (!request.url().startsWith(base) && !request.url().startsWith("data:")) {
      outside.push(request.url())
    }
  })
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ body: PIXEL, contentType: "image/png" }),
  )
  await page.goto(`${base}/drawings/maps.md`)
  await page.waitForSelector(".geo-map .leaflet-overlay-pane path")
  await page.waitForFunction(
    () => document.querySelectorAll(".geo-map .leaflet-interactive").length === 3,
  )

  const blocks = await page.$$eval(".markdown-body > :not(h1)", (found) =>
    found.map((block) => ({
      map: block.classList.contains("geo-map"),
      shapes: block.querySelectorAll(".leaflet-interactive").length,
      reason: block.querySelector(".drawing-reason")?.textContent ?? null,
      source: block.matches(".drawing-failed")
        ? block.querySelector("pre code")?.textContent
        : null,
    })),
  )
  assert.deepEqual(blocks, [
    { map: true, shapes: 2, reason: null, source: null },
    { map: true, shapes: 1, reason: null, source: null },
    {
      map: false,
      shapes: 0,
      reason: "Map failed to draw - it is not valid JSON",
      source: "{not json\n",
    },
    {
      map: false,
      shapes: 0,
      reason: "Map failed to draw - it is not GeoJSON",
      source: '{"type": "Nope"}\n',
    },
  ])

  const fitted = await page.$eval(".geo-map", (map) => {
    const box = map.querySelector(".geo-map-canvas")?.getBoundingClientRect() as DOMRect
    const shape = map.querySelector("path.leaflet-interactive")?.getBoundingClientRect() as DOMRect
    return (
      shape.left >= box.left &&
      shape.right <= box.right &&
      shape.top >= box.top &&
      shape.bottom <= box.bottom
    )
  })
  assert.ok(fitted, "the view holds every shape")

  await page.locator(".geo-map").first().locator('path.leaflet-interactive[d*="a5,5"]').click()
  await page.waitForSelector(".leaflet-popup-content")
  assert.equal(await page.textContent(".leaflet-popup-content"), "name: Oslopeople: 709000")

  await page.waitForTimeout(500)
  assert.equal(outside.join(), "", "no request leaves the machine before Load map")

  await page.click(".geo-map .geo-map-tiles")
  await page.waitForSelector(".geo-map .leaflet-tile-loaded")
  assert.ok(
    outside.length > 0 && outside.every((url) => url.startsWith("https://tile.openstreetmap.org/")),
  )
  assert.match(
    (await page.textContent(".geo-map .leaflet-control-attribution")) ?? "",
    /© OpenStreetMap contributors/,
  )
  assert.equal(await page.locator(".geo-map >> nth=0 >> .geo-map-tiles").isHidden(), true)
  await page.close()
})

test("Source, Themes, Pages without maps: a map switches to its source, reads in either theme, and loads only where one is", async () => {
  maps()
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await open("drawings/maps.md")
  await page.waitForSelector(".geo-map .leaflet-overlay-pane path")
  const map = page.locator(".geo-map").first()

  await map.hover()
  assert.equal(
    await map.locator(".drawn-toolbar").evaluate((bar) => getComputedStyle(bar).opacity),
    "1",
  )
  assert.deepEqual(
    await map
      .locator(".drawn-toolbar button")
      .evaluateAll((all) => all.map((one) => (one as HTMLElement).title)),
    ["Show source", "Copy source"],
  )
  await map.locator(".source-switch").click()
  await map.locator('.source-switch[aria-pressed="true"]').waitFor()
  assert.equal(await map.locator(".geo-map-canvas").isHidden(), true)
  assert.equal(await map.locator(":scope > pre code").textContent(), `${SHAPES}\n`)
  await map.locator(".source-copy").click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), SHAPES)
  await map.locator(".source-switch").click()
  assert.equal(await map.locator(".geo-map-canvas").isVisible(), true)

  const looks: string[] = []

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
      await page.waitForSelector(
        `.markdown-body[data-theme="${theme}"] .geo-map .leaflet-overlay-pane path`,
      )
    }

    looks.push(
      await page.$eval(".geo-map", (drawn) => {
        const zoom = getComputedStyle(drawn.querySelector(".leaflet-control-zoom-in") as Element)
        const shape = getComputedStyle(drawn.querySelector("path.leaflet-interactive") as Element)
        return `${zoom.color} on ${zoom.backgroundColor}, shapes ${shape.stroke}`
      }),
    )
  }

  await page.click('button[title="Switch theme"]')
  assert.deepEqual(looks, [
    "rgb(31, 35, 40) on rgb(255, 255, 255), shapes rgb(9, 105, 218)",
    "rgb(204, 204, 204) on rgb(26, 26, 26), shapes rgb(68, 147, 248)",
  ])

  const mapped = new Set(await chunks(page))
  const plain = await context.newPage()
  await plain.goto(`${base}/drawings/plain.md`)
  await plain.waitForSelector(".markdown-body > p")
  await plain.waitForTimeout(500)
  const loaded = await chunks(plain)
  const leaflet: string[] = []

  for (const chunk of mapped) {
    if ((await (await fetch(chunk)).text()).includes("leaflet-container")) {
      leaflet.push(chunk)
    }
  }

  assert.ok(leaflet.length > 0, "the map page loaded the map code")
  assert.deepEqual(
    loaded.filter((chunk) => leaflet.includes(chunk)),
    [],
    "a page without maps loads none of it",
  )
  await Promise.all([page.close(), plain.close()])
})

const TETRA = [
  "solid tetra",
  ...[
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ].flatMap((face) => [
    "  facet normal 0 0 0",
    "    outer loop",
    ...face.map((at) => `      vertex ${["0 0 0", "10 0 0", "0 10 0", "0 0 10"][at]}`),
    "    endloop",
    "  endfacet",
  ]),
  "endsolid tetra",
].join("\n")

function models(): void {
  write({
    "drawings/model.md": [
      "# Model",
      "",
      "```stl",
      TETRA,
      "```",
      "",
      "```stl",
      "not a model",
      "```",
    ].join("\n"),
    "drawings/plain.md": "# Plain\n\nNo map here.\n",
  })
}

test("Model, Turn, Zoom, Not ASCII STL, No WebGL: an stl fence draws as a model to turn and zoom", async () => {
  models()
  const page = await open("drawings/model.md")
  await page.waitForSelector(".stl-model canvas")
  const canvas = page.locator(".stl-canvas")
  const picture = async () => {
    await page.waitForTimeout(200)
    return (await canvas.screenshot()).toString("base64")
  }

  assert.deepEqual(
    await page.$$eval(".markdown-body > :not(h1)", (found) =>
      found.map((block) => ({
        model: block.classList.contains("stl-model"),
        reason: block.querySelector(".drawing-reason")?.textContent ?? null,
      })),
    ),
    [
      { model: true, reason: null },
      { model: false, reason: "Model failed to draw - it is not an ASCII STL model" },
    ],
  )

  await page.click('.stl-controls button[title="Reset view"]')
  const first = await picture()
  const box = (await canvas.boundingBox()) as {
    x: number
    y: number
    width: number
    height: number
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 8 })
  await page.mouse.up()
  const turned = await picture()
  assert.ok(turned !== first, "dragging turns the model")

  await page.click('.stl-controls button[title="Zoom in"]')
  const closer = await picture()
  assert.ok(closer !== turned, "zoom in moves the camera")
  await page.click('.stl-controls button[title="Zoom out"]')
  await page.click('.stl-controls button[title="Zoom out"]')
  assert.ok((await picture()) !== closer, "zoom out moves the camera back")
  await page.click('.stl-controls button[title="Reset view"]')
  assert.ok((await picture()) === first, "reset returns to the first view")
  await page.close()

  const blind = await context.newPage()
  await blind.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      return /webgl/.test(kind)
        ? null
        : (original as (...all: unknown[]) => unknown).call(this, kind, ...rest)
    } as typeof original
  })
  await blind.goto(`${base}/drawings/model.md`)
  await blind.waitForSelector(".drawing-reason")
  assert.deepEqual(
    await blind.$$eval(".drawing-reason", (found) => found.map((one) => one.textContent)),
    [
      "Model failed to draw - 3D graphics are unavailable in this browser",
      "Model failed to draw - it is not an ASCII STL model",
    ],
  )
  assert.equal(await blind.locator(".drawing-failed pre code").first().textContent(), `${TETRA}\n`)
  await blind.close()
})

test("Source, Themes, Pages without models: a model switches to its source, reads in either theme, and loads only where one is", async () => {
  models()
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await open("drawings/model.md")
  await page.waitForSelector(".stl-model canvas")
  const model = page.locator(".stl-model")

  await model.hover()
  assert.equal(
    await model.locator(".drawn-toolbar").evaluate((bar) => getComputedStyle(bar).opacity),
    "1",
  )
  await model.locator(".source-switch").click()
  await model.locator('.source-switch[aria-pressed="true"]').waitFor()
  assert.equal(await model.locator(".stl-canvas").isHidden(), true)
  assert.equal(await model.locator(":scope > pre code").textContent(), `${TETRA}\n`)
  await model.locator(".source-copy").click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), TETRA)
  await model.locator(".source-switch").click()
  assert.equal(await model.locator(".stl-canvas").isVisible(), true)

  const looks: string[] = []

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
      await page.waitForSelector(`.markdown-body[data-theme="${theme}"] .stl-model canvas`)
      await page.waitForTimeout(200)
    }

    looks.push(
      await page.$eval(".stl-controls button", (control) => {
        const style = getComputedStyle(control)
        const bar = getComputedStyle(control.parentElement as Element)
        return `${style.color} on ${bar.backgroundColor}`
      }),
    )
  }

  await page.click('button[title="Switch theme"]')
  assert.deepEqual(looks, [
    "rgb(89, 99, 110) on rgb(255, 255, 255)",
    "rgb(154, 154, 154) on rgb(26, 26, 26)",
  ])

  const drawn = new Set(await chunks(page))
  const plain = await context.newPage()
  await plain.goto(`${base}/drawings/plain.md`)
  await plain.waitForSelector(".markdown-body > p")
  await plain.waitForTimeout(500)
  const loaded = await chunks(plain)
  const three: string[] = []

  for (const chunk of drawn) {
    if ((await (await fetch(chunk)).text()).includes("WebGLRenderer")) {
      three.push(chunk)
    }
  }

  assert.ok(three.length > 0, "the model page loaded the 3D code")
  assert.deepEqual(
    loaded.filter((chunk) => three.includes(chunk)),
    [],
    "a page without models loads none of it",
  )
  await Promise.all([page.close(), plain.close()])
})

test("Several drawings: each keeps its own shown source through a theme switch and saves that add, remove or edit one", async () => {
  const fenced = (kind: string, body: string) => [`\`\`\`${kind}`, body, "```", ""]
  const flow = (...lines: string[]) => ["graph LR", ...lines.map((line) => `  ${line}`)].join("\n")
  let firstMap = SHAPES
  const several = (...diagrams: string[]) =>
    [
      "# Several",
      "",
      ...fenced("geojson", firstMap),
      ...fenced("geojson", SHAPES.replace("Area", "Field")),
      ...diagrams.flatMap((diagram) => fenced("mermaid", diagram)),
    ].join("\n")
  const showing = (selector: string) => shownSources(page, selector)
  const toggle = (selector: string, index: number) => switchSource(page, selector, index)
  const switchTheme = () => redrawInTheOtherTheme(page)

  write({ "drawings/several.md": several(flow("First --> Stop"), flow("Second --> Stop")) })
  const page = await open("drawings/several.md")
  await page.waitForFunction(() => document.querySelectorAll(".mermaid > svg").length === 2)

  await toggle(".geo-map", 0)
  await switchTheme()
  assert.deepEqual(await showing(".geo-map"), [true, false])

  await toggle(".mermaid", 1)
  write({
    "drawings/several.md": several(
      flow("First --> Stop"),
      flow("Added --> Stop"),
      flow("Second --> Stop"),
    ),
  })
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body .mermaid").length === 3,
  )
  await switchTheme()
  assert.deepEqual(await showing(".mermaid"), [false, false, true])

  write({
    "drawings/several.md": several(flow("Added --> Stop"), flow("Second --> Stop", "Stop --> End")),
  })
  await page.waitForFunction(() =>
    document.querySelector(".mermaid > .drawn-source")?.textContent?.includes("End"),
  )
  assert.deepEqual(await showing(".mermaid"), [false, true])

  const latest = [
    flow("Added --> Stop"),
    flow("Third --> Stop"),
    flow("Second --> Stop", "Stop --> End"),
  ]
  write({ "drawings/several.md": several(...latest) })
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body .mermaid").length === 3,
  )
  assert.deepEqual(await showing(".mermaid"), [false, false, true])
  await toggle(".mermaid", 0)
  await switchTheme()
  assert.deepEqual(await showing(".mermaid"), [true, false, true])
  await toggle(".mermaid", 2)
  await switchTheme()
  assert.deepEqual(await showing(".mermaid"), [true, false, false])

  firstMap = SHAPES.replace("Oslo", "Bergen")
  write({ "drawings/several.md": several(...latest) })
  await page.waitForFunction(() =>
    document.querySelector(".geo-map > pre code")?.textContent?.includes("Bergen"),
  )
  assert.deepEqual(await showing(".geo-map"), [true, false])

  write({
    "drawings/several.md": several(flow("Brand --> New"), flow("Added --> Stop", "Stop --> Again")),
  })
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body .mermaid").length === 2,
  )
  await page.waitForFunction(() =>
    document.querySelector(".mermaid > .drawn-source")?.textContent?.includes("Again"),
  )
  assert.deepEqual(await showing(".mermaid"), [false, true])

  const listed = (...diagrams: string[]) =>
    [
      "# Listed",
      "",
      ...diagrams.flatMap((diagram) => [
        "- item",
        "",
        "  ```mermaid",
        ...diagram.split("\n").map((line) => `  ${line}`),
        "  ```",
        "",
      ]),
    ].join("\n")
  write({ "drawings/several.md": listed(flow("Kept --> Here")) })
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body .mermaid").length === 1,
  )
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Listed",
  )
  await toggle(".mermaid", 0)
  write({ "drawings/several.md": listed(flow("Fresh --> One"), flow("Kept --> Here")) })
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body .mermaid").length === 2,
  )
  await page.waitForTimeout(500)
  assert.deepEqual(await showing(".mermaid"), [false, true])
  await page.close()
})

test("Followed link, Height, Points, Bad topology: a map reached by a link draws as one opened directly", async () => {
  const cluster = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Wells" },
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [10.7, 59.85],
            [10.8, 59.95],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Field" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [10.6, 59.8],
              [10.9, 59.8],
              [10.9, 60.0],
              [10.6, 60.0],
              [10.6, 59.8],
            ],
          ],
        },
      },
    ],
  })
  write({
    "drawings/start.md": "# Start\n\nSee [the wells](wells.md).\n",
    "drawings/wells.md": [
      "# Wells",
      "",
      "```geojson",
      cluster,
      "```",
      "",
      "```topojson",
      '{"type": "Topology", "objects": {"line": {"type": "LineString", "arcs": [0]}}}',
      "```",
      "",
      ...Array.from({ length: 80 }, (_, i) => `Filler paragraph ${i}.\n`),
      "```geojson",
      SHAPES,
      "```",
    ].join("\n"),
  })
  const page = await context.newPage()
  await page.goto(`${base}/drawings/start.md`)
  await page.hover('.markdown-body a[href="wells.md"]')
  await page.waitForTimeout(500)
  await page.click('.markdown-body a[href="wells.md"]')
  await page.waitForSelector(".geo-map .leaflet-overlay-pane path")

  const state = await page.evaluate(() => {
    const [first, last] = [...document.querySelectorAll(".geo-map")]
    const paths = [...first.querySelectorAll("path.leaflet-interactive")]
    const lastCanvas = last.querySelector(".geo-map-canvas") as HTMLElement
    return {
      styled: [...document.head.querySelectorAll("style")].some((style) =>
        style.textContent?.includes(".leaflet-pane"),
      ),
      panes: getComputedStyle(first.querySelector(".leaflet-pane") as Element).position,
      order: paths.map((path) => (path.getAttribute("d")?.includes("a5,5") ? "point" : "area")),
      fills: paths.map((path) => path.getAttribute("fill-opacity")),
      drawn: lastCanvas.classList.contains("leaflet-container"),
      height: lastCanvas.offsetHeight,
      reason: document.querySelector(".drawing-reason")?.textContent,
    }
  })

  assert.deepEqual(state, {
    styled: true,
    panes: "absolute",
    order: ["area", "point", "point"],
    fills: ["0.2", "0.8", "0.8"],
    drawn: false,
    height: 300,
    reason: "Map failed to draw - its geometry is not valid",
  })

  await page
    .locator(".geo-map")
    .first()
    .locator('path.leaflet-interactive[d*="a5,5"]')
    .first()
    .click()
  await page.waitForSelector(".leaflet-popup-content")
  assert.equal(await page.textContent(".leaflet-popup-content"), "name: Wells")
  await page.close()
})

test("Contexts, Leading text, Not a model: a redrawn model, or one the reader leaves, gives its WebGL context back, text before solid still draws, and a fence that is no model loads no 3D code", async () => {
  write({
    "drawings/lit.md": ["# Lit", "", "[Unlit](unlit.md)", "", "```stl", TETRA, "```"].join("\n"),
    "drawings/unlit.md": ["# Unlit", "", "No model here."].join("\n"),
    "drawings/noted.md": ["# Noted", "", "```stl", "exported by a scanner", TETRA, "```"].join(
      "\n",
    ),
    "drawings/unfit.md": ["# Unfit", "", "```stl", "not a model", "```"].join("\n"),
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    const made = new Set<unknown>()
    const lost = new Set<unknown>()
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      const context = (original as (...all: unknown[]) => unknown).call(this, kind, ...rest)

      if (context && /webgl/.test(kind) && !made.has(context)) {
        const extension = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context")
        made.add(context)

        if (extension) {
          const lose = extension.loseContext.bind(extension)
          extension.loseContext = () => {
            lost.add(context)
            lose()
          }
        }
      }

      return context
    } as typeof original
    ;(window as { live?: () => number }).live = () => made.size - lost.size
  })
  await page.goto(`${base}/drawings/lit.md`)
  await page.waitForSelector(".stl-model canvas")

  for (let switched = 0; switched < 4; switched++) {
    const was = await page.evaluate(() => document.documentElement.dataset.theme)
    await page.click('button[title="Switch theme"]')
    await page.waitForFunction((t) => document.documentElement.dataset.theme !== t, was)
    await page.waitForSelector(".stl-model canvas")
    await page.waitForTimeout(300)
  }

  assert.equal(await page.evaluate(() => (window as unknown as { live: () => number }).live()), 1)
  await page.click('a[href$="unlit.md"]')
  await page.waitForSelector("h1:text('Unlit')")
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => (window as unknown as { live: () => number }).live()), 0)
  const three: string[] = []

  for (const chunk of await chunks(page)) {
    if ((await (await fetch(chunk)).text()).includes("WebGLRenderer")) {
      three.push(chunk)
    }
  }

  await page.goto(`${base}/drawings/noted.md`)
  await page.waitForSelector(".stl-model canvas")
  assert.equal(await page.locator(".drawing-failed").count(), 0)

  const unfit = await context.newPage()
  await unfit.goto(`${base}/drawings/unfit.md`)
  await unfit.waitForSelector(".drawing-reason")
  await unfit.waitForTimeout(500)
  assert.ok(three.length > 0)
  assert.deepEqual(
    (await chunks(unfit)).filter((chunk) => three.includes(chunk)),
    [],
    "a fence that is no model loads none of the 3D code",
  )
  await Promise.all([page.close(), unfit.close()])
})

test("Failed save, Included twice: a shown source survives a save that fails to draw, and each copy of a section keeps its own", async () => {
  const flow = (...lines: string[]) => ["graph LR", ...lines.map((line) => `  ${line}`)].join("\n")
  const fenced = (body: string) => ["```mermaid", body, "```", ""]
  const showing = () => shownSources(page, ".mermaid, pre.diagram-failed")
  const toggle = (index: number) => switchSource(page, ".mermaid", index)
  const switchTheme = () => redrawInTheOtherTheme(page)

  write({ "drawings/failing.md": ["# Failing", "", ...fenced(flow("Up --> Down"))].join("\n") })
  const page = await open("drawings/failing.md")
  await page.waitForSelector(".mermaid > svg")
  await toggle(0)
  write({ "drawings/failing.md": ["# Failing", "", ...fenced(flow("Up -->"))].join("\n") })
  await page.waitForSelector("pre.diagram-failed")
  write({
    "drawings/failing.md": ["# Failing", "", ...fenced(flow("Up --> Sideways"))].join("\n"),
  })
  await page.waitForFunction(() =>
    document.querySelector(".mermaid > .drawn-source")?.textContent?.includes("Sideways"),
  )
  assert.deepEqual(await showing(), [true])

  write({
    "drawings/part.md": ["# Part", "", "## Shared", "", ...fenced(flow("Shared --> Twice"))].join(
      "\n",
    ),
    "drawings/twice.md": [
      "# Twice",
      "",
      "{include: part.md#shared}",
      "",
      "{include: part.md#shared}",
    ].join("\n"),
  })
  await page.goto(`${base}/drawings/twice.md`)
  await page.waitForFunction(() => document.querySelectorAll(".mermaid > svg").length === 2)
  await toggle(0)
  await switchTheme()
  assert.deepEqual(await showing(), [true, false])

  write({
    "drawings/part.md": [
      "# Part",
      "",
      "## Shared",
      "",
      ...fenced(flow("Shared --> Twice", "Twice --> Again")),
    ].join("\n"),
  })
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".mermaid > .drawn-source")].some((one) =>
      one.textContent?.includes("Again"),
    ),
  )
  await page.waitForTimeout(500)
  assert.deepEqual(await showing(), [true, false])

  await page.close()
})
