/** Headless Chromium run of folio's documented behaviour: stepping through pages in tree order. */

import assert from "node:assert/strict"
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import {
  CLI,
  context,
  ENV,
  frameOf,
  freePort,
  keepFrame,
  landed,
  pathOf,
  until,
  writeIn,
} from "./harness.ts"

/** Its own folder, so the first and last page of the whole tree stay put whatever other tests add. */
const stepRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-steps-")))
const STEP_FILES: Record<string, string> = {
  "guide/extra/more.md": "# More",
  "guide/intro.md": "# Intro",
  "guide/setup.md": "# Setup",
  "guide/shot.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
  "notes/todo.md": `# Todo\n\n${"Words fill the page. ".repeat(900)}`,
  "pics/only.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
  "flow.mmd": "graph LR\n  A --> B",
  "index.md": [
    "# Index",
    "",
    "```text",
    "wide ".repeat(400),
    "```",
    "",
    "$$",
    `${"x + ".repeat(300)}x`,
    "$$",
    "",
    "```mermaid",
    "graph LR",
    "  A --> B",
    "```",
  ].join("\n"),
  "readme.md": "# Readme",
}

let stepServer: ChildProcess
let stepBase = ""

before(async () => {
  writeIn(stepRoot, STEP_FILES)
  const stepPort = await freePort()
  let stepOutput = ""
  stepBase = `http://localhost:${stepPort}`
  stepServer = spawn(process.execPath, [CLI, stepRoot, "--port", String(stepPort)], {
    env: ENV,
  })
  stepServer.stdout?.on("data", (chunk) => {
    stepOutput += chunk
  })
  await until(() => stepOutput.includes(stepBase))
})

after(() => {
  stepServer?.kill()
  fs.rmSync(stepRoot, { recursive: true, force: true })
})

test("Buttons, Step forward, Step back, Pages only, First and last: every page in tree order", async () => {
  const page = await openStep(STEP_ORDER[0])
  const titles = await page.$$eval(".bar > *", (items) =>
    items.slice(0, 4).map((item) => item.getAttribute("title") ?? item.className),
  )

  assert.deepEqual(titles, [
    "Show or hide the file tree",
    "Previous page (←)",
    "Next page (→)",
    "breadcrumbs",
  ])
  await stepsShown(page, { previous: false, next: true })
  await page.keyboard.press("ArrowLeft")
  await page.waitForTimeout(300)
  assert.equal(await pathOf(page), STEP_ORDER[0])

  for (const urlPath of STEP_ORDER.slice(1)) {
    await page.keyboard.press("ArrowRight")
    await arrived(page, urlPath)
  }

  await stepsShown(page, { previous: true, next: false })
  await page.keyboard.press("ArrowRight")
  await page.waitForTimeout(300)
  assert.equal(await pathOf(page), STEP_ORDER.at(-1))

  for (const urlPath of STEP_ORDER.slice(0, -1).reverse()) {
    await page.click('button[title="Previous page (←)"]')
    await arrived(page, urlPath)
  }

  await stepsShown(page, { previous: false, next: true })
  await page.click('button[title="Next page (→)"]')
  await arrived(page, STEP_ORDER[1])
  await page.close()
})

test("Folder page: both steps are greyed out and the arrows do nothing", async () => {
  const page = await context.newPage()
  await page.goto(`${stepBase}/guide/`)
  await page.waitForSelector(".markdown-body > *")
  await page.waitForTimeout(300)
  await stepsShown(page, { previous: false, next: false })
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowLeft")
  await page.waitForTimeout(300)

  assert.equal(await pathOf(page), "guide/")
  await page.close()
})

test("Scrollable block: after a click into a wide code block or formula the arrows scroll it, elsewhere they step", async () => {
  const page = await openStep("index.md")

  for (const block of ["pre code", ".katex-display"]) {
    await page.click(block)
    await page.keyboard.press("ArrowRight")
    await page.waitForTimeout(300)

    assert.equal(await pathOf(page), "index.md", block)
    assert.ok((await page.$eval(block, (element) => element.scrollLeft)) > 0, block)
  }

  await page.click("h1")
  await page.keyboard.press("ArrowRight")
  await arrived(page, "readme.md")
  await page.close()
})

test("Expanded diagram: the arrows pan it and never step", async () => {
  const page = await openStep("index.md")
  const transform = () =>
    page.$eval(".mermaid-zoom-inner", (e) => (e as HTMLElement).style.transform)

  await page.hover(".mermaid")
  await page.click(".mermaid-expand")
  await page.waitForSelector(".mermaid-zoom.visible svg")
  const fitted = await transform()
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowLeft")
  await page.waitForTimeout(300)

  assert.notEqual(await transform(), fitted)
  assert.equal(await pathOf(page), "index.md")
  await page.close()
})

test("Modified arrows: an arrow held with a modifier never steps", async () => {
  const page = await openStep("index.md")

  for (const key of ["Shift+ArrowRight", "Control+ArrowLeft", "Meta+ArrowLeft"]) {
    await page.keyboard.press(key)
    await page.waitForTimeout(300)

    assert.equal(await pathOf(page), "index.md", key)
  }

  await page.close()
})

test("Tree, Outline, Same as the buttons, No browser history step, Expanded diagram: Alt+arrows show or hide the side panels", async () => {
  const page = await openStep("readme.md")
  const state = () =>
    page.evaluate(() => ({
      path: decodeURIComponent(location.pathname).slice(1),
      tree: getComputedStyle(document.querySelector(".tree") as Element).display !== "none",
      outline: getComputedStyle(document.querySelector(".outline") as Element).display !== "none",
      pressed: ["Show or hide the file tree", "Show or hide the outline"].map((title) =>
        document.querySelector(`button[title="${title}"]`)?.getAttribute("aria-pressed"),
      ),
    }))

  await page.click('.tree a[href$="/index.md"]')
  await arrived(page, "index.md")
  const entries = await page.evaluate(() => history.length)

  await page.keyboard.press("Alt+ArrowLeft")
  await page.waitForTimeout(300)
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: false,
    outline: true,
    pressed: ["false", "true"],
  })

  await page.keyboard.press("Alt+ArrowRight")
  await page.waitForTimeout(300)
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: false,
    outline: false,
    pressed: ["false", "false"],
  })
  assert.equal(await page.evaluate(() => history.length), entries)

  await page.reload()
  await page.waitForSelector(".markdown-body > *")
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: false,
    outline: false,
    pressed: ["false", "false"],
  })

  await page.hover(".mermaid")
  await page.click(".mermaid-expand")
  await page.waitForSelector(".mermaid-zoom.visible svg")
  const transform = () =>
    page.$eval(".mermaid-zoom-inner", (e) => (e as HTMLElement).style.transform)
  const fitted = await transform()
  await page.keyboard.press("Alt+ArrowLeft")
  await page.keyboard.press("Alt+ArrowRight")
  await page.keyboard.press("Alt+ArrowRight")
  await page.waitForTimeout(300)
  assert.notEqual(await transform(), fitted)
  assert.deepEqual((await state()).pressed, ["false", "false"])
  await page.keyboard.press("Escape")

  await page.keyboard.press("Alt+ArrowLeft")
  await page.keyboard.press("Alt+ArrowRight")
  await page.waitForTimeout(300)
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: true,
    outline: true,
    pressed: ["true", "true"],
  })
  await page.close()
})

test("Like a link: a step swaps only the content, opens at the top, and back returns to the place left", async () => {
  const page = await openStep("notes/todo.md")

  await keepFrame(page)
  await page.evaluate(() => scrollTo(0, 600))
  await page.waitForTimeout(400)
  await page.keyboard.press("ArrowRight")
  await arrived(page, "flow.mmd")
  await page.waitForSelector(".mermaid svg[aria-roledescription]")
  const stepped = { y: await page.evaluate(() => scrollY), kept: (await frameOf(page)).kept }
  await page.goBack()
  await arrived(page, "notes/todo.md")
  await page.waitForFunction(() => scrollY === 600)

  assert.deepEqual(stepped, { y: 0, kept: true })
  assert.equal((await frameOf(page)).kept, true)
  await page.close()
})

test("Live tree: a page added or removed while one is open counts at the next step", async () => {
  const page = await openStep("readme.md")

  await stepsShown(page, { previous: true, next: false })
  writeIn(stepRoot, { "zz.md": "# Zz" })
  await stepsShown(page, { previous: true, next: true })
  await page.keyboard.press("ArrowRight")
  await arrived(page, "zz.md")
  fs.rmSync(path.join(stepRoot, "readme.md"))
  await page.waitForTimeout(300)
  await page.keyboard.press("ArrowLeft")
  await arrived(page, "index.md")

  fs.rmSync(path.join(stepRoot, "zz.md"))
  writeIn(stepRoot, { "readme.md": STEP_FILES["readme.md"] })
  await page.close()
})

const STEP_ORDER = [
  "guide/extra/more.md",
  "guide/intro.md",
  "guide/setup.md",
  "notes/todo.md",
  "flow.mmd",
  "index.md",
  "readme.md",
]

async function openStep(urlPath: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${stepBase}/${urlPath}`)
  await landed(page)
  return page
}

async function arrived(page: Page, urlPath: string): Promise<void> {
  await page.waitForFunction(
    (p) =>
      decodeURIComponent(location.pathname).slice(1) === p &&
      document.querySelector(".tree .current")?.parentElement?.dataset.path === p,
    urlPath,
  )
}

async function stepsShown(page: Page, enabled: { previous: boolean; next: boolean }) {
  await page.waitForFunction(
    (want) =>
      ["previous", "next"].every(
        (key, i) =>
          (document.querySelectorAll(".bar .icon-button")[i + 1] as HTMLButtonElement).disabled ===
          !want[key as "previous" | "next"],
      ),
    enabled,
  )
}
