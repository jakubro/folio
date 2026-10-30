/** Headless Chromium run of folio's documented behaviour: what folio remembers as read. */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { browser, context, landed, serveFolder, snapshotTree, waitFor, writeIn } from "./harness.ts"

test("Reading counts, Glance does not count, Version, Shared, Survives restarts, Folder untouched, Inspectable: folio remembers what was read", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-reading-")))
  const sections = Array.from(
    { length: 24 },
    (_, i) => `## Section ${i + 1}\n\n${`Section ${i + 1} holds words. `.repeat(30)}`,
  )
  writeIn(folder, { "log.md": `# Log\n\n${sections.join("\n\n")}\n` })
  const files = () => snapshotTree(folder)
  const written = files()
  let served = await serveFolder(folder)
  const readOf = async (address: string) => {
    const response = await fetch(`${address}/log.md?read`)
    return (await response.json()) as {
      blocks: { id: string; version: string; lines: number[]; read: { version: string } | null }[]
    }
  }
  const readLines = async (address: string) =>
    (await readOf(address)).blocks.filter((block) => block.read).map((block) => block.lines[0])
  const page = await context.newPage()

  try {
    await page.goto(`${served.base}/log.md`)
    await landed(page)
    await page.waitForTimeout(2500)
    const first = await readLines(served.base)

    assert.ok(first.includes(1), "the heading on screen is read")
    assert.ok(!first.some((line) => line > 40), `blocks below the window are unread: ${first}`)

    // Past the middle and on to the end within half a second: what flew past stays unread.
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight / 2))
    const passed = await page.evaluate(() =>
      Number(
        document
          .elementFromPoint(innerWidth / 2, innerHeight / 2)
          ?.closest("[data-folio-lines]")
          ?.getAttribute("data-folio-lines")
          ?.split("-")[0],
      ),
    )
    await page.waitForTimeout(400)
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(2500)
    const after = await readLines(served.base)
    const middle = (await readOf(served.base)).blocks.find((block) => block.lines[0] === passed)

    assert.ok(
      after.some((line) => line > 90),
      `the end is read: ${after}`,
    )
    assert.ok(passed > 40 && passed < 60, `a block was on screen mid-way: ${passed}`)
    assert.equal(middle?.read, null, "a block scrolled past is not read")
    await page.close()

    const top = (await readOf(served.base)).blocks.find((block) => block.lines[0] === 5)
    writeIn(folder, {
      "log.md": `# Log\n\n${sections.join("\n\n").replace("Section 1 holds", "Section 1 now holds")}\n`,
    })
    await waitFor(async () => {
      const block = (await readOf(served.base)).blocks.find((found) => found.id === top?.id)
      return block !== undefined && block.version !== top?.version
    })
    const edited = (await readOf(served.base)).blocks.find((block) => block.id === top?.id)

    assert.equal(edited?.read?.version, top?.version, "the version read, not the new one")

    const other = await browser.newContext()
    const elsewhere = await other.newPage()
    await elsewhere.goto(`${served.base}/`)
    const shared = await elsewhere.evaluate(async () => {
      const response = await fetch("/log.md?read")
      const { blocks } = (await response.json()) as { blocks: { read: unknown }[] }
      return blocks.filter((block) => block.read).length
    })
    await other.close()

    assert.equal(shared, after.length, "another browser knows the same blocks are read")

    served.stop()
    await served.stopped
    served = await serveFolder(folder)

    assert.deepEqual(await readLines(served.base), after, "the record survives a restart")
    assert.deepEqual(
      files().filter((line) => !line.startsWith("log.md")),
      written.filter((line) => !line.startsWith("log.md")),
      "nothing is written into the folder",
    )
  } finally {
    served.stop()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("Reading counts: a block many windows tall is read once it fills the window, not while a sliver shows", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-tall-")))
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n")
  writeIn(folder, {
    "tall.md": `# Tall\n\n\`\`\`text\n${lines}\n\`\`\`\n\n## After\n\n${"After the block. ".repeat(900)}\n`,
  })
  const served = await serveFolder(folder)
  const page = await context.newPage()
  const readOf = async () => {
    const { blocks } = await (await fetch(`${served.base}/tall.md?read`)).json()
    return Object.fromEntries(
      blocks.map((block: { kind: string; read: unknown }) => [block.kind, block.read !== null]),
    )
  }

  try {
    // Opened below the block, so it is never on screen before the sliver.
    await page.goto(`${served.base}/tall.md#after`)
    await page.waitForSelector(".markdown-body > pre[data-folio-version]")
    await page.waitForTimeout(300)
    const tall = await page.$eval(".markdown-body > pre", (pre) => ({
      top: pre.getBoundingClientRect().top + scrollY,
      height: pre.getBoundingClientRect().height,
    }))

    assert.ok(tall.height > 12 * 800, `the block is many windows tall: ${tall.height}`)

    // Only the block's last 100 pixels at the top of the window: a sliver, not a read.
    await page.evaluate((y) => scrollTo(0, y), tall.top + tall.height - 140)
    await page.waitForTimeout(2500)
    assert.equal((await readOf()).code, false, "a sliver of a tall block is not read")

    await page.evaluate((y) => scrollTo(0, y), tall.top + tall.height / 2)
    await page.waitForTimeout(2500)
    assert.equal((await readOf()).code, true, "a tall block filling the window is read")
  } finally {
    await page.close()
    served.stop()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("Tall block, Sleep: a change far down a tall block stays new until seen, and no read spans a sleep", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-tallchange-")))
  const tall = (last: string) =>
    `# Tall\n\n\`\`\`text\n${Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n")}\n${last}\n\`\`\`\n\n## After\n\n${"After the block. ".repeat(900)}\n`
  writeIn(folder, { "tall.md": tall("the end"), "short.md": "# Short\n\nA few words.\n" })
  const served = await serveFolder(folder)
  const codeRead = async () => {
    const { blocks } = await (await fetch(`${served.base}/tall.md?read`)).json()
    const code = blocks.find((block: { kind: string }) => block.kind === "code")
    return code.read !== null && code.read.version === code.version
  }
  const page = await context.newPage()

  try {
    await page.goto(`${served.base}/tall.md#after`)
    await page.waitForSelector(".markdown-body > pre[data-folio-version]")
    const block = async () =>
      page.$eval(".markdown-body > pre", (pre) => ({
        top: pre.getBoundingClientRect().top + scrollY,
        height: pre.getBoundingClientRect().height,
      }))
    let { top, height } = await block()
    await page.evaluate((y) => scrollTo(0, y), top + height / 2)
    await waitFor(codeRead)

    writeIn(folder, { "tall.md": tall("the end, changed") })
    await page.waitForSelector(".read-mark.mark-changed")
    ;({ top, height } = await block())
    await page.evaluate((y) => scrollTo(0, y), top)
    await page.waitForTimeout(2500)
    assert.equal(await codeRead(), false, "the block's top holds no change")

    await page.evaluate((y) => scrollTo(0, y), top + height - 400)
    await waitFor(codeRead)

    const sleeper = await context.newPage()
    await sleeper.clock.install()
    await sleeper.goto(`${served.base}/short.md`)
    await sleeper.waitForSelector(".markdown-body > p[data-folio-version]")
    await sleeper.clock.fastForward(60_000)
    await sleeper.waitForTimeout(500)
    const shortRead = async () => {
      const { blocks } = await (await fetch(`${served.base}/short.md?read`)).json()
      return blocks.some((found: { read: unknown }) => found.read !== null)
    }
    assert.equal(await shortRead(), false, "nothing is read across a sleep")
    await sleeper.clock.runFor(2_000)
    await waitFor(shortRead)
    await sleeper.close()
  } finally {
    await page.close()
    served.stop()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
