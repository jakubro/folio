/** Opens a fixture page and waits until nothing on it will still change: tree, fonts and images. */

import type { Page } from "@playwright/test"

export async function show(page: Page, urlPath: string): Promise<void> {
  await healthKnown(page, "")
  const problems = page.waitForResponse((response) => response.url().includes("?health-data"))
  await page.goto(urlPath)
  await problems
  await page.waitForSelector(".markdown-body > *")
  await page.waitForSelector(urlPath.endsWith("/") ? ".tree .tree-row" : ".tree .current")
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      [...document.images].map((image) => image.complete || image.decode().catch(() => {})),
    )
  })
}

/** The tree marks what health lists, so a picture waits for health to be worked out before it opens. */
export async function healthKnown(page: Page, base: string): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    const health = (await (await page.request.get(`${base}/?health-data`)).json()) as {
      ready: boolean
    }

    if (health.ready) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error("health was never worked out")
}
