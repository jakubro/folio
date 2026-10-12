// The pictures the README and the documentation show, recorded from the fixture folder.

import { expect, test } from "@playwright/test";
import { show } from "./show.ts";

test("README: a rendered page with its tree and outline", async ({ page }) => {
  await show(page, "README.md");
  await page.evaluate(() => document.getElementById("wind-chill")?.scrollIntoView());
  await expect(page).toHaveScreenshot(["images", "folio.png"]);
});

test("Sections: one folded, another under the pointer", async ({ page }) => {
  await show(page, "calibration.md");
  await page.hover("#thermometer");
  await page.click("#thermometer .fold-toggle");
  await page.hover("#rain-gauge");
  await expect(page).toHaveScreenshot(["images", "sections-folded.png"]);
});

test("Diagrams: the full-window viewer", async ({ page }) => {
  await show(page, "README.md");
  await page.hover(".mermaid");
  await page.click(".mermaid-expand");
  await page.waitForSelector(".mermaid-zoom.visible svg");
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot(["images", "diagram-viewer.png"]);
});
