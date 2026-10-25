/** Opens a fixture page and waits until nothing on it will still change: tree, fonts and images. */

import type { Page } from "@playwright/test";

export async function show(page: Page, urlPath: string): Promise<void> {
  await page.goto(urlPath);
  await page.waitForSelector(".markdown-body > *");
  await page.waitForSelector(urlPath.endsWith("/") ? ".tree .tree-row" : ".tree .current");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) => image.complete || image.decode().catch(() => {})),
    );
  });
}
