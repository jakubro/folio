/** Headless Chromium run of component fences: drawn by scripts from the folders Folio started with. */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Page } from "playwright"
import {
  base,
  browser,
  context,
  open,
  root,
  SERVE_ARGS,
  serveFolder,
  write,
  writeIn,
} from "./harness.ts"

const FIRST = path.join(root, "components/first")
const SECOND = path.join(root, "components/second")
const LEVELS = (drawn: string) => `
const log = (globalThis.levelsLog ??= [])

export default function levels(element, context) {
  log.push("draw " + context.theme)
  const made = (tag, className, textContent) => Object.assign(document.createElement(tag), { className, textContent })
  const gauges = made("ul", "gauges", "")
  const open = made("button", "open", "open")
  const days = made("p", "days", "days")
  const status = made("p", "status", "")
  const flag = (className, details) => {
    const button = made("button", className, className)
    button.addEventListener("click", () => {
      status.textContent = "asked"
      context.act("flag", details).then(
        () => { status.textContent = "Flagged" },
        (error) => { status.textContent = error.message },
      )
    })
    return button
  }
  const show = (rows) =>
    gauges.replaceChildren(...rows.map((row) => made("li", "", row.station + " " + row.rain_mm)))

  days.hidden = true
  open.addEventListener("click", () => { days.hidden = !days.hidden })
  show(context.data.readings)
  element.append(
    made("style", "", "h3 { color: var(--accent) }"),
    made("h3", "title", "${drawn} " + context.options.title),
    gauges,
    open,
    days,
    flag("flag", { station: "north", day: { date: "2026-10-09", rain_mm: 12.4 } }),
    flag("flag-dry", { station: "east", day: { date: "2026-10-03", rain_mm: 0 } }),
    status,
  )

  return {
    update(next) {
      log.push("update")
      show(next.data.readings)
    },
    destroy() {
      log.push("destroy")
    },
  }
}
`
const PAGE = [
  "# Rain",
  "",
  "```component levels",
  "data:",
  "  readings: readings.csv",
  "title: Rain by station",
  "```",
  "",
  "{table: readings.csv}",
].join("\n")
const READINGS = "date,station,rain_mm\n2026-10-01,north,0.7\n2026-10-01,east,0.0\n"
function handler(): string {
  const reference = fs.readFileSync(
    path.join(import.meta.dirname, "../docs/reference/components.md"),
    "utf8",
  )
  const [, fence] =
    /- \*\*Actions\*\*[^\n]*\n\n {2}```js\n([\s\S]*?)\n {2}```/.exec(reference) ?? []

  assert.ok(fence, "the Actions entry holds a js fence")
  return fence.replace(/^ {2}/gm, "")
}

SERVE_ARGS.push("--components", FIRST, "--components", SECOND)
write({
  "components/first/levels.js": LEVELS("first"),
  "components/first/broken.js": "export default () => { throw new Error('broken on purpose') }\n",
  "components/second/levels.js": LEVELS("second"),
  "components/second/list.js":
    "export default (element, { data, options }) => { element.textContent = JSON.stringify([data.items, options]) }\n",
  "comp/readings.csv": READINGS,
  "comp/items.yaml": "a: 1\nb: [x, y]\n",
  "comp/page.md": PAGE,
  "comp/list.md": "# List\n\n```component list\ndata:\n  items: items.yaml\nshow: all\n```\n",
  "comp/missing.md":
    "# Missing\n\n```component nowhere\ntitle: Gone\n```\n\n```component toString\n```\n\n```component later\ndata:\n  rows: absent.csv\n```\n",
  "components/first/form.js": [
    'customElements.get("form-badge") || customElements.define("form-badge", class extends HTMLElement {',
    "  constructor() {",
    "    super()",
    '    this.attachShadow({ mode: "open" }).innerHTML = \'<b class="badge">badge</b>\'',
    "  }",
    "})",
    "",
    "export default function form(element) {",
    "  element.innerHTML =",
    '    \'<input class="text" value="start"><textarea class="area"></textarea>\' +',
    "    '<select class=\"pick\"><option>one</option><option>two</option></select><form-badge></form-badge>' +",
    '    \'<div class="fold">its own fold</div><a class="link-changed" title="mine" href="#mine">its link</a>\' +',
    "    '<template class=\"tpl\"><i>inside</i></template>'",
    "}",
  ].join("\n"),
  "comp/form.md": "# Form\n\n```component form\n```\n",
  "comp/broken.md": [
    "# Broken",
    "",
    "```component broken",
    "```",
    "",
    "```component list",
    "data:",
    "  items: absent.csv",
    "```",
  ].join("\n"),
})

const NOT_READ = "Markdown from a component takes no includes, data references or queries."
const DIAGRAM = ["```mermaid", "flowchart LR", "  A --> B", "```"]
const HANDED = (lines: string[]) => `export default () => ${JSON.stringify(lines.join("\n"))}\n`

write({
  "components/first/said.js": HANDED(["Hello **World**!"]),
  "components/first/diagram.js": HANDED(DIAGRAM),
  "components/first/failing.js": HANDED(["```mermaid", "this is not a diagram", "```"]),
  "components/first/lines.js":
    "export default (element, { data }) => data.lines.map((row) => row.text).join('\\n\\n')\n",
  "components/first/asked.js": [
    "export default async function asked(element, context) {",
    "  const make = (tag, className, textContent) => Object.assign(document.createElement(tag), { className, textContent })",
    "  const toggle = make('button', 'toggle', 'toggle')",
    "  const holder = make('div', 'holder', '')",
    "  const status = make('p', 'status', '')",
    "  const show = async ({ data, markdown }) => {",
    "    const edges = data.edges.map((row) => '  ' + row.from + ' --> ' + row.to)",
    "    const drawing = await markdown(['```mermaid', 'flowchart LR', ...edges, '```'].join('\\n'))",
    "    drawing.addEventListener('click', (event) => {",
    "      status.textContent = 'clicked ' + event.target.closest('.node')?.id",
    "    })",
    "    holder.replaceChildren(drawing)",
    "  }",
    "  toggle.addEventListener('click', () => { holder.hidden = !holder.hidden })",
    "  element.append(toggle, holder, status)",
    "  await show(context)",
    "  return { update: show }",
    "}",
  ].join("\n"),
  "components/first/bound.js": HANDED([
    "Before {value: readings.csv#0.rain_mm} after.",
    "",
    "{table: readings.csv}",
    "",
    "{include: said.md}",
    "",
    "```sql query",
    "select 1 as one",
    "```",
    "",
    "```vega-lite",
    '{"data": {"url": "readings.csv"}, "mark": "bar", "encoding": {"x": {"field": "station"}}}',
    "```",
  ]),
  "components/first/browser.js": HANDED([
    "| Station | Rain |",
    "|---|---|",
    "| north | 0.7 |",
    "",
    "```js",
    "const rain = 0.7",
    "```",
    "",
    "$$x^2$$",
    "",
    "```vega-lite",
    '{"data": {"values": [{"station": "north", "mm": 0.7}]}, "mark": "bar", "encoding": {"x": {"field": "station"}, "y": {"field": "mm", "type": "quantitative"}}}',
    "```",
    "",
    "```geojson",
    '{"type": "Point", "coordinates": [14.4, 50.1]}',
    "```",
    "",
    "```stl",
    "solid gauge",
    "facet normal 0 0 1",
    "outer loop",
    "vertex 0 0 0",
    "vertex 1 0 0",
    "vertex 0 1 0",
    "endloop",
    "endfacet",
    "endsolid gauge",
    "```",
  ]),
  "comp/said.md": [
    "# Said",
    "",
    "```component said",
    "```",
    "",
    "Hello **World**!",
    "",
    "```component diagram",
    "```",
    "",
    ...DIAGRAM,
    "",
    "```component failing",
    "```",
    "",
    "```mermaid",
    "this is not a diagram",
    "```",
  ].join("\n"),
  "comp/lines.csv": "text\nFirst line\n",
  "comp/lines.md": "# Lines\n\n```component lines\ndata:\n  lines: lines.csv\n```\n",
  "comp/edges.csv": "from,to\nA,B\n",
  "comp/asked.md": "# Asked\n\n```component asked\ndata:\n  edges: edges.csv\n```\n",
  "comp/bound.md": "# Bound\n\n```component bound\n```\n",
  "components/second/gauges.js": fs.readFileSync(
    path.join(import.meta.dirname, "../visual/ridge/components/levels.js"),
    "utf8",
  ),
  "comp/rain.csv": "date,station,rain_mm\n2026-10-01,north,12.5\n2026-10-01,east,4.0\n",
  "comp/gauges.md":
    "# Gauges\n\n```component gauges\ndata:\n  readings: rain.csv\ntitle: Rain by station\n```\n",
  "comp/browser.md": [
    "# Browser",
    "",
    "```component browser",
    "```",
    "",
    "| Station | Rain |",
    "|---|---|",
    "| north | 0.7 |",
  ].join("\n"),
})

function handed(page: Page, selector: string) {
  return page.locator(`.embed-component folio-component > .component-markdown ${selector}`)
}

function styleOf(page: Page, selector: string, properties: string[]) {
  return page.$eval(
    selector,
    (element, names) => names.map((name) => getComputedStyle(element).getPropertyValue(name)),
    properties,
  )
}

async function drawn(urlPath: string): Promise<Page> {
  const page = await open(urlPath)
  await page.waitForSelector(".embed-component.drawn folio-component .title")
  return page
}

function shown(page: Page, selector: string): Promise<string[]> {
  return page.locator(`.embed-component folio-component ${selector}`).allTextContents()
}

function levelsLog(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((globalThis as { levelsLog?: string[] }).levelsLog ?? [])])
}

async function problems(urlPath: string): Promise<[string, number, string][]> {
  for (;;) {
    const state = await (await fetch(`${base}/?health-data`)).json()

    if (state.ready) {
      return state.problems
        .filter((problem: { path: string }) => problem.path === urlPath)
        .map(({ kind, line, what }: { kind: string; line: number; what: string }) => [
          kind,
          line,
          what,
        ])
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test("a component draws from its fence's data and options, a name from the first folder holding it, and health names the clash", async () => {
  const page = await drawn("comp/page.md")

  assert.deepEqual(await shown(page, ".title"), ["first Rain by station"])
  assert.deepEqual(await shown(page, ".gauges li"), ["north 0.7", "east 0"])
  assert.equal(await page.isVisible(".embed-component > pre"), false, "the YAML gives way")
  assert.equal(
    await page.$eval(
      ".embed-component folio-component .title",
      (title) => getComputedStyle(title).color,
    ),
    await page.evaluate(() => getComputedStyle(document.querySelector("a") as Element).color),
    "the page's colours reach the component",
  )
  assert.deepEqual(await problems("comp/page.md"), [
    [
      "component",
      3,
      "levels.js is in components/first and components/second; pages draw the one in components/first.",
    ],
  ])

  await page.click('button[title="Switch theme"]')
  await page.waitForFunction(() =>
    (globalThis as { levelsLog?: string[] }).levelsLog?.includes("destroy"),
  )
  assert.deepEqual((await levelsLog(page)).sort(), ["destroy", "draw dark", "draw light"])
  await page.click('button[title="Switch theme"]')
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light")
  await page.close()

  const list = await open("comp/list.md")
  await list.waitForSelector(".embed-component.drawn folio-component")
  assert.deepEqual(
    JSON.parse(
      await list.$eval(
        ".embed-component folio-component",
        (host) => host.shadowRoot?.textContent ?? "",
      ),
    ),
    [{ a: 1, b: ["x", "y"] }, { show: "all" }],
  )
  await list.close()
})

test("new data reaches the component as fast as an embed redraws, and it keeps its own state", async () => {
  const page = await drawn("comp/page.md")

  await page.click(".embed-component folio-component .open")
  assert.equal(await page.isVisible(".embed-component folio-component .days"), true)
  await page.evaluate(() => {
    ;(document.querySelector("folio-component") as HTMLElement & { kept?: boolean }).kept = true
  })

  const saved = Date.now()
  write({ "comp/readings.csv": `${READINGS}2026-10-02,north,1.4\n` })
  const [component, embed] = await Promise.all([
    page
      .waitForFunction(() =>
        document.querySelector("folio-component")?.shadowRoot?.textContent?.includes("north 1.4"),
      )
      .then(() => Date.now() - saved),
    page
      .waitForFunction(() =>
        document.querySelector('[data-embed="table"]')?.textContent?.includes("1.4"),
      )
      .then(() => Date.now() - saved),
  ])

  assert.ok(component < embed + 500, `component ${component} ms, embed ${embed} ms`)
  assert.deepEqual(await shown(page, ".gauges li"), ["north 0.7", "east 0", "north 1.4"])
  assert.equal(await page.isVisible(".embed-component folio-component .days"), true, "still open")
  assert.equal(
    await page.evaluate(
      () => (document.querySelector("folio-component") as HTMLElement & { kept?: boolean }).kept,
    ),
    true,
    "the same element",
  )
  assert.deepEqual(await levelsLog(page), ["draw light", "update"])
  write({ "comp/readings.csv": READINGS })
  await page.close()
})

test("a script saved while its page is open draws the page again with the new code", async () => {
  const page = await drawn("comp/page.md")

  try {
    write({ "components/first/levels.js": LEVELS("saved") })
    await page.waitForFunction(() =>
      document
        .querySelector("folio-component")
        ?.shadowRoot?.textContent?.includes("saved Rain by station"),
    )
    assert.deepEqual(await levelsLog(page), ["draw light", "destroy", "draw light"])
  } finally {
    write({ "components/first/levels.js": LEVELS("first") })
    await page.close()
  }
})

test("a data entry's query file kept in another folder draws the component again once fixed, the page left open", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-fixed-query-")))
  writeIn(folder, {
    "components/list.js":
      "export default (element, { data }) => { element.textContent = JSON.stringify(data.items) }\n",
    "lib/queries/items.sql": "select 1 as n",
    "docs/deep/page.md":
      "# Fixed\n\n```component list\ndata:\n  items: /lib/queries/items.sql\n```\n",
  })
  const served = await serveFolder(folder, ["--components", path.join(folder, "components")])
  const page = await context.newPage()
  const listed = () =>
    page.$eval(".embed-component folio-component", (host) => host.shadowRoot?.textContent)

  try {
    await page.goto(`${served.base}/docs/deep/page.md`)
    await page.waitForSelector(".embed-component.drawn folio-component")
    assert.equal(await listed(), '[{"n":1}]')

    for (const [broken, fixed, drawn] of [
      ["selec 1 as n", "select 2 as n", '[{"n":2}]'],
      ["select n from 'absent.csv'", "select 3 as n", '[{"n":3}]'],
    ]) {
      writeIn(folder, { "lib/queries/items.sql": broken })
      await page.waitForSelector(".embed-component.embed-missing .component-reason")
      // Long enough for Folio to settle what the failing entry watches, as a person fixing it takes.
      await page.waitForTimeout(1500)
      writeIn(folder, { "lib/queries/items.sql": fixed })
      await page.waitForSelector(".embed-component.drawn folio-component")
      assert.equal(await listed(), drawn)
    }
  } finally {
    await page.close()
    served.stop()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("the Components reference's handler, in a content script's world of its own, answers a flag carried out or with its reason; with none it fails at once", async () => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await drawn("comp/page.md")

  await page.click(".embed-component folio-component .flag")
  assert.deepEqual(await shown(page, ".status"), ["Nothing on this page carries out flag."])

  const cdp = await page.context().newCDPSession(page)
  const { frameTree } = await cdp.send("Page.getFrameTree")
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "content-script",
  })
  await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `{
      const write = navigator.clipboard.writeText.bind(navigator.clipboard)
      navigator.clipboard.writeText = (text) => new Promise((done) => setTimeout(done, 300)).then(() => write(text))
    }
    ${handler()}
    document.addEventListener("folio:action", (event) => {
      const { component, action, details } = event.detail
      document.body.dataset.scriptSaw = JSON.stringify({
        component, action, details,
        block: event.target.closest("[data-folio-id]").dataset.folioSource,
        gesture: navigator.userActivation.isActive,
        taken: event.defaultPrevented,
      })
    })`,
  })

  await page.click(".embed-component folio-component .flag")
  assert.deepEqual(
    await shown(page, ".status"),
    ["asked"],
    "the flag waits for the handler's answer",
  )
  await page.waitForFunction(() =>
    document.querySelector("folio-component")?.shadowRoot?.textContent?.includes("Flagged"),
  )
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "2026-10-09,north,12.4")
  assert.deepEqual(JSON.parse(await page.$eval("body", (body) => body.dataset.scriptSaw ?? "")), {
    component: "levels",
    action: "flag",
    details: { station: "north", day: { date: "2026-10-09", rain_mm: 12.4 } },
    block: "comp/page.md",
    gesture: true,
    taken: true,
  })

  await page.click(".embed-component folio-component .flag-dry")
  await page.waitForFunction(() =>
    document.querySelector("folio-component")?.shadowRoot?.textContent?.includes("No rain"),
  )
  assert.deepEqual(await shown(page, ".status"), ["No rain fell at east on 2026-10-03."])
  await page.close()
})

test("a fence no folder's script draws shows its YAML under a note naming the component, health lists it, and it draws once its script appears", async () => {
  const errors: string[] = []
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${base}/comp/missing.md`)
  await page.waitForSelector(".tree .current")

  await page.waitForFunction(
    () =>
      document.querySelectorAll(".embed-component.embed-missing .component-reason").length === 3,
  )
  assert.equal(await page.isVisible(".embed-component > pre"), true)
  assert.equal(await page.textContent(".embed-component > pre code"), "title: Gone\n")
  assert.deepEqual(await page.locator(".embed-component .component-reason").allTextContents(), [
    "No components folder holds nowhere.js.",
    "No components folder holds toString.js.",
    "No components folder holds later.js.",
  ])
  assert.deepEqual(
    (await problems("comp/missing.md")).filter(([kind]) => kind === "component"),
    [
      ["component", 3, "No components folder holds nowhere.js."],
      ["component", 7, "No components folder holds toString.js."],
      ["component", 10, "No components folder holds later.js."],
    ],
  )

  try {
    write({
      "components/second/nowhere.js":
        "export default (element, { options }) => { element.textContent = options.title }\n",
    })
    await page.waitForSelector(".embed-component.drawn folio-component")
    assert.equal(
      await page.$eval(".embed-component folio-component", (host) => host.shadowRoot?.textContent),
      "Gone",
    )
    write({ "components/second/later.js": "export default () => {}\n" })
    await page.waitForFunction(() =>
      document
        .querySelectorAll(".embed-component")[2]
        ?.querySelector(".component-reason")
        ?.textContent?.startsWith("absent.csv: "),
    )
  } finally {
    fs.rmSync(path.join(SECOND, "nowhere.js"))
    fs.rmSync(path.join(SECOND, "later.js"), { force: true })
    await page.close()
    assert.deepEqual(errors, [], "no error left unhandled")
  }
})

test("a script that throws, or a data entry naming nothing, shows its reason in the fence's place, and health lists the entry", async () => {
  const page = await open("comp/broken.md")

  await page.waitForFunction(
    () =>
      document.querySelectorAll(".embed-component.embed-missing .component-reason").length === 2,
  )
  const reasons = await page.locator(".embed-component .component-reason").allTextContents()

  assert.equal(reasons[0], "broken on purpose")
  assert.match(reasons[1], /^absent\.csv: /)
  assert.deepEqual(
    (await problems("comp/broken.md")).map(([kind, line, what]) => [
      kind,
      line,
      what.split(":")[0],
    ]),
    [["data", 6, "absent.csv"]],
  )
  await page.close()
})

test("a failed fence's reason starts where its source's text starts, every line of it, in either theme", async () => {
  write({
    "components/first/wordy.js": `export default () => { throw new Error(${JSON.stringify("A reason that goes on. ".repeat(20).trim())}) }\n`,
    "comp/reasons.md": [
      "# Reasons",
      "",
      "```component nowhere",
      "title: Gone",
      "```",
      "",
      "```vega-lite",
      '{"data": {"url": "absent.csv"}, "mark": "bar"}',
      "```",
      "",
      "```component wordy",
      "title: Wordy",
      "```",
    ].join("\n"),
  })
  // A theme switched stays the context's choice, so it is switched in a context of its own.
  const own = await browser.newContext()
  const page = await own.newPage()
  await page.goto(`${base}/comp/reasons.md`)
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".embed-missing :is(.chart-reason, .component-reason)").length ===
      3,
  )

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".embed-missing :is(.chart-reason, .component-reason)")
            .length === 3,
      )
    }

    const edges = await page.evaluate(() => {
      const lefts = (element: Element) => {
        const range = document.createRange()
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const found: number[] = []

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          range.selectNodeContents(node)
          found.push(...[...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.left))
        }

        return found
      }

      return [...document.querySelectorAll(".embed-missing")].map((embed) => ({
        kind: (embed as HTMLElement).dataset.embed,
        source: Math.min(...lefts(embed.querySelector(":scope > pre code") as Element)),
        reason: lefts(
          embed.querySelector(":scope > :is(.chart-reason, .component-reason)") as Element,
        ),
      }))
    })

    assert.deepEqual(
      edges.map(({ kind }) => kind),
      ["component", "chart", "component"],
    )
    assert.ok(edges[2].reason.length > 1, "the long reason wraps")

    for (const { kind, source, reason } of edges) {
      assert.deepEqual(
        reason.map((left) => Math.round(left - source)),
        reason.map(() => 0),
        `${kind} in ${theme}`,
      )
    }
  }

  fs.rmSync(path.join(FIRST, "wordy.js"))
  await own.close()
})

test("the corner switches to the source and copies it, the block copies as the fence, and a downloaded page keeps the drawing without behaviour", async () => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await drawn("comp/page.md")
  const component = page.locator(".embed-component")
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())

  await component.hover()
  await component.locator(".source-switch").click()
  assert.equal(await page.isVisible(".embed-component > pre"), true)
  assert.equal(await page.isVisible(".embed-component folio-component"), false)
  await component.locator(".source-switch").click()
  assert.equal(await page.isVisible(".embed-component folio-component .title"), true)

  await component.hover()
  await component.locator(".source-copy").click()
  assert.equal(await clipboard(), "data:\n  readings: readings.csv\ntitle: Rain by station")

  await component.hover()
  await page.waitForSelector(".block-copy:not([hidden])")
  await page.click(".block-copy")
  assert.equal(
    await clipboard(),
    "```component levels\ndata:\n  readings: readings.csv\ntitle: Rain by station\n```",
  )

  await page.click(".embed-component folio-component .open")
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button[title="Freeze this page into one HTML file"]'),
  ])
  const saved = path.join(os.tmpdir(), `folio-frozen-component-${process.pid}.html`)
  await download.saveAs(saved)
  await page.close()

  const html = fs.readFileSync(saved, "utf8")
  assert.match(html, /<folio-component><template shadowrootmode="open"><div><style class="">h3/)
  assert.ok(!html.includes("levelsLog"), "no script of the component travels")

  const offline = await browser.newContext({ offline: true })
  const frozen = await offline.newPage()
  await frozen.goto(`file://${saved}`)
  assert.deepEqual(await frozen.locator("folio-component .gauges li").allTextContents(), [
    "north 0.7",
    "east 0",
  ])
  assert.equal(await frozen.isVisible("folio-component .days"), true, "as last shown")
  assert.equal(await frozen.isVisible(".embed-component > pre"), false)
  await frozen.click("folio-component .flag")
  assert.deepEqual(await frozen.locator("folio-component .status").allTextContents(), [""])
  await offline.close()
  fs.rmSync(saved)
})

test("a component whose data changed since its block was read is marked as an embed whose data changed", async () => {
  write({
    "comp/read-readings.csv": READINGS,
    "comp/read.md":
      "# Read\n\n```component levels\ndata:\n  readings: read-readings.csv\ntitle: Read\n```\n",
  })
  const page = await drawn("comp/read.md")
  const block = await page.$eval(
    ".embed-component",
    (element) => (element as HTMLElement).dataset.folioId,
  )
  const read = async () =>
    (await (await fetch(`${base}/comp/read.md?read`)).json()).blocks.find(
      ({ id }: { id: string }) => id === block,
    )?.read

  for (let tries = 0; !(await read()) && tries < 40; tries++) {
    await page.waitForTimeout(250)
  }

  assert.ok(await read(), "the component's block was read")
  await page.close()

  write({ "comp/read-readings.csv": `${READINGS}2026-10-02,east,3.1\n` })
  const again = await drawn("comp/read.md")
  await again.waitForSelector(".read-mark.mark-changed")
  await again.click(".read-mark.mark-changed")
  assert.match(
    (await again.textContent(".mark-panel")) ?? "",
    /Its data changed since you read it: read-readings\.csv/,
  )
  await again.close()
})

test("arrows typed in a component's field step its caret, never the page, and Alt with an arrow toggles no panel", async () => {
  const form = await open("comp/form.md")

  await form.waitForSelector(".embed-component.drawn folio-component .text")
  await form.click(".embed-component folio-component .text")
  await form.keyboard.press("End")
  await form.keyboard.press("ArrowLeft")
  await form.keyboard.press("ArrowLeft")
  await form.waitForTimeout(300)
  assert.equal(new URL(form.url()).pathname, "/comp/form.md", "the page did not step")
  const tree = () => form.evaluate(() => document.querySelector(".tree")?.checkVisibility())
  const shown = await tree()
  await form.keyboard.press("Alt+ArrowLeft")
  await form.waitForTimeout(300)
  assert.equal(await tree(), shown, "Alt with an arrow opened or closed no panel")
  assert.equal(new URL(form.url()).pathname, "/comp/form.md", "nor left the page")
  assert.equal(
    await form.$eval(
      "folio-component",
      (host) =>
        ((host.shadowRoot as ShadowRoot).querySelector(".text") as HTMLInputElement).selectionStart,
    ),
    3,
    "the caret stepped",
  )
  await form.close()
})

test("a frozen page keeps a component's fields as left and the shadow roots inside it", async () => {
  const form = await open("comp/form.md")

  await form.waitForSelector(".embed-component.drawn folio-component .text")
  await form.fill(".embed-component folio-component .area", "typed here")
  await form.selectOption(".embed-component folio-component .pick", "two")
  const [download] = await Promise.all([
    form.waitForEvent("download"),
    form.click('button[title="Freeze this page into one HTML file"]'),
  ])
  const saved = path.join(os.tmpdir(), `folio-frozen-form-${process.pid}.html`)
  await download.saveAs(saved)
  await form.close()

  const offline = await browser.newContext({ offline: true })
  const frozen = await offline.newPage()
  await frozen.goto(`file://${saved}`)
  assert.deepEqual(
    await frozen.$eval("folio-component", (host) => {
      const root = host.shadowRoot as ShadowRoot
      return {
        area: (root.querySelector(".area") as HTMLTextAreaElement).value,
        pick: (root.querySelector(".pick") as HTMLSelectElement).value,
        text: (root.querySelector(".text") as HTMLInputElement).value,
        badge: root.querySelector("form-badge")?.shadowRoot?.textContent,
        fold: root.querySelector(".fold")?.textContent,
        link: [root.querySelector("a")?.className, root.querySelector("a")?.getAttribute("title")],
        template: (root.querySelector(".tpl") as HTMLTemplateElement).content.textContent,
      }
    }),
    {
      area: "typed here",
      pick: "two",
      text: "start",
      badge: "badge",
      fold: "its own fold",
      link: ["link-changed", "mine"],
      template: "inside",
    },
  )
  await offline.close()
  fs.rmSync(saved)
})

test("a component's returned markdown draws as the same markdown on the page", async () => {
  const page = await open("comp/said.md")
  const looks = ["font-size", "line-height", "color", "margin-top", "margin-bottom"]

  await handed(page, ".mermaid > svg").waitFor()
  await handed(page, "pre.diagram-failed").waitFor()
  assert.deepEqual(await handed(page, "> p").allTextContents(), ["Hello World!"])
  assert.deepEqual(await handed(page, "> p strong").allTextContents(), ["World"])
  assert.deepEqual(
    await styleOf(page, ".component-markdown > p", looks),
    await styleOf(page, ".markdown-body > p", looks),
    "the paragraph looks as the page's own",
  )
  assert.deepEqual(
    await styleOf(page, ".component-markdown > p strong", ["font-weight"]),
    await styleOf(page, ".markdown-body > p strong", ["font-weight"]),
  )
  assert.deepEqual(
    await styleOf(page, ".component-markdown .mermaid .node rect", ["fill", "stroke"]),
    await styleOf(page, ".markdown-body > .mermaid .node rect", ["fill", "stroke"]),
    "the diagram is drawn as the page's own",
  )
  assert.equal(await handed(page, ".mermaid > .drawn-toolbar .drawn-expand").count(), 1)
  assert.equal(
    await handed(page, "pre.diagram-failed").getAttribute("title"),
    await page.locator(".markdown-body > pre.diagram-failed").getAttribute("title"),
    "a fence that does not parse fails as on the page",
  )
  assert.equal(
    await handed(page, "pre.diagram-failed code").textContent(),
    "this is not a diagram\n",
  )
  await page.close()
})

test("what Folio drew for a component follows the theme as the page's own markdown does", async () => {
  const page = await open("comp/said.md")
  const fills = async () => [
    ...(await styleOf(page, ".component-markdown .mermaid .node rect", ["fill"])),
    ...(await styleOf(page, ".markdown-body > .mermaid .node rect", ["fill"])),
  ]

  await handed(page, ".mermaid > svg").waitFor()
  const [light] = await fills()
  await page.click('button[title="Switch theme"]')
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
  await page.waitForFunction((before) => {
    const rect = document.querySelector(
      ".embed-component folio-component > .component-markdown .mermaid .node rect",
    )
    return rect && getComputedStyle(rect).fill !== before
  }, light)
  const [dark, own] = await fills()
  assert.notEqual(dark, light)
  assert.equal(dark, own)
  await page.click('button[title="Switch theme"]')
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light")
  await page.close()
})

test("a component places the drawing it asked for among its own elements, hears clicks on it, and new data redraws only the drawing", async () => {
  const page = await open("comp/asked.md")

  await handed(page, ".mermaid > svg").waitFor()
  const [button, drawing] = await Promise.all([
    page.locator(".embed-component folio-component .toggle").boundingBox(),
    handed(page, ".mermaid > svg").boundingBox(),
  ])
  assert.ok(
    button && drawing && drawing.y >= button.y + button.height,
    "the diagram sits under the button",
  )

  await handed(page, ".mermaid .node").first().click()
  assert.match(
    (await page.locator(".embed-component folio-component .status").textContent()) ?? "",
    /^clicked [\w-]*flowchart-A-/,
  )
  await page.evaluate(() => {
    const own = document.querySelector("folio-component")?.shadowRoot?.querySelector(".toggle")
    ;(own as HTMLElement & { kept?: boolean }).kept = true
  })

  write({ "comp/edges.csv": "from,to\nA,B\nB,C\n" })
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        ".embed-component folio-component > .component-markdown .mermaid .node",
      ).length === 3,
  )
  assert.equal(
    await page.evaluate(
      () =>
        (
          document.querySelector("folio-component")?.shadowRoot?.querySelector(".toggle") as
            | (HTMLElement & { kept?: boolean })
            | null
        )?.kept,
    ),
    true,
    "the component's own elements stay",
  )
  assert.match(
    (await page.locator(".embed-component folio-component .status").textContent()) ?? "",
    /^clicked [\w-]*flowchart-A-/,
  )
  write({ "comp/edges.csv": "from,to\nA,B\n" })
  await page.close()

  const lines = await open("comp/lines.md")
  await handed(lines, "> p").waitFor()
  write({ "comp/lines.csv": "text\nFirst line\nSecond line\n" })
  await lines.waitForFunction(
    () =>
      document.querySelectorAll(".embed-component folio-component > .component-markdown > p")
        .length === 2,
  )
  assert.deepEqual(await handed(lines, "> p").allTextContents(), ["First line", "Second line"])
  write({ "comp/lines.csv": "text\nFirst line\n" })
  await lines.close()
})

test("what the page draws from a block's own text draws; includes, data references and queries read nothing and say so", async () => {
  const page = await open("comp/browser.md")

  await handed(page, ".embed-chart .chart svg").waitFor()
  await handed(page, ".stl-model, .drawing-failed").first().waitFor()
  assert.deepEqual(await handed(page, "table td").allTextContents(), ["north", "0.7"])
  assert.deepEqual(
    await styleOf(page, ".component-markdown td", ["padding-left", "border-top-color"]),
    await styleOf(page, ".markdown-body > table td", ["padding-left", "border-top-color"]),
    "the table looks as the page's own",
  )
  assert.equal(await handed(page, "pre code.language-js.hljs").count(), 1)
  assert.equal(await handed(page, ".katex").count(), 1)
  assert.equal(await handed(page, ".geo-map").count(), 1)
  assert.equal(await handed(page, ".stl-model").count(), 1)
  await page.close()

  const asked: string[] = []
  const bound = await context.newPage()
  bound.on("request", (request) => {
    if (new URL(request.url()).searchParams.has("embed")) {
      asked.push(request.url())
    }
  })
  await bound.goto(`${base}/comp/bound.md`)
  await handed(bound, ".chart-reason").waitFor()
  await handed(bound, ".query-result").waitFor()

  assert.equal(
    await handed(bound, '[data-embed="value"]').textContent(),
    `readings.csv#0.rain_mm: ${NOT_READ}`,
  )
  assert.equal(
    await handed(bound, '[data-embed="table"]').textContent(),
    `readings.csv: ${NOT_READ}`,
  )
  assert.equal(await handed(bound, ".include-missing").getAttribute("title"), NOT_READ)
  assert.equal(await handed(bound, ".include-missing").textContent(), "{include: said.md}")
  assert.equal(await handed(bound, ".query-result").textContent(), NOT_READ)
  assert.equal(await handed(bound, ".chart-reason").textContent(), NOT_READ)
  assert.deepEqual(asked, [], "nothing was read for the component's markdown")
  await bound.close()
})

test("a downloaded page keeps what Folio drew for a component", async () => {
  const page = await open("comp/said.md")

  await handed(page, ".mermaid > svg").waitFor()
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button[title="Freeze this page into one HTML file"]'),
  ])
  const saved = path.join(os.tmpdir(), `folio-frozen-handed-${process.pid}.html`)
  await download.saveAs(saved)
  await page.close()

  const offline = await browser.newContext({ offline: true })
  const frozen = await offline.newPage()
  await frozen.goto(`file://${saved}`)
  assert.equal(await frozen.locator("folio-component strong").first().isVisible(), true)
  assert.equal(await frozen.locator("folio-component strong").first().textContent(), "World")
  assert.equal(await frozen.locator("folio-component .mermaid > svg").first().isVisible(), true)
  await offline.close()
  fs.rmSync(saved)
})

test("a new day raises the open station's gauge, and the station stays open", async () => {
  const page = await open("comp/gauges.md")
  const fill = (at: number) =>
    page.$$eval(
      ".embed-component folio-component .fill",
      (fills, index) => (fills[index] as HTMLElement).style.height,
      at,
    )

  await page.locator(".embed-component folio-component .gauge").first().click()
  await page.locator(".embed-component folio-component .days").waitFor()
  const before = [await fill(0), await fill(1)]

  write({
    "comp/rain.csv":
      "date,station,rain_mm\n2026-10-01,north,12.5\n2026-10-01,east,4.0\n2026-10-02,north,8.0\n",
  })
  await page.waitForFunction(() =>
    document
      .querySelector("folio-component")
      ?.shadowRoot?.querySelector(".days")
      ?.textContent?.includes("2026-10-02"),
  )
  assert.ok(
    Number.parseFloat(await fill(0)) > Number.parseFloat(before[0]),
    `north ${before[0]} -> ${await fill(0)}`,
  )
  assert.equal(await fill(1), before[1], "east, given no rain, stays where it was")
  assert.equal(
    await page.locator(".embed-component folio-component .days caption").textContent(),
    "north",
  )
  write({ "comp/rain.csv": "date,station,rain_mm\n2026-10-01,north,12.5\n2026-10-01,east,4.0\n" })
  await page.close()
})
