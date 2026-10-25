/** Headless Chromium run of folio's documented behaviour: checked figures and where each block came from. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { context, open, serveFolder, waitFor, waitText, write, writeIn } from "./harness.ts";

test("Matching figure, Contradicted figure, Precision, Data moves, Untied figures: a figure in prose is checked against its data", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-claims-")));
  writeIn(folder, {
    "rates.csv": "arm,pct\nA,0.8104\nB,0.806\nC,0.816\n",
    "report.md": [
      "# Report",
      "",
      'Arm A converted <data value="rates.csv#0.pct">81.0%</data> of visitors.',
      "",
      'Arm B <data value="rates.csv#1.pct">81%</data>, arm C <data value="rates.csv#2.pct">81%</data>, overall 75% untied.',
      "",
      'The query counts <data value="#arms#0.n">3</data> arms.',
      "",
      "```sql query arms",
      "select count(*) as n from 'rates.csv'",
      "```",
    ].join("\n"),
  });
  const served = await serveFolder(folder);
  const json = async (address: string) => (await fetch(`${served.base}/${address}`)).json();

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/report.md`);
    await page.waitForSelector(".embed-claim.claim-contradicted");
    await page.waitForTimeout(300);
    const claims = () =>
      page.$$eval(".embed-claim", (found) =>
        found.map((claim) => [
          claim.childNodes[0]?.textContent,
          claim.classList.contains("claim-contradicted"),
          claim.querySelector(".claim-live")?.textContent ?? null,
        ]),
      );

    assert.deepEqual(await claims(), [
      ["81.0%", false, null],
      ["81%", false, null],
      ["81%", true, "82%"],
      ["3", false, null],
    ]);
    assert.equal(
      await page.$eval(".markdown-body p", (p) => p.childNodes[0].textContent),
      "Arm A converted ",
    );
    assert.match((await page.textContent(".markdown-body p >> nth=1")) ?? "", /overall 75% untied/);
    await page.waitForTimeout(2500);

    writeIn(folder, { "rates.csv": "arm,pct\nA,0.79\nB,0.806\nC,0.816\nD,0.5\n" });
    await page.waitForFunction(() => document.querySelectorAll(".claim-contradicted").length === 3);
    assert.deepEqual(await claims(), [
      ["81.0%", true, "79.0%"],
      ["81%", false, null],
      ["81%", true, "82%"],
      ["3", true, "4"],
    ]);
    await page.close();

    await waitFor(async () => (await json("report.md?read")).marks.length === 4);
    assert.deepEqual(
      (await json("report.md?read")).marks.flatMap(({ data }: { data?: string[] }) => data),
      ["rates.csv#0.pct", "rates.csv#1.pct", "rates.csv#2.pct", "#arms#0.n", "#arms"],
    );
    assert.deepEqual(
      (await json("?changed")).documents.map((d: { path: string }) => d.path),
      ["report.md"],
    );
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Range figure, Why, Health, Unreadable data: a figure left unchecked on purpose reads as typed", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-ranges-")));
  writeIn(folder, {
    "rates.csv": "arm,pct\nA,0.4\n",
    "report.md": [
      "# Report",
      'The arms converted <data value="rates.csv#0.pct">29-56%</data> of visitors.',
      'A missing arm converted <data value="rates.csv#9.pct">12%</data>.',
      'The whole table reads <data value="rates.csv">40%</data>.',
      'An included figure <data value="rates.csv#0.pct">{include: nope.md}</data>.',
    ].join("\n\n"),
  });
  const served = await serveFolder(folder);

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/report.md`);
    await page.waitForFunction(() => document.querySelectorAll(".embed-claim[title]").length === 4);
    await page.waitForTimeout(500);
    const shown = await page.$$eval(".markdown-body p[data-folio-id]", (paragraphs) =>
      paragraphs.map((p) => {
        const claim = p.querySelector(".embed-claim") as HTMLElement;
        const flags = [...document.querySelectorAll<HTMLElement>(".problem-flag")];
        return [
          claim.textContent,
          claim.classList.contains("embed-missing") ||
            claim.classList.contains("claim-contradicted"),
          claim.title,
          flags.some((flag) => flag.dataset.folioId === p.dataset.folioId),
        ];
      }),
    );
    const problems = async () =>
      (
        (await (await fetch(`${served.base}/?health-data`)).json()) as {
          problems?: { what: string }[];
        }
      ).problems?.map(({ what }) => what);

    assert.deepEqual(shown, [
      ["29-56%", false, "29-56% is a range, not one figure to check.", false],
      ["12%", true, "Nothing at 9.", true],
      ["40%", true, "Not a single value: name a row and column, as in #0.total.", true],
      ["{include: nope.md}", false, "An include in this figure resolves to nothing.", true],
    ]);
    await waitFor(async () => (await problems()) !== undefined);
    assert.deepEqual((await problems())?.sort(), [
      "Includes nope.md, which is not there",
      "rates.csv#9.pct: Nothing at 9.",
      "rates.csv: Not a single value: name a row and column, as in #0.total.",
    ]);
    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Contradicted figure, Outline: a heading holding a tied figure lists the figure as typed", async () => {
  write({
    "ties/rates.csv": "arm,pct\nA,0.816\n",
    "ties/heading.md":
      '# Ties\n\n## Rate <data value="rates.csv#0.pct">81%</data> this week\n\nText.\n',
  });
  const page = await open("ties/heading.md");
  await page.waitForSelector("h2 .claim-contradicted .claim-live");

  assert.deepEqual(
    await page.$$eval(".outline a", (links) => links.map((link) => link.textContent)),
    ["Ties", "Rate 81% this week"],
  );
  await page.close();
});

test("Own block, Included block, Computed block, Trust, Problems unasked, Quiet otherwise: every block shows where it came from", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-provenance-")));
  writeIn(folder, {
    "rates.csv": "arm,pct\nA,0.8104\nB,0.816\n",
    "parts/pumps.md":
      "# Pumps\n\n## Seals\n\nSeals wear out in spring.\n\n## Valves\n\nValves close.\n",
    "report.md": [
      "# Report",
      "",
      "Plain words of our own.",
      "",
      "{include: parts/pumps.md#seals}",
      "",
      "{include: parts/pumps.md}",
      "",
      "{table: rates.csv}",
      "",
      'Shown {value: rates.csv#0.pct} and tied <data value="rates.csv#0.pct">81.0%</data>.',
      "",
      'Arm A <data value="rates.csv#0.pct">81.0%</data>, arm B <data value="rates.csv#1.pct">81%</data>.',
      "",
      "```sql query broken",
      "select nothing from 'absent.csv'",
      "```",
    ].join("\n"),
    "plain.md": "# Plain\n\nNothing wrong here.\n\n- one\n- two\n",
  });
  const served = await serveFolder(folder);

  try {
    const page = await context.newPage();
    await page.goto(`${served.base}/plain.md`);
    await waitText(page, "Nothing wrong here.");
    await page.waitForTimeout(500);
    assert.equal(
      await page.locator(".problem-flag").count(),
      0,
      "an ordinary page carries no flag",
    );
    assert.equal(await page.isVisible(".provenance-panel"), false);

    await page.goto(`${served.base}/report.md`);
    await page.waitForSelector(".claim-contradicted");
    await page.waitForSelector(".embed-query.embed-missing");
    await page.waitForFunction(() => document.querySelectorAll(".problem-flag").length === 2);
    const flagged = await page.$$eval(".problem-flag", (flags) =>
      flags.map((flag) => {
        const { folioId, folioSource } = (flag as HTMLElement).dataset;
        return document
          .querySelector(`[data-folio-source="${folioSource}"][data-folio-id="${folioId}"]`)
          ?.textContent?.slice(0, 5);
      }),
    );
    assert.deepEqual(flagged, ["Arm A", "Query"]);

    const provenanceOf = async (text: string, control = ".block-provenance") => {
      await page.hover(`.markdown-body > :has-text("${text}")`);
      await page.click(control);
      await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line");
      const lines = await page.$$eval(".provenance-panel .provenance-line", (found) =>
        found.map((line) => line.textContent ?? ""),
      );
      const query = await page.$$eval(".provenance-panel pre", (found) =>
        found.map((pre) => pre.textContent),
      );
      await page.keyboard.press("Escape");
      return { lines, query };
    };

    const own = await provenanceOf("Plain words of our own.");
    assert.match(own.lines[0], /^report\.md lines 3-3, changed .+/);
    assert.equal(own.lines.length, 1);

    const included = await provenanceOf("Seals wear out in spring.");
    assert.match(included.lines[0], /^parts\/pumps\.md lines 5-5, changed /);
    assert.equal(included.lines[1], 'Included: the section "Seals" of parts/pumps.md');

    await page.hover('.markdown-body > :has-text("Seals wear out in spring.") >> nth=1');
    await page.click(".block-provenance");
    await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line");
    assert.equal(
      await page.textContent(".provenance-panel .provenance-line >> nth=1"),
      "Included: the whole of parts/pumps.md",
      "the same block included again whole says so",
    );
    await page.keyboard.press("Escape");

    await page.hover(".markdown-body h1");
    await page.click(".block-provenance");
    await page.waitForSelector(".provenance-panel:not([hidden]) .provenance-line");
    assert.match(
      (await page.textContent(".provenance-panel .provenance-line")) ?? "",
      /^report\.md lines 1-1, changed /,
    );
    assert.equal(await page.isVisible(".block-link"), false, "a heading keeps its own link mark");
    await page.keyboard.press("Escape");

    const shared = await provenanceOf("Shown");
    assert.deepEqual(
      shared.lines.slice(1).map((line) => line.replace(/\(changed .+\)/, "(changed)")),
      [
        "Data: rates.csv#0.pct - reads rates.csv (changed)",
        "Figure 81.0% (rates.csv#0.pct): matches its data",
      ],
    );

    const table = await provenanceOf("arm");
    assert.match(table.lines[1], /^Data: rates\.csv - reads rates\.csv \(changed .+\)$/);

    const query = await provenanceOf("Query", ".problem-flag >> nth=1");
    assert.match(query.lines[1], /^Query/);
    assert.deepEqual(query.query, ["select nothing from 'absent.csv'"]);

    const trust = await provenanceOf("Arm A", ".problem-flag >> nth=0");
    assert.deepEqual(trust.lines.slice(1), [
      "Figure 81.0% (rates.csv#0.pct): matches its data",
      "Figure 81% (rates.csv#1.pct): contradicted - the data says 82%",
    ]);

    // The whole-file include brings its own top heading, whose section holds both flagged blocks.
    await page.hover(".markdown-body h1 >> nth=1");
    await page.click(".markdown-body h1 >> nth=1 >> .fold-toggle");
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>(".problem-flag")].every((flag) => flag.hidden),
    );
    await page.click(".markdown-body h1 >> nth=1 >> .fold-toggle");
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>(".problem-flag")].every((flag) => !flag.hidden),
    );

    writeIn(folder, { "rates.csv": "arm,pct\nA,0.8104\nB,0.81\n" });
    await page.waitForFunction(() => document.querySelectorAll(".problem-flag").length === 1);
    await page.click(".problem-flag");
    await page.waitForSelector(".provenance-panel:not([hidden]) pre");
    assert.match((await page.textContent(".provenance-panel")) ?? "", /absent\.csv/);
    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Marker characters, Link to an include, Query text changes: ties, formulas and links around includes", async () => {
  const lines = (sql: string) =>
    [
      "# Edges",
      "",
      'Tied <data value="n.csv#0.n">{include: nope.md}</data> here.',
      "",
      "Math $x + {include: nope.md}$ here.",
      "",
      "A [link]({include: nope.md}) here.",
      "",
      'Query tie <data value="#q#0.n">81</data>.',
      "",
      "```sql query q",
      sql,
      "```",
    ].join("\n");
  write({ "edges/n.csv": "n\n81\n", "edges/page.md": lines("select n from 'n.csv'") });
  const page = await open("edges/page.md");
  await page.waitForSelector(
    '.embed-claim[title="An include in this figure resolves to nothing."]',
  );
  await page.waitForSelector(".query-result table");

  assert.deepEqual(
    await page.$$eval(".embed-claim", (ties) =>
      ties.map((tie) => (tie as HTMLElement).dataset.figure),
    ),
    ["{include: nope.md}", "81"],
  );
  assert.equal(
    await page.locator(".claim-contradicted, .embed-claim.embed-missing").count(),
    0,
    "the include tie is unchecked, its include alone marked",
  );
  assert.deepEqual(
    await page.$$eval("[title], [data-figure]", (all) =>
      all.flatMap((element) =>
        /[\uE000-\uE0FF]/.test(element.outerHTML) ? [element.outerHTML.slice(0, 80)] : [],
      ),
    ),
    [],
    "no private character reaches an attribute",
  );
  assert.equal(
    await page.getAttribute(".markdown-body p a:text-is('link')", "href"),
    "{include%3A nope.md}",
  );

  write({ "edges/page.md": lines("select n + 1 as n from 'n.csv'") });
  await page.waitForSelector(".claim-contradicted .claim-live:text-is('82')");
  await page.close();
});
