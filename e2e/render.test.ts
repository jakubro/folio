/** Headless Chromium run of folio's documented behaviour: rendering, includes, theme, faces and the toolbar. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  base,
  CLI,
  context,
  FILES,
  open,
  output,
  port,
  root,
  sourced,
  waitFor,
  write,
} from "./harness.ts";

test("Serve: prints its address and serves every renderable file by its relative path", async () => {
  assert.match(output, new RegExp(`folio serving ${escapeRegExp(root)} at ${escapeRegExp(base)}/`));

  for (const urlPath of ["notes/guide.md", "notes/flow.mmd", "media/logo.svg", "deep/a/b/c.md"]) {
    assert.equal((await fetch(`${base}/${urlPath}`)).status, 200, urlPath);
  }

  assert.equal((await fetch(`${base}/data/table.csv`)).status, 200);
  assert.equal((await fetch(`${base}/data/table.txt`)).status, 404);
});

test("Port taken: exits with an error naming the port", () => {
  const result = spawnSync(process.execPath, [CLI, root, "--port", String(port)], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), `Port ${port} is already in use.`);
});

test("Render: GFM, math, highlighting, sanitized HTML and mermaid", async () => {
  const page = await open("notes/guide.md");
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
  }));

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
  });
  await page.close();
});

test("Inline tags: underline, small print, citations and definitions render; outdated tags stay plain", async () => {
  const page = await open("notes/parts/inline.md");
  const look = (selector: string) =>
    page.$eval(`.markdown-body ${selector}`, (e) => {
      const style = getComputedStyle(e);
      return [style.textDecorationLine, style.fontStyle, style.fontSize];
    });
  const plain = await look("p");

  assert.equal((await look("u"))[0], "underline");
  assert.ok(Number.parseFloat((await look("small"))[2]) < Number.parseFloat(plain[2]));
  assert.equal((await look("cite"))[1], "italic");
  assert.equal((await look("dfn"))[1], "italic");
  assert.equal(await page.locator(".markdown-body :is(big, center, font)").count(), 0);
  assert.match(
    await page.$eval(".markdown-body", (e) => e.textContent ?? ""),
    /big red[\s\S]*centered/,
  );

  write({
    "notes/parts/inline.md": FILES["notes/parts/inline.md"].replace(
      "Marked later.",
      "Marked <u>later</u>.",
    ),
  });
  await page.waitForFunction(() => document.querySelectorAll(".markdown-body u").length === 2);
  await page.close();
});

test("Includes: replaced verbatim inside HTML, unresolved ones stay as written, marked", async () => {
  const page = await open("notes/guide.md");

  assert.equal(await page.$eval(".markdown-body td li", (li) => li.textContent), "cell item");
  assert.match(
    await page.$eval(".markdown-body", (e) => e.textContent ?? ""),
    /Missing: \[\{include: parts\/absent\.md\}\]/,
  );
  assert.equal(
    await page.$eval(".markdown-body .include-missing", (marker) => marker.textContent),
    "{include: parts/absent.md}",
  );
  await page.close();
});

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
  });
  const page = await open("notes/parts/inc/page.md");
  await page.waitForSelector(".mermaid svg");

  assert.equal(
    await page.$eval(".markdown-body p", (p) => p.textContent),
    "Inline PART and escaped {include: part.txt} and {include: part.txt}.",
  );
  assert.equal(
    await page.$eval(".markdown-body pre code", (code) => code.textContent),
    "PART\n{include: gone.txt}\n",
  );
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
  );
  assert.ok(
    await page.isVisible("#intro-include-gonemd"),
    "a heading holding one is named as written",
  );
  assert.match(
    (await page.textContent('.markdown-body > p:has-text("Icon")')) ?? "",
    /^Icon \uE000 then /,
  );
  assert.equal(await page.locator("pre.diagram-failed .include-missing").count(), 1);
  const raw = await (await context.request.get(`${base}/notes/parts/inc/page.md?raw`)).text();
  assert.match(raw, /^PART\n\{include: gone\.txt\}$/m);
  assert.doesNotMatch(raw.replace("\uE000 then", ""), /[\uE000-\uE01F]/);

  await page.goto(`${base}/notes/parts/inc/lost.mmd`);
  await page.waitForSelector("pre.diagram-failed .include-missing");
  assert.equal(await page.textContent(".include-missing"), "{include: nothing.mmd}");
  await page.close();
});

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
  });
  const page = await open("notes/parts/inc2/page.md");
  await page.waitForSelector(".embed-query >> nth=1 >> table");

  const markers = await page.$$eval(".markdown-body .include-missing", (found) =>
    found.map((marker) => [marker.textContent, marker.id, marker.checkVisibility()]),
  );
  assert.deepEqual(markers, [
    ["{include: gone-link.md}", "include-notes/parts/inc2/page.md:3:9", true],
    ["{include: gone.png}", "include-notes/parts/inc2/page.md:3:56", true],
    ["{include: one.md}", "include-notes/parts/inc2/page.md:5:4", true],
    ["{include: two.md}", "include-notes/parts/inc2/page.md:5:26", true],
    ["{include: gone-mark.txt}", "include-notes/parts/inc2/page.md:8:42", true],
    ["{include: gone-twice.md}", "include-notes/parts/inc2/twice.md:1:6", true],
    ["{include: gone-twice.md}", "include-notes/parts/inc2/twice.md:1:6~2", true],
  ]);
  assert.match(
    (await page.textContent(".markdown-body p")) ?? "",
    /^A link \{include: gone-link\.md\} and/,
  );
  assert.equal(await page.locator(".embed-chart .chart").count(), 0, "the chart is not drawn");
  assert.deepEqual(
    await page.$$eval(".embed-query table td", (cells) => cells.map((cell) => cell.textContent)),
    ["2", "{include: x}"],
  );
  await page.close();
});

test("Large page: a page of over 20,000 text nodes draws within a bound, with or without an include to mark", async () => {
  const items = Array.from({ length: 7000 }, (_, i) => `- item ${i} *of* note`).join("\n");
  write({
    "notes/parts/large.md": `# Large\n\n${items}\n`,
    "notes/parts/large-marked.md": `# Large\n\n${items}\n\nLast {include: gone-large.md}.\n`,
  });

  for (const name of ["large", "large-marked"]) {
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`${base}/notes/parts/${name}.md`);
    await page.waitForSelector(".markdown-body li:nth-child(7000)");
    const took = Date.now() - started;
    const nodes = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.querySelector(".markdown-body") as Node,
        NodeFilter.SHOW_TEXT,
      );
      let count = 0;

      while (walker.nextNode()) {
        count++;
      }

      return count;
    });

    assert.ok(nodes >= 20_000, `${name}: ${nodes} text nodes`);
    assert.ok(took < 6000, `${name}: drawn in ${took} ms`);
    assert.equal(await page.locator(".include-missing").count(), name === "large" ? 0 : 1);
    await page.close();
  }
});

test("Details: consecutive blocks sit 2px apart, the last keeps its gap to what follows", async () => {
  const page = await open("notes/folds.md");
  const gaps = await page.$$eval(".markdown-body > *", (blocks) =>
    blocks.slice(1).map((block, i) => {
      const above = (blocks[i] as Element).getBoundingClientRect().bottom;
      return Math.round(block.getBoundingClientRect().top - above);
    }),
  );

  assert.deepEqual(gaps, [2, 2, 8]);
  await page.close();
});

test("Theme: page, code and diagrams follow; the choice survives a reload and leaves other open tabs alone", async () => {
  const page = await open("notes/guide.md");
  const other = await open("notes/other.md");
  const look = () =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
      keyword: getComputedStyle(document.querySelector(".hljs-keyword") as Element).color,
      diagram: document.querySelector(".mermaid svg")?.innerHTML.length,
      node: getComputedStyle(document.querySelector(".mermaid .node rect") as Element).fill,
    }));
  const before = await look();

  await page.click('button[title="Switch theme"]');
  await page.waitForFunction((t) => document.documentElement.dataset.theme !== t, before.theme);
  await page.waitForSelector(".mermaid svg");
  const switched = await look();

  assert.notEqual(switched.background, before.background);
  assert.notEqual(switched.keyword, before.keyword);
  assert.notEqual(switched.diagram, before.diagram);
  assert.deepEqual([before.theme, before.node], ["light", "rgb(236, 236, 255)"]);
  assert.equal(switched.node, "rgb(45, 45, 48)");
  await other.waitForTimeout(300);
  assert.equal(await other.evaluate(() => document.documentElement.dataset.theme), before.theme);
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), switched.theme);
  await page.click('button[title="Switch theme"]');
  await Promise.all([page.close(), other.close()]);
});

test("Sharing, Paused, Digest, History, Pointer and keyboard: text buttons are drawn as the data switches, in either theme", async () => {
  write({ "notes/parts/buttons.md": "# Buttons\n\nText.\n" });
  const page = await open("notes/parts/buttons.md");
  const look = (selector: string) =>
    page.$eval(selector, (button) => {
      const style = getComputedStyle(button);
      return [
        `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
        style.borderRadius,
        style.backgroundColor,
        style.color,
        style.cursor,
        style.opacity,
      ].join(" / ");
    });
  const seen: Record<string, string> = {};

  for (const theme of ["light", "dark"]) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.click('button[title="Switch theme"]');
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
    }

    await page.goto(`${base}/`);
    await page.waitForSelector('.sharing-toggle[aria-pressed="false"]');
    seen[`${theme} sharing`] = await look(".sharing-toggle");
    await page.click(".sharing-toggle");
    await page.waitForSelector('.sharing-toggle[aria-pressed="true"]');
    seen[`${theme} paused`] = await look(".sharing-toggle");
    await page.click(".sharing-toggle");
    await page.waitForSelector('.sharing-toggle[aria-pressed="false"]');
    await page.goto(`${base}/?digest`);
    await page.waitForSelector(".digest-periods button");
    seen[`${theme} show`] = await look(".digest-periods button");
    await page.goto(`${base}/notes/parts/buttons.md?history`);
    await page.waitForSelector(".history-compare");
    seen[`${theme} compare`] = await look(".history-compare");
  }

  await page.click('button[title="Switch theme"]');
  await page.close();

  const light = "1px solid rgb(209, 217, 224) / 6px / rgba(0, 0, 0, 0) / rgb(31, 35, 40)";
  const dark = "1px solid rgb(54, 54, 54) / 6px / rgba(0, 0, 0, 0) / rgb(204, 204, 204)";
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
  });
});

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
  ].join("\n");
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
  });
  const page = await open("notes/parts/fills.md");
  const text = () =>
    page.evaluate(() => {
      const color = (selector: string) =>
        getComputedStyle(document.querySelector(`.markdown-body ${selector}`) as Element).color;
      return {
        theme: document.documentElement.dataset.theme,
        body: ["h1", "p", "strong", "td"].map(color),
        quote: color("blockquote"),
      };
    });
  const look = (scope: string) =>
    page.evaluate((within) => {
      const style = (selector: string) =>
        getComputedStyle(document.querySelector(`${within} ${selector}`) as Element);
      const node = (id: string) => `[id*="-flowchart-${id}-"]`;
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
      };
    }, scope);
  const shaded = () =>
    page.$$eval(".markdown-body .mermaid svg *", (elements) =>
      [...new Set(elements.map((element) => getComputedStyle(element).filter))].filter(
        (filter) => filter !== "none",
      ),
    );
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
  };
  const dark = {
    labels: { ...light.labels, plain: "rgb(204, 204, 204)" },
    fills: { ...light.fills, plain: "rgb(45, 45, 48)" },
    shadow: "none",
  };

  assert.deepEqual(await text(), {
    theme: "light",
    body: Array(4).fill("rgb(31, 35, 40)"),
    quote: "rgb(89, 99, 110)",
  });
  assert.deepEqual(await look(".markdown-body .mermaid"), light);
  await page.click('button[title="Switch theme"]');
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg');
  assert.deepEqual(await text(), {
    theme: "dark",
    body: Array(4).fill("rgb(204, 204, 204)"),
    quote: "rgb(154, 154, 154)",
  });
  assert.deepEqual(await look(".markdown-body .mermaid"), dark);
  assert.deepEqual(await shaded(), []);
  await page.hover(".mermaid");
  await page.click(".mermaid-expand");
  await page.waitForSelector(".mermaid-zoom.visible svg");
  assert.deepEqual(await look(".mermaid-zoom-inner"), dark);
  await page.keyboard.press("Escape");
  await page.goto(`${base}/notes/flow.mmd`);
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg');
  assert.deepEqual(await shaded(), []);
  await page.goto(`${base}/notes/parts/fills.mmd`);
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg');
  assert.deepEqual(await look(".markdown-body .mermaid"), dark);
  await page.click('button[title="Switch theme"]');
  await page.waitForSelector('.markdown-body[data-theme="light"] .mermaid svg');
  assert.deepEqual(await look(".markdown-body .mermaid"), light);
  await page.close();
});

test("Labels on fills: rows, notes, text labels, faint, sketched and brace fills, code and any colour notation read on what lies under them; a label already readable keeps its colour", async () => {
  const fence = (lines: string[]) => ["```mermaid", ...lines, "```", ""].join("\n");
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
  });
  const page = await open("notes/parts/kinds.md");
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
    }));

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
  });
  await page.click('button[title="Switch theme"]');
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid svg');
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.mermaid [class^="row-rect"]')].map(
        (row) => getComputedStyle(row.querySelector("path") as Element).fill,
      ),
    ),
    ["rgb(44, 45, 45)", "rgb(240, 213, 232)"],
  );
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
  });
  await page.hover(".mermaid >> nth=4");
  await page.click(".mermaid >> nth=4 >> .mermaid-expand");
  await page.waitForSelector(".mermaid-zoom.visible svg");
  assert.deepEqual(
    await page.$eval(".mermaid-zoom-inner code", (code) => [
      getComputedStyle(code).color,
      getComputedStyle(code).backgroundColor,
    ]),
    ["rgb(204, 204, 204)", "rgb(36, 36, 36)"],
  );
  await page.keyboard.press("Escape");
  await page.click('button[title="Switch theme"]');
  await page.close();
});

test("Mermaid: a diagram expands to the window, zooms at the pointer and pans by drag", async () => {
  const page = await open("notes/guide.md");
  const transform = () =>
    page.$eval(".mermaid-zoom-inner", (e) => (e as HTMLElement).style.transform);

  await page.click(".mermaid svg[aria-roledescription]");
  assert.equal(await page.locator(".mermaid-zoom.visible").count(), 0);
  await page.hover(".mermaid");
  await page.click(".mermaid-expand");
  await page.waitForSelector(".mermaid-zoom.visible svg");
  const fitted = await transform();
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(
    (t) => (document.querySelector(".mermaid-zoom-inner") as HTMLElement).style.transform !== t,
    fitted,
  );
  const zoomed = await transform();
  await page.mouse.down();
  await page.mouse.move(800, 450, { steps: 5 });
  await page.mouse.up();
  const panned = await transform();

  assert.match(zoomed, /scale\(1\.25\)/);
  assert.notEqual(panned, zoomed);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".mermaid-zoom.visible").count(), 0);
  await page.goto(`${base}/notes/flow.mmd`);
  await page.waitForSelector(".mermaid svg[aria-roledescription]");
  await page.close();
});

test("Text face, Code face, No merged operators, Offline, Diagram face: folio draws in the faces it carries", async () => {
  const outside: string[] = [];
  const page = await context.newPage();
  page.on("request", (request) => {
    if (!request.url().startsWith(base) && !request.url().startsWith("data:")) {
      outside.push(request.url());
    }
  });
  await page.goto(`${base}/notes/guide.md`);
  await page.waitForSelector(".markdown-body > *");
  const cdp = await page.context().newCDPSession(page);
  const faces = async (selector: string) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((font) => font.familyName);
  };
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");

  assert.deepEqual(await faces(".markdown-body td"), ["Arimo"]);
  assert.deepEqual(await faces(".markdown-body strong"), ["Arimo"]);
  assert.deepEqual(await faces(".markdown-body h1"), ["Arimo SemiBold"]);
  assert.deepEqual(await faces(".markdown-body p code"), ["JetBrains Mono"]);
  assert.deepEqual(await faces(".markdown-body pre code"), ["JetBrains Mono"]);
  assert.match(
    await page.$eval(".markdown-body pre", (pre) => getComputedStyle(pre).fontFamily),
    /^"JetBrains Mono"/,
  );
  assert.deepEqual(await faces(".mermaid .nodeLabel"), ["Arimo"]);
  assert.deepEqual(
    await page.$$eval(".markdown-body code", (codes) => [
      ...new Set(codes.map((code) => getComputedStyle(code).fontVariantLigatures)),
    ]),
    ["no-contextual"],
  );
  await page.click('button[title="Switch theme"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForSelector('.markdown-body[data-theme="dark"] .mermaid .nodeLabel');
  assert.deepEqual(await faces(".mermaid .nodeLabel"), ["Arimo"]);
  assert.deepEqual(outside, []);
  await page.click('button[title="Switch theme"]');
  await page.close();
});

test("Outline: lists the headings and highlights the section being read", async () => {
  const page = await open("notes/long.md");

  assert.equal(await page.$$eval(".outline a", (links) => links.length), 9);
  await page.evaluate(() => document.getElementById("part-5")?.scrollIntoView());
  await page.waitForFunction(
    () => document.querySelector(".outline a.current")?.textContent === "Part 5",
  );
  await page.close();
});

test("Full width: the page uses the whole window", async () => {
  const page = await open("notes/long.md");
  const width = () => page.$eval(".markdown-body", (e) => e.getBoundingClientRect().width);

  await page.click('button[title="Show or hide the file tree"]');
  await page.click('button[title="Show or hide the outline"]');
  const narrow = await width();
  await page.click('button[title="Full width"]');
  const wide = await width();

  assert.equal(narrow, 980);
  assert.ok(wide > 1300, String(wide));
  await page.click('button[title="Full width"]');
  await page.click('button[title="Show or hide the file tree"]');
  await page.click('button[title="Show or hide the outline"]');
  await page.close();
});

test("Toolbar: every button spans the same rows as the path, on pages, diagrams and listings", async () => {
  for (const urlPath of ["notes/guide.md", "notes/flow.mmd", "notes/"]) {
    const page = await context.newPage();
    await page.goto(`${base}/${urlPath}`);
    await page.waitForSelector(".markdown-body > *");
    const rows = await page.$$eval(".breadcrumbs, .bar .icon-button", (elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return `${box.top}-${box.bottom}`;
      }),
    );

    assert.ok(rows.length > 5, urlPath);
    assert.deepEqual(new Set(rows), new Set([rows[0]]), `${urlPath}: ${rows.join(", ")}`);
    await page.close();
  }
});

test("Per-tab preferences: a tab keeps its own, a tab opened from a link takes its opener's, others the last choice", async () => {
  const LINK = '.tree a[href="/notes/other.md"]';
  const state = (page: Page) =>
    page.evaluate(() => {
      const root = document.documentElement;
      return {
        theme: root.dataset.theme,
        fullWidth: root.classList.contains("full-width"),
        tree: !root.classList.contains("no-tree"),
        outline: !root.classList.contains("no-outline"),
      };
    });
  // Playwright can miss a popup's first navigation and then wait on it for good, so the page itself is asked.
  const opened = async (action: () => Promise<unknown>) => {
    const [page] = await Promise.all([context.waitForEvent("page"), action()]);
    await waitFor(() =>
      page.evaluate(() => Boolean(document.querySelector(".markdown-body > *"))).catch(() => false),
    );
    return page;
  };
  const typed = async (urlPath: string) => {
    const page = await context.newPage();
    await page.goto(`${base}/${urlPath}`);
    await page.waitForSelector(".markdown-body > *");
    return page;
  };
  const X = { theme: "dark", fullWidth: true, tree: true, outline: false };
  const Y = { theme: "light", fullWidth: false, tree: false, outline: true };

  const opener = await typed("notes/guide.md");
  await opener.evaluate(() => {
    sessionStorage.clear();
    localStorage.setItem(
      "folio.lastPrefs",
      JSON.stringify({ theme: "light", fullWidth: false, tree: true, outline: true }),
    );
  });
  await opener.reload();
  await opener.waitForSelector(LINK);
  await opener.waitForSelector(".markdown-body > *");
  await sourced(opener);

  for (const title of ["Switch theme", "Full width", "Show or hide the outline"]) {
    await opener.click(`button[title="${title}"]`);
  }

  assert.deepEqual(await state(opener), X);

  const elsewhere = await typed("notes/long.md");
  assert.deepEqual(await state(elsewhere), X, "a typed address starts from the last choice");

  for (const title of [
    "Switch theme",
    "Full width",
    "Show or hide the outline",
    "Show or hide the file tree",
  ]) {
    await elsewhere.click(`button[title="${title}"]`);
  }

  assert.deepEqual(await state(elsewhere), Y);
  assert.deepEqual(await state(opener), X, "another tab's choice reached an open tab");
  await opener.reload();
  await opener.waitForSelector(LINK);
  await opener.waitForSelector(".markdown-body > *");
  await sourced(opener);
  assert.deepEqual(await state(opener), X, "a reload lost the tab's own choice");

  const ways: [string, () => Promise<Page>][] = [
    ["ctrl-click", () => opened(() => opener.click(LINK, { modifiers: ["ControlOrMeta"] }))],
    ["middle-click", () => opened(() => opener.click(LINK, { button: "middle" }))],
    ["shift-click", () => opened(() => opener.click(LINK, { modifiers: ["Shift"] }))],
    [
      "context menu",
      async () => {
        await opener.click(LINK, { button: "right" });
        await opener.keyboard.press("Escape");
        return typed("notes/other.md");
      },
    ],
  ];

  for (const [way, open] of ways) {
    const page = await open();
    assert.deepEqual(await state(page), X, way);
    await page.close();
  }

  const fresh = await typed("notes/other.md");
  assert.deepEqual(await state(fresh), Y, "an address opened without a link takes the last choice");

  await opener.click(LINK, { button: "right" });
  await opener.evaluate(() => {
    const handoff = JSON.parse(localStorage.getItem("folio.handoff") ?? "{}");
    localStorage.setItem(
      "folio.handoff",
      JSON.stringify({ ...handoff, time: handoff.time - 60_000 }),
    );
  });
  const late = await typed("notes/other.md");
  assert.deepEqual(await state(late), Y, "a stale handoff was taken");

  await opener.evaluate(() => localStorage.removeItem("folio.handoff"));
  await opener.click(LINK);
  await opener.waitForURL(`${base}/notes/other.md`);
  await opener.waitForSelector(".markdown-body > *");
  assert.deepEqual(await state(opener), X, "following a link lost the tab's own choice");
  assert.equal(await opener.evaluate(() => localStorage.getItem("folio.handoff")), null);

  await opener.evaluate(() =>
    localStorage.setItem(
      "folio.lastPrefs",
      JSON.stringify({ theme: "light", fullWidth: false, tree: true, outline: true }),
    ),
  );
  await Promise.all([opener.close(), elsewhere.close(), fresh.close(), late.close()]);
});

test("Directory: a folder's address lists it with breadcrumbs", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/notes/`);
  await page.waitForSelector(".listing li");

  assert.deepEqual(await page.$$eval(".listing li a", (links) => links.map((a) => a.textContent)), [
    "parts/",
    "flow.mmd",
    "folds.md",
    "guide.md",
    "long.md",
    "other.md",
  ]);
  assert.deepEqual(
    await page.$$eval(".breadcrumbs > :not(.separator)", (crumbs) =>
      crumbs.map((c) => c.textContent),
    ),
    [path.basename(root), "notes"],
  );
  await page.close();
});

test("File tree and Tree content: loads folders as expanded, never showing dot-folders or node_modules", async () => {
  const page = await open("notes/guide.md");
  const top = await page.$$eval(".tree > ul > li", (items) =>
    items.map((i) => (i as HTMLElement).dataset.path),
  );

  assert.deepEqual(top, ["deep", "media", "notes"]);
  assert.equal(await page.$eval(".tree .current", (e) => e.textContent), "guide.md");
  assert.equal(await page.locator('.tree li[data-path="deep/a"]').count(), 0);
  await page.click('.tree li[data-path="deep"] > .tree-row');
  await page.waitForSelector('.tree li[data-path="deep/a"]');
  await page.close();
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
