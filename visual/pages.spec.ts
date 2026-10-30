/** Reference images of every page kind and panel state, recorded from the fixture folder. */

import { expect, type Page, test } from "@playwright/test"
import { show } from "./show.ts"

test("Markdown page, light", async ({ page }) => {
  await show(page, "README.md")
  await whole(page, "markdown-light.png")
})

test("Markdown page, dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await show(page, "README.md")
  await whole(page, "markdown-dark.png")
})

test("Collapsible block, open", async ({ page }) => {
  await show(page, "README.md")
  await page.click("summary")
  await page.mouse.move(0, 400)
  await whole(page, "details-open.png")
})

test("Frontmatter and code, light", async ({ page }) => {
  await show(page, "calibration.md")
  await whole(page, "frontmatter-light.png")
})

test("Frontmatter and code, dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await show(page, "calibration.md")
  await whole(page, "frontmatter-dark.png")
})

test("Malformed frontmatter and a diagram that cannot be drawn", async ({ page }) => {
  await show(page, "log.md")
  await whole(page, "malformed.png")
})

test("Loose tables", async ({ page }) => {
  await show(page, "readings.md")
  await whole(page, "loose-tables.png")
})

test("Diagram file, light", async ({ page }) => {
  await show(page, "network.mmd")
  await whole(page, "diagram-light.png")
})

test("Diagram file, dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await show(page, "network.mmd")
  await whole(page, "diagram-dark.png")
})

test("Expanded diagram", async ({ page }) => {
  await show(page, "README.md")
  await page.hover(".mermaid")
  await page.click(".mermaid-expand")
  await page.waitForSelector(".mermaid-zoom.visible svg")
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot("diagram-expanded.png")
})

test("Folder listing, with its folder expanded in the tree", async ({ page }) => {
  await show(page, "sensors/")
  await whole(page, "folder-listing.png")
})

test("Tree hidden", async ({ page }) => {
  await show(page, "calibration.md")
  await page.click('button[title="Show or hide the file tree"]')
  await page.mouse.move(0, 400)
  await whole(page, "tree-hidden.png")
})

test("Panels hidden, full width", async ({ page }) => {
  await show(page, "README.md")
  await page.click('button[title="Show or hide the file tree"]')
  await page.click('button[title="Show or hide the outline"]')
  await page.click('button[title="Full width"]')
  await page.mouse.move(0, 400)
  await whole(page, "panels-hidden-full-width.png")
})

test("Heading link mark under the pointer", async ({ page }) => {
  await show(page, "calibration.md")
  await page.hover("#rain-gauge .heading-link")
  await expect(page).toHaveScreenshot("heading-hover.png")
})

test("Folded section", async ({ page }) => {
  await show(page, "calibration.md")
  await page.hover("#thermometer")
  await page.click("#thermometer .fold-toggle")
  await page.mouse.move(0, 400)
  await whole(page, "section-folded.png")
})

test("Live updates suspended", async ({ page }) => {
  await show(page, "sensors/wind.md")
  await page.click('button[title="Suspend live updates in this tab"]')
  await page.mouse.move(0, 400)
  await whole(page, "suspended.png")
})

async function whole(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(name, { fullPage: true })
}
