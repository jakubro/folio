/** Headless Chromium run of folio's documented behaviour: conventions, kinds, document queries and health. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { context, serveFolder, writeIn } from "./harness.ts";

test("Found, Layering, Live, Broken, Inspect: a folder declares its conventions in FOLIO.md files", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-declare-")));
  const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;
  writeIn(folder, {
    "FOLIO.md": `# Conventions\n\nNotes are kept short.\n\n${fence("kinds:\n  note:\n    where: '**/*.md'")}\n`,
    "team/FOLIO.md": `# Team\n\n${fence("kinds:\n  note:\n    where: notes/*.md")}\n`,
    "team/notes/a.md": "# A\n\nA note.\n",
  });
  const served = await serveFolder(folder);
  const declared = async (urlPath: string) =>
    (await (await fetch(`${served.base}/${urlPath}?conventions`)).json()).declarations;

  try {
    assert.deepEqual(await declared("team/notes/a.md"), ["FOLIO.md", "team/FOLIO.md"]);

    const page = await context.newPage();
    await page.goto(`${served.base}/team/notes/a.md`);
    await page.waitForSelector(".markdown-body > p[data-folio-id]");
    await page.hover(".markdown-body > p");
    await page.click(".block-provenance");
    await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line");
    assert.match(
      (await page.textContent(".provenance-panel")) ?? "",
      /Declared by FOLIO\.md, team\/FOLIO\.md/,
    );

    const declaration = await context.newPage();
    await declaration.goto(`${served.base}/FOLIO.md`);
    await declaration.waitForSelector(".markdown-body pre code.language-yaml");
    assert.match((await declaration.textContent(".markdown-body")) ?? "", /Notes are kept short/);

    writeIn(folder, { "team/FOLIO.md": `# Team\n\n${fence("colours: [red")}\n` });
    const health = await context.newPage();
    await health.goto(`${served.base}/?health`);
    await health.waitForSelector(".health-declaration li");
    assert.match(
      (await health.textContent(".health-declaration")) ?? "",
      /team\/FOLIO\.md:4 The declaration cannot be read/,
    );
    assert.deepEqual(await declared("team/notes/a.md"), ["FOLIO.md", "team/FOLIO.md"]);

    writeIn(folder, { "team/FOLIO.md": "# Team\n\nNothing declared.\n" });
    await health.waitForSelector(".health-declaration", { state: "detached" });
    await Promise.all([page.close(), declaration.close(), health.close()]);
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Declare a kind, Labelled lines, Path parts, Types, Inspect: kinds of documents and their fields", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-kinds-")));
  const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;
  writeIn(folder, {
    "FOLIO.md": `# Workshop\n\n${fence(
      [
        "kinds:",
        "  part:",
        "    where: parts/**/gear-*.md",
        "    fields:",
        "      id: {from: name, pattern: '^([a-z]+-\\d+)'}",
        "      bin: {from: folder}",
        "      grams: {from: label, type: number}",
        "      fits: {from: label, type: list, of: link, to: part}",
      ].join("\n"),
    )}\n`,
    "parts/stock/gear-1_one.md": "# gear-1 One\n\n**Grams:** 3\n\n**Fits:** gear-2\n",
    "parts/retired/gear-2_two.md": "# gear-2 Two\n\n**Grams:** many\n\n**Fits:** none\n",
  });
  const served = await serveFolder(folder);

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/parts/stock/gear-1_one.md`);
    await page.waitForSelector(".markdown-body > p[data-folio-id]");
    await page.hover(".markdown-body > p >> nth=0");
    await page.click(".block-provenance");
    await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line");
    const panel = (await page.textContent(".provenance-panel")) ?? "";
    assert.match(panel, /Kind: part, from FOLIO\.md/);
    assert.match(panel, /id: gear-1/);
    assert.match(panel, /bin: stock/);
    assert.match(panel, /grams: 3/);
    assert.match(panel, /fits: parts\/retired\/gear-2_two\.md/);

    const health = await context.newPage();
    await health.goto(`${served.base}/?health`);
    await health.waitForSelector(".health-field li");
    assert.deepEqual(
      await health.$$eval(".health-field li", (items) => items.map((item) => item.textContent)),
      [
        "parts/retired/gear-2_two.md:3 grams: many is not a number",
        "parts/retired/gear-2_two.md:5 fits: none names no part",
      ],
    );
    await Promise.all([page.close(), health.close()]);
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("A kind as a table, Structure, Join, Shapes, Live: documents can be queried as data", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-docdata-")));
  const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;
  writeIn(folder, {
    "FOLIO.md": `# Conventions\n\n${fence(
      "kinds:\n  part:\n    where: parts/**/gear-*.md\n    fields:\n      bin: {from: folder}",
    )}\n`,
    "parts/stock/gear-1.md": "# gear-1\n\n- [ ] weigh it\n",
    "parts/stock/gear-2.md": "# gear-2\n\n- [ ] cut it\n",
    "parts/retired/gear-3.md": "# gear-3\n\n- [x] scrapped\n",
    "limits.csv": "bin,limit\nstock,1\nretired,5\n",
    "report.md": [
      "# Report",
      "",
      "Open tasks: {value: #open#0.n}.",
      "",
      "```sql query open",
      "select count(*) as n from folio.tasks where not done",
      "```",
      "",
      "{table: #bins}",
      "",
      "```sql query bins",
      "select p.bin, count(*) as n, any_value(l.limit) as cap from kind.part p join 'limits.csv' l on l.bin = p.bin group by p.bin order by p.bin",
      "```",
      "",
      "```vega-lite",
      '{"data": {"url": "#bins"}, "mark": "bar", "encoding": {"x": {"field": "bin"}, "y": {"field": "n", "type": "quantitative"}}}',
      "```",
    ].join("\n"),
  });
  const served = await serveFolder(folder);

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/report.md`);
    await page.waitForSelector(".embed-value:text-is('2')");
    await page.waitForSelector(".embed-chart .chart svg");
    assert.deepEqual(
      await page.$$eval(".embed-table tbody tr", (rows) =>
        rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent)),
      ),
      [
        ["retired", "1", "5"],
        ["stock", "2", "1"],
      ],
    );

    writeIn(folder, { "parts/stock/gear-2.md": "# gear-2\n\n- [x] cut it\n" });
    await page.waitForSelector(".embed-value:text-is('1')");
    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("A rule, Lands, Severity, Live, Broken rule: a folder's conventions check themselves", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-rules-")));
  const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;
  const rules = [
    "rules:",
    "  owned:",
    "    query: select path, title from folio.documents where path like 'notes/%' and path not in (select path from folio.frontmatter where key = 'owner')",
    "    message: '{title} has no owner'",
    "  long:",
    "    severity: warning",
    "    query: select path from folio.headings where length(text) > 20",
    "    message: Heading too long",
  ].join("\n");
  writeIn(folder, {
    "FOLIO.md": `# Conventions\n\nEvery note has an owner, so questions reach someone.\n\n${fence(rules)}\n`,
    "notes/a.md": "# Alpha\n\nNo owner yet.\n",
    "notes/b.md": "---\nowner: ann\n---\n# A heading longer than twenty letters\n",
  });
  const served = await serveFolder(folder);

  try {
    const health = await context.newPage();
    await health.goto(`${served.base}/?health`);
    await health.waitForSelector(".health-rule-error li");
    assert.deepEqual(
      await health.$$eval(".health-kind > summary", (all) =>
        all.map((summary) => summary.textContent),
      ),
      ["Rule errors - 1", "Rule warnings - 1"],
    );
    assert.equal(
      await health.textContent(".health-rule-error li"),
      "notes/a.md:1 Alpha has no owner",
    );

    await health.click(".health-rule-error li a");
    await health.waitForURL(/notes\/a\.md/);
    await health.waitForSelector(".markdown-body h1");

    writeIn(folder, { "notes/a.md": "---\nowner: bo\n---\n# Alpha\n" });
    await health.goto(`${served.base}/?health`);
    await health.waitForSelector(".health-rule-warning li");
    assert.equal(await health.locator(".health-rule-error").count(), 0, "a fixed violation leaves");

    writeIn(folder, {
      "FOLIO.md": `# Conventions\n\n${fence("rules:\n  owned:\n    query: select nothing from folio.documents")}\n`,
    });
    await health.waitForSelector(".health-rule-error li:has-text('The rule owned cannot run')");
    await health.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Skip a folder, Skip a check, Layered, Health only: a folder declares what health checks", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-scope-")));
  const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;
  writeIn(folder, {
    "FOLIO.md": `# Scope\n\n${fence("health:\n  - where: copies/**\n    skip: all\n  - where: archive/**\n    skip: [link]")}\n`,
    "copies/a.md": "# A\n\n[gone](nowhere.md) and {include: none.md}\n",
    "archive/b.md": "# B\n\n[gone](nowhere.md) and {include: none.md}\n",
    "team/FOLIO.md": `# Team\n\n${fence("health:\n  - where: '*.md'\n    skip: [link]")}\n`,
    "team/c.md": "# C\n\n[gone](nowhere.md)\n",
    "d.md": "# D\n\n[gone](nowhere.md)\n",
  });
  const served = await serveFolder(folder);

  try {
    const health = await context.newPage();
    await health.goto(`${served.base}/?health`);
    await health.waitForSelector(".health-link li");
    assert.deepEqual(
      await health.$$eval(".health-kind li a", (links) => links.map((link) => link.textContent)),
      ["d.md:3", "archive/b.md:3"],
    );

    const copy = await context.newPage();
    await copy.goto(`${served.base}/copies/a.md`);
    await copy.waitForSelector(".markdown-body .include-missing");
    await Promise.all([health.close(), copy.close()]);
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// It times two pages, so a busy machine needs more than the suite's 60 s; its comparison stays as strict.
test("Many flagged blocks: a long page with hundreds of failing embeds settles in seconds", {
  timeout: 120_000,
}, async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-flags-")));
  const items = Array.from({ length: 12 }, (_, k) => `- item ${k} with **strong** and \`code\``);
  const parts = (reads: (n: number) => string) =>
    Array.from(
      { length: 400 },
      (_, n) => `## Part ${n}\n\nPart ${n} reads ${reads(n)}.\n\n${items.join("\n")}\n`,
    ).join("\n");
  writeIn(folder, {
    "plain.md": parts((n) => `nothing ${n}`),
    "many.md": parts((n) => `{value: none-${n}.csv#0.x}`),
  });
  const served = await serveFolder(folder);
  const timed = async (urlPath: string, done: () => boolean) => {
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`${served.base}/${urlPath}`);
    await page.waitForFunction(done, null, { timeout: 120_000, polling: 250 });
    await page.close();
    return Date.now() - started;
  };

  try {
    // The same page without embeds, timed on the same machine at the same moment, is the yardstick.
    const plain = await timed(
      "plain.md",
      () => document.querySelectorAll(".markdown-body h2[data-folio-id]").length === 400,
    );
    const flagged = await timed("many.md", () => {
      const flags = [...document.querySelectorAll<HTMLElement>(".problem-flag")];
      return flags.length === 400 && flags.every((flag) => flag.style.top);
    });
    assert.ok(flagged < 3 * plain + 2000, `settled in ${flagged} ms against ${plain} ms unflagged`);
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Open health, Kinds, Open from it, Live, Unopened pages, Tree: one view of everything wrong in the folder", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-health-")));
  writeIn(folder, {
    "rates.csv": "arm,pct\nA,0.816\n",
    "bad.parquet": "not a parquet file at all",
    "notes/target.md": [
      "# Target",
      "",
      "## Real heading",
      "",
      'Text with an <a id="old-name"></a>anchor of its own.',
      "",
      "```mermaid",
      "flowchart TD",
      "  A[Start] --> B{Ok?}",
      "```",
      "",
      "```mermaid",
      "classDiagram",
      "  Animal <|-- Duck",
      "```",
    ].join("\n"),
    "charts/only.md": [
      "# Only a chart",
      "",
      "```vega-lite",
      '{"data": {"values": [{"a": 1}]}, "mark": "bar", "encoding": {"y": {"field": "a", "type": "nope"}}}',
      "```",
    ].join("\n"),
    "notes/links.md": [
      "# Links",
      "",
      "[gone file](absent.md), [gone heading](target.md#no-such-heading), [gone block](target.md#^deadbeef).",
      "",
      "[fine](target.md#real-heading), [inline anchor](target.md#old-name), [outside](https://example.com) and [a file](files/report.pdf).",
    ].join("\n"),
    "notes/a.md": "# A\n\n{include: b.md}\n",
    "notes/b.md": "# B\n\n{include: a.md}\n",
    "notes/nowhere.md": "# Nowhere\n\n{include: parts/absent.md}\n",
    "data/report.md": [
      "# Report",
      "",
      'Arm A <data value="../rates.csv#0.pct">81%</data>.',
      "",
      "```mermaid",
      "flowchart LR",
      "  A-->",
      "```",
      "",
      "```vega-lite",
      '{"data": {"values": [{"a": 1}]}, "mark": "bar", "encoding": {"x": {"field": "a", "type": "wrong"}}}',
      "```",
      "",
      "```sql query",
      "select nothing from 'absent.csv'",
      "```",
      "",
      "{table: ../bad.parquet}",
    ].join("\n"),
    "fine.md": "# Fine\n\nNothing wrong.\n",
  });
  const served = await serveFolder(folder);

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/?health`);
    await page.waitForSelector(".health-kind");
    const shown = await page.$$eval(".health-kind", (kinds) =>
      kinds.map((kind) => ({
        kind: kind.querySelector("summary")?.textContent ?? "",
        folders: [...kind.querySelectorAll(".health-folder")].map((group) => ({
          folder: group.querySelector("summary")?.textContent ?? "",
          entries: [...group.querySelectorAll("li")].map((item) => item.textContent ?? ""),
        })),
      })),
    );
    const entries = (index: number) =>
      shown[index]?.folders.flatMap((group) => group.entries) ?? [];

    assert.deepEqual(
      shown.map(({ kind }) => kind),
      [
        "Contradicted figures - 1",
        "Broken links - 4",
        "Includes pointing nowhere - 1",
        "Include loops - 2",
        "Diagrams that cannot be drawn - 1",
        "Charts that cannot be drawn - 2",
        "Failing queries - 1",
        "Data that cannot be read - 1",
      ],
    );
    assert.deepEqual(shown[0]?.folders, [
      {
        folder: "data - 1",
        entries: ["data/report.md:3 81% is contradicted: the data says 82% (../rates.csv#0.pct)"],
      },
    ]);
    assert.deepEqual(shown[1]?.folders, [
      {
        folder: "notes - 4",
        entries: [
          "notes/links.md:3 Links to notes/absent.md, which is not there",
          "notes/links.md:3 Links to a heading not in notes/target.md: #no-such-heading",
          "notes/links.md:3 Links to a block no longer in notes/target.md: #^deadbeef",
          "notes/links.md:5 Links to notes/files/report.pdf, which is not there",
        ],
      },
    ]);
    assert.deepEqual(entries(2), [
      "notes/nowhere.md:3 Includes parts/absent.md, which is not there",
    ]);
    assert.deepEqual(
      entries(3).map((entry) => entry.split(" ")[0]),
      ["notes/a.md:3", "notes/b.md:3"],
    );
    assert.match(entries(4)[0] ?? "", /^data\/report\.md:5 The diagram cannot be drawn: /);
    assert.match(
      entries(5).join("\n"),
      /^charts\/only\.md:3 The chart cannot be drawn: Invalid field type[^\n]*\ndata\/report\.md:10 The chart cannot be drawn: Invalid field type/,
    );
    assert.match(entries(6)[0] ?? "", /^data\/report\.md:14 The query fails: .*absent\.csv/);
    assert.match(entries(7)[0] ?? "", /^data\/report\.md:18 \.\.\/bad\.parquet: /);
    assert.equal(await page.locator(".tree [class*=health], .tree .problem-flag").count(), 0);

    const answers: unknown[] = [];
    page.on("response", async (response) => {
      if (response.url().includes("health-data")) {
        answers.push({ url: response.url(), body: await response.json() });
      }
    });
    await page.evaluate(() => {
      (document.querySelector('[data-kind="figure"]') as HTMLElement & { kept?: boolean }).kept =
        true;
    });
    writeIn(folder, { "fine.md": "# Fine\n\nNow [broken](missing.md).\n" });
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".health-kind summary")].some(
        (summary) => summary.textContent === "Broken links - 5",
      ),
    );
    assert.equal(
      await page.evaluate(
        () =>
          (document.querySelector('[data-kind="figure"]') as HTMLElement & { kept?: boolean }).kept,
      ),
      true,
      "a kind the change did not touch is not drawn again",
    );
    assert.deepEqual(
      answers.map((answer) => {
        const { url, body } = answer as { url: string; body: Record<string, unknown> };
        return [
          /since=/.test(url),
          "problems" in body,
          (body.added as unknown[] | undefined)?.length,
        ];
      }),
      [[true, false, 1]],
      "the tab is sent only the entry that changed",
    );
    writeIn(folder, { "fine.md": "# Fine\n\nNothing wrong.\n", "rates.csv": "arm,pct\nA,0.81\n" });
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".health-kind summary")].some(
        (summary) => summary.textContent === "Broken links - 4",
      ),
    );
    writeIn(folder, { "notes/files/report.pdf": "%PDF-1.4" });
    await page.waitForFunction(() => {
      const kinds = [...document.querySelectorAll(".health-kind summary")].map(
        (s) => s.textContent,
      );
      return kinds.includes("Broken links - 3") && !kinds.includes("Contradicted figures - 1");
    });

    assert.equal(await page.getAttribute(".health-link", "data-count"), null, "no count");
    assert.equal(await page.textContent(".health-link"), "");
    await page.click("text=notes/links.md:3 >> nth=0");
    await page.waitForURL(/notes\/links\.md#\^/);
    await page.waitForSelector(".landed");
    assert.match((await page.textContent(".landed")) ?? "", /gone file/);

    for (const [entry, address, literal] of [
      [
        "notes/nowhere.md:3",
        /notes\/nowhere\.md#include-notes%2Fnowhere\.md%3A3%3A0$/,
        "{include: parts/absent.md}",
      ],
      ["notes/a.md:3", /notes\/b\.md#include-notes%2Fa\.md%3A3%3A0$/, "{include: b.md}"],
    ]) {
      await page.goto(`${served.base}/?health`);
      await page.click(`text=${entry} >> nth=0`);
      await page.waitForURL(address as RegExp);
      await page.waitForSelector(".include-missing.landed");
      assert.equal(await page.textContent(".include-missing.landed"), literal);
    }

    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Landing, Contents, Declared attention, Listing, Live: opening folio shows what needs you", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-needs-")));
  const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;
  writeIn(folder, {
    "FOLIO.md": `# Needs\n\n${fence(
      [
        "rules:",
        "  no-draft:",
        "    message: '{path} is a draft'",
        "    query: select path from folio.documents where path like '%draft%'",
        "attention:",
        "  on-order:",
        "    message: '{path} is on order'",
        "    query: select path from 'orders.csv'",
      ].join("\n"),
    )}\n`,
    "draft.md": "# Draft\n",
    "spec.md": "# Spec\n",
    "orders.csv": "path\nspec.md\n",
  });
  const served = await serveFolder(folder);

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/`);
    await page.waitForSelector(".needs-attention li");
    assert.equal(await page.textContent(".markdown-body h1"), "What needs you");
    assert.match((await page.textContent(".needs-error")) ?? "", /draft\.md is a draft/);
    assert.match((await page.textContent(".needs-attention")) ?? "", /spec\.md is on order/);
    assert.deepEqual(
      await page.$eval("a.needs-files", (link) => [
        link.parentElement?.textContent,
        link.getAttribute("href"),
        link.nextElementSibling?.getAttribute("href"),
      ]),
      [
        "Every file of the folder \u00b7 Documents that may have outlived their use",
        "/?files",
        "/?stale",
      ],
    );
    await page.click(".needs-stale");
    await page.waitForURL(`${served.base}/?stale`);
    await page.goBack();
    await page.waitForSelector(".needs-attention li");

    writeIn(folder, { "orders.csv": "path\n" });
    await page.waitForSelector(".needs-attention", { state: "detached" });

    await page.click(".needs-files");
    await page.waitForSelector(".markdown-body.listing");
    assert.match((await page.textContent(".markdown-body")) ?? "", /spec\.md/);
    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Read context, Looking at, Pause, Resume: agents share the reader's context until sharing is paused", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-presence-")));
  writeIn(folder, {
    "notes.md": "# Notes\n\nThe valve closes at noon.\n\nThe pump runs at night.\n",
  });
  const served = await serveFolder(folder);
  const api = async (resource: string) =>
    (await fetch(`${served.base}/?api=${resource}`)).json() as Promise<Record<string, unknown>>;

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/notes.md`);
    await page.waitForSelector(".markdown-body > p[data-folio-id]");
    await page.locator(".markdown-body p", { hasText: "pump" }).hover();
    const pump = await page
      .locator(".markdown-body p", { hasText: "pump" })
      .getAttribute("data-folio-id");

    let looking: { page: string; block?: { id: string; text: string } }[] = [];
    for (let tries = 0; looking[0]?.block?.id !== pump; tries++) {
      assert.ok(tries < 100, "presence never arrived");
      await new Promise((resolve) => setTimeout(resolve, 50));
      looking = (await api("presence")).looking as typeof looking;
    }
    assert.equal(looking[0].page, "notes.md");
    assert.match(looking[0].block?.text ?? "", /pump runs at night/);
    assert.equal((await api("reads")).paused, undefined);

    await page.mouse.move(0, 400);
    for (let tries = 0; looking[0]?.block !== undefined; tries++) {
      assert.ok(tries < 100, "the block stayed under the pointer after it left");
      await new Promise((resolve) => setTimeout(resolve, 50));
      looking = (await api("presence")).looking as typeof looking;
    }

    const landing = await context.newPage();
    await landing.goto(`${served.base}/`);
    await landing.click(".sharing-toggle");
    await landing.waitForSelector('.sharing-toggle[aria-pressed="true"]');
    for (const resource of ["presence", "reads", "changes", "needs", "stale"]) {
      assert.equal((await api(resource)).paused, true, resource);
    }
    assert.equal((await api("health")).ready, true, "what is not the reader's is still shared");

    await landing.click(".sharing-toggle");
    await landing.waitForSelector('.sharing-toggle[aria-pressed="false"]');
    assert.equal(((await api("presence")).looking as unknown[]).length > 0, true);
    await Promise.all([page.close(), landing.close()]);
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
