/** The pictures the README and the documentation show, recorded from the fixture folders. */

import fs from "node:fs"
import path from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { BROWSER_NOW, type Ridge, ridge } from "./ridge.ts"
import { show } from "./show.ts"

test("README: a rendered page with its tree and outline", async ({ page }) => {
  await show(page, "README.md")
  await page.evaluate(() => document.getElementById("wind-chill")?.scrollIntoView())
  await expect(page).toHaveScreenshot(["images", "folio.png"])
})

test("Sections: one folded, another under the pointer", async ({ page }) => {
  await show(page, "calibration.md")
  await page.hover("#thermometer")
  await page.click("#thermometer .fold-toggle")
  await page.hover("#rain-gauge")
  await expect(page).toHaveScreenshot(["images", "sections-folded.png"])
})

test("Diagrams: the full-window viewer", async ({ page }) => {
  await show(page, "README.md")
  await page.hover(".mermaid")
  await page.click(".mermaid-expand")
  await page.waitForSelector(".mermaid-zoom.visible svg")
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot(["images", "diagram-viewer.png"])
})

test("Frontmatter: a table above the page", async ({ page }) => {
  await show(page, "calibration.md")
  await expect(page).toHaveScreenshot(["images", "frontmatter.png"], {
    clip: { x: 280, y: 44, width: 880, height: 300 },
  })
})

test.describe("the ridge folder", () => {
  test.describe.configure({ timeout: 60_000 })
  let folder: Ridge

  test.beforeEach(async ({ page }) => {
    folder = await ridge()
    await page.clock.setFixedTime(BROWSER_NOW)
  })

  test.afterEach(async () => {
    await folder.close()
  })

  test("Data: a report embedding a value, a checked figure, a query, a table and a chart", async ({
    page,
  }) => {
    await open(page, folder, "report.md", ".chart svg")
    await expect(page).toHaveScreenshot(["images", "report.png"])
  })

  test("Provenance: where a chart came from", async ({ page }) => {
    await open(page, folder, "report.md", ".chart svg")
    await page.hover("[data-ref='queries/wettest.sql']")
    await page.click(".block-provenance")
    await page.waitForSelector(".provenance-panel:not([hidden])")
    await expect(page).toHaveScreenshot(["images", "provenance.png"])
  })

  test("Health: everything wrong in the folder", async ({ page }) => {
    await open(page, folder, "?health", ".health-kind")
    await expect(page).toHaveScreenshot(["images", "health.png"], { clip: top(570) })
  })

  test("Data files: a CSV sorted and filtered", async ({ page }) => {
    await open(page, folder, "data/daily.csv", ".data-page table")
    await page.click("th:has-text('rain_mm')")
    await page.click("th:has-text('rain_mm')")
    await page.hover(".data-page table")
    await page.click(".table-control")
    await page.fill("input[aria-label='Filter station']", "north")
    await page.waitForSelector(".table-status:has-text('14 of 42 rows')")
    await page.mouse.move(1390, 790)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(page).toHaveScreenshot(["images", "table-view.png"])
  })

  test("Data files: a JSON file as a tree", async ({ page }) => {
    await open(page, folder, "data/stations.json", ".data-tree table")
    await page.click(".data-tree table > tbody > tr >> nth=0")
    await page.waitForSelector(".data-tree tr.data-record")
    await page.mouse.move(1390, 790)
    await expect(page).toHaveScreenshot(["images", "data-tree.png"], { clip: top(560) })
  })

  test("Data files: every field compared by station", async ({ page }) => {
    await open(page, folder, "data/daily.csv", ".data-page table")
    await page.click(".data-field:has-text('station')")
    await page.click(".data-compare-by")
    await page.waitForSelector(".data-compare-table")
    await page.mouse.move(1390, 790)
    await expect(page).toHaveScreenshot(["images", "compare.png"])
  })

  test("Maps and models: the stations on a map, and a funnel as a 3D model", async ({ page }) => {
    await open(page, folder, "notes/sites.md", ".stl-canvas canvas")
    await page.waitForSelector(".geo-map-canvas path")
    await expect(page).toHaveScreenshot(["images", "map-and-model.png"])
  })

  test("Linked from: the documents linking to a page", async ({ page }) => {
    await open(page, folder, "stations/north.md", ".backlinks .backlink-context")
    await page.evaluate(() => document.querySelector(".backlinks")?.scrollIntoView())
    await expect(page).toHaveScreenshot(["images", "backlinks.png"])
  })

  test("History: two versions of a document compared", async ({ page }) => {
    const response = await page.request.get(`${folder.base}/report.md?versions`)
    const { versions } = (await response.json()) as { versions: { id: string }[] }
    const [newest, previous] = versions

    await open(page, folder, "report.md?history", ".history-timeline")
    await expect(page).toHaveScreenshot(["images", "history.png"], { clip: top(270) })
    await open(
      page,
      folder,
      `report.md?history&compare=${previous.id},${newest.id}`,
      ".history-compare-table",
    )
    await expect(page).toHaveScreenshot(["images", "history-compare.png"])
  })

  test("Digests: what changed in a week", async ({ page }) => {
    await open(page, folder, "?digest&from=2026-10-12&to=2026-10-18", ".digest-folder")
    await expect(page).toHaveScreenshot(["images", "digest.png"])
  })

  test("Outlived documents: unchanged, unread and linked from nowhere", async ({ page }) => {
    await open(page, folder, "?stale", ".stale li")
    await expect(page).toHaveScreenshot(["images", "stale.png"], { clip: top(200) })
  })

  test("Reading: what is new, catching up and what needs you", async ({ page, context }) => {
    test.setTimeout(120_000)

    for (const file of ["stations/north.md", "README.md"]) {
      await open(page, folder, file)
      await expect.poll(() => unread(page, folder, file), { timeout: 15_000 }).toBe(0)
    }

    await open(page, folder, "report.md", ".chart svg")
    await expect.poll(() => unread(page, folder, "report.md"), { timeout: 15_000 }).toBeLessThan(9)

    const changed = new Date("2026-10-18T14:20:00Z")
    folder.write("stations/north.md", NORTH_EDITED, changed)
    folder.write("README.md", README_EDITED, changed)
    await expect.poll(() => marked(page, folder, "stations/north.md")).toBeGreaterThan(0)

    // Hidden, the tab never counts a block as read, so the marks stay for the picture.
    const viewer = await context.newPage()
    await viewer.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden" })
      Object.defineProperty(document, "hidden", { get: () => true })
    })
    await viewer.clock.setFixedTime(BROWSER_NOW)

    await open(viewer, folder, "stations/north.md", ".read-mark.mark-changed")
    await viewer.click(".read-mark.mark-changed")
    await viewer.waitForSelector(".mark-panel:not([hidden])")
    await viewer.mouse.move(1390, 790)
    await expect(viewer).toHaveScreenshot(["images", "marks.png"])

    await open(viewer, folder, "?catch-up", ".catch-up li")
    await expect(viewer).toHaveScreenshot(["images", "catch-up.png"], { clip: top(330) })

    await open(viewer, folder, "", ".needs li")
    await expect(viewer).toHaveScreenshot(["images", "needs.png"], { clip: top(640) })

    const landed = new Date("2026-10-19T07:05:00Z")
    await page.goto("about:blank")
    folder.write("data/daily.csv", `${DAILY}${DAY_15}`, landed)
    await expect.poll(() => marked(page, folder, "report.md")).toBeGreaterThan(0)
    // The note dates a change by when the file changed in the folder, which no test can set.
    await viewer.route(/\/report\.md\?(read|page)$/, async (route) => {
      const answer = await (await route.fetch()).json()
      const read = answer.read ?? answer
      read.upstream = read.upstream.map((entry: object) => ({
        ...entry,
        at: landed.toISOString(),
      }))
      await route.fulfill({ json: answer })
    })
    await open(viewer, folder, "report.md", ".read-mark.mark-changed")
    await expect(viewer).toHaveScreenshot(["images", "data-changed.png"])
  })
})

const DAILY = fs.readFileSync(path.join(import.meta.dirname, "ridge/data/daily.csv"), "utf8")
const DAY_15 =
  "2026-10-15,north,0.0,7.2,19\n2026-10-15,east,2.4,7.9,23\n2026-10-15,south,1.8,8.8,21\n"

const NORTH_EDITED = [
  "# North",
  "",
  "- **Status:** active",
  "- **Owner:** Tove Brann",
  "- **Calibrated:** 2026-04-12",
  "",
  "The original station, on the summit cairn. Its rain gauge sits in the lee of the hut, so in a westerly it reads up to a tenth high.",
  "",
  "## Instruments",
  "",
  "| Instrument | Height | Interval |",
  "|---|---|---|",
  "| Anemometer | 10 m | 10 min |",
  "| Rain gauge | 1 m | 10 min |",
  "| Thermometer | 2 m | 1 min |",
  "",
  "A spare thermometer is kept in the hut, sealed against the damp.",
  "",
].join("\n")

const README_EDITED = [
  "# Ridge network",
  "",
  "Three stations along the ridge report every ten minutes; a fourth was retired after the spring storms. This folder holds each station's page, the readings they send and the reports written from them.",
  "",
  "| Station | Elevation | Since |",
  "|---|---|---|",
  "| [North](stations/north.md) | 412 m | 2019 |",
  "| [East](stations/east.md) | 388 m | 2021 |",
  "| [South](stations/south.md) | 351 m | 2022 |",
  "| [West](stations/west.md) | 405 m | retired |",
  "",
  "The [October report](report.md) sums up the first two weeks of the season.",
  "",
].join("\n")

async function open(page: Page, folder: Ridge, address: string, ready = ".markdown-body > *") {
  await page.goto(`${folder.base}/${address}`)
  await page.waitForSelector(ready)
  await page.waitForLoadState("networkidle")
  // A table's pinned header is animated by the page's scroll, an animation that never ends.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.timeline !== document.timeline),
  )
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      [...document.images].map((image) => image.complete || image.decode().catch(() => {})),
    )
  })
  await page.mouse.move(1390, 790)
}

function top(height: number) {
  return { x: 0, y: 0, width: 1400, height }
}

async function unread(page: Page, folder: Ridge, file: string): Promise<number> {
  const response = await page.request.get(`${folder.base}/${file}?read`)
  const { blocks } = (await response.json()) as { blocks: { read?: unknown }[] }

  return blocks.filter((block) => !block.read).length
}

async function marked(page: Page, folder: Ridge, file: string): Promise<number> {
  const response = await page.request.get(`${folder.base}/${file}?read`)
  const { marks } = (await response.json()) as { marks: unknown[] }

  return marks.length
}
