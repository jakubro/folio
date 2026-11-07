/** Headless Chromium run of Folio's documented behaviour: rendering, includes, theme, faces and the toolbar. */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import zlib from "node:zlib"
import type { Page } from "playwright"
import {
  base,
  browser,
  CLI,
  context,
  FILES,
  landed,
  open,
  openData,
  output,
  port,
  root,
  sourced,
  visible,
  waitFor,
  write,
} from "./harness.ts"

test("Serve: prints its address and serves every renderable file by its relative path", async () => {
  assert.match(
    output,
    new RegExp(`^Folio serving ${escapeRegExp(root)}\n {2}at ${escapeRegExp(base)}/\n`),
  )

  for (const urlPath of ["notes/guide.md", "notes/flow.mmd", "media/logo.svg", "deep/a/b/c.md"]) {
    assert.equal((await fetch(`${base}/${urlPath}`)).status, 200, urlPath)
  }

  assert.equal((await fetch(`${base}/data/table.csv`)).status, 200)
  assert.equal((await fetch(`${base}/data/table.txt`)).status, 404)
})

test("Port taken: exits with an error naming the port", () => {
  const result = spawnSync(process.execPath, [CLI, root, "--port", String(port)], {
    encoding: "utf8",
  })

  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), `Port ${port} is already in use.`)
})

test("Render: GFM, math, highlighting, sanitized HTML and mermaid", async () => {
  const page = await open("notes/guide.md")
  const facts = await page.evaluate(() => ({
    table: document.querySelectorAll(".markdown-body table td").length > 0,
    tasks: document.querySelectorAll(".markdown-body input[type=checkbox]").length,
    math: document.querySelectorAll(".katex").length,
    highlighted: Boolean(document.querySelector("pre code.hljs .hljs-keyword")),
    diagram: Boolean(document.querySelector(".mermaid svg[aria-roledescription]")),
    scripts: document.querySelectorAll(".markdown-body script").length,
    handler: document.querySelector('img[src="nowhere.png"]')?.getAttribute("onerror") ?? null,
    injected: (window as { xssProbe?: number }).xssProbe ?? null,
    sameTab: document.querySelector('a[href="other.md"]')?.getAttribute("target") ?? null,
    newTab: document.querySelector('a[href="https://example.com"]')?.getAttribute("target"),
    anchor: Boolean(document.getElementById("links")),
  }))

  assert.deepEqual(facts, {
    table: true,
    tasks: 2,
    math: 2,
    highlighted: true,
    diagram: true,
    scripts: 0,
    handler: null,
    injected: null,
    sameTab: null,
    newTab: "_blank",
    anchor: true,
  })
  await page.close()
})

test("Page draws, Using the link, Other links: a link whose address cannot be read breaks nothing", async () => {
  write({
    "notes/parts/unreadable.md": [
      "# Unreadable",
      "",
      "Served at http://localhost:PORT/, on [the site](https://example.com) and in [the guide](../guide.md).",
      "",
      "The last paragraph.",
    ].join("\n"),
  })
  const UNREADABLE = '.markdown-body a[href="http://localhost:PORT/"]'
  const own = await browser.newContext()
  const page = await own.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${base}/notes/parts/unreadable.md`)
  await landed(page)

  assert.equal(await visible(page, "The last paragraph."), true)
  assert.equal(
    await page.getAttribute('.markdown-body a[href="https://example.com"]', "target"),
    "_blank",
  )
  await page.click('.markdown-body a[href="../guide.md"]')
  await page.waitForURL(`${base}/notes/guide.md`)
  await page.goBack()

  await page.hover(UNREADABLE)
  await Promise.all([own.waitForEvent("page"), page.click(UNREADABLE, { button: "middle" })])
  await page.click(UNREADABLE, { button: "right" })
  await page.keyboard.press("Escape")
  await page.click(UNREADABLE)
  await page.waitForTimeout(300)
  assert.deepEqual(errors, [])
  await own.close()
})

test("Page draws, Live, Snapshot, Other images: an image whose address cannot be read breaks nothing on its page", async (t) => {
  t.after(() => fs.rmSync(path.join(root, "notes/pictured"), { recursive: true, force: true }))
  const images = {
    unparsed: {
      source: "http://localhost:PORT/a.png",
      frozen: '<span class="frozen-image">[x]</span>',
    },
    undecoded: { source: "a%zz.png", frozen: '<span class="frozen-image">[x]</span>' },
    folder: { source: "../../media/logo.svg", frozen: 'src="data:image/svg+xml;base64,' },
    outside: {
      source: "https://example.com/a.png",
      frozen: '<span class="frozen-image">[x]</span>',
    },
  }

  for (const [name, { source, frozen }] of Object.entries(images)) {
    const file = `notes/pictured/${name}.md`
    const own = await browser.newContext({ viewport: { width: 1400, height: 800 } })
    const page = await own.newPage()
    const errors: string[] = []
    const reworded = (wording: string) =>
      write({ [file]: `# ${name}\n\n![x](${source})\n\n${wording}\n\nThe last paragraph.\n` })
    const shown = (wording: string) =>
      page.waitForFunction(
        (t) => document.querySelector(".markdown-body")?.textContent?.includes(t),
        wording,
        { timeout: 10_000 },
      )

    await own.route("https://example.com/**", (route) => route.fulfill({ status: 404 }))
    page.on("pageerror", (error) => errors.push(error.message))
    reworded("The first wording.")
    write({ [`notes/pictured/to-${name}.md`]: `# To ${name}\n\n[The page](${name}.md)\n` })

    await page.goto(`${base}/${file}`)
    await landed(page)
    assert.equal(await visible(page, "The last paragraph."), true, name)
    reworded("The second wording.")
    await shown("The second wording.")

    await page.goto(`${base}/notes/pictured/to-${name}.md`)
    await landed(page)
    await page.click(`.markdown-body a[href="${name}.md"]`)
    await page.waitForURL(`${base}/${file}`)
    await page.waitForTimeout(300)
    reworded("The third wording.")
    await shown("The third wording.")

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click('button[title="Freeze this page into one HTML file"]'),
    ])
    const saved = path.join(root, "..", `folio-pictured-${name}-${process.pid}.html`)
    await download.saveAs(saved)
    assert.ok(fs.readFileSync(saved, "utf8").includes(frozen), name)
    fs.rmSync(saved)
    assert.deepEqual(errors, [], name)
    await own.close()
  }
})

test("Fragment opened, Fragment through a link, Link within the page, Link hover, Other addresses: a broken escape breaks nothing", async (t) => {
  t.after(() => fs.rmSync(path.join(root, "notes/escaped"), { recursive: true, force: true }))
  const own = await browser.newContext({ viewport: { width: 1400, height: 800 } })
  const page = await own.newPage()
  const errors: string[] = []
  let wording = 0
  const reworded = () => {
    wording++
    write({
      "notes/escaped/ok.md": [
        "# Ok",
        "",
        "## Intro",
        "",
        `Wording ${wording}.`,
        "",
        "Filler line.\n\n".repeat(60),
        "[Broken](#%zz), [Missing](#nowhere) and [Away](a%zz.md).",
        "",
        "The end.",
        "",
      ].join("\n"),
    })
    return `Wording ${wording}.`
  }
  const saved = async () => {
    await page.waitForFunction(
      (t) => document.querySelector(".markdown-body")?.textContent?.includes(t),
      reworded(),
      { timeout: 10_000 },
    )
  }
  const clicked = async (href: string) => {
    await page.click(`.markdown-body a[href="${href}"]`)
    await page.waitForTimeout(300)
    return page.evaluate(() => ({
      y: scrollY,
      hash: location.hash,
      gone: !(document.querySelector(".block-gone") as HTMLElement).hidden,
    }))
  }

  page.on("pageerror", (error) => errors.push(error.message))
  reworded()
  write({
    "notes/escaped/from.md":
      "# From\n\n[Broken](ok.md#%zz), [Intro](ok.md#intro) and [Plain](ok.md).\n",
  })

  for (const fragment of ["#%zz", "#intro", ""]) {
    await page.goto(`${base}/notes/escaped/ok.md${fragment}`)
    await landed(page)
    await saved()

    await page.goto(`${base}/notes/escaped/from.md`)
    await landed(page)
    await page.click(`.markdown-body a[href="ok.md${fragment}"]`)
    await page.waitForURL(`${base}/notes/escaped/ok.md${fragment}`)
    await page.waitForTimeout(300)
    await saved()
  }

  const id = await page.$eval(
    ".markdown-body > p:last-of-type",
    (block) => (block as HTMLElement).dataset.folioId,
  )
  await page.goto(`${base}/notes/escaped/ok.md#^${id}`)
  await landed(page)
  await saved()

  const missing = await clicked("#nowhere")
  const broken = await clicked("#%zz")
  assert.deepEqual(broken, { ...missing, hash: "#%zz" })
  await saved()

  await page.hover('.markdown-body a[href="a%zz.md"]')
  await page.waitForTimeout(200)
  await page.mouse.down()
  await page.mouse.move(0, 400)
  await page.mouse.up()
  await page.waitForTimeout(300)
  assert.deepEqual(errors, [])
  await own.close()
})

test("Inline tags: underline, small print, citations and definitions render; outdated tags stay plain", async () => {
  const page = await open("notes/parts/inline.md")
  const look = (selector: string) =>
    page.$eval(`.markdown-body ${selector}`, (e) => {
      const style = getComputedStyle(e)
      return [style.textDecorationLine, style.fontStyle, style.fontSize]
    })
  const plain = await look("p")

  assert.equal((await look("u"))[0], "underline")
  assert.ok(Number.parseFloat((await look("small"))[2]) < Number.parseFloat(plain[2]))
  assert.equal((await look("cite"))[1], "italic")
  assert.equal((await look("dfn"))[1], "italic")
  assert.equal(await page.locator(".markdown-body :is(big, center, font)").count(), 0)
  assert.match(
    await page.$eval(".markdown-body", (e) => e.textContent ?? ""),
    /big red[\s\S]*centered/,
  )

  write({
    "notes/parts/inline.md": FILES["notes/parts/inline.md"].replace(
      "Marked later.",
      "Marked <u>later</u>.",
    ),
  })
  await page.waitForFunction(() => document.querySelectorAll(".markdown-body u").length === 2)
  await page.close()
})

test("Includes: replaced verbatim inside HTML, unresolved ones stay as written, marked", async () => {
  const page = await open("notes/guide.md")

  assert.equal(await page.$eval(".markdown-body td li", (li) => li.textContent), "cell item")
  assert.match(
    await page.$eval(".markdown-body", (e) => e.textContent ?? ""),
    /Missing: \[\{include: parts\/absent\.md\}\]/,
  )
  assert.equal(
    await page.$eval(".markdown-body .include-missing", (marker) => marker.textContent),
    "{include: parts/absent.md}",
  )
  await page.close()
})

test("Includes everywhere, Escaped include: an include resolves in code and diagrams, an escaped one never", async () => {
  write({
    "notes/parts/inc/part.txt": "PART",
    "notes/parts/inc/flow.mmd": "graph LR\n  A --> B",
    "notes/parts/inc/lost.mmd": "graph LR\n  A --> B\n  {include: nothing.mmd}",
    "notes/parts/inc/page.md": [
      "# Inc",
      "",
      "Inline `{include: part.txt}` and escaped \\{include: part.txt} and `\\{include: part.txt}`.",
      "",
      "```",
      "{include: part.txt}",
      "{include: gone.txt}",
      "```",
      "",
      "```mermaid",
      "{include: flow.mmd}",
      "```",
      "",
      "## Intro {include: gone.md}",
      "",
      "Icon \uE000 then {include: *a*.md} and {include: <b>.md} and {include: a\\_b.md}.",
      "",
      "```mermaid",
      "graph LR",
      "  A --> B",
      "  %% {include: gone.mmd}",
      "```",
    ].join("\n"),
  })
  const page = await open("notes/parts/inc/page.md")
  await page.waitForSelector(".mermaid svg")

  assert.equal(
    await page.$eval(".markdown-body p", (p) => p.textContent),
    "Inline PART and escaped {include: part.txt} and {include: part.txt}.",
  )
  assert.equal(
    await page.$eval(".markdown-body pre code", (code) => code.textContent),
    "PART\n{include: gone.txt}\n",
  )
  assert.deepEqual(
    await page.$$eval(".markdown-body .include-missing", (found) =>
      found.map((marker) => [marker.textContent, marker.id]),
    ),
    [
      ["{include: gone.txt}", "include-notes/parts/inc/page.md:7:0"],
      ["{include: gone.md}", "include-notes/parts/inc/page.md:14:9"],
      ["{include: *a*.md}", "include-notes/parts/inc/page.md:16:12"],
      ["{include: <b>.md}", "include-notes/parts/inc/page.md:16:34"],
      ["{include: a\\_b.md}", "include-notes/parts/inc/page.md:16:56"],
      ["{include: gone.mmd}", "include-notes/parts/inc/page.md:21:5"],
    ],
  )
  assert.ok(
    await page.isVisible("#intro-include-gonemd"),
    "a heading holding one is named as written",
  )
  assert.match(
    (await page.textContent('.markdown-body > p:has-text("Icon")')) ?? "",
    /^Icon \uE000 then /,
  )
  assert.equal(await page.locator("pre.diagram-failed .include-missing").count(), 1)
  const raw = await (await context.request.get(`${base}/notes/parts/inc/page.md?raw`)).text()
  assert.match(raw, /^PART\n\{include: gone\.txt\}$/m)
  assert.doesNotMatch(raw.replace("\uE000 then", ""), /[\uE000-\uE01F]/)

  await page.goto(`${base}/notes/parts/inc/lost.mmd`)
  await page.waitForSelector("pre.diagram-failed .include-missing")
  assert.equal(await page.textContent(".include-missing"), "{include: nothing.mmd}")
  await page.close()
})

test("Includes in addresses, charts and queries: each unresolved one is marked where it shows, and a query runs what it shows", async () => {
  write({
    "notes/parts/inc2/n.csv": "n\n1\n2\n",
    "notes/parts/inc2/count.sql": "select count(*) as n from 'n.csv'",
    "notes/parts/inc2/twice.md": "Twice {include: gone-twice.md}.\n",
    "notes/parts/inc2/page.md": [
      "# Inc2",
      "",
      'A [link]({include: gone-link.md}) and <img alt="x" src="{include: gone.png}">.',
      "",
      "Two {include: one.md} and {include: two.md} on a line.",
      "",
      "```vega-lite",
      '{"data": {"values": [{"a": 1}]}, "mark": "{include: gone-mark.txt}"}',
      "```",
      "",
      "```sql query",
      "{include: count.sql}",
      "```",
      "",
      "```sql query",
      "select '\\{include: x}' as s",
      "```",
      "",
      "{include: twice.md}",
      "",
      "{include: twice.md}",
    ].join("\n"),
  })
  const page = await open("notes/parts/inc2/page.md")
  await page.waitForSelector(".embed-query >> nth=1 >> table")

  const markers = await page.$$eval(".markdown-body .include-missing", (found) =>
    found.map((marker) => [marker.textContent, marker.id, marker.checkVisibility()]),
  )
  assert.deepEqual(markers, [
    ["{include: gone-link.md}", "include-notes/parts/inc2/page.md:3:9", true],
    ["{include: gone.png}", "include-notes/parts/inc2/page.md:3:56", true],
    ["{include: one.md}", "include-notes/parts/inc2/page.md:5:4", true],
    ["{include: two.md}", "include-notes/parts/inc2/page.md:5:26", true],
    ["{include: gone-mark.txt}", "include-notes/parts/inc2/page.md:8:42", true],
    ["{include: gone-twice.md}", "include-notes/parts/inc2/twice.md:1:6", true],
    ["{include: gone-twice.md}", "include-notes/parts/inc2/twice.md:1:6~2", true],
  ])
  assert.match(
    (await page.textContent(".markdown-body p")) ?? "",
    /^A link \{include: gone-link\.md\} and/,
  )
  assert.equal(await page.locator(".embed-chart .chart").count(), 0, "the chart is not drawn")
  assert.deepEqual(
    await page.$$eval(".embed-query table td", (cells) => cells.map((cell) => cell.textContent)),
    ["2", "{include: x}"],
  )
  await page.close()
})

test("Large page: a page of over 20,000 text nodes draws within a bound, with or without an include to mark", async () => {
  const items = Array.from({ length: 7000 }, (_, i) => `- item ${i} *of* note`).join("\n")
  write({
    "notes/parts/large.md": `# Large\n\n${items}\n`,
    "notes/parts/large-marked.md": `# Large\n\n${items}\n\nLast {include: gone-large.md}.\n`,
  })

  for (const name of ["large", "large-marked"]) {
    const page = await context.newPage()
    const started = Date.now()
    await page.goto(`${base}/notes/parts/${name}.md`)
    await page.waitForSelector(".markdown-body li:nth-child(7000)")
    const took = Date.now() - started
    const nodes = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.querySelector(".markdown-body") as Node,
        NodeFilter.SHOW_TEXT,
      )
      let count = 0

      while (walker.nextNode()) {
        count++
      }

      return count
    })

    assert.ok(nodes >= 20_000, `${name}: ${nodes} text nodes`)
    assert.ok(took < 6000, `${name}: drawn in ${took} ms`)
    assert.equal(await page.locator(".include-missing").count(), name === "large" ? 0 : 1)
    await page.close()
  }
})

test("Details: consecutive blocks sit 2px apart, the last keeps its gap to what follows", async () => {
  const page = await open("notes/folds.md")
  const gaps = await page.$$eval(".markdown-body > *", (blocks) =>
    blocks.slice(1).map((block, i) => {
      const above = (blocks[i] as Element).getBoundingClientRect().bottom
      return Math.round(block.getBoundingClientRect().top - above)
    }),
  )

  assert.deepEqual(gaps, [2, 2, 8])
  await page.close()
})

test("Theme: page, code and diagrams follow; the choice survives a reload and leaves other open tabs alone", async () => {
  const page = await open("notes/guide.md")
  const other = await open("notes/other.md")
  const look = () =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
      keyword: getComputedStyle(document.querySelector(".hljs-keyword") as Element).color,
      diagram: document.querySelector(".mermaid svg")?.innerHTML.length,
      node: getComputedStyle(document.querySelector(".mermaid .node rect") as Element).fill,
    }))
  const before = await look()
  const redrawn = page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        document.addEventListener("folio:redraw", (event) => {
          if ((event as CustomEvent<{ cause: string }>).detail.cause === "load") {
            resolve()
          }
        }),
      ),
  )

  await page.click('button[title="Switch theme"]')
  await page.waitForFunction((t) => document.documentElement.dataset.theme !== t, before.theme)
  await redrawn
  const switched = await look()

  assert.notEqual(switched.background, before.background)
  assert.notEqual(switched.keyword, before.keyword)
  assert.notEqual(switched.diagram, before.diagram, "the diagram did not follow the theme")
  assert.deepEqual([before.theme, before.node], ["light", "rgb(236, 236, 255)"])
  assert.equal(switched.node, "rgb(45, 45, 48)", "the diagram's nodes kept the light theme")
  await other.waitForTimeout(300)
  assert.equal(await other.evaluate(() => document.documentElement.dataset.theme), before.theme)
  await page.reload()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), switched.theme)
  await page.click('button[title="Switch theme"]')
  await Promise.all([page.close(), other.close()])
})

test("Sharing, Paused, Digest, History, Pointer and keyboard: text buttons are drawn as the data switches, in either theme", async () => {
  write({ "notes/parts/buttons.md": "# Buttons\n\nText.\n" })
  const page = await open("notes/parts/buttons.md")
  const look = (selector: string) =>
    page.$eval(selector, (button) => {
      const style = getComputedStyle(button)
      return [
        `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
        style.borderRadius,
        style.backgroundColor,
        style.color,
        style.cursor,
        style.opacity,
      ].join(" / ")
    })
  const seen: Record<string, string> = {}

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
    }

    await page.goto(`${base}/`)
    await page.waitForSelector('.sharing-toggle[aria-pressed="false"]')
    seen[`${theme} sharing`] = await look(".sharing-toggle")
    await page.click(".sharing-toggle")
    await page.waitForSelector('.sharing-toggle[aria-pressed="true"]')
    seen[`${theme} paused`] = await look(".sharing-toggle")
    await page.click(".sharing-toggle")
    await page.waitForSelector('.sharing-toggle[aria-pressed="false"]')
    await page.goto(`${base}/?digest`)
    await page.waitForSelector(".digest-periods button")
    seen[`${theme} show`] = await look(".digest-periods button")
    await page.goto(`${base}/notes/parts/buttons.md?history`)
    await page.waitForSelector(".history-compare")
    seen[`${theme} compare`] = await look(".history-compare")
  }

  await page.click('button[title="Switch theme"]')
  await page.close()

  const light = "1px solid rgb(209, 217, 224) / 6px / rgba(0, 0, 0, 0) / rgb(31, 35, 40)"
  const dark = "1px solid rgb(54, 54, 54) / 6px / rgba(0, 0, 0, 0) / rgb(204, 204, 204)"
  assert.deepEqual(seen, {
    "light sharing": `${light} / pointer / 1`,
    "light paused":
      "1px solid rgb(9, 105, 218) / 6px / rgba(0, 0, 0, 0) / rgb(9, 105, 218) / pointer / 1",
    "light show": `${light} / pointer / 1`,
    "light compare": `${light} / default / 0.35`,
    "dark sharing": `${dark} / pointer / 1`,
    "dark paused":
      "1px solid rgb(68, 147, 248) / 6px / rgba(0, 0, 0, 0) / rgb(68, 147, 248) / pointer / 1",
    "dark show": `${dark} / pointer / 1`,
    "dark compare": `${dark} / default / 0.35`,
  })
})

test("Each kind, Themes, Case, Marker with text, Not top level, Unknown kind, Included: GitHub alerts render as callouts", async () => {
  write({
    "notes/parts/alerts.md": [
      "# Alerts",
      "",
      ...["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"].flatMap((kind) => [
        `> [!${kind}]`,
        `> Body of ${kind.toLowerCase()}.`,
        "",
      ]),
      "> [!note]",
      "> Written in lower case.",
      "",
      "> [!NOTE] text on the same line",
      "",
      "- > [!NOTE]",
      "  > Inside a list.",
      "",
      "> > [!NOTE]",
      "> > Inside a quote.",
      "",
      "> [!TODO]",
      "> Not a kind.",
      "",
      "{include: shared.md#shared}",
    ].join("\n"),
    "notes/parts/shared.md": "# Shared page\n\n## Shared\n\n> [!TIP]\n> Included tip.\n",
  })
  const page = await open("notes/parts/alerts.md")
  const quotes = () =>
    page.$$eval(".markdown-body blockquote", (found) =>
      found.map((quote) => {
        const title = quote.querySelector(":scope > .markdown-alert-title")
        return {
          alert: quote.className,
          title: title?.textContent ?? null,
          icon: Boolean(title?.querySelector("svg")),
          text: (
            quote.querySelector(":scope > p:not(.markdown-alert-title)")?.textContent ?? ""
          ).trim(),
          edge: getComputedStyle(quote).borderLeftColor,
          ink: title && getComputedStyle(title).color,
          body: getComputedStyle(quote).color,
        }
      }),
    )
  const seen: Record<string, Awaited<ReturnType<typeof quotes>>> = {}

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
      await page.waitForSelector(".markdown-alert-title svg")
    }

    seen[theme] = await quotes()
  }

  await page.click('button[title="Switch theme"]')
  await page.close()

  const kinds = ["note", "tip", "important", "warning", "caution"]
  const colours = {
    light: [
      "rgb(9, 105, 218)",
      "rgb(26, 127, 55)",
      "rgb(130, 80, 223)",
      "rgb(154, 103, 0)",
      "rgb(209, 36, 47)",
    ],
    dark: [
      "rgb(68, 147, 248)",
      "rgb(63, 185, 80)",
      "rgb(171, 125, 248)",
      "rgb(210, 153, 34)",
      "rgb(248, 81, 73)",
    ],
  }
  const body = { light: "rgb(31, 35, 40)", dark: "rgb(204, 204, 204)" }

  for (const theme of ["light", "dark"] as const) {
    const found = seen[theme]
    const callout = (kind: string, text: string, colour: string) => ({
      alert: `markdown-alert markdown-alert-${kind}`,
      title: kind[0].toUpperCase() + kind.slice(1),
      icon: true,
      text,
      edge: colour,
      ink: colour,
      body: body[theme],
    })

    assert.deepEqual(
      found.slice(0, 6),
      [
        ...kinds.map((kind, i) => callout(kind, `Body of ${kind}.`, colours[theme][i])),
        callout("note", "Written in lower case.", colours[theme][0]),
      ],
      theme,
    )
    assert.deepEqual(
      found.slice(6).map(({ alert, title, text }) => ({ alert, title, text })),
      [
        { alert: "", title: null, text: "[!NOTE] text on the same line" },
        { alert: "", title: null, text: "[!NOTE]\nInside a list." },
        { alert: "", title: null, text: "" },
        { alert: "", title: null, text: "[!NOTE]\nInside a quote." },
        { alert: "", title: null, text: "[!TODO]\nNot a kind." },
        { alert: "markdown-alert markdown-alert-tip", title: "Tip", text: "Included tip." },
      ],
      theme,
    )
  }
})

test("Copy, Placement, No language, Included code, Drawings, Themes, SQL file: a code block, or a .sql file's page, copies with one click", async () => {
  write({
    "notes/parts/totals.sql": "select 1 as one\nfrom range(3)\n",
    "notes/parts/windows.sql": "select 2 as two\r\n",
    "notes/parts/snippet.md": "first included line\nsecond included line",
    "notes/parts/code.md": [
      "# Code",
      "",
      "```python",
      "def double(x):",
      "    return x * 2",
      "```",
      "",
      "```",
      `plain ${"wide ".repeat(60)}end`,
      "```",
      "",
      "```text",
      "{include: snippet.md}",
      "```",
      "",
      "```mermaid",
      "graph LR",
      "  A --> B",
      "```",
    ].join("\n"),
  })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await open("notes/parts/code.md")
  await page.waitForSelector(".markdown-body .mermaid svg")
  const pres = page.locator(".markdown-body pre")
  const look = (index: number) =>
    pres.nth(index).evaluate((pre) => {
      const copy = pre.querySelector(":scope > .code-copy") as HTMLElement
      const code = pre.querySelector(":scope > code") as HTMLElement
      const [box, button, text] = [pre, copy, code].map((element) =>
        element.getBoundingClientRect(),
      )
      return {
        corner: Math.round(box.right - button.right) <= 6 && Math.round(button.top - box.top) <= 6,
        clear: button.left >= text.right,
        scrolls: code.scrollWidth > code.clientWidth,
        shown: getComputedStyle(copy).opacity,
        colour: getComputedStyle(copy).color,
      }
    })

  assert.equal(await pres.count(), 3)
  assert.equal(await page.locator(".markdown-body .mermaid .code-copy").count(), 0)
  assert.equal((await look(0)).shown, "0")

  const copied: string[] = []

  for (const index of [0, 1, 2]) {
    await pres.nth(index).hover()
    const seen = await look(index)
    assert.equal(seen.shown, "1", `block ${index}`)
    assert.ok(seen.corner && seen.clear, `block ${index}: ${JSON.stringify(seen)}`)
    await pres.nth(index).locator(".code-copy").click()
    copied.push(await page.evaluate(() => navigator.clipboard.readText()))
  }

  assert.ok((await look(1)).scrolls, "the wide block scrolls")
  assert.deepEqual(copied, [
    "def double(x):\n    return x * 2",
    `plain ${"wide ".repeat(60)}end`,
    "first included line\nsecond included line",
  ])
  assert.match(
    (await pres.nth(2).locator(".code-copy").innerHTML()) ?? "",
    /M20 6L9 17l-5-5/,
    "the button shows a check",
  )
  await page.waitForFunction(
    () => !document.querySelectorAll(".code-copy")[2]?.innerHTML.includes("M20 6L9 17l-5-5"),
  )

  const colours: string[] = []

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
      await page.waitForSelector(".markdown-body pre > .code-copy")
    }

    await pres.nth(0).hover()
    colours.push((await look(0)).colour)
  }

  await page.click('button[title="Switch theme"]')
  await page.goto(`${base}/notes/parts/totals.sql`)
  await page.waitForSelector(".data-page pre")
  await page.locator(".data-page pre").hover()
  const query = await look(0)
  await page.locator(".data-page pre .code-copy").click()
  const copiedQuery = await page.evaluate(() => navigator.clipboard.readText())
  await page.goto(`${base}/notes/parts/windows.sql`)
  await page.waitForSelector(".data-page pre")
  await page.locator(".data-page pre").hover()
  await page.locator(".data-page pre .code-copy").click()
  const copiedWindows = await page.evaluate(() => navigator.clipboard.readText())
  await page.close()
  assert.deepEqual(colours, ["rgb(89, 99, 110)", "rgb(154, 154, 154)"])
  assert.ok(query.corner && query.clear && query.shown === "1", JSON.stringify(query))
  assert.equal(copiedQuery, "select 1 as one\nfrom range(3)")
  assert.equal(copiedWindows, "select 2 as two")
})

test("Hex, RGB, HSL, Out of range, Other text, Code block, Themes: a colour in inline code shows its swatch", async () => {
  write({
    "notes/parts/colours.md": [
      "# Colours",
      "",
      "Hex `#0969DA`, RGB `rgb(9, 105, 218)`, HSL `hsl(212, 92%, 45%)` and `hsl(0, 100%, 50%)`.",
      "",
      "White `#FFFFFF` and black `#000000`.",
      "",
      "Nested <code><code>#0969DA</code></code>.",
      "",
      "Not colours: `rgb(300, 0, 0)`, `color: #0969DA`, `#fff`, `hsl(400, 10%, 10%)`,",
      "<code>#09<em>x</em>69DA</code>, <code><em>x</em>#0969DA</code>.",
      "",
      "```",
      "#0969DA",
      "```",
    ].join("\n"),
  })
  const page = await open("notes/parts/colours.md")
  const swatches = () =>
    page.$$eval(".markdown-body .color-swatch", (found) =>
      found.map((swatch) => {
        const style = getComputedStyle(swatch)
        const box = swatch.getBoundingClientRect()
        return {
          after: swatch.previousElementSibling?.textContent,
          fill: style.backgroundColor,
          edge: style.borderTopColor,
          shown: box.width > 0 && box.height > 0,
        }
      }),
    )
  const seen: Record<string, Awaited<ReturnType<typeof swatches>>> = {}

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      const redrawn = page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            document.addEventListener("folio:redraw", (event) => {
              if ((event as CustomEvent<{ cause: string }>).detail.cause === "load") {
                resolve()
              }
            }),
          ),
      )
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
      await redrawn
    }

    seen[theme] = await swatches()
  }

  await page.click('button[title="Switch theme"]')
  await page.close()

  for (const [theme, edge] of [
    ["light", "rgb(89, 99, 110)"],
    ["dark", "rgb(154, 154, 154)"],
  ]) {
    assert.deepEqual(
      seen[theme].map(({ after, fill }) => [after, fill]),
      [
        ["#0969DA", "rgb(9, 105, 218)"],
        ["rgb(9, 105, 218)", "rgb(9, 105, 218)"],
        ["hsl(212, 92%, 45%)", "rgb(9, 108, 220)"],
        ["hsl(0, 100%, 50%)", "rgb(255, 0, 0)"],
        ["#FFFFFF", "rgb(255, 255, 255)"],
        ["#000000", "rgb(0, 0, 0)"],
        ["#0969DA", "rgb(9, 105, 218)"],
      ],
      theme,
    )
    assert.ok(
      seen[theme].every((swatch) => swatch.shown && swatch.edge === edge),
      JSON.stringify(seen[theme]),
    )
  }
})

test("Backtick form, Dollar inside, Dollar form, Code alone, Across lines: inline math written with backticks renders", async () => {
  write({
    "notes/parts/math.md": [
      "# Math",
      "",
      "Area $`a^2`$.",
      "",
      "Area $a^2$.",
      "",
      "Price $`\\$5`$.",
      "",
      "Dollar form $b^2$.",
      "",
      "Code `a^2` alone.",
      "",
      "Broken $`a",
      "b`$ here, $c$ after.",
    ].join("\n"),
  })
  const page = await open("notes/parts/math.md")
  await page.waitForSelector(".katex")
  const lines = await page.$$eval(".markdown-body > p", (found) =>
    found.map((line) => ({
      tex: [...line.querySelectorAll('annotation[encoding="application/x-tex"]')].map(
        (note) => note.textContent,
      ),
      drawn: line.querySelector(".katex-html")?.innerHTML ?? null,
      shown: line.querySelector(".katex-html")?.textContent ?? null,
      code: [...line.querySelectorAll("code:not(.katex code)")].map((code) => code.textContent),
      text: line.textContent,
    })),
  )
  await page.close()

  assert.deepEqual(
    lines.map(({ tex, shown, code }) => ({ tex, shown, code })),
    [
      { tex: ["a^2"], shown: "a2", code: [] },
      { tex: ["a^2"], shown: "a2", code: [] },
      { tex: ["\\$5"], shown: "$5", code: [] },
      { tex: ["b^2"], shown: "b2", code: [] },
      { tex: [], shown: null, code: ["a^2"] },
      { tex: ["c"], shown: "c", code: ["a b"] },
    ],
  )
  assert.equal(lines[0].drawn, lines[1].drawn)
  assert.match(lines[5].text, /^Broken \$a b\$ here, /)
})

test("Toolbar, Source, Drawing, Copy, Diagram file, Chart, Failed diagram, Update, Themes, Source showing: a drawing switches to its source and copies it, and hides its expand button meanwhile", async () => {
  const flow = "graph LR\n  Start --> Stop"
  const chart = [
    "data:",
    "  url: visits.csv",
    "mark: bar",
    "encoding:",
    "  x: {field: city, type: nominal}",
    "  y: {field: visits, type: quantitative}",
  ].join("\n")
  const drawings = (diagram: string) =>
    [
      "# Drawings",
      "",
      "```mermaid",
      diagram,
      "```",
      "",
      "```vega-lite",
      chart,
      "```",
      "",
      "```mermaid",
      "graph LR",
      "  A --> ",
      "```",
    ].join("\n")
  write({
    "notes/parts/visits.csv": "city,visits\nOslo,3\nLima,5\n",
    "notes/parts/drawings.md": drawings(flow),
    "notes/parts/drawing.mmd": "graph TD\n  Up --> Down",
  })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await open("notes/parts/drawings.md")
  await page.waitForSelector(".mermaid svg")
  await page.waitForSelector(".embed-chart .chart svg")
  const diagram = page.locator(".markdown-body .mermaid").first()
  const graph = page.locator(".markdown-body .embed-chart")
  const toolbar = (drawing: typeof diagram) =>
    drawing.evaluate((element) => {
      const bar = element.querySelector(":scope > .drawn-toolbar") as HTMLElement
      const [box, corner] = [element, bar].map((part) => part.getBoundingClientRect())
      return {
        buttons: [...bar.querySelectorAll("button")].map((control) => control.title),
        expand: bar.querySelector(".drawn-expand")?.checkVisibility() ?? null,
        pressed: bar.querySelector(".source-switch")?.getAttribute("aria-pressed"),
        corner: Math.round(box.right - corner.right) <= 6 && Math.round(corner.top - box.top) <= 6,
        shown: getComputedStyle(bar).opacity,
        drawn: Boolean(
          element.querySelector(":scope > svg, :scope > .chart svg")?.checkVisibility(),
        ),
        source:
          [...element.querySelectorAll(":scope > pre")]
            .find((pre) => pre.checkVisibility())
            ?.querySelector("code")
            ?.textContent?.replace(/\n$/, "") ?? null,
        highlighted: Boolean(element.querySelector(":scope > pre > code.hljs")?.checkVisibility()),
        clear: (() => {
          const pre = [...element.querySelectorAll(":scope > pre")].find((one) =>
            one.checkVisibility(),
          )
          const scroller = [pre?.querySelector(":scope > code"), pre].find(
            (one) => one && getComputedStyle(one).overflowX === "auto",
          )
          return !pre || (scroller ? scroller.getBoundingClientRect().right <= corner.left : false)
        })(),
      }
    })
  const copied = async (drawing: typeof diagram) => {
    await drawing.locator(".source-copy").click()
    return page.evaluate(() => navigator.clipboard.readText())
  }

  assert.equal((await toolbar(diagram)).shown, "0")
  await diagram.hover()
  assert.deepEqual(await toolbar(diagram), {
    buttons: ["Expand diagram", "Show source", "Copy source"],
    expand: true,
    pressed: "false",
    corner: true,
    shown: "1",
    drawn: true,
    source: null,
    highlighted: false,
    clear: true,
  })
  assert.equal(await copied(diagram), flow)
  await diagram.locator(".source-switch").click()
  await diagram.locator('.source-switch[aria-pressed="true"]').waitFor()
  assert.deepEqual(await toolbar(diagram), {
    buttons: ["Expand diagram", "Show the drawing", "Copy source"],
    expand: false,
    pressed: "true",
    corner: true,
    shown: "1",
    drawn: false,
    source: flow,
    highlighted: false,
    clear: true,
  })
  assert.equal(await copied(diagram), flow)
  assert.match(await diagram.locator(".source-copy").innerHTML(), /M20 6L9 17l-5-5/)

  write({ "notes/parts/drawings.md": drawings("graph LR\n  Start --> Middle --> Stop") })
  await page.waitForFunction(() =>
    document.querySelector(".mermaid > .drawn-source")?.textContent?.includes("Middle"),
  )
  assert.equal((await toolbar(diagram)).drawn, false, "the saved diagram still shows its source")
  await diagram.locator(".source-switch").click()
  assert.equal((await toolbar(diagram)).drawn, true)

  await graph.hover()
  const before = await toolbar(graph)
  assert.deepEqual(before.buttons, ["Expand chart", "Show source", "Copy source"])
  assert.equal(before.expand, true)
  assert.equal(before.drawn, true)
  await graph.locator(".source-switch").click()
  await graph.locator('.source-switch[aria-pressed="true"]').waitFor()
  assert.deepEqual(
    { ...(await toolbar(graph)), shown: undefined },
    {
      buttons: ["Expand chart", "Show the drawing", "Copy source"],
      expand: false,
      pressed: "true",
      corner: true,
      shown: undefined,
      drawn: false,
      source: chart,
      highlighted: true,
      clear: true,
    },
  )
  assert.equal(await copied(graph), chart)
  await graph.locator(".source-switch").click()
  assert.equal((await toolbar(graph)).drawn, true)

  const failed = page.locator(".markdown-body pre.diagram-failed")
  assert.equal(await failed.count(), 1)
  await failed.hover()
  await failed.locator(".code-copy").click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "graph LR\n  A --> ")

  const colours: string[] = []

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]')
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
      await page.waitForSelector(".mermaid .drawn-toolbar")
    }

    await diagram.hover()
    colours.push(
      await diagram.locator(".source-switch").evaluate((control) => {
        const bar = control.parentElement as HTMLElement
        return `${getComputedStyle(control).color} on ${getComputedStyle(bar).backgroundColor}`
      }),
    )
  }

  await page.click('button[title="Switch theme"]')
  assert.deepEqual(colours, [
    "rgb(89, 99, 110) on rgb(255, 255, 255)",
    "rgb(154, 154, 154) on rgb(26, 26, 26)",
  ])

  await page.goto(`${base}/notes/parts/drawing.mmd`)
  await page.waitForSelector(".mermaid svg")
  await page.hover(".mermaid")
  assert.deepEqual((await toolbar(page.locator(".mermaid"))).buttons, [
    "Expand diagram",
    "Show source",
    "Copy source",
  ])
  await page.close()
})

test("Dark theme: text is calmer, and every diagram label reads on its fill in either theme", async () => {
  const diagram = [
    "graph LR",
    "  classDef pale fill:#f0d5e8",
    "  classDef inked fill:#f0d5e8,color:#c00000",
    "  subgraph box [Box]",
    "    pale[Pale]:::pale",
    "  end",
    "  dark[Dark] --> inked[Inked]:::inked --> plain[Plain]",
    "  style dark fill:#333333",
    "  style box fill:#ffe6cc",
  ].join("\n")
  write({
    "notes/parts/fills.md": [
      "# Fills",
      "",
      "Body with **bold**.",
      "",
      "| Cell |",
      "|---|",
      "| a |",
      "",
      "> Quoted.",
      "",
      "```mermaid",
      diagram,
      "```",
    ].join("\n"),
    "notes/parts/fills.mmd": diagram,
  })
  const page = await open("notes/parts/fills.md")
  const text = () =>
    page.evaluate(() => {
      const color = (selector: string) =>
        getComputedStyle(document.querySelector(`.markdown-body ${selector}`) as Element).color
      return {
        theme: document.documentElement.dataset.theme,
        body: ["h1", "p", "strong", "td"].map(color),
        quote: color("blockquote"),
      }
    })
  const look = (scope: string) =>
    page.evaluate((within) => {
      const style = (selector: string) =>
        getComputedStyle(document.querySelector(`${within} ${selector}`) as Element)
      const node = (id: string) => `[id*="-flowchart-${id}-"]`
      return {
        labels: {
          pale: style(`${node("pale")} .nodeLabel`).color,
          dark: style(`${node("dark")} .nodeLabel`).color,
          inked: style(`${node("inked")} .nodeLabel`).color,
          plain: style(`${node("plain")} .nodeLabel`).color,
          box: style('.cluster[id$="-box"] .nodeLabel').color,
        },
        fills: {
          pale: style(`${node("pale")} rect`).fill,
          dark: style(`${node("dark")} rect`).fill,
          plain: style(`${node("plain")} rect`).fill,
          box: style('.cluster[id$="-box"] rect').fill,
        },
        shadow: style(`${node("plain")} rect`).filter,
      }
    }, scope)
  const shaded = () =>
    page.$$eval(".markdown-body .mermaid svg *", (elements) =>
      [...new Set(elements.map((element) => getComputedStyle(element).filter))].filter(
        (filter) => filter !== "none",
      ),
    )
  const light = {
    labels: {
      pale: "rgb(51, 51, 51)",
      dark: "rgb(204, 204, 204)",
      inked: "rgb(192, 0, 0)",
      plain: "rgb(51, 51, 51)",
      box: "rgb(51, 51, 51)",
    },
    fills: {
      pale: "rgb(240, 213, 232)",
      dark: "rgb(51, 51, 51)",
      plain: "rgb(236, 236, 255)",
      box: "rgb(255, 230, 204)",
    },
    shadow: "drop-shadow(rgb(185, 185, 185) 1px 2px 2px)",
  }
  const dark = {
    labels: { ...light.labels, plain: "rgb(204, 204, 204)" },
    fills: { ...light.fills, plain: "rgb(45, 45, 48)" },
    shadow: "none",
  }

  assert.deepEqual(await text(), {
    theme: "light",
    body: Array(4).fill("rgb(31, 35, 40)"),
    quote: "rgb(89, 99, 110)",
  })
  assert.deepEqual(await look(".markdown-body .mermaid"), light)
  await page.click('button[title="Switch theme"]')
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg')
  assert.deepEqual(await text(), {
    theme: "dark",
    body: Array(4).fill("rgb(204, 204, 204)"),
    quote: "rgb(154, 154, 154)",
  })
  assert.deepEqual(await look(".markdown-body .mermaid"), dark)
  assert.deepEqual(await shaded(), [])
  await page.hover(".mermaid")
  await page.click(".mermaid .drawn-expand")
  await page.waitForSelector(".viewer.visible svg")
  assert.deepEqual(await look(".viewer-inner"), dark)
  await page.keyboard.press("Escape")
  await page.goto(`${base}/notes/flow.mmd`)
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg')
  assert.deepEqual(await shaded(), [])
  await page.goto(`${base}/notes/parts/fills.mmd`)
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg')
  assert.deepEqual(await look(".markdown-body .mermaid"), dark)
  await page.click('button[title="Switch theme"]')
  await page.waitForSelector('.markdown-body[data-theme="light"] .mermaid svg')
  assert.deepEqual(await look(".markdown-body .mermaid"), light)
  await page.close()
})

test("Labels on fills: rows, notes, text labels, faint, sketched and brace fills, code and any colour notation read on what lies under them; a label already readable keeps its colour", async () => {
  const fence = (lines: string[]) => ["```mermaid", ...lines, "```", ""].join("\n")
  write({
    "notes/parts/kinds.md": [
      "# Kinds",
      "",
      fence([
        "erDiagram",
        "  CUSTOMER {",
        "    string name",
        "    int email",
        "  }",
        "  style CUSTOMER fill:#f0d5e8",
      ]),
      fence(["classDiagram", "  class Duck", '  note for Duck "can fly"']),
      fence([
        "---",
        "config:",
        "  htmlLabels: false",
        "---",
        "graph LR",
        "  classDef pale fill:#f0d5e8",
        "  shown[Text label]:::pale",
      ]),
      fence(["graph LR", "  faint[Faint]", "  style faint fill:#000000,fill-opacity:0.1"]),
      fence([
        "graph LR",
        "  classDef pale fill:#f0d5e8",
        '  coded["Run <code>make</code>"]:::pale',
        '  brace@{ shape: brace, label: "Brace" }',
        "  style brace fill:#f0d5e8",
      ]),
      fence([
        "stateDiagram-v2",
        "  classDef wide fill:oklch(0.9 0.04 340)",
        "  [*] --> Wide",
        "  class Wide wide",
      ]),
      fence([
        "---",
        "config:",
        "  look: handDrawn",
        "---",
        "graph LR",
        "  classDef pale fill:#f0d5e8",
        "  sketched[Sketched]:::pale",
      ]),
    ].join("\n"),
  })
  const page = await open("notes/parts/kinds.md")
  const labels = () =>
    page.evaluate(() => ({
      ...Object.fromEntries(
        [
          ...document.querySelectorAll(
            ".mermaid :is(.node, .rough-node, .cluster) :is(.nodeLabel, text)",
          ),
        ]
          .filter((label) => label.textContent?.trim())
          .map((label) => [
            label.textContent?.trim(),
            label.localName === "text"
              ? getComputedStyle(label).fill
              : getComputedStyle(label).color,
          ]),
      ),
      "<code>": getComputedStyle(document.querySelector(".mermaid .nodeLabel code") as Element)
        .color,
    }))

  assert.deepEqual(await labels(), {
    CUSTOMER: "rgb(51, 51, 51)",
    string: "rgb(51, 51, 51)",
    name: "rgb(51, 51, 51)",
    int: "rgb(51, 51, 51)",
    email: "rgb(51, 51, 51)",
    Duck: "rgb(19, 19, 0)",
    "can fly": "rgb(0, 0, 0)",
    "Text label": "rgb(51, 51, 51)",
    Faint: "rgb(51, 51, 51)",
    "Run make": "rgb(51, 51, 51)",
    "<code>": "rgb(51, 51, 51)",
    Brace: "rgb(51, 51, 51)",
    Wide: "rgb(19, 19, 0)",
    Sketched: "rgb(51, 51, 51)",
  })
  await page.click('button[title="Switch theme"]')
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg')
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.mermaid [class^="row-rect"]')].map(
        (row) => getComputedStyle(row.querySelector("path") as Element).fill,
      ),
    ),
    ["rgb(44, 45, 45)", "rgb(240, 213, 232)"],
  )
  assert.deepEqual(await labels(), {
    CUSTOMER: "rgb(51, 51, 51)",
    string: "rgb(204, 204, 204)",
    name: "rgb(204, 204, 204)",
    int: "rgb(51, 51, 51)",
    email: "rgb(51, 51, 51)",
    Duck: "rgb(204, 204, 204)",
    "can fly": "rgb(184, 182, 182)",
    "Text label": "rgb(51, 51, 51)",
    Faint: "rgb(204, 204, 204)",
    "Run make": "rgb(51, 51, 51)",
    "<code>": "rgb(204, 204, 204)",
    Brace: "rgb(204, 204, 204)",
    Wide: "rgb(51, 51, 51)",
    Sketched: "rgb(51, 51, 51)",
  })
  await page.hover(".mermaid >> nth=4")
  await page.click(".mermaid >> nth=4 >> .drawn-expand")
  await page.waitForSelector(".viewer.visible svg")
  assert.deepEqual(
    await page.$eval(".viewer-inner code", (code) => [
      getComputedStyle(code).color,
      getComputedStyle(code).backgroundColor,
    ]),
    ["rgb(204, 204, 204)", "rgb(36, 36, 36)"],
  )
  await page.keyboard.press("Escape")
  await page.click('button[title="Switch theme"]')
  await page.close()
})

test("Mermaid, Small diagram: a diagram expands filling the window, zooms at the pointer and pans by drag", async () => {
  const page = await open("notes/guide.md")
  const transform = () => page.$eval(".viewer-inner", (e) => (e as HTMLElement).style.transform)
  const scaleOf = (shown: string) => Number(/scale\(([\d.]+)\)/.exec(shown)?.[1])

  await page.click(".mermaid svg[aria-roledescription]")
  assert.equal(await page.locator(".viewer.visible").count(), 0)
  await page.hover(".mermaid")
  await page.click(".mermaid .drawn-expand")
  await page.waitForSelector(".viewer.visible svg")
  const fitted = await transform()
  const fill = await shownIn(page)
  await page.mouse.move(700, 400)
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(
    (t) => (document.querySelector(".viewer-inner") as HTMLElement).style.transform !== t,
    fitted,
  )
  const zoomed = await transform()
  await page.mouse.down()
  await page.mouse.move(800, 450, { steps: 5 })
  await page.mouse.up()
  const panned = await transform()

  assert.ok(
    fill.own.width < fill.port.width && fill.own.height < fill.port.height,
    "a small diagram",
  )
  assert.ok(scaleOf(fitted) > 1, "it grows past its own size")
  assert.ok(fill.filled, "it fills the window")
  assert.ok(Math.abs(scaleOf(zoomed) / scaleOf(fitted) - 1.25) < 1e-4, `${fitted} then ${zoomed}`)
  assert.notEqual(panned, zoomed)
  await page.keyboard.press("Escape")
  assert.equal(await page.locator(".viewer.visible").count(), 0)
  await page.goto(`${base}/notes/flow.mmd`)
  await page.waitForSelector(".mermaid svg[aria-roledescription]")
  await page.close()
})

test("Backdrop, Empty space, Drag, X, Escape, Leaving: only the X, Escape and leaving the page close the diagram viewer", async () => {
  write({
    "notes/parts/viewer-a.md": "# A\n\n[The flow](viewer-b.md)\n",
    "notes/parts/viewer-b.md": "# B\n\n```mermaid\ngraph TD\n  Start --> Stop\n```\n",
  })
  const page = await open("notes/parts/viewer-a.md")
  const shown = () => page.locator(".viewer.visible").count()
  const expand = async () => {
    await page.hover(".mermaid")
    await page.click(".mermaid .drawn-expand")
    await page.waitForSelector(".viewer.visible svg")
  }
  const hit = (x: number, y: number) =>
    page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [x, y])

  await page.click("text=The flow")
  await page.waitForSelector(".mermaid svg[aria-roledescription]")
  await expand()
  const viewport = await page.$eval(".viewer-viewport", (element) => {
    const { left, top } = element.getBoundingClientRect()
    return { left, top }
  })

  assert.equal(await hit(10, 400), "viewer visible")
  await page.mouse.click(10, 400)
  assert.equal(await shown(), 1, "backdrop")

  assert.equal(await hit(viewport.left + 10, viewport.top + 10), "viewer-viewport")
  await page.mouse.click(viewport.left + 10, viewport.top + 10)
  assert.equal(await shown(), 1, "empty space")

  const before = await page.$eval(".viewer-inner", (e) => (e as HTMLElement).style.transform)
  await page.mouse.move(700, 400)
  await page.mouse.down()
  await page.mouse.move(800, 450, { steps: 5 })
  await page.mouse.up()
  assert.notEqual(
    await page.$eval(".viewer-inner", (e) => (e as HTMLElement).style.transform),
    before,
  )
  assert.equal(await shown(), 1, "drag")

  await page.click(".viewer-close")
  assert.equal(await shown(), 0, "X")

  await expand()
  await page.keyboard.press("Escape")
  assert.equal(await shown(), 0, "Escape")

  await expand()
  await page.goBack()
  await page.waitForSelector("text=The flow")
  assert.equal(await shown(), 0, "leaving")
  await page.close()
})

test("Screenshot, Small picture, SVG image, Written as HTML, Inside a link, Closing: an image opens in the viewer, fitted, an SVG filling it and any other no larger than its own size", async () => {
  const shots = [
    "# Shots",
    "",
    "![wide](wide.png)",
    "",
    "Inline ![small](small.png) in a sentence.",
    "",
    "![shape](shape.svg)",
    "",
    '<img src="small.png" alt="html" width="50%">',
    "",
    '<img src="https://example.com/remote.png" alt="remote">',
    "",
    '<picture><source srcset="wide.png"><img src="small.png" alt="pictured"></picture>',
    "",
    "[![badge](small.png)](badged.md)",
  ].join("\n")
  write({
    "notes/parts/shots/wide.png": png(2400, 1200),
    "notes/parts/shots/small.png": png(200, 100),
    "notes/parts/shots/shape.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="teal"/></svg>',
    "notes/parts/shots/shots.md": shots,
    "notes/parts/shots/badged.md": "# Badged\n\n[Shots](shots.md)",
  })
  const page = await context.newPage()
  await page.route("https://example.com/remote.png", (route) =>
    route.fulfill({ body: png(200, 100), contentType: "image/png" }),
  )
  await page.goto(`${base}/notes/parts/shots/shots.md`)
  await page.waitForSelector(".markdown-body > *")
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".markdown-body img")].every(
      (image) => (image as HTMLImageElement).naturalWidth > 0,
    ),
  )
  const image = (alt: string) => page.locator(`.markdown-body img[alt="${alt}"]`)
  const corner = (alt: string) =>
    image(alt).evaluate((found) => {
      const toolbar = (found.closest("picture") ?? found).nextElementSibling
      const [box, bar] = [found, toolbar].map((part) => part?.getBoundingClientRect())
      return toolbar?.matches(".image-toolbar") && box && bar
        ? {
            buttons: [...toolbar.querySelectorAll("button")].map((control) => control.title),
            corner: Math.round(box.right - bar.right) === 4 && Math.round(bar.top - box.top) === 4,
            shown: getComputedStyle(toolbar).opacity,
          }
        : null
    })
  const expand = async (alt: string) => {
    await image(alt).scrollIntoViewIfNeeded()
    await image(alt).hover()
    const found = await corner(alt)
    await page
      .locator(
        `.markdown-body :is(img[alt="${alt}"], picture:has(img[alt="${alt}"])) + .image-toolbar .drawn-expand`,
      )
      .click()
    await page.waitForFunction(() => {
      const inner = document.querySelector(".viewer.visible .viewer-inner") as HTMLElement | null
      const shown = inner?.querySelector("img")
      return inner?.style.visibility === "" && shown?.complete
    })
    return found
  }
  const close = () => page.keyboard.press("Escape")

  assert.equal((await corner("wide"))?.shown, "0", "the corner shows only under the pointer")
  await image("wide").click()
  assert.equal(
    await page.locator(".viewer.visible").count(),
    0,
    "a click on the image opens nothing",
  )

  assert.deepEqual(await expand("wide"), { buttons: ["Expand image"], corner: true, shown: "1" })
  const wide = await shownIn(page)
  assert.deepEqual(wide.own, { width: 2400, height: 1200 })
  assert.ok(wide.filled && wide.box.width <= 2400, "a screenshot is fitted to the window")
  const fitted = await page.$eval(
    ".viewer-inner",
    (inner) => (inner as HTMLElement).style.transform,
  )
  await page.mouse.move(700, 400)
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(
    (was) => (document.querySelector(".viewer-inner") as HTMLElement).style.transform !== was,
    fitted,
  )
  const zoomed = await page.$eval(
    ".viewer-inner",
    (inner) => (inner as HTMLElement).style.transform,
  )
  await page.mouse.down()
  await page.mouse.move(800, 450, { steps: 5 })
  await page.mouse.up()
  const dragged = await page.$eval(
    ".viewer-inner",
    (inner) => (inner as HTMLElement).style.transform,
  )
  assert.deepEqual(
    [0, 1].map((axis) => Math.round(translationOf(dragged)[axis] - translationOf(zoomed)[axis])),
    [100, 50],
    "dragging pans it as far as the pointer moves",
  )
  await page.keyboard.press("-")
  await page.keyboard.press("ArrowLeft")
  await page.click('.viewer-controls button[title="Fit to view"]')
  assert.equal(
    await page.$eval(".viewer-inner", (inner) => (inner as HTMLElement).style.transform),
    fitted,
  )

  await page.mouse.click(10, 400)
  assert.equal(
    await page.locator(".viewer.visible").count(),
    1,
    "a click on the backdrop leaves it",
  )
  await page.click(".viewer-close")
  assert.equal(await page.locator(".viewer.visible").count(), 0, "the X closes it")

  assert.deepEqual(await expand("small"), { buttons: ["Expand image"], corner: true, shown: "1" })
  assert.deepEqual((await shownIn(page)).box, { width: 200, height: 100 })
  await page.click('.viewer-controls button[title="Zoom in"]')
  assert.deepEqual((await shownIn(page)).box, { width: 250, height: 125 }, "zooming in enlarges it")
  await close()
  assert.equal(await page.locator(".viewer.visible").count(), 0, "Escape closes it")

  await expand("shape")
  const shape = await shownIn(page)
  assert.ok(shape.filled && shape.box.width > 600, "an SVG image fills the window")
  assert.equal(shape.box.width / shape.box.height, 2)
  await close()

  for (const alt of ["html", "remote"]) {
    assert.deepEqual(await expand(alt), { buttons: ["Expand image"], corner: true, shown: "1" })
    assert.deepEqual((await shownIn(page)).box, { width: 200, height: 100 }, alt)
    await close()
  }

  await expand("pictured")
  assert.deepEqual((await shownIn(page)).own, { width: 2400, height: 1200 }, "the source it shows")
  await close()

  await image("badge").scrollIntoViewIfNeeded()
  await image("badge").hover()
  assert.equal(await corner("badge"), null, "a linked image has no expand button")
  await image("badge").click()
  await page.waitForSelector("h1:text('Badged')")

  await page.click('.markdown-body a[href="shots.md"]')
  await page.waitForSelector(".markdown-body img[alt='wide']")
  await expand("wide")
  await page.goBack()
  await page.waitForSelector("h1:text('Badged')")
  assert.equal(await page.locator(".viewer.visible").count(), 0, "back closes it")

  await page.goForward()
  await page.waitForSelector(".markdown-body img[alt='html']")
  write({ "notes/parts/shots/shots.md": `${shots}\n\nAppended.` })
  await page.waitForSelector("text=Appended.")
  const kept = await corner("html")
  assert.deepEqual(
    kept && { buttons: kept.buttons, corner: kept.corner },
    { buttons: ["Expand image"], corner: true },
    "an image on a line of its own keeps its corner through a save",
  )
  await page.close()
})

test("Chart: a chart opens in the viewer filling the window, and zooms and pans as a diagram does", async () => {
  write({
    "notes/parts/charted.csv": "city,visits\nOslo,3\nLima,5\n",
    "notes/parts/charted.md": [
      "# Charted",
      "",
      "```vega-lite",
      "data: {url: charted.csv}",
      "mark: bar",
      "width: 120",
      "height: 80",
      "encoding:",
      "  x: {field: city, type: nominal}",
      "  y: {field: visits, type: quantitative}",
      "```",
    ].join("\n"),
  })
  const page = await open("notes/parts/charted.md")
  const transform = () =>
    page.$eval(".viewer-inner", (inner) => (inner as HTMLElement).style.transform)
  await page.waitForSelector(".embed-chart .chart svg")
  await page.hover(".embed-chart")
  await page.click(".embed-chart .drawn-expand")
  await page.waitForSelector(".viewer.visible svg")
  const chart = await shownIn(page)

  assert.ok(chart.own.width < 400, "a small chart")
  assert.ok(chart.filled, "it fills the window")
  const fitted = await transform()
  await page.mouse.move(700, 400)
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(
    (was) => (document.querySelector(".viewer-inner") as HTMLElement).style.transform !== was,
    fitted,
  )
  const zoomed = await transform()
  await page.mouse.down()
  await page.mouse.move(800, 450, { steps: 5 })
  await page.mouse.up()
  assert.notEqual(await transform(), zoomed)
  assert.equal(await page.locator(".viewer-inner svg text").first().isVisible(), true)
  await page.keyboard.press("Escape")
  await page.close()
})

test("Text face, Code face, No merged operators, Offline, Diagram face: Folio draws in the faces it carries", async () => {
  const outside: string[] = []
  const page = await context.newPage()
  page.on("request", (request) => {
    if (!request.url().startsWith(base) && !request.url().startsWith("data:")) {
      outside.push(request.url())
    }
  })
  await page.goto(`${base}/notes/guide.md`)
  await page.waitForSelector(".markdown-body > *")
  const cdp = await page.context().newCDPSession(page)
  const faces = async (selector: string) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true })
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector })
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId })
    return fonts.map((font) => font.familyName)
  }
  await cdp.send("DOM.enable")
  await cdp.send("CSS.enable")

  assert.deepEqual(await faces(".markdown-body td"), ["Arimo"])
  assert.deepEqual(await faces(".markdown-body strong"), ["Arimo"])
  assert.deepEqual(await faces(".markdown-body h1"), ["Arimo SemiBold"])
  assert.deepEqual(await faces(".markdown-body p code"), ["JetBrains Mono"])
  assert.deepEqual(await faces(".markdown-body pre code"), ["JetBrains Mono"])
  assert.match(
    await page.$eval(".markdown-body pre", (pre) => getComputedStyle(pre).fontFamily),
    /^"JetBrains Mono"/,
  )
  assert.deepEqual(await faces(".mermaid .nodeLabel"), ["Arimo"])
  assert.deepEqual(
    await page.$$eval(".markdown-body code", (codes) => [
      ...new Set(codes.map((code) => getComputedStyle(code).fontVariantLigatures)),
    ]),
    ["no-contextual"],
  )
  await page.click('button[title="Switch theme"]')
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid .nodeLabel')
  assert.deepEqual(await faces(".mermaid .nodeLabel"), ["Arimo"])
  assert.deepEqual(outside, [])
  await page.click('button[title="Switch theme"]')
  await page.close()
})

test("Outline: lists the headings and highlights the section being read", async () => {
  const page = await open("notes/long.md")

  assert.equal(await page.$$eval(".outline a", (links) => links.length), 9)
  await page.evaluate(() => document.getElementById("part-5")?.scrollIntoView())
  await page.waitForFunction(
    () => document.querySelector(".outline a.current")?.textContent === "Part 5",
  )
  await page.close()
})

test("Following, Your scroll, Reading on, An entry, Another page: the outline stays where you scroll it", async () => {
  const sections = Array.from(
    { length: 80 },
    (_, i) => `## Section ${i + 1}\n\n${"Words fill the section. ".repeat(40)}`,
  ).join("\n\n")
  write({
    "notes/parts/outline-many.md": `# Many\n\n[Other](outline-other.md)\n\n${sections}`,
    "notes/parts/outline-other.md": `# Other\n\n[Many](outline-many.md)\n\n${sections}`,
  })
  const page = await open("notes/parts/outline-many.md")
  const outline = () =>
    page.$eval(".outline", (panel) => {
      const box = panel.getBoundingClientRect()
      const current = panel.querySelector(".current")?.getBoundingClientRect()
      return {
        top: panel.scrollTop,
        current: panel.querySelector(".current")?.textContent,
        shown:
          current !== undefined && current.top >= box.top - 1 && current.bottom <= box.bottom + 1,
      }
    })
  const read = async (heading: string) => {
    await page.evaluate((id) => document.getElementById(id)?.scrollIntoView(), heading)
    await page.waitForTimeout(300)
    return outline()
  }
  const yours = async () => {
    const box = await page.$eval(".outline", (panel) => {
      const { x, y, width, height } = panel.getBoundingClientRect()
      return { x, y, width, height }
    })
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 10_000)
    await page.waitForTimeout(300)
    return (await outline()).top
  }

  const following = await read("section-60")
  assert.equal(following.current, "Section 60")
  assert.ok(following.top > 0 && following.shown, JSON.stringify(following))

  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(300)
  const left = await yours()
  assert.ok(left > 0, "the wheel did not scroll the outline")
  assert.deepEqual(await read("section-10"), { top: left, current: "Section 10", shown: false })
  assert.deepEqual(await read("section-25"), { top: left, current: "Section 25", shown: false })
  await page.evaluate(() => scrollBy(0, 300))
  await page.waitForTimeout(300)
  assert.equal((await outline()).top, left, "reading on")

  await page.click(".outline a:text-is('Section 5')")
  await page.waitForTimeout(300)
  assert.equal((await outline()).current, "Section 5")
  const entry = await read("section-70")
  assert.ok(entry.shown && entry.top !== left, JSON.stringify(entry))

  await page.click(".outline-backlinks .backlinks-title")
  const pressed = await read("section-20")
  assert.ok(pressed.shown, `a press that scrolls nothing stopped it: ${JSON.stringify(pressed)}`)

  const held = await yours()
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.click(".outline-backlinks a", { modifiers: ["ControlOrMeta"] }),
  ])
  await tab.close()
  assert.equal((await read("section-25")).top, held, "a click for a new tab made it follow")

  await read("section-1")
  await yours()
  await page.evaluate(() => scrollTo(0, 0))
  await page.$eval(".markdown-body a[href='outline-other.md']", (link) =>
    (link as HTMLElement).click(),
  )
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Other",
  )
  const other = await read("section-10")
  assert.ok(other.current === "Section 10" && other.shown, JSON.stringify(other))
  await page.close()
})

test("Full width: the page uses the whole window", async () => {
  const page = await open("notes/long.md")
  const width = () => page.$eval(".markdown-body", (e) => e.getBoundingClientRect().width)

  await page.click('button[title="Show or hide the file tree"]')
  await page.click('button[title="Show or hide the outline"]')
  const narrow = await width()
  await page.click('button[title="Full width"]')
  const wide = await width()

  assert.equal(narrow, 980)
  assert.ok(wide > 1300, String(wide))
  await page.click('button[title="Full width"]')
  await page.click('button[title="Show or hide the file tree"]')
  await page.click('button[title="Show or hide the outline"]')
  await page.close()
})

test("Toolbar: every button spans the same rows as the path, on pages, diagrams and listings", async () => {
  for (const urlPath of ["notes/guide.md", "notes/flow.mmd", "notes/"]) {
    const page = await context.newPage()
    await page.goto(`${base}/${urlPath}`)
    await page.waitForSelector(".markdown-body > *")
    const rows = await page.$$eval(".breadcrumbs, .bar .icon-button:not([hidden])", (elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect()
        return `${box.top}-${box.bottom}`
      }),
    )

    assert.ok(rows.length > 5, urlPath)
    assert.deepEqual(new Set(rows), new Set([rows[0]]), `${urlPath}: ${rows.join(", ")}`)
    await page.close()
  }
})

test("Per-tab preferences: a tab keeps its own, a tab opened from a link takes its opener's, others the last choice", async () => {
  const LINK = '.tree a[href="/notes/other.md"]'
  const state = (page: Page) =>
    page.evaluate(() => {
      const root = document.documentElement
      return {
        theme: root.dataset.theme,
        fullWidth: root.classList.contains("full-width"),
        tree: !root.classList.contains("no-tree"),
        outline: !root.classList.contains("no-outline"),
      }
    })
  // Playwright can miss a popup's first navigation and then wait on it for good, so the page itself is asked.
  const opened = async (action: () => Promise<unknown>) => {
    const [page] = await Promise.all([context.waitForEvent("page"), action()])
    await waitFor(() =>
      page.evaluate(() => Boolean(document.querySelector(".markdown-body > *"))).catch(() => false),
    )
    return page
  }
  const typed = async (urlPath: string) => {
    const page = await context.newPage()
    await page.goto(`${base}/${urlPath}`)
    await page.waitForSelector(".markdown-body > *")
    return page
  }
  const X = { theme: "dark", fullWidth: true, tree: true, outline: false }
  const Y = { theme: "light", fullWidth: false, tree: false, outline: true }

  const opener = await typed("notes/guide.md")
  await opener.evaluate(() => {
    sessionStorage.clear()
    localStorage.setItem(
      "folio.lastPrefs",
      JSON.stringify({ theme: "light", fullWidth: false, tree: true, outline: true }),
    )
  })
  await opener.reload()
  await opener.waitForSelector(LINK)
  await opener.waitForSelector(".markdown-body > *")
  await sourced(opener)

  for (const title of ["Switch theme", "Full width", "Show or hide the outline"]) {
    await opener.click(`button[title="${title}"]`)
  }

  assert.deepEqual(await state(opener), X)

  const elsewhere = await typed("notes/long.md")
  assert.deepEqual(await state(elsewhere), X, "a typed address starts from the last choice")

  for (const title of [
    "Switch theme",
    "Full width",
    "Show or hide the outline",
    "Show or hide the file tree",
  ]) {
    await elsewhere.click(`button[title="${title}"]`)
  }

  assert.deepEqual(await state(elsewhere), Y)
  assert.deepEqual(await state(opener), X, "another tab's choice reached an open tab")
  await opener.reload()
  await opener.waitForSelector(LINK)
  await opener.waitForSelector(".markdown-body > *")
  await sourced(opener)
  assert.deepEqual(await state(opener), X, "a reload lost the tab's own choice")

  const ways: [string, () => Promise<Page>][] = [
    ["ctrl-click", () => opened(() => opener.click(LINK, { modifiers: ["ControlOrMeta"] }))],
    ["middle-click", () => opened(() => opener.click(LINK, { button: "middle" }))],
    ["shift-click", () => opened(() => opener.click(LINK, { modifiers: ["Shift"] }))],
    [
      "context menu",
      async () => {
        await opener.click(LINK, { button: "right" })
        await opener.keyboard.press("Escape")
        return typed("notes/other.md")
      },
    ],
  ]

  for (const [way, open] of ways) {
    const page = await open()
    assert.deepEqual(await state(page), X, way)
    await page.close()
  }

  const fresh = await typed("notes/other.md")
  assert.deepEqual(await state(fresh), Y, "an address opened without a link takes the last choice")

  await opener.click(LINK, { button: "right" })
  await opener.evaluate(() => {
    const handoff = JSON.parse(localStorage.getItem("folio.handoff") ?? "{}")
    localStorage.setItem(
      "folio.handoff",
      JSON.stringify({ ...handoff, time: handoff.time - 60_000 }),
    )
  })
  const late = await typed("notes/other.md")
  assert.deepEqual(await state(late), Y, "a stale handoff was taken")

  await opener.evaluate(() => localStorage.removeItem("folio.handoff"))
  await opener.click(LINK)
  await opener.waitForURL(`${base}/notes/other.md`)
  await opener.waitForSelector(".markdown-body > *")
  assert.deepEqual(await state(opener), X, "following a link lost the tab's own choice")
  assert.equal(await opener.evaluate(() => localStorage.getItem("folio.handoff")), null)

  await opener.evaluate(() =>
    localStorage.setItem(
      "folio.lastPrefs",
      JSON.stringify({ theme: "light", fullWidth: false, tree: true, outline: true }),
    ),
  )
  await Promise.all([opener.close(), elsewhere.close(), fresh.close(), late.close()])
})

const STARTING = { fullWidth: false, tree: true, outline: true }

function layoutOf(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement
    const pressed = (title: string) =>
      document.querySelector(`button[title="${title}"]`)?.getAttribute("aria-pressed") === "true"

    return {
      fullWidth: root.classList.contains("full-width"),
      tree: !root.classList.contains("no-tree"),
      outline: !root.classList.contains("no-outline"),
      buttons: [
        pressed("Full width"),
        pressed("Show or hide the file tree"),
        pressed("Show or hide the outline"),
      ],
      selected: getSelection()?.toString() ?? "",
    }
  })
}

function shown(layout: typeof STARTING) {
  return {
    ...layout,
    buttons: [layout.fullWidth, layout.tree, layout.outline],
    selected: "",
  }
}

/** The spacer has no height of its own, so the double-click lands on the toolbar beside it. */
async function stretch(page: Page): Promise<void> {
  const { x, y } = await page.evaluate(() => {
    const spacer = (document.querySelector(".bar .spacer") as Element).getBoundingClientRect()
    const bar = (document.querySelector(".bar") as Element).getBoundingClientRect()
    return { x: spacer.left + spacer.width / 2, y: bar.top + bar.height / 2 }
  })
  await page.mouse.dblclick(x, y)
}

async function freshTab(urlPath: string, ready = ".markdown-body > *"): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${base}/${urlPath}`)
  await page.evaluate((layout) => {
    sessionStorage.clear()
    localStorage.setItem("folio.lastPrefs", JSON.stringify({ theme: "light", ...layout }))
  }, STARTING)
  await page.reload()
  await page.waitForSelector(ready)
  await page.waitForTimeout(300)
  return page
}

test("Maximize, Restore, Buttons and links, Same as the buttons, Changed while maximized, Maximized by hand: a double-click on the toolbar gives the page the whole window", async () => {
  const page = await freshTab("notes/guide.md")
  const WHOLE = shown({ fullWidth: true, tree: false, outline: false })
  const gap = await page.evaluate(() => {
    const left = (
      document.querySelector('button[title="Show or hide the file tree"]') as Element
    ).getBoundingClientRect()
    const right = (
      document.querySelector('button[title^="Previous page"]') as Element
    ).getBoundingClientRect()
    return { x: (left.right + right.left) / 2, y: (left.top + left.bottom) / 2 }
  })

  assert.deepEqual(await layoutOf(page), shown(STARTING))

  for (const [where, act] of [
    ["the empty stretch", () => stretch(page)],
    ["a gap between buttons", () => page.mouse.dblclick(gap.x, gap.y)],
    ["a separator", () => page.dblclick(".breadcrumbs .separator >> nth=0")],
    ["the page's name", () => page.dblclick(".breadcrumbs > span:last-child")],
  ] as const) {
    await act()
    assert.deepEqual(await layoutOf(page), WHOLE, `maximized from ${where}`)
    await act()
    assert.deepEqual(await layoutOf(page), shown(STARTING), `restored from ${where}`)
  }

  await page.dblclick('button[title="Full width"]')
  assert.deepEqual(await layoutOf(page), shown(STARTING), "a double-clicked button clicks twice")

  await page.click('button[title="Show or hide the outline"]')
  await stretch(page)
  assert.deepEqual(await layoutOf(page), WHOLE)
  await page.keyboard.press("Alt+ArrowLeft")
  await page.waitForTimeout(100)
  assert.deepEqual(await layoutOf(page), shown({ fullWidth: true, tree: true, outline: false }))
  await stretch(page)
  assert.deepEqual(await layoutOf(page), WHOLE, "changed while maximized: maximized again")
  await stretch(page)
  assert.deepEqual(
    await layoutOf(page),
    shown({ fullWidth: true, tree: true, outline: false }),
    "the layout the second maximize replaced comes back",
  )

  await page.click('button[title="Show or hide the file tree"]')
  assert.deepEqual(await layoutOf(page), WHOLE, "maximized by hand")
  await stretch(page)
  assert.deepEqual(
    await layoutOf(page),
    shown(STARTING),
    "a layout maximized by hand restores the start",
  )

  await page.click('button[title="Show or hide the outline"]')
  await stretch(page)
  await page.keyboard.press("Alt+ArrowLeft")
  await page.keyboard.press("Alt+ArrowLeft")
  await page.waitForTimeout(100)
  assert.deepEqual(await layoutOf(page), WHOLE)
  await stretch(page)
  assert.deepEqual(
    await layoutOf(page),
    shown(STARTING),
    "a change by hand while maximized forgets the layout it replaced",
  )

  const crumb = await page.$eval(".breadcrumbs a >> nth=-1", (link) => {
    const box = link.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
  await page.mouse.move(crumb.x, crumb.y)
  await page.mouse.down({ clickCount: 1 })
  await page.mouse.up({ clickCount: 1 })
  await page.waitForURL(`${base}/notes/`)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
  await page.waitForSelector(".listing li")
  await page.waitForTimeout(100)
  const { selected: _, ...after } = await layoutOf(page)
  const { selected: __, ...before } = shown(STARTING)
  assert.deepEqual(
    after,
    before,
    "a link double-clicked as a person does is followed, not maximized",
  )
  await page.close()
})

test("Reload, New tab, Every page: the layout a double-click replaced stays with the tab", async () => {
  const LAYOUT = { fullWidth: false, tree: true, outline: false }
  const WHOLE = shown({ fullWidth: true, tree: false, outline: false })
  const opener = await freshTab("notes/guide.md")
  await sourced(opener)

  await opener.click('button[title="Show or hide the outline"]')
  await stretch(opener)
  await opener.reload()
  await opener.waitForSelector(".markdown-body > *")
  assert.deepEqual(await layoutOf(opener), WHOLE, "a reload keeps the page maximized")
  await stretch(opener)
  assert.deepEqual(await layoutOf(opener), shown(LAYOUT), "and the layout from before it")

  await stretch(opener)
  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    opener.click('.markdown-body a[href="other.md"]', { modifiers: ["ControlOrMeta"] }),
  ])
  await waitFor(() =>
    opened.evaluate(() => Boolean(document.querySelector(".markdown-body > *"))).catch(() => false),
  )
  assert.deepEqual(await layoutOf(opened), WHOLE, "a tab opened from a link opens maximized")
  await stretch(opened)
  assert.deepEqual(await layoutOf(opened), shown(LAYOUT), "and restores the opener's layout")
  await Promise.all([opener.close(), opened.close()])

  for (const [address, ready] of [
    ["notes/", ".listing li"],
    ["data/table.csv", ".markdown-body > h1"],
    ["?health", ".markdown-body > *"],
    ["?catch-up", ".markdown-body > *"],
    ["notes/guide.md?history", ".markdown-body > *"],
  ]) {
    const page = await freshTab(address, ready)

    await stretch(page)
    assert.deepEqual(await layoutOf(page), WHOLE, `maximized on ${address}`)
    await stretch(page)
    assert.deepEqual(await layoutOf(page), shown(STARTING), `restored on ${address}`)
    await page.close()
  }
})

test("Directory: a folder's address lists it with breadcrumbs", async () => {
  const page = await context.newPage()
  await page.goto(`${base}/notes/`)
  await page.waitForSelector(".listing li")

  assert.deepEqual(await page.$$eval(".listing li a", (links) => links.map((a) => a.textContent)), [
    "parts/",
    "flow.mmd",
    "folds.md",
    "guide.md",
    "long.md",
    "other.md",
  ])
  assert.deepEqual(
    await page.$$eval(".breadcrumbs > :not(.separator)", (crumbs) =>
      crumbs.map((c) => c.textContent),
    ),
    [path.basename(root), "notes"],
  )
  await page.close()
})

test("File tree and Tree content: loads folders as expanded, never showing dot-folders or node_modules", async () => {
  const page = await open("notes/guide.md")
  const top = await page.$$eval(".tree > ul > li", (items) =>
    items.map((i) => (i as HTMLElement).dataset.path),
  )

  assert.deepEqual(top, ["deep", "media", "notes"])
  assert.equal(await page.$eval(".tree .current", (e) => e.textContent), "guide.md")
  assert.equal(await page.locator('.tree li[data-path="deep/a"]').count(), 0)
  await page.click('.tree li[data-path="deep"] > .tree-row')
  await page.waitForSelector('.tree li[data-path="deep/a"]')
  await page.close()
})

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function translationOf(transform: string): number[] {
  return (/translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform) ?? []).slice(1, 3).map(Number)
}

function shownIn(page: Page) {
  return page.evaluate(() => {
    const port = (document.querySelector(".viewer-viewport") as Element).getBoundingClientRect()
    const shown = document.querySelector(".viewer-inner > *") as HTMLImageElement | SVGSVGElement
    const box = shown.getBoundingClientRect()

    return {
      own:
        shown instanceof HTMLImageElement
          ? { width: shown.naturalWidth, height: shown.naturalHeight }
          : { width: shown.viewBox.baseVal.width, height: shown.viewBox.baseVal.height },
      port: { width: port.width, height: port.height },
      box: { width: Math.round(box.width), height: Math.round(box.height) },
      filled: Math.abs(box.width - port.width) < 1 || Math.abs(box.height - port.height) < 1,
    }
  })
}

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const framing = Buffer.alloc(8)
    framing.writeUInt32BE(data.length, 0)
    framing.writeUInt32BE(zlib.crc32(body), 4)
    return Buffer.concat([framing.subarray(0, 4), body, framing.subarray(4)])
  }
  const header = Buffer.alloc(13)
  const row = Buffer.alloc(1 + width * 3, 0x80)

  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  row[0] = 0
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

test("Hyphens and dashes, A word too wide, Every page, Copy and find: a line breaks at a space, and a word at its hyphen only when it cannot fit whole", async () => {
  const sentence =
    "The well-known e-mail from 2026-11-05 cites PO-4471 and ISO-8601 times over 2020\u20132026, re-read by a co-worker in a follow-up note to the long-standing list"
  write({
    "hyphens/text.md": [
      "# Well-known e-mail rules for PO-4471 and ISO-8601",
      "",
      "## The cross-district-boundary-checks list",
      "",
      `${sentence} ${sentence}`,
      "",
      `- ${sentence}`,
      "",
      "| Ticket | Date | Why |",
      "|---|---|---|",
      `| PO-4471 | 2026-11-05 | ${sentence} |`,
      "",
      "| Narrow |",
      "|---|",
      `| ${"a-long-word-wider-than-any-column-could-be-".repeat(4)}end |`,
      "",
      "{table: rows.csv}",
      "",
      "{table: links.csv}",
      "",
      "The note **PO-4471**, then ([PO-4471](rows.csv)) and `2026-11-05`, an e-mail[^1] and (*re-read*) by a co-worker in a follow-up to the long-standing list, then the well-known `2020\u20132026` range.",
      "",
      `The path ${"docs/notes_on_the_long_standing_list_of_co_workers_and_their_follow_ups".repeat(2)}-end.md stays on the page.`,
      "",
      "[^1]: A footnote.",
    ].join("\n"),
    "hyphens/rows.csv": `id,date,text,link\nPO-4471,2026-11-05,"${sentence}",https://example.com/items/0f8e2c1a-5b7d-4c3e-9a1f-2d6b8e4c7a90-with-every-revision-joined-on\n`,
    "hyphens/PO-4471 notes.md": "# Notes\n",
    "hyphens/links.csv":
      "link\nhttps://example.com/items/0f8e2c1a-5b7d-4c3e-9a1f-2d6b8e4c7a90-with-every-revision-joined-on\n",
    "hyphens/front.md": `---\nnote: ${sentence}\n---\n# Front\n\nBelow the frontmatter.\n`,
    "hyphens/record.json": JSON.stringify({ note: sentence, detail: { why: sentence } }),
  })
  const page = await open("hyphens/text.md")
  await page.waitForSelector(".markdown-body .embed table")
  const hyphenEnds = (selector: string, on = page) =>
    on.evaluate((within) => {
      const found: { word: string; fits: boolean }[] = []
      const range = document.createRange()
      const dash = /[-\u2010-\u2015]/
      const fits = (whole: Element | null) => {
        let block = whole?.parentElement ?? null

        while (block && ["inline", "contents"].includes(getComputedStyle(block).display)) {
          block = block.parentElement
        }

        if (!whole || !block) {
          return true
        }

        const copy = whole.cloneNode(true) as HTMLElement
        copy.style.cssText = "position: absolute; visibility: hidden; white-space: nowrap"
        whole.parentElement?.append(copy)
        const width = copy.getBoundingClientRect().width
        copy.remove()
        const style = getComputedStyle(block)
        return (
          width <=
          block.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight)
        )
      }

      for (const root of document.querySelectorAll(within)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const boxes: { character: string; top: number; whole: Element | null }[] = []

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node as Text

          for (let at = 0; at < text.data.length; at++) {
            range.setStart(text, at)
            range.setEnd(text, at + 1)
            const box = range.getClientRects()[0]

            if (box && box.width > 0) {
              const whole = text.parentElement?.closest(".whole") ?? null
              boxes.push({ character: text.data[at], top: box.top, whole })
            }
          }
        }

        for (const [at, box] of boxes.entries()) {
          const next = boxes[at + 1]

          if (
            next &&
            dash.test(box.character) &&
            /\S/.test(next.character) &&
            next.top > box.top + 2
          ) {
            found.push({ word: box.whole?.textContent ?? box.character, fits: fits(box.whole) })
          }
        }
      }

      return found
    }, selector)
  const edgeBreaks = () =>
    page.evaluate(() => {
      const found: string[] = []
      const range = document.createRange()
      const top = (node: Node, at: number) => {
        range.setStart(node, at)
        range.setEnd(node, at + 1)
        return range.getClientRects()[0]?.top
      }

      for (const whole of document.querySelectorAll(".markdown-body p .whole:not(.split)")) {
        const text = whole.firstChild as Text
        const walker = document.createTreeWalker(
          whole.closest("p") as Element,
          NodeFilter.SHOW_TEXT,
        )
        const texts: Text[] = []

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          texts.push(node as Text)
        }

        const at = texts.indexOf(text)
        const before = texts[at - 1]
        const after = texts[at + 1]

        if (before?.data && /\S$/.test(before.data)) {
          if (Math.abs((top(before, before.data.length - 1) ?? 0) - (top(text, 0) ?? 0)) > 10) {
            found.push(`before ${text.data}`)
          }
        }

        if (after?.data && /^\S/.test(after.data)) {
          if (Math.abs((top(after, 0) ?? 0) - (top(text, text.data.length - 1) ?? 0)) > 10) {
            found.push(`after ${text.data}`)
          }
        }
      }

      return found
    })
  const scrollingForWords = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".markdown-body table")].map(
        (table) => table.scrollWidth > table.clientWidth + 1 && !table.classList.contains("loose"),
      ),
    )

  try {
    for (const width of [700, 900, 1100, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(150)
      const broken = await hyphenEnds(".markdown-body, .outline")
      assert.deepEqual(
        broken.filter(({ fits }) => fits),
        [],
        `${width} px`,
      )
      assert.deepEqual(await scrollingForWords(), [false, false, false, false], `${width} px`)
      assert.deepEqual(await edgeBreaks(), [], `${width} px`)
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `${width} px: the page scrolls sideways`,
      )
      assert.deepEqual(
        await page.evaluate(() =>
          [...document.querySelectorAll("aside, .markdown-body .data-cell")]
            .filter((box) => box.scrollWidth > box.clientWidth + 1)
            .map((box) => box.className),
        ),
        [],
        `${width} px: a panel or a cell holds a word it cannot show`,
      )
    }

    assert.ok(
      (await hyphenEnds(".markdown-body table:nth-of-type(2)")).length > 0,
      "the word too wide breaks",
    )

    const shown = await page.evaluate(() => {
      const paragraph = document.querySelector(".markdown-body p") as HTMLElement
      getSelection()?.selectAllChildren(paragraph)
      const copied = getSelection()?.toString() ?? ""
      getSelection()?.removeAllRanges()
      const find = (window as { find?: (text: string) => boolean }).find
      return {
        copied,
        found: find?.("PO-4471"),
        phrase: find?.("from 2026-11-05 cites PO-4471 and"),
      }
    })
    assert.ok(
      shown.copied.includes("cites PO-4471 and ISO-8601 times over 2020\u20132026,"),
      shown.copied,
    )
    assert.ok(shown.copied.includes("from 2026-11-05 cites"), shown.copied)
    assert.equal(shown.found, true)
    assert.equal(shown.phrase, true, "a phrase across words kept whole")
    assert.deepEqual(
      await page.evaluate(async () => {
        const added = document.createElement("div")
        added.innerHTML = `<pre class="history-text">A re-read line.</pre><pre>a re-read line</pre>`
        document.querySelector(".markdown-body")?.append(added)
        await new Promise((resolve) => setTimeout(resolve, 50))
        const held = [...added.querySelectorAll("pre")].map(
          (pre) => pre.querySelectorAll(".whole").length,
        )
        added.remove()
        return held
      }),
      [1, 0],
      "a pre of prose holds its words, code does not",
    )

    const listing = await context.newPage()

    try {
      await listing.goto(`${base}/hyphens/`)
      await listing.waitForSelector(".listing li")
      assert.deepEqual(
        await listing.evaluate(() => ({
          items: document.querySelectorAll(".listing a > .whole").length,
          found: (window as { find?: (text: string) => boolean }).find?.("PO-4471 notes.md"),
        })),
        { items: 0, found: true },
        "a name in a listing stays one item",
      )
    } finally {
      await listing.close()
    }

    for (const [urlPath, opening] of [
      ["hyphens/front.md", open],
      ["hyphens/record.json", openData],
    ] as const) {
      const other = await opening(urlPath)

      try {
        for (const width of [700, 1100]) {
          await other.setViewportSize({ width, height: 900 })
          await other.waitForTimeout(150)
          assert.deepEqual(
            (await hyphenEnds(".markdown-body", other)).filter(({ fits }) => fits),
            [],
            `${urlPath} at ${width} px`,
          )
        }
      } finally {
        await other.close()
      }
    }
  } finally {
    await page.close()
  }
})
