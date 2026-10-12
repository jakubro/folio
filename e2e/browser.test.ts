// Headless Chromium run of every documented behaviour against a folio process serving a fixture folder.

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

const CLI = path.join(import.meta.dirname, "../dist/cli.js");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-")));
const FILES: Record<string, string> = {
  "notes/guide.md": [
    "# Guide",
    "",
    "Text with **bold**, `code`, <kbd>Ctrl</kbd> and <mark>marked</mark>.",
    '<script>window.xssProbe = 1</script><img src="nowhere.png" onerror="window.xssProbe = 2">',
    "",
    "| Name | Value |",
    "|---|---|",
    "| a | 1 |",
    "",
    "- [x] done",
    "- [ ] open",
    "",
    "Inline $e^{i\\pi}+1=0$ and display:",
    "",
    "$$\\int_0^1 x\\,dx$$",
    "",
    "```python",
    "def double(x):",
    "    return x * 2",
    "```",
    "",
    "```mermaid",
    "graph LR",
    "  A[Start] --> B{Choice}",
    "  B -->|yes| C[Done]",
    "```",
    "",
    "## Links",
    "",
    "[Sibling](other.md), [outside](https://example.com) and [here](#links).",
    "",
    "<table><tr><td>",
    "",
    "{include: parts/cell.md}",
    "",
    "</td></tr></table>",
    "",
    "Missing: [{include: parts/absent.md}]",
    "",
    "![logo](../media/logo.svg)",
  ].join("\n"),
  "notes/parts/cell.md": "- cell item",
  "notes/other.md": "# Other",
  "notes/folds.md": [
    "<details><summary>One</summary>a</details>",
    "<details><summary>Two</summary>b</details>",
    "<details><summary>Three</summary>c</details>",
    "",
    "After.",
  ].join("\n"),
  "notes/flow.mmd": "sequenceDiagram\n  A->>B: hi",
  "notes/long.md": `# Long\n\n${Array.from({ length: 8 }, (_, i) => `## Part ${i + 1}\n\n${"Words fill the section. ".repeat(160)}\n\n`).join("")}`,
  "media/logo.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>',
  "deep/a/b/c.md": "# C",
  "data/table.csv": "a,b",
  ".git/HEAD.md": "x",
  ".cache/x.md": "x",
  "node_modules/pkg/README.md": "x",
};

// Its own folder, so the first and last page of the whole tree stay put whatever other tests add.
const stepRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-steps-")));
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
};
const STEP_ORDER = [
  "guide/extra/more.md",
  "guide/intro.md",
  "guide/setup.md",
  "notes/todo.md",
  "flow.mmd",
  "index.md",
  "readme.md",
];

let server: ChildProcess;
let stepServer: ChildProcess;
let stepBase = "";
let port = 0;
let base = "";
let output = "";
let browser: Browser;
let context: BrowserContext;

before(async () => {
  write(FILES);
  port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, [CLI, root, "--port", String(port)]);
  server.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  await until(() => output.includes(base));
  writeIn(stepRoot, STEP_FILES);
  const stepPort = await freePort();
  let stepOutput = "";
  stepBase = `http://localhost:${stepPort}`;
  stepServer = spawn(process.execPath, [CLI, stepRoot, "--port", String(stepPort)]);
  stepServer.stdout?.on("data", (chunk) => {
    stepOutput += chunk;
  });
  await until(() => stepOutput.includes(stepBase));
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
});

after(async () => {
  await browser?.close();
  server?.kill();
  stepServer?.kill();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(stepRoot, { recursive: true, force: true });
});

test("Serve: prints its address and serves every renderable file by its relative path", async () => {
  assert.match(output, new RegExp(`folio serving ${escapeRegExp(root)} at ${escapeRegExp(base)}/`));

  for (const urlPath of ["notes/guide.md", "notes/flow.mmd", "media/logo.svg", "deep/a/b/c.md"]) {
    assert.equal((await fetch(`${base}/${urlPath}`)).status, 200, urlPath);
  }

  assert.equal((await fetch(`${base}/data/table.csv`)).status, 404);
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

test("Includes: replaced verbatim inside HTML, unresolved ones leave nothing", async () => {
  const page = await open("notes/guide.md");

  assert.equal(await page.$eval(".markdown-body td li", (li) => li.textContent), "cell item");
  assert.match(await page.$eval(".markdown-body", (e) => e.textContent ?? ""), /Missing: \[\]/);
  await page.close();
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
  await page.waitForSelector(".mermaid .nodeLabel");
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
  const opened = async (action: () => Promise<unknown>) => {
    const [page] = await Promise.all([context.waitForEvent("page"), action()]);
    await page.waitForSelector(".markdown-body > *");
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

test("Update on save, No update elsewhere: only the page's own files update it, in place", async () => {
  const page = await open("notes/guide.md");
  await page.evaluate(() => scrollTo(0, 400));
  const y = await page.evaluate(() => scrollY);

  await mark(page);
  write({ "notes/other.md": "# Other, saved" });
  await page.waitForTimeout(600);
  assert.ok(await marked(page), "an unrelated save re-rendered the page");

  write({ "notes/parts/cell.md": "- cell saved" });
  await page.waitForFunction(
    () => document.querySelector(".markdown-body td li")?.textContent === "cell saved",
  );
  assert.equal(await page.evaluate(() => scrollY), y);

  const temporary = path.join(root, "notes/.guide.md.swp");
  fs.writeFileSync(temporary, `${FILES["notes/guide.md"]}\n\nSaved by rename.`);
  fs.renameSync(temporary, path.join(root, "notes/guide.md"));
  await waitText(page, "Saved by rename.");

  const image = await page.$eval("img[alt=logo]", (i) => i.getAttribute("src"));
  write({ "media/logo.svg": FILES["media/logo.svg"].replace("<rect", '<rect fill="teal"') });
  await page.waitForFunction(
    (src) => document.querySelector("img[alt=logo]")?.getAttribute("src") !== src,
    image,
  );
  const updated = await page.$eval("img[alt=logo]", (i) => i.getAttribute("src"));
  write({ "notes/parts/cell.md": "- cell saved again" });
  await page.waitForFunction(
    () => document.querySelector(".markdown-body td li")?.textContent === "cell saved again",
  );
  assert.equal(await page.$eval("img[alt=logo]", (i) => i.getAttribute("src")), updated);
  await page.close();
});

test("Tree changes: added, renamed and removed files show in the tree and listings without reloading pages", async () => {
  const page = await open("notes/guide.md");
  const listing = await context.newPage();
  await listing.goto(`${base}/notes/`);
  await listing.waitForSelector(".listing li");
  await mark(page);

  write({ "notes/added.md": "# Added" });
  await page.waitForSelector('.tree li[data-path="notes/added.md"]');
  await listing.waitForFunction(() => document.body.innerText.includes("added.md"));
  fs.renameSync(path.join(root, "notes/added.md"), path.join(root, "notes/renamed.md"));
  await page.waitForSelector('.tree li[data-path="notes/renamed.md"]');
  fs.unlinkSync(path.join(root, "notes/renamed.md"));
  await page.waitForFunction(() => !document.querySelector('.tree li[data-path^="notes/renamed"]'));

  assert.ok(await marked(page), "a tree change re-rendered the page");
  await Promise.all([page.close(), listing.close()]);
});

test("Suspend: a suspended tab holds still until resumed, then catches up; other tabs update", async () => {
  const held = await open("notes/other.md");
  const live = await open("notes/other.md");

  await held.click('button[title="Suspend live updates in this tab"]');
  write({ "notes/other.md": "# Other\n\nwhile suspended" });
  await waitText(live, "while suspended");
  await held.waitForTimeout(400);
  assert.ok(!(await held.evaluate(() => document.body.innerText.includes("while suspended"))));

  await held.click('button[title="Resume live updates in this tab"]');
  await waitText(held, "while suspended");
  await Promise.all([held.close(), live.close()]);
});

test("Many tabs: pages keep loading with more tabs open than the browser's six connections per host", async () => {
  const tabs = [];

  for (let i = 0; i < 8; i++) {
    tabs.push(await open("notes/other.md"));
  }

  const page = await open("notes/guide.md");
  await page.click('.markdown-body a[href="other.md"]');
  await page.waitForURL(`${base}/notes/other.md`, { timeout: 5000 });
  await page.waitForSelector(".markdown-body h1", { timeout: 5000 });

  write({ "notes/other.md": "# Other\n\nwith many tabs" });
  await Promise.all([page, ...tabs].map((tab) => waitText(tab, "with many tabs")));
  await Promise.all([page, ...tabs].map((tab) => tab.close()));
});

test("Sleep: a tab whose connection went silent reconnects and still updates", async () => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const opened: number[] = [];
    (window as { opened?: number[] }).opened = opened;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        opened.push(Date.now());
      }
    };
  });
  await page.clock.install();
  await page.goto(`${base}/notes/other.md`);
  await page.waitForSelector(".markdown-body h1");
  await page.clock.runFor(70_000);
  await page.waitForFunction(() => ((window as { opened?: number[] }).opened ?? []).length >= 2);

  write({ "notes/other.md": "# Other\n\nafter sleep" });
  await page.clock.runFor(2_000);
  await waitText(page, "after sleep");
  await page.close();
});

test("Whole workspace: a large folder opens, browses and updates as quickly as a small one", async () => {
  const many: Record<string, string> = {};

  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < 50; j++) {
      many[`big/pkg-${i}/node_modules/dep-${j}/README.md`] = "x";
    }

    many[`big/pkg-${i}/src/module.ts`] = "x";
    many[`big/pkg-${i}/docs/readme.md`] = "# readme";
  }

  write(many);
  const page = await context.newPage();
  let started = Date.now();
  await page.goto(`${base}/big/pkg-7/docs/readme.md`);
  await page.waitForSelector(".tree .current");
  const opened = Date.now() - started;

  started = Date.now();
  await page.click('.tree li[data-path="big/pkg-8"] > .tree-row');
  await page.waitForSelector('.tree li[data-path="big/pkg-8/docs"]');
  const browsed = Date.now() - started;

  await page.waitForTimeout(300);
  started = Date.now();
  write({ "big/pkg-7/docs/readme.md": "# readme\n\nsaved" });
  await waitText(page, "saved");
  const updated = Date.now() - started;

  assert.ok(opened < 3000, `opened in ${opened} ms`);
  assert.ok(browsed < 1000, `expanded a folder in ${browsed} ms`);
  assert.ok(updated < 1000, `updated in ${updated} ms`);
  await page.close();
});

test("Open and Tree reveal: a page opens at its top, the tree showing its file within its own panel", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  const tree = await page.$eval(".tree", (panel) => {
    const box = panel.getBoundingClientRect();
    const row = (panel.querySelector(".current") as Element).getBoundingClientRect();
    return { scrolled: panel.scrollTop, inside: row.top >= box.top && row.bottom <= box.bottom };
  });

  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.ok(tree.scrolled > 0, "the tree did not scroll to its current file");
  assert.ok(tree.inside, "the current file is outside the tree panel");
  await page.close();
});

test("Heading: an address naming a heading opens with it just below the toolbar", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md#part-3");
  const gap = await page.evaluate(
    () =>
      (document.getElementById("part-3") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );

  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);
  await page.close();
});

test("Reload: a scrolled page returns to where it was read, an unscrolled one to its top", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");

  await page.evaluate(() => scrollTo(0, 1500));
  await page.waitForTimeout(400);
  await page.reload();
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 1500);

  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.reload();
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.close();
});

test("Back and forward: each page returns to where it was left, a followed link opens at its top", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");

  await page.evaluate(() => scrollTo(0, 1200));
  await page.waitForTimeout(400);
  // A pointer click would first scroll the link into view, moving the position being tested.
  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForURL(`${base}/shelf/page-58.md`);
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 0, "a followed link did not open at its top");

  await page.evaluate(() => scrollTo(0, 700));
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForURL(`${base}/shelf/page-59.md`);
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 1200, "back");

  await page.goForward();
  await page.waitForURL(`${base}/shelf/page-58.md`);
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 700, "forward");
  await page.close();
});

test("Reload and Back and forward: a position below images still loading is reached once they load", async () => {
  write({
    "tall/page.md": `# Tall\n\n![tall](tall.svg)\n\n${"Words after the image. ".repeat(400)}`,
    "tall/tall.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="3000"><rect width="400" height="3000"/></svg>',
  });
  const page = await settled("tall/page.md");
  await page.evaluate(() => scrollTo(0, 2800));
  await page.waitForTimeout(400);
  await page.route("**/tall/tall.svg*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });

  for (const time of ["first", "second"]) {
    await page.reload();
    await landed(page);
    await page.waitForFunction(
      () => (document.querySelector("img[alt=tall]") as HTMLImageElement).complete,
    );
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY), 2800, `${time} reload`);
  }

  await page.unroute("**/tall/tall.svg*");
  await page.close();
});

test("Back and forward: a place the page can no longer reach does not pull it back later", async () => {
  const long = (words: number) =>
    `# X\n\n[y](y.md)\n\n${"Words of a page that changes length. ".repeat(words)}`;
  write({ "short/x.md": long(1200), "short/y.md": "# Y" });
  const page = await settled("short/x.md");

  await page.evaluate(() => scrollTo(0, 2000));
  await page.waitForTimeout(400);
  await page.$eval('.markdown-body a[href="y.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Y",
  );
  write({ "short/x.md": long(300) });
  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "X",
  );
  await page.waitForTimeout(300);
  const landed = await page.evaluate(() => scrollY);

  assert.ok(landed < 2000, `the shorter page still reached ${landed}`);
  write({ "short/x.md": `${long(300)}\n\nappended ${"Words appended at the end. ".repeat(1500)}` });
  await waitText(page, "appended");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), landed);
  await page.close();
});

test("Back and forward: a heading followed right after scrolling returns to where the scroll ended", async () => {
  const page = await settled("notes/long.md");

  await page.evaluate(() => scrollTo(0, 2000));
  await page.$eval('.outline a[href="#part-7"]', (link) => (link as HTMLElement).click());
  await page.waitForURL(`${base}/notes/long.md#part-7`);
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForURL(`${base}/notes/long.md`);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), 2000);
  await page.close();
});

test("Follow a link and Frame follows: content, tree, listing and breadcrumb links swap only the content", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  await keepFrame(page);

  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  assert.deepEqual(await frameOf(page), {
    kept: true,
    url: `${base}/shelf/page-58.md`,
    title: "page-58.md",
    crumbs: [path.basename(root), "shelf", "page-58.md"],
    current: "page-58.md",
    outline: "Page 58",
  });

  await page.click('.tree a[href="/shelf/page-30.md"]');
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 30",
  );
  assert.equal((await frameOf(page)).current, "page-30.md");
  assert.ok((await frameOf(page)).kept, "a tree link reloaded the page");

  await page.click('.breadcrumbs a[href="/shelf/"]');
  await page.waitForSelector(".listing li");
  assert.equal(await page.$eval(".listing h1", (h) => h.textContent), "shelf");
  assert.equal(page.url(), `${base}/shelf/`);
  assert.equal(await page.title(), "shelf");

  await page.click('.listing a[href="/shelf/page-05.md"]');
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 5",
  );
  assert.ok((await frameOf(page)).kept, "a listing link reloaded the page");
  await page.close();
});

test("Folder and Heading on another page: a folder lists in place, a heading link lands on its heading", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  await keepFrame(page);

  await page.$eval('.markdown-body a[href="page-58.md#part-3"]', (link) =>
    (link as HTMLElement).click(),
  );
  await page.waitForURL(`${base}/shelf/page-58.md#part-3`);
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  const gap = await page.evaluate(
    () =>
      (document.getElementById("part-3") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );
  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);

  await page.$eval('.markdown-body a[href="./"]', (link) => (link as HTMLElement).click());
  await page.waitForSelector(".listing li");
  assert.equal(page.url(), `${base}/shelf/`);
  assert.ok((await frameOf(page)).kept, "a folder link reloaded the page");
  await page.close();
});

test("Landing: back and forward between followed links keep the frame and each page's place", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  await keepFrame(page);

  await page.evaluate(() => scrollTo(0, 900));
  await page.waitForTimeout(400);
  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.evaluate(() => scrollTo(0, 500));
  await page.waitForTimeout(400);

  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 59",
  );
  assert.equal(await page.evaluate(() => scrollY), 900);
  await page.goForward();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  assert.equal(await page.evaluate(() => scrollY), 500);
  assert.equal((await frameOf(page)).current, "page-58.md");
  assert.ok((await frameOf(page)).kept, "back or forward reloaded the page");
  await page.close();
});

test("External link and Missing page: an outside link opens a new tab, a missing page shows as opened directly", async () => {
  writeShelf();
  await context.route("https://example.com/**", (route) => route.fulfill({ body: "outside" }));
  const page = await open("notes/guide.md");

  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.click('.markdown-body a[href="https://example.com"]'),
  ]);
  assert.equal(page.url(), `${base}/notes/guide.md`);
  await popup.close();
  await context.unroute("https://example.com/**");

  const direct = await (await fetch(`${base}/shelf/absent.md`)).text();
  const shelf = await settled("shelf/page-59.md");
  await shelf.$eval('.markdown-body a[href="absent.md"]', (link) => (link as HTMLElement).click());
  await shelf.waitForURL(`${base}/shelf/absent.md`);
  await shelf.waitForLoadState();
  assert.equal(await shelf.evaluate(() => document.body.innerText.trim()), direct.trim());
  await Promise.all([page.close(), shelf.close()]);
});

test("Live updates: after following a link only the new page's saves update it; a suspended tab resumes", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");

  await page.click('button[title="Suspend live updates in this tab"]');
  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  await page.waitForSelector('button[title="Suspend live updates in this tab"]');
  await page.waitForTimeout(300);
  await mark(page);

  write({ "shelf/page-59.md": "# Page 59\n\nsaved while away" });
  await page.waitForTimeout(600);
  assert.ok(await marked(page), "a save of the previous page re-rendered the new one");

  write({ "shelf/page-58.md": "# Page 58\n\nsaved while shown" });
  await waitText(page, "saved while shown");
  await page.close();
});

test("Prepared ahead: resting the pointer on a page link fetches that page before the click", async () => {
  writeShelf();
  const page = await settled("shelf/page-40.md");
  const fetched = page.waitForRequest(`${base}/shelf/page-39.md?raw`, { timeout: 2000 });

  await page.hover('.markdown-body a[href="page-39.md"]');
  await fetched;
  await page.click('.markdown-body a[href="page-39.md"]');
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 39",
  );
  await page.close();
});

test("Prepared ahead: the page rendered while the pointer rested is the one shown, unless its file changed since", async () => {
  const diagram = (name: string) =>
    `# ${name}\n\n[next](b.md)\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n`;
  write({ "ahead/a.md": diagram("A"), "ahead/b.md": diagram("B") });
  const page = await settled("ahead/a.md");
  const id = (selector: string) =>
    page.$eval(selector, (svg) => Number(svg.id.replace("diagram-", "")));
  const shown = await id(".mermaid > svg");
  const fetched = page.waitForRequest(`${base}/ahead/b.md?raw`);

  await page.hover('.markdown-body a[href="b.md"]');
  await fetched;
  await page.waitForTimeout(500);
  await page.$eval('.markdown-body a[href="b.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "B",
  );
  assert.equal(await id(".mermaid > svg"), shown + 1, "the click rendered the page again");

  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "A",
  );
  await page.hover('.markdown-body a[href="b.md"]');
  await page.waitForTimeout(500);
  write({ "ahead/b.md": diagram("B, saved after the pointer rested") });
  await page.waitForTimeout(300);
  await page.$eval('.markdown-body a[href="b.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body h1")?.textContent?.startsWith("B"),
  );
  assert.equal(
    await page.$eval(".markdown-body h1", (h) => h.textContent),
    "B, saved after the pointer rested",
  );
  await page.close();
});

test("No blank: the old content stays until the new page is ready", async () => {
  writeShelf();
  const page = await settled("shelf/page-20.md");
  await page.route("**/shelf/page-19.md?raw", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  await page.$eval('.markdown-body a[href="page-19.md"]', (link) => (link as HTMLElement).click());
  await page.waitForTimeout(400);
  assert.equal(await page.$eval(".markdown-body h1", (h) => h.textContent), "Page 20");
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 19",
  );
  await page.unroute("**/shelf/page-19.md?raw");
  await page.close();
});

test("Live updates: a save of the previous page in flight while following a link never reaches the new page", async () => {
  writeShelf();
  const page = await settled("shelf/page-12.md");
  await page.route("**/shelf/page-12.md?raw", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });

  write({ "shelf/page-12.md": "# Page 12, saved\n\n[Previous](page-11.md)" });
  await page.waitForRequest(`${base}/shelf/page-12.md?raw`);
  // The wrong content heals within one round trip, so every swap is recorded rather than sampled.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as { seen?: string[] }).seen = seen;
    new MutationObserver(() =>
      seen.push(document.querySelector(".markdown-body h1")?.textContent ?? ""),
    ).observe(document.querySelector("main") as Element, { childList: true });
  });
  await page.$eval('.markdown-body a[href="page-11.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 11",
  );
  await page.waitForTimeout(1500);
  assert.deepEqual(await page.evaluate(() => (window as { seen?: string[] }).seen), ["Page 11"]);
  await page.unroute("**/shelf/page-12.md?raw");
  await page.close();
});

test("Live updates: a save of the previous page before the new one is subscribed leaves the new page alone", async () => {
  write({
    "late/a.md": "# A\n\n[b](b.md)",
    "late/b.md": "# B\n\n![pic](pic.svg)",
    "late/pic.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
  });
  const page = await settled("late/a.md");
  await page.route("**/late/pic.svg", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await page.$eval('.markdown-body a[href="b.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "B",
  );
  await mark(page);
  write({ "late/a.md": "# A, saved" });
  await page.waitForTimeout(800);
  assert.ok(await marked(page), "a save of the previous page re-rendered the new one");
  await page.unroute("**/late/pic.svg");
  await page.close();
});

test("Landing: a scroll while back is still loading is not saved as the earlier page's place", async () => {
  writeShelf();
  const page = await settled("shelf/page-30.md");

  await page.evaluate(() => scrollTo(0, 1200));
  await page.waitForTimeout(400);
  await page.$eval('.markdown-body a[href="page-29.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 29",
  );
  await page.route("**/shelf/page-30.md?raw", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });

  await page.goBack();
  await page.waitForURL(`${base}/shelf/page-30.md`);
  await page.evaluate(() => scrollTo(0, 600));
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 30",
  );
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), 1200);
  await page.unroute("**/shelf/page-30.md?raw");
  await page.close();
});

test("Scalar frontmatter, Nested values, Outline: frontmatter shows as a key/value table above the body", async () => {
  write({
    "cards/card.md":
      "---\ntitle: Folio\nstatus: draft\ntags: [a, b]\nowner:\n  name: X\n---\n# Body\n\nText.\n\n## Section\n",
  });
  const page = await open("cards/card.md");
  const facts = await page.evaluate(() => ({
    first: document.querySelector(".markdown-body > :first-child")?.className,
    rows: [...document.querySelectorAll(".markdown-body .frontmatter tr")].map((row) => [
      row.querySelector("th")?.textContent,
      row.querySelector("td pre code.language-yaml.hljs")?.textContent ??
        row.querySelector("td")?.textContent,
    ]),
    rules: document.querySelectorAll(".markdown-body hr").length,
    headings: [...document.querySelectorAll(".markdown-body :is(h1, h2)")].map(
      (h) => h.textContent,
    ),
    outline: [...document.querySelectorAll(".outline a")].map((link) => link.textContent),
  }));

  assert.deepEqual(facts, {
    first: "frontmatter",
    rows: [
      ["title", "Folio"],
      ["status", "draft"],
      ["tags", "[a, b]"],
      ["owner", "name: X"],
    ],
    rules: 0,
    headings: ["Body", "Section"],
    outline: ["Body", "Section"],
  });
  await page.close();
});

test("Malformed YAML: the block shows as highlighted YAML and the body renders", async () => {
  write({ "cards/broken.md": "---\ntitle: [unclosed\n---\n# Body\n\nText.\n" });
  const page = await open("cards/broken.md");
  const facts = await page.evaluate(() => ({
    block: document.querySelector(".markdown-body > pre:first-child > code.language-yaml.hljs")
      ?.textContent,
    tables: document.querySelectorAll(".markdown-body table").length,
    body: document.querySelector(".markdown-body h1")?.textContent,
    outline: [...document.querySelectorAll(".outline a")].map((link) => link.textContent),
  }));

  assert.deepEqual(facts, {
    block: "title: [unclosed",
    tables: 0,
    body: "Body",
    outline: ["Body"],
  });
  await page.close();
});

test("No frontmatter: a rule that does not open the file renders as a rule", async () => {
  write({
    "cards/later.md": "# Later\n\nText.\n\n---\n\nmode: x\n\n---\n",
    "cards/indented.md": "\n---\nmode: x\n---\n",
  });

  for (const [file, rules, heading] of [
    ["cards/later.md", 2, null],
    ["cards/indented.md", 1, "mode: x"],
  ] as const) {
    const page = await open(file);
    const facts = await page.evaluate(() => ({
      tables: document.querySelectorAll(".markdown-body .frontmatter").length,
      rules: document.querySelectorAll(".markdown-body hr").length,
      heading: document.querySelector(".markdown-body h2")?.textContent ?? null,
    }));

    assert.deepEqual(facts, { tables: 0, rules, heading }, file);
    await page.close();
  }
});

test("Live update: a saved frontmatter value updates the table in place", async () => {
  write({ "cards/live.md": "---\ntitle: Folio\nstatus: draft\n---\n# Body\n" });
  const page = await open("cards/live.md");

  await keepFrame(page);
  write({ "cards/live.md": "---\ntitle: Folio\nstatus: final\n---\n# Body\n" });
  await page.waitForFunction(
    () => document.querySelector(".frontmatter tr:nth-child(2) td")?.textContent === "final",
  );
  assert.equal((await frameOf(page)).kept, true);
  await page.close();
});

test("Heading in a block, Open or closed, Highlight, Heading in the block's title, Nested blocks, Live update: a block's content stays out of the outline", async () => {
  const words = "Words fill the section. ".repeat(160);
  const blocks = (extra: string) =>
    [
      "# A",
      words,
      "<details><summary>More</summary>",
      `## B\n\n${extra}${words}`,
      "</details>",
      `## C\n\n${words}`,
      "<details><summary><h2>Notes</h2></summary>",
      "Inside.",
      "<details><summary><h3>Inner</h3></summary>",
      "Deeper.",
      "</details>",
      "</details>",
      words,
    ].join("\n\n");
  const listed = (page: Page) =>
    page.$$eval(".outline a", (links) =>
      links.map((link) => `${link.className.replace(" current", "")} ${link.textContent}`),
    );
  const current = (page: Page, name: string) =>
    page.waitForFunction(
      (want) => document.querySelector(".outline a.current")?.textContent === want,
      name,
    );
  const outline = ["outline-h1 A", "outline-h2 C", "outline-h2 Notes"];
  write({ "outline/blocks.md": blocks("") });
  const page = await open("outline/blocks.md");

  assert.deepEqual(await listed(page), outline);
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) {
      details.open = true;
    }
  });
  assert.deepEqual(await listed(page), outline);

  await page.evaluate(() => document.getElementById("c")?.scrollIntoView());
  await current(page, "C");
  await page.evaluate(() => document.getElementById("b")?.scrollIntoView());
  await current(page, "A");

  write({ "outline/blocks.md": blocks("## Added\n\n") });
  await waitText(page, "Added");
  assert.deepEqual(await listed(page), outline);
  await page.close();
});

test("Mark on hover, Text stays text, Set the anchor, History, Copied address, Every level, Link in a heading, Heading in a block's title: a heading's mark sets its anchor", async () => {
  const words = "Words fill the section. ".repeat(160);
  write({
    "anchors/start.md": "# Start\n\n[Marks](marks.md)",
    "anchors/marks.md": [
      "# Top",
      words,
      "## Second [linked](start.md)",
      words,
      "### Third",
      words,
      "#### Fourth",
      words,
      "##### Fifth",
      "###### Sixth",
      "<details><summary><h2>Titled</h2></summary>",
      "Body.",
      "</details>",
      words,
    ].join("\n\n"),
  });
  const page = await open("anchors/start.md");
  const opacity = (id: string) =>
    page.$eval(`[id="${id}"] .heading-link`, (mark) => getComputedStyle(mark).opacity);

  await page.click("text=Marks");
  await page.waitForSelector("#fourth");
  assert.deepEqual(
    await page.$$eval(":is(h1, h2, h3, h4, h5, h6)[id]", (headings) =>
      headings.map((h) => [h.id, h.querySelectorAll(".heading-link").length, h.textContent]),
    ),
    [
      ["top", 1, "Top"],
      ["second-linked", 1, "Second linked"],
      ["third", 1, "Third"],
      ["fourth", 1, "Fourth"],
      ["fifth", 1, "Fifth"],
      ["sixth", 1, "Sixth"],
      ["titled", 1, "Titled"],
    ],
  );
  assert.equal(await page.$$eval("#third a:not(.heading-link)", (links) => links.length), 0);

  await page.evaluate(() => scrollTo(0, 1500));
  await page.mouse.move(0, 0);
  assert.equal(await opacity("fourth"), "0");
  await page.hover("#fourth");
  assert.equal(await opacity("fourth"), "1");
  const entries = await page.evaluate(() => history.length);
  await page.click("#fourth .heading-link");
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, entries: history.length })), {
    hash: "#fourth",
    entries,
  });

  const copied = await context.newPage();
  await copied.goto(page.url());
  await landed(copied);
  const gap = await copied.evaluate(
    () =>
      (document.getElementById("fourth") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );
  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);
  await copied.close();

  await page.click("#titled .heading-link");
  assert.deepEqual(
    await page.evaluate(() => ({
      hash: location.hash,
      open: (document.querySelector("details") as HTMLDetailsElement).open,
    })),
    { hash: "#titled", open: false },
  );

  await page.goBack();
  await page.waitForFunction(() => location.pathname.endsWith("/anchors/start.md"));
  await page.goForward();
  await page.waitForSelector("#second-linked");
  await page.click("#second-linked >> text=linked");
  await page.waitForFunction(() => location.pathname.endsWith("/anchors/start.md"));
  await page.close();
});

test("Pilcrow on hover, Hidden otherwise, Click unchanged, Outline clean, Copy clean: a heading's mark is a pilcrow", async () => {
  write({ "pilcrow/page.md": "# Alpha\n\nText.\n\n## Beta\n\nText.\n\n###### Gamma" });
  const page = await open("pilcrow/page.md");
  const mark = (id: string) =>
    page.$eval(`[id="${id}"] .heading-link`, (a) => {
      const glyph = getComputedStyle(a, "::before");
      const text = document.createRange();
      text.selectNodeContents(a.parentElement as Element);
      text.setEndBefore(a);
      return {
        glyph: glyph.content,
        weight: glyph.fontWeight,
        scale:
          Math.round(
            (100 * parseFloat(glyph.fontSize)) / parseFloat(getComputedStyle(a).fontSize),
          ) / 100,
        icons: a.childElementCount,
        after: a.getBoundingClientRect().left >= text.getBoundingClientRect().right,
        opacity: getComputedStyle(a).opacity,
      };
    });

  await page.mouse.move(0, 0);
  for (const id of ["alpha", "beta", "gamma"]) {
    assert.deepEqual(await mark(id), {
      glyph: '"\u00b6"',
      weight: "400",
      scale: 0.8,
      icons: 0,
      after: true,
      opacity: "0",
    });
  }
  await page.hover("#beta");
  assert.equal((await mark("beta")).opacity, "1");
  await page.hover("#beta .heading-link");
  assert.equal(
    await page.$eval("#beta .heading-link", (a) => getComputedStyle(a).textDecorationLine),
    "none",
  );

  assert.deepEqual(await page.$$eval(".outline a", (links) => links.map((a) => a.textContent)), [
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  assert.equal(
    await page.$eval("#beta", (heading) => {
      getSelection()?.selectAllChildren(heading);
      return getSelection()?.toString();
    }),
    "Beta",
  );

  const entries = await page.evaluate(() => history.length);
  await page.click("#beta .heading-link");
  assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, entries: history.length })), {
    hash: "#beta",
    entries,
  });
  await page.close();
});

test("Bring to top, Same spot, Address, History, Instant, Near the bottom, Heading in a block's title: a heading's mark brings it just below the toolbar", async () => {
  const words = "Words fill the section. ".repeat(160);
  write({
    "anchors/top-start.md": "# Start\n\n[Tops](tops.md)",
    "anchors/tops.md": [
      "# Top",
      words,
      "## Middle",
      words,
      "<details><summary><h2>Titled</h2></summary>",
      "Body.",
      "</details>",
      words,
      "## Last",
      "Short.",
    ].join("\n\n"),
  });
  const page = await open("anchors/top-start.md");
  const gap = (id: string) =>
    page.evaluate(
      (heading) =>
        (document.getElementById(heading) as Element).getBoundingClientRect().top -
        (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
      id,
    );

  await page.click("text=Tops");
  await page.waitForSelector("#middle");
  const entries = await page.evaluate(() => history.length);
  const middle = await page.$eval("#middle", (h) => h.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => scrollTo(0, y - 400), middle);
  await page.hover("#middle");
  await page.click("#middle .heading-link");
  const at = await page.evaluate(() => scrollY);
  assert.ok((await gap("middle")) >= 0 && (await gap("middle")) <= 16, "heading below the toolbar");
  assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, entries: history.length })), {
    hash: "#middle",
    entries,
  });

  await page.click(".outline >> text=Middle");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), at);

  await page.evaluate(() => scrollTo(0, 0));
  await page.hover("#titled");
  await page.click("#titled .heading-link");
  assert.ok((await gap("titled")) >= 0 && (await gap("titled")) <= 16, "title heading on top");
  assert.equal(await page.$eval("details", (d) => (d as HTMLDetailsElement).open), false);

  await page.evaluate(() => scrollTo(0, 0));
  await page.hover("#last");
  await page.click("#last .heading-link");
  assert.equal(
    await page.evaluate(() => scrollY),
    await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
  );

  await page.goBack();
  await page.waitForFunction(() => location.pathname.endsWith("/anchors/top-start.md"));
  await page.close();
});

const SECTIONS = [
  "# Top",
  "Top text.",
  "## Alpha",
  "Alpha text.",
  "### Alpha one",
  "Alpha one text.",
  "## Beta",
  "Beta text.",
  "<details><summary><h2>Titled</h2></summary>",
  "Titled text.",
  "</details>",
  "<details><summary>Block</summary>",
  "## Inner",
  "Inner text.",
  "</details>",
  "After the block.",
  "## Gamma",
  `${"Gamma words. ".repeat(400)}`,
  "###### Sixth",
].join("\n\n");

function visible(page: Page, text: string): Promise<boolean> {
  return page.evaluate(
    (t) =>
      [...document.querySelectorAll(".markdown-body p")]
        .find((p) => p.textContent === t)
        ?.checkVisibility() ?? false,
    text,
  );
}

function folded(page: Page, id: string): Promise<string | null> {
  return page.$eval(`[id="${id}"] > .fold-toggle`, (b) => b.getAttribute("aria-expanded"));
}

test("Control on hover, Fold, Nested sections, Folded is visible, Unfold, Outline, Link mark, Selection: a heading's control folds its section", async () => {
  write({ "folds/sections.md": SECTIONS });
  const page = await open("folds/sections.md");
  const opacity = (id: string) =>
    page.$eval(`[id="${id}"] > .fold-toggle`, (b) => getComputedStyle(b).opacity);
  const textLeft = (id: string) =>
    page.$eval(`[id="${id}"]`, (h) => {
      const range = document.createRange();
      range.selectNodeContents(h.lastChild?.previousSibling ?? h);
      return range.getBoundingClientRect().left;
    });
  const outlined = () => page.$$eval(".outline a", (links) => links.map((a) => a.textContent));

  assert.deepEqual(
    await page.$$eval(":is(h1, h2, h3, h4, h5, h6)[id]", (headings) =>
      headings.map((h) => [h.id, h.querySelectorAll(":scope > .fold-toggle").length]),
    ),
    ["top", "alpha", "alpha-one", "beta", "titled", "inner", "gamma", "sixth"].map((id) => [id, 1]),
  );
  const outline = await outlined();
  await page.mouse.move(0, 0);
  const left = await textLeft("alpha");
  assert.equal(await opacity("alpha"), "0");
  await page.hover("#alpha");
  assert.equal(await opacity("alpha"), "1");
  assert.equal(await textLeft("alpha"), left);
  const toggle = await page.$eval("#alpha > .fold-toggle", (b) => b.getBoundingClientRect());
  const heading = await page.$eval("#alpha", (h) => h.getBoundingClientRect());
  assert.ok(toggle.right <= heading.left + 1, "control sits left of the heading");

  await page.click("#alpha-one > .fold-toggle");
  await page.click("#alpha > .fold-toggle");
  assert.deepEqual(
    [await visible(page, "Alpha text."), await visible(page, "Alpha one text.")],
    [false, false],
  );
  assert.equal(await visible(page, "Beta text."), true);
  assert.equal(await folded(page, "alpha"), "false");
  assert.deepEqual(await outlined(), outline);

  await page.mouse.move(0, 0);
  assert.equal(await opacity("alpha"), "1");
  assert.equal(await opacity("beta"), "0");

  await page.click("#alpha > .fold-toggle");
  assert.deepEqual(
    [await visible(page, "Alpha text."), await visible(page, "Alpha one text.")],
    [true, false],
  );
  assert.equal(await folded(page, "alpha"), "true");
  await page.click("#alpha-one > .fold-toggle");
  assert.equal(await visible(page, "Alpha one text."), true);

  await page.click("#beta > .fold-toggle");
  assert.equal(await visible(page, "Beta text."), false);
  assert.equal(await page.$eval("#titled", (h) => h.checkVisibility()), true);
  await page.click("#beta > .fold-toggle");
  await page.click("#gamma > .fold-toggle");
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  assert.equal(await page.$eval(".outline .current", (a) => a.textContent), "Gamma");
  await page.click("#gamma > .fold-toggle");

  await page.hover("#gamma");
  await page.click("#gamma .heading-link");
  assert.equal(await page.evaluate(() => location.hash), "#gamma");

  await page.evaluate(() => scrollTo(0, 0));
  const box = await page.$eval("#beta", (h) => {
    const range = document.createRange();
    range.selectNodeContents(h.lastChild?.previousSibling ?? h);
    const r = range.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, right: r.right };
  });
  await page.mouse.move(box.x + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.y, { steps: 5 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => String(getSelection())), "Beta");
  assert.equal(await folded(page, "beta"), "true");
  await page.close();
});

test("Live update, Reload, Same tab back, Other tab, Outline into a fold, Deep link, Find: folds last per tab and page, and unfold to show what is asked for", async () => {
  write({ "folds/kept.md": SECTIONS, "folds/away.md": "# Away" });
  const page = await open("folds/kept.md");

  await page.click("#alpha > .fold-toggle");
  write({ "folds/kept.md": `${SECTIONS}\n\nAppended.` });
  await waitText(page, "Appended.");
  assert.equal(await visible(page, "Alpha text."), false);

  await page.reload();
  await landed(page);
  assert.equal(await visible(page, "Alpha text."), false);

  await page.evaluate(() => {
    const link = Object.assign(document.createElement("a"), { href: "away.md", textContent: "Go" });
    document.querySelector(".markdown-body")?.append(link);
  });
  await page.click("text=Go");
  await page.waitForSelector("#away");
  await page.goBack();
  await page.waitForSelector("#alpha");
  assert.equal(await visible(page, "Alpha text."), false);

  const other = await open("folds/kept.md");
  assert.equal(await visible(other, "Alpha text."), true);
  await other.close();

  await page.click(".outline >> text=Alpha one");
  await page.waitForTimeout(300);
  assert.equal(await visible(page, "Alpha one text."), true);
  assert.equal(await folded(page, "alpha"), "true");
  const gap = await page.evaluate(
    () =>
      (document.getElementById("alpha-one") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );
  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);

  await page.click("#alpha > .fold-toggle");
  await page.goto(`${base}/folds/away.md`);
  await page.goto(`${base}/folds/kept.md#alpha-one`);
  await landed(page);
  assert.equal(await visible(page, "Alpha one text."), true);
  assert.equal(await folded(page, "alpha"), "true");

  await page.click("#beta > .fold-toggle");
  assert.equal(await page.$eval("#beta + .fold", (f) => f.getAttribute("hidden")), "until-found");
  await page.$eval("#beta + .fold", (f) => f.dispatchEvent(new Event("beforematch")));
  assert.equal(await folded(page, "beta"), "true");
  await page.reload();
  await landed(page);
  assert.equal(await visible(page, "Beta text."), true);
  await page.close();
});

test("Heading in a block's content, Heading in a block's title: a section inside a collapsible block ends with the block", async () => {
  write({ "folds/blocks.md": SECTIONS });
  const page = await open("folds/blocks.md");
  const open_ = (n: number) =>
    page.$$eval("details", (all, i) => (all[i] as HTMLDetailsElement).open, n);

  await page.click("#titled > .fold-toggle");
  assert.equal(await open_(0), false);
  assert.equal(await folded(page, "titled"), "false");
  await page.click("#titled");
  assert.equal(await open_(0), true);
  assert.equal(await visible(page, "Titled text."), false);

  await page.click('summary >> text="Block"');
  await page.click("#inner > .fold-toggle");
  assert.equal(await visible(page, "Inner text."), false);
  assert.equal(await visible(page, "After the block."), true);
  assert.equal(await page.$eval("#gamma", (h) => h.checkVisibility()), true);
  await page.close();
});

test("Loose tables: extra cells, uneven rows, no header line and missing edge pipes show in full", async () => {
  const cases = [
    "|foo|\n|---|\n|baz|bar|",
    "|h|\n|-|\n|a|\n|b|c|d|\n|e|f|",
    "|a|b|\n|1|2|",
    "|a|\n|1|2|",
    "|a|b\n|1|2",
    "a|b|\n1|2|",
    "|a|b\n|-|-\n|1|2",
    "pick x | y\n\npick x | y\nor a | b",
    "Before.\n\n|a|b|\n\nAfter.",
    "`|a|` x\n`|b|` y",
    "```\n|a|b|\n|1|2|\n```",
    "| Name | Value |\n|---|---|\n| a | 1 |",
    "|a|\n|---|---|\n|1|2|",
  ];
  write({ "cards/tables.md": cases.map((body, i) => `## Case ${i}\n\n${body}\n`).join("\n") });
  const page = await open("cards/tables.md");
  const blocks = await page.evaluate(() => {
    const cells = (row: Element) => [...row.children].map((cell) => cell.textContent);
    const sections: unknown[][] = [];

    for (const block of document.querySelectorAll(".markdown-body > *")) {
      if (block.tagName === "H2") {
        sections.push([]);
      } else if (block.tagName === "TABLE") {
        sections.at(-1)?.push({
          head: [...block.querySelectorAll("thead tr")].map(cells),
          body: [...block.querySelectorAll("tbody tr")].map(cells),
        });
      } else {
        sections.at(-1)?.push(`${block.tagName}: ${block.textContent}`);
      }
    }

    return sections;
  });
  const ab12 = {
    head: [],
    body: [
      ["a", "b"],
      ["1", "2"],
    ],
  };

  assert.deepEqual(blocks, [
    [{ head: [["foo", ""]], body: [["baz", "bar"]] }],
    [
      {
        head: [["h", "", ""]],
        body: [
          ["a", "", ""],
          ["b", "c", "d"],
          ["e", "f", ""],
        ],
      },
    ],
    [ab12],
    [
      {
        head: [],
        body: [
          ["a", ""],
          ["1", "2"],
        ],
      },
    ],
    [ab12],
    [ab12],
    [{ head: [["a", "b"]], body: [["1", "2"]] }],
    ["P: pick x | y", "P: pick x | y\nor a | b"],
    ["P: Before.", "P: |a|b|", "P: After."],
    ["P: |a| x\n|b| y"],
    ["PRE: |a|b|\n|1|2|\n"],
    [{ head: [["Name", "Value"]], body: [["a", "1"]] }],
    [{ head: [["a", ""]], body: [["1", "2"]] }],
  ]);
  await page.close();
});

test("Buttons, Step forward, Step back, Pages only, First and last: every page in tree order", async () => {
  const page = await openStep(STEP_ORDER[0]);
  const titles = await page.$$eval(".bar > *", (items) =>
    items.slice(0, 4).map((item) => item.getAttribute("title") ?? item.className),
  );

  assert.deepEqual(titles, [
    "Show or hide the file tree",
    "Previous page (←)",
    "Next page (→)",
    "breadcrumbs",
  ]);
  await stepsShown(page, { previous: false, next: true });
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  assert.equal(await pathOf(page), STEP_ORDER[0]);

  for (const urlPath of STEP_ORDER.slice(1)) {
    await page.keyboard.press("ArrowRight");
    await arrived(page, urlPath);
  }

  await stepsShown(page, { previous: true, next: false });
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  assert.equal(await pathOf(page), STEP_ORDER.at(-1));

  for (const urlPath of STEP_ORDER.slice(0, -1).reverse()) {
    await page.click('button[title="Previous page (←)"]');
    await arrived(page, urlPath);
  }

  await stepsShown(page, { previous: false, next: true });
  await page.click('button[title="Next page (→)"]');
  await arrived(page, STEP_ORDER[1]);
  await page.close();
});

test("Folder page: both steps are greyed out and the arrows do nothing", async () => {
  const page = await context.newPage();
  await page.goto(`${stepBase}/guide/`);
  await page.waitForSelector(".markdown-body > *");
  await page.waitForTimeout(300);
  await stepsShown(page, { previous: false, next: false });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);

  assert.equal(await pathOf(page), "guide/");
  await page.close();
});

test("Scrollable block: after a click into a wide code block or formula the arrows scroll it, elsewhere they step", async () => {
  const page = await openStep("index.md");

  for (const block of ["pre code", ".katex-display"]) {
    await page.click(block);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);

    assert.equal(await pathOf(page), "index.md", block);
    assert.ok((await page.$eval(block, (element) => element.scrollLeft)) > 0, block);
  }

  await page.click("h1");
  await page.keyboard.press("ArrowRight");
  await arrived(page, "readme.md");
  await page.close();
});

test("Expanded diagram: the arrows pan it and never step", async () => {
  const page = await openStep("index.md");
  const transform = () =>
    page.$eval(".mermaid-zoom-inner", (e) => (e as HTMLElement).style.transform);

  await page.hover(".mermaid");
  await page.click(".mermaid-expand");
  await page.waitForSelector(".mermaid-zoom.visible svg");
  const fitted = await transform();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);

  assert.notEqual(await transform(), fitted);
  assert.equal(await pathOf(page), "index.md");
  await page.close();
});

test("Modified arrows: an arrow held with a modifier never steps", async () => {
  const page = await openStep("index.md");

  for (const key of ["Shift+ArrowRight", "Control+ArrowLeft", "Meta+ArrowLeft"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(300);

    assert.equal(await pathOf(page), "index.md", key);
  }

  await page.close();
});

test("Tree, Outline, Same as the buttons, No browser history step, Expanded diagram: Alt+arrows show or hide the side panels", async () => {
  const page = await openStep("readme.md");
  const state = () =>
    page.evaluate(() => ({
      path: decodeURIComponent(location.pathname).slice(1),
      tree: getComputedStyle(document.querySelector(".tree") as Element).display !== "none",
      outline: getComputedStyle(document.querySelector(".outline") as Element).display !== "none",
      pressed: ["Show or hide the file tree", "Show or hide the outline"].map((title) =>
        document.querySelector(`button[title="${title}"]`)?.getAttribute("aria-pressed"),
      ),
    }));

  await page.click('.tree a[href$="/index.md"]');
  await arrived(page, "index.md");
  const entries = await page.evaluate(() => history.length);

  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(300);
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: false,
    outline: true,
    pressed: ["false", "true"],
  });

  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(300);
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: false,
    outline: false,
    pressed: ["false", "false"],
  });
  assert.equal(await page.evaluate(() => history.length), entries);

  await page.reload();
  await page.waitForSelector(".markdown-body > *");
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: false,
    outline: false,
    pressed: ["false", "false"],
  });

  await page.hover(".mermaid");
  await page.click(".mermaid-expand");
  await page.waitForSelector(".mermaid-zoom.visible svg");
  const transform = () =>
    page.$eval(".mermaid-zoom-inner", (e) => (e as HTMLElement).style.transform);
  const fitted = await transform();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(300);
  assert.notEqual(await transform(), fitted);
  assert.deepEqual((await state()).pressed, ["false", "false"]);
  await page.keyboard.press("Escape");

  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(300);
  assert.deepEqual(await state(), {
    path: "index.md",
    tree: true,
    outline: true,
    pressed: ["true", "true"],
  });
  await page.close();
});

test("Like a link: a step swaps only the content, opens at the top, and back returns to the place left", async () => {
  const page = await openStep("notes/todo.md");

  await keepFrame(page);
  await page.evaluate(() => scrollTo(0, 600));
  await page.waitForTimeout(400);
  await page.keyboard.press("ArrowRight");
  await arrived(page, "flow.mmd");
  await page.waitForSelector(".mermaid svg[aria-roledescription]");
  const stepped = { y: await page.evaluate(() => scrollY), kept: (await frameOf(page)).kept };
  await page.goBack();
  await arrived(page, "notes/todo.md");
  await page.waitForFunction(() => scrollY === 600);

  assert.deepEqual(stepped, { y: 0, kept: true });
  assert.equal((await frameOf(page)).kept, true);
  await page.close();
});

test("Live tree: a page added or removed while one is open counts at the next step", async () => {
  const page = await openStep("readme.md");

  await stepsShown(page, { previous: true, next: false });
  writeIn(stepRoot, { "zz.md": "# Zz" });
  await stepsShown(page, { previous: true, next: true });
  await page.keyboard.press("ArrowRight");
  await arrived(page, "zz.md");
  fs.rmSync(path.join(stepRoot, "readme.md"));
  await page.waitForTimeout(300);
  await page.keyboard.press("ArrowLeft");
  await arrived(page, "index.md");

  fs.rmSync(path.join(stepRoot, "zz.md"));
  writeIn(stepRoot, { "readme.md": STEP_FILES["readme.md"] });
  await page.close();
});

async function open(urlPath: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/${urlPath}`);
  await page.waitForSelector(".markdown-body > *");
  await page.waitForSelector(".tree .current");
  // The first subscription lands after the first render; saves before it would go unheard.
  await page.waitForTimeout(300);
  return page;
}

async function openStep(urlPath: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${stepBase}/${urlPath}`);
  await landed(page);
  return page;
}

async function pathOf(page: Page): Promise<string> {
  return page.evaluate(() => decodeURIComponent(location.pathname).slice(1));
}

async function arrived(page: Page, urlPath: string): Promise<void> {
  await page.waitForFunction(
    (p) =>
      decodeURIComponent(location.pathname).slice(1) === p &&
      document.querySelector(".tree .current")?.parentElement?.dataset.path === p,
    urlPath,
  );
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
  );
}

// Long pages in a folder long enough that its last files sit below the tree panel's fold.
function writeShelf(): void {
  const parts = (i: number) =>
    Array.from(
      { length: 5 },
      (_, k) =>
        `## Part ${k + 1}\n\n${Array.from({ length: 40 }, (_, n) => `Paragraph ${n + 1} of page ${i}.`).join("\n\n")}`,
    ).join("\n\n");
  const pages: Record<string, string> = {};

  for (let i = 0; i < 60; i++) {
    const name = `shelf/page-${String(i).padStart(2, "0")}.md`;
    const previous = `page-${String(Math.max(i - 1, 0)).padStart(2, "0")}.md`;
    pages[name] = [
      `# Page ${i}`,
      `[Previous](${previous}), [its part 3](${previous}#part-3), [absent](absent.md), [shelf](./)`,
      parts(i),
    ].join("\n\n");
  }

  if (!fs.existsSync(path.join(root, "shelf"))) {
    write(pages);
  }
}

async function settled(urlPath: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/${urlPath}`);
  await landed(page);
  return page;
}

// The tree loads beside the content and reveals its current file once its folders are open.
async function landed(page: Page): Promise<void> {
  await page.waitForSelector(".markdown-body > *");
  await page.waitForSelector(".tree .current");
  await page.waitForTimeout(300);
}

// Marks the frame and the document, so a reload or a rebuilt frame shows as a lost mark.
async function keepFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as { kept?: boolean }).kept = true;

    for (const selector of [".bar", ".tree", ".outline"]) {
      (document.querySelector(selector) as HTMLElement).dataset.kept = "";
    }
  });
}

async function frameOf(page: Page) {
  return page.evaluate(() => ({
    kept:
      (window as { kept?: boolean }).kept === true &&
      [".bar", ".tree", ".outline"].every(
        (selector) => (document.querySelector(selector) as HTMLElement).dataset.kept === "",
      ),
    url: location.href,
    title: document.title,
    crumbs: [...document.querySelectorAll(".breadcrumbs > :not(.separator)")].map(
      (c) => c.textContent,
    ),
    current: document.querySelector(".tree .current")?.textContent,
    outline: document.querySelector(".outline a")?.textContent,
  }));
}

function write(files: Record<string, string>): void {
  writeIn(root, files);
}

function writeIn(folder: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
}

async function mark(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.querySelector(".markdown-body") as HTMLElement).dataset.mark = "";
  });
}

async function marked(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (document.querySelector(".markdown-body") as HTMLElement).dataset.mark === "",
  );
}

async function waitText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (t) => document.querySelector(".markdown-body")?.textContent?.includes(t),
    text,
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
