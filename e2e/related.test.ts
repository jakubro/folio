/** Headless Chromium run of related by meaning, with the model stood in for by word counts. */

import assert from "node:assert/strict"
import { test } from "node:test"
import type { Page } from "playwright"
import { base, open, write } from "./harness.ts"

const MORNING =
  "Water the tomato beds early in the morning before the sun warms the soil, so the roots drink deeply."
const PESTS = "Aphids gather under cucumber leaves when the weather turns warm and humid."
const SHARED = "Every bed is checked by the gardener on duty before the gate is locked at night."
const LOG = Array.from({ length: 60 }, (_, day) => `Day ${day + 1}.`).join("\n\n")

test("Not asked, First start, Reading, Point at a block, Boilerplate, Jump, Edit, Agents: a document shows what elsewhere in the folder says the same", async () => {
  write({
    "elsewhere/notes.md": `# Notes\n\n${MORNING}\n`,
    "elsewhere/title.md": "# Only a title\n",
  })
  const unasked = await open("elsewhere/notes.md")
  await unasked.waitForTimeout(500)
  assert.equal(await unasked.isVisible(".outline-related"), false, "not asked: no list")
  assert.deepEqual(await api("?api=related&question=tomato%20beds"), { asked: false })
  await unasked.close()

  write({
    "garden/FOLIO.md": "# Garden\n\n```yaml folio\nrelated:\n  - where: '**'\n```\n",
    "garden/watering.md": `# Watering\n\n## Morning\n\n${MORNING}\n\n## Pests\n\n${PESTS}\n\nOut of scope, by decision:\n\n${SHARED}\n\n## Log\n\n${LOG}\n\n[Title](../elsewhere/title.md)\n`,
    "garden/schedule.md": `# Schedule\n\nTomato beds want water early each morning, before the sun warms the soil and the roots dry.\n\n${SHARED}\n`,
    "garden/pests.md": `# Pests\n\nCucumber leaves hide aphids when the weather turns warm and humid; check under each leaf.\n`,
  })
  const page = await open("garden/watering.md")
  const said = () => page.textContent(".outline-related")
  const listed = () =>
    page.$$eval(".related-entry", (entries) =>
      entries.map((entry) => (entry as HTMLAnchorElement).pathname.split("/").pop()),
    )
  const until = (wanted: RegExp, what: string) =>
    page
      .waitForFunction(
        ([source, flags]) =>
          new RegExp(source, flags).test(
            document.querySelector(".outline-related")?.textContent ?? "",
          ),
        [wanted.source, wanted.flags],
        { timeout: 10_000 },
      )
      .catch(async () => assert.fail(`${what}: the panel read ${JSON.stringify(await said())}`))

  await until(/Downloading the model: 400 of 1,200 MB|Relating the folder/, "first start: progress")
  assert.equal(
    await page.isVisible(`text=${MORNING}`),
    true,
    "first start: the page reads meanwhile",
  )
  await page.waitForSelector(".related-entry")
  assert.deepEqual(await listed(), ["schedule.md"], "reading: the section in view")
  assert.match(
    (await page.textContent(".related-entry")) ?? "",
    /^Scheduleschedule\.md lines 3-3 - \d+%Tomato beds want water/,
  )

  await page.hover(`text=${PESTS}`)
  await until(/Cucumber leaves hide aphids/, "point at a block")
  assert.deepEqual(await listed(), ["pests.md"])
  await page.evaluate((text) => {
    const block = [...document.querySelectorAll(".markdown-body p")].find(
      (p) => p.textContent === text,
    ) as Element
    const range = document.createRange()
    range.selectNodeContents(block)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  }, PESTS)
  await page.mouse.move(100, 300)
  await page.waitForTimeout(400)
  assert.deepEqual(await listed(), ["pests.md"], "a selection keeps its block")
  await page.evaluate(() => getSelection()?.removeAllRanges())
  await until(/Tomato beds want water/, "back to the section in view")

  await page.hover("text=Out of scope, by decision:")
  await until(/Nothing close enough$/, "boilerplate: a short line")
  await page.hover(`text=${SHARED}`)
  await page.waitForTimeout(400)
  assert.equal(
    await said(),
    "Related by meaningNothing close enough",
    "boilerplate: a repeated block",
  )
  const asked = await api("?api=related&question=gardener%20on%20duty%20locks%20the%20gate")
  assert.ok(
    !asked.related.some(({ text }: { text: string }) => text === SHARED),
    "a block repeated word for word is never listed",
  )

  write({
    "garden/schedule.md": `# Schedule\n\nTomato beds want water early each morning, before the sun warms the soil and the roots dry.\n\nCucumber leaves shelter aphids under them in warm humid weather.\n\n${SHARED}\n`,
  })
  await page.hover(`text=${PESTS}`)
  await until(/Cucumber leaves shelter aphids/, "edit: related again")
  assert.deepEqual((await listed()).sort(), ["pests.md", "schedule.md"])

  const pests = await page.$eval(`text=${PESTS}`, (p) => (p as HTMLElement).dataset.folioId)
  const answer = await api(`garden/watering.md?api=related&block=${pests}`)
  assert.deepEqual(
    answer.related.map(({ path }: { path: string }) => path).sort(),
    ["garden/pests.md", "garden/schedule.md"],
    "agents: the same blocks as the panel",
  )
  const question = await api("?api=related&question=aphids%20under%20cucumber%20leaves")
  assert.ok(question.related.length > 0, "agents: a question in their own words")
  assert.ok(
    question.related.every(({ text }: { text: string }) => /aphids/i.test(text)),
    JSON.stringify(question.related),
  )

  await page.click('.markdown-body a[href$="elsewhere/title.md"]')
  await page.waitForFunction(() => location.pathname.endsWith("/elsewhere/title.md"))
  await page.waitForTimeout(400)
  assert.equal(await page.isVisible(".outline-related"), false, "not asked: the list goes")
  await page.goBack()
  await page.hover(`text=${PESTS}`)
  await jump(page)
  await page.close()
})

async function jump(page: Page): Promise<void> {
  await page.waitForSelector(".related-entry")
  const target = await page.$eval(".related-entry", (entry) => (entry as HTMLAnchorElement).href)
  await page.click(".related-entry")
  await page.waitForURL(target)
  await page.waitForSelector(".markdown-body .landed")
}

async function api(address: string) {
  return (await fetch(`${base}/${address}`)).json()
}
