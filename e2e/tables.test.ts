/** Headless Chromium run of folio's documented behaviour: table views and data files opened as pages. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  base,
  caption,
  cells,
  context,
  frameOf,
  keepFrame,
  LEDGER,
  open,
  openData,
  panel,
  pathOf,
  root,
  snapshotOf,
  sourced,
  waitFor,
  waitText,
  write,
  writeData,
} from "./harness.ts";

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

test("Sort, Small tables: a header click sorts numbers as numbers, again in reverse, then as written", async () => {
  write({ "tables/ledger.md": LEDGER });
  const page = await open("tables/ledger.md");
  const small = await page.$eval(".markdown-body table", (table) => ({
    html: table.innerHTML,
    height: table.getBoundingClientRect().height,
  }));

  assert.deepEqual(await cells(page, 1, 1), ["10", "9", "100", ""]);
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1");
  assert.deepEqual(await cells(page, 1, 1), ["9", "10", "100", ""]);
  assert.equal(await caption(page, 1), "4 rows · sorted by Count");
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1");
  assert.deepEqual(await cells(page, 1, 1), ["100", "10", "9", ""]);
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1");
  assert.deepEqual(await cells(page, 1, 1), ["10", "9", "100", ""]);
  assert.equal(await caption(page, 1), null);
  assert.deepEqual(
    await page.$eval(".markdown-body table", (table) => ({
      html: table.innerHTML,
      height: table.getBoundingClientRect().height,
    })),
    small,
  );
  await page.close();
});

test("Keyboard: a header sorts on Enter with its order announced; the filter button follows the headers and shows on focus", async () => {
  write({ "tables/ledger.md": LEDGER });
  const page = await open("tables/ledger.md");
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return element.matches("th") ? `th:${element.textContent}` : element.className;
    });

  await page.focus(".markdown-body table >> nth=1 >> th >> nth=1");
  await page.keyboard.press("Enter");
  assert.deepEqual(await cells(page, 1, 1), ["9", "10", "100", ""]);
  assert.equal(
    await page.getAttribute(".markdown-body table >> nth=1 >> th >> nth=1", "aria-sort"),
    "ascending",
  );
  await page.keyboard.press(" ");
  assert.equal(
    await page.getAttribute(".markdown-body table >> nth=1 >> th >> nth=1", "aria-sort"),
    "descending",
  );
  assert.ok(await page.isVisible(".table-control"));

  const last = await page.$$eval(".markdown-body table >> nth=1 >> th", (cells) => cells.length);
  for (let index = 2; index < last; index++) {
    await page.keyboard.press("Tab");
  }
  assert.equal(await focused(), "th:Note");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), "icon-button table-control");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".table-panel:not([hidden])");
  await page.keyboard.type("r");
  await page.keyboard.press("Escape");
  assert.match((await caption(page, 1)) ?? "", /^\d of 4 rows/);
  assert.equal(await focused(), "th:Item");

  await page.focus(".markdown-body table >> nth=1 >> th >> nth=-1");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(), "th:Note");
  await page.close();
});

test("Keyboard, Hidden last column: the filter button follows the last header shown, the column comes back, and Tab leaves the panel past the table", async () => {
  write({
    "tables/keys.md": [
      "# Keys",
      "",
      "| Item | Count | Note |",
      "|---|---|---|",
      "| pear | 10 | ripe |",
      "| fig | 9 | dried |",
      "",
      "[After the table](#keys)",
    ].join("\n"),
  });
  const page = await open("tables/keys.md");
  await sourced(page);
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return element.matches("th")
        ? `th:${element.textContent}`
        : element.matches("input[type=checkbox]")
          ? `box:${element.parentElement?.textContent}`
          : element.textContent || element.className;
    });

  await panel(page, 0);
  await page.click('.table-panel li:nth-child(3) input[type="checkbox"]');
  await page.keyboard.press("Escape");
  assert.equal(await page.isVisible(".markdown-body th >> nth=2"), false);

  await page.focus(".markdown-body th >> nth=0");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), "th:Count");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), "icon-button table-control");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".table-panel:not([hidden])");

  for (let step = 0; step < 20 && (await focused()) !== "box:Note"; step++) {
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press(" ");
  assert.equal(await focused(), "box:Note");
  assert.equal(await page.isVisible(".markdown-body th >> nth=2"), true);

  for (let step = 0; step < 20 && (await focused()) !== "Show as written"; step++) {
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Tab");
  assert.equal(await focused(), "After the table");
  assert.equal(await page.isVisible(".table-panel"), false);
  await page.close();
});

test("Filter, Hide columns: the table's filter and a column's narrow the rows with a count; a column hides and returns", async () => {
  write({ "tables/ledger.md": LEDGER });
  const page = await open("tables/ledger.md");

  await panel(page, 1);
  await page.fill('.table-panel input[aria-label="Filter rows"]', "r");
  assert.deepEqual(await cells(page, 1, 0), ["pear", "apple", "fig"]);
  assert.equal(await caption(page, 1), "3 of 4 rows");
  await page.fill('.table-panel input[aria-label="Filter Note"]', "e");
  assert.deepEqual(await cells(page, 1, 0), ["pear", "apple", "fig"]);
  await page.fill('.table-panel input[aria-label="Filter Note"]', "rip");
  assert.deepEqual(await cells(page, 1, 0), ["pear"]);
  assert.equal(await caption(page, 1), "1 of 4 rows");
  await page.fill('.table-panel input[aria-label="Filter rows"]', "");
  await page.fill('.table-panel input[aria-label="Filter Note"]', "");

  const shown = () =>
    page.$$eval(".markdown-body table >> nth=1 >> th", (heads) =>
      heads.filter((th) => getComputedStyle(th).display !== "none").map((th) => th.textContent),
    );
  await page.click('.table-panel label:has-text("Count") input');
  assert.deepEqual(await shown(), ["Item", "Note"]);
  assert.equal(await caption(page, 1), "4 rows · 1 hidden column");
  await page.click('.table-panel label:has-text("Count") input');
  assert.deepEqual(await shown(), ["Item", "Count", "Note"]);
  assert.equal(await caption(page, 1), null);
  await page.close();
});

test("Long table: the first rows of a long table show, with a way to show the rest", async () => {
  write({ "tables/ledger.md": LEDGER });
  const page = await open("tables/ledger.md");

  assert.equal((await cells(page, 4, 0)).length, 50);
  assert.equal((await cells(page, 4, 0))[49], "run-50");
  await page.click('.markdown-body button:has-text("Show all 300 rows")');
  assert.equal((await cells(page, 4, 0)).length, 300);
  await page.click('.markdown-body button:has-text("Show the first 50 rows")');
  assert.equal((await cells(page, 4, 0)).length, 50);
  await page.close();
});

test("Every table: a loose table and one with no header row sort, filter and fold through the panel", async () => {
  write({ "tables/ledger.md": LEDGER });
  const page = await open("tables/ledger.md");

  assert.deepEqual(await cells(page, 2, 0), ["loose", "other"]);
  await panel(page, 2);
  await page.click('.table-panel button[aria-label="Sort by Column 2"]');
  assert.deepEqual(await cells(page, 2, 0), ["other", "loose"]);
  await page.fill('.table-panel input[aria-label="Filter rows"]', "extra");
  assert.deepEqual(await cells(page, 2, 0), ["other"]);
  await page.keyboard.press("Escape");

  await panel(page, 3);
  await page.click('.table-panel button[aria-label="Sort by 5"]');
  assert.deepEqual(await cells(page, 3, 0), ["6", "7"]);
  await page.close();
});

test("File untouched, Edits: a sorted, filtered table keeps its view through saves; the file and other tabs see it as written", async () => {
  write({ "tables/ledger.md": LEDGER });
  const page = await open("tables/ledger.md");

  await sourced(page);
  await page.click(".markdown-body table >> nth=1 >> th >> nth=1");
  await panel(page, 1);
  await page.click('.table-panel label:has-text("Note") input');
  await page.fill('.table-panel input[aria-label="Filter rows"]', "p");
  await page.keyboard.press("Escape");
  assert.deepEqual(await cells(page, 1, 0), ["apple", "pear"]);

  const other = await open("tables/ledger.md");
  assert.deepEqual(await cells(other, 1, 0), ["pear", "apple", "fig", "kiwi"]);
  assert.equal(fs.readFileSync(path.join(root, "tables/ledger.md"), "utf8"), LEDGER);
  await other.close();

  write({ "tables/ledger.md": LEDGER.replace("Above the tables.", "Above the tables, edited.") });
  await waitText(page, "edited");
  assert.deepEqual(await cells(page, 1, 0), ["apple", "pear"]);

  write({
    "tables/ledger.md": LEDGER.replace("Above the tables.", "Above the tables, edited.").replace(
      "| fig | 100 | dried |",
      "| plum | 1 | soft |\n| fig | 100 | dried |",
    ),
  });
  await waitFor(async () => (await cells(page, 1, 0)).join() === "plum,apple,pear");
  assert.equal(await caption(page, 1), "3 of 5 rows · sorted by Count · 1 hidden column");
  await page.close();
});

test("Tabular file, Nested file, Database: data files open as tables, trees and lists of tables", async () => {
  await writeData();
  const page = await openData("store/visits.csv");

  assert.equal(await page.$eval(".markdown-body h1", (h) => h.textContent), "visits.csv");
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^CSV · \d+ bytes · 3 rows$/,
  );
  assert.deepEqual(
    await page.$$eval(".markdown-body th", (cells) => cells.map((cell) => cell.textContent)),
    ["city", "visits"],
  );
  assert.deepEqual(
    await page.$$eval(".markdown-body tbody td", (cells) => cells.map((cell) => cell.textContent)),
    ["Oslo", "1204", "Lima", "87", "Rome", "9"],
  );

  for (const [file, first] of [
    ["store/visits.jsonl", "Oslo"],
    ["store/visits.parquet", "0"],
    ["store/visits.tsv", "Oslo"],
  ]) {
    await page.goto(`${base}/${file}`);
    await page.waitForSelector(".markdown-body tbody td");
    assert.equal(
      await page.$eval(".markdown-body tbody td", (cell) => cell.textContent),
      first,
      file,
    );
  }

  await page.goto(`${base}/store/kit.json`);
  await page.waitForSelector(".data-tree");
  assert.equal(await page.$eval(".data-tree > summary", (s) => s.textContent), "{2}");
  assert.equal(await page.$eval(".data-tree", (d) => (d as HTMLDetailsElement).open), true);
  await page.click(".data-tree > summary");
  assert.equal(await page.$eval(".data-tree", (d) => (d as HTMLDetailsElement).open), false);

  await page.goto(`${base}/store/people.yaml`);
  await page.waitForSelector(".markdown-body tbody td");
  assert.deepEqual(
    await page.$$eval(".markdown-body tbody td", (cells) => cells.map((cell) => cell.textContent)),
    ["ada", "36", "bob", ""],
  );
  await page.click('.data-switch:has-text("Tree")');
  assert.equal(await page.isVisible(".markdown-body table"), false);
  assert.equal(await page.isVisible(".data-tree"), true);

  await page.goto(`${base}/store/shop.sqlite`);
  await page.waitForSelector(".markdown-body h2");
  assert.deepEqual(
    await page.$$eval(".markdown-body h2", (headings) => headings.map((h) => h.textContent)),
    ["orders"],
  );
  assert.match(
    await page.$eval(".markdown-body h2 + .data-info", (p) => p.textContent ?? ""),
    /^12 rows · id INTEGER, item TEXT · Open the whole table$/,
  );
  assert.equal(await page.$$eval(".markdown-body tbody tr", (rows) => rows.length), 10);
  await page.click('a:has-text("Open the whole table")');
  await page.waitForSelector(".markdown-body h1:has-text('orders')");
  assert.equal(await page.$$eval(".markdown-body tbody tr", (rows) => rows.length), 12);
  assert.equal(new URL(page.url()).search, "?table=orders");

  await page.goto(`${base}/store/shop.duckdb`);
  await page.waitForSelector(".markdown-body h2");
  assert.deepEqual(
    await page.$$eval(".markdown-body h2", (headings) => headings.map((h) => h.textContent)),
    ["stock"],
  );
  await page.close();
});

test("Large file, Broken file: a large file shows its start and says so; a malformed one says what is wrong", async () => {
  await writeData();
  const item = `{"key": "${"x".repeat(1000)}"},`;
  write({ "store/huge.json": `[${item.repeat(21 * 1024)}{}]` });

  const page = await openData("store/huge.json");
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^JSON · 21 MB · too large to show whole; showing its start$/,
  );
  assert.ok(
    (await page.$eval(".markdown-body pre", (pre) => pre.textContent ?? "")).startsWith(`[${item}`),
  );

  await page.goto(`${base}/store/many.parquet`);
  await page.waitForSelector(".markdown-body tbody td");
  assert.match(
    await page.$eval(".data-info", (p) => p.textContent ?? ""),
    /^PARQUET · .+ · showing its first 5,000 rows$/,
  );

  await page.goto(`${base}/store/broken.csv`);
  await page.waitForSelector(".data-error");
  const error = await page.$eval(".data-error", (p) => p.textContent ?? "");
  assert.match(error, /store\/broken\.csv/);
  assert.match(error, /\n\n1 row could not be read and is left out\.$/);
  assert.deepEqual(
    await page.$$eval(".markdown-body tbody td", (cells) => cells.map((cell) => cell.textContent)),
    ["Oslo", "1204", "Rome", "9"],
  );
  await page.close();
});

test("Growing file: rows appended to an open data file appear as they arrive", async () => {
  await writeData();
  const page = await openData("store/visits.csv");

  fs.appendFileSync(path.join(root, "store/visits.csv"), "Kyiv,44\n");
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body")?.textContent?.includes("Kyiv"),
  );
  fs.appendFileSync(path.join(root, "store/visits.csv"), "Baku,5\n");
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body")?.textContent?.includes("Baku"),
  );
  assert.match(await page.$eval(".data-info", (p) => p.textContent ?? ""), /5 rows$/);
  await page.close();
});

test("Linked, Tree toggle: a link to a data file opens it inside folio; the tree lists data files only when asked", async () => {
  await writeData();
  const page = await open("store/index.md");

  assert.deepEqual(await treeNames(page, "store"), ["index.md"]);
  await keepFrame(page);
  await page.click('a[href="visits.csv"]');
  await page.waitForSelector(".markdown-body tbody td");
  assert.equal((await frameOf(page)).kept, true);
  assert.equal(await pathOf(page), "store/visits.csv");

  await page.hover(".tree");
  await page.click(".tree-data");
  await waitFor(async () => (await treeNames(page, "store")).includes("visits.csv"));
  assert.ok((await treeNames(page, "store")).includes("shop.sqlite"));
  await page.click(".tree-data");
  await waitFor(async () => !(await treeNames(page, "store")).includes("visits.csv"));
  assert.deepEqual(await treeNames(page, "store"), ["index.md"]);
  await page.close();
});

test("Toggle position, Table control position, Toggle hidden, Pointer back, Keyboard, Backgrounds: controls sit clear of their block's edge", async () => {
  const wide = `| ${Array.from({ length: 12 }, (_, i) => `column number ${i}`).join(" | ")} |`;
  write({
    "edges/tables.md": [
      "# Edges",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      `${wide}\n|${"---|".repeat(12)}\n|${" x |".repeat(12)}`,
    ].join("\n\n"),
    "edges/n.csv": "n\n1\n",
  });
  const page = await open("edges/tables.md");
  const placed = (table: number) =>
    page.evaluate((at) => {
      const control = (
        document.querySelector(".table-control") as HTMLElement
      ).getBoundingClientRect();
      const box = document.querySelectorAll(".markdown-body table")[at].getBoundingClientRect();
      return control.top - box.top;
    }, table);
  const toggle = () =>
    page.$eval(".tree-data", (button) => {
      const style = getComputedStyle(button);
      const box = button.getBoundingClientRect();
      const tree = (document.querySelector(".tree") as Element).getBoundingClientRect();
      const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return [
        box.top - tree.top,
        style.opacity,
        under === button || button.contains(under),
        button.getAttribute("aria-pressed"),
      ];
    });
  const away = () => page.mouse.move(700, 400);
  const seen: Record<string, unknown> = {};

  await page.focus(".markdown-body table >> nth=0 >> th >> nth=0");
  await away();
  seen.headerFocused = await page.isVisible(".table-control");
  await page.click(".markdown-body table >> nth=0 >> th >> nth=1");
  await away();
  seen.headerClicked = await page.isVisible(".table-control");
  await page.hover(".markdown-body table >> nth=0");
  seen.narrow = await placed(0);
  await page.hover(".markdown-body table >> nth=1");
  seen.wide = await placed(1);
  seen.controlBackground = await page.$eval(
    ".table-control",
    (control) => getComputedStyle(control).backgroundColor,
  );

  await page.hover(".tree");
  seen.pointed = await toggle();
  await away();
  seen.away = await toggle();
  await page.hover(".tree");
  await page.click(".tree-data");
  await waitFor(async () => (await treeNames(page, "edges")).includes("n.csv"));
  await away();
  seen.awayShown = [...(await toggle()), (await treeNames(page, "edges")).includes("n.csv")];
  await page.hover(".tree");
  seen.back = await toggle();
  seen.toggleBackground = await page.$eval(
    ".tree-data",
    (button) => getComputedStyle(button).backgroundColor,
  );
  await page.click(".tree-data");
  await waitFor(async () => !(await treeNames(page, "edges")).includes("n.csv"));
  await away();
  await page.evaluate(() => {
    const focusable = [
      ...document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]"),
    ].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const at = focusable.indexOf(document.querySelector(".tree-data") as HTMLElement);
    focusable[at + 1].dataset.next = "";
  });
  await page.focus("[data-next]");
  await page.keyboard.press("Shift+Tab");
  seen.keyboard = [await page.evaluate(() => document.activeElement?.className), await toggle()];
  await page.click('button[title="Switch theme"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.hover(".markdown-body table >> nth=0");
  await page.hover(".tree");
  seen.dark = await page.evaluate(() =>
    [".table-control", ".tree-data"].map(
      (selector) => getComputedStyle(document.querySelector(selector) as Element).backgroundColor,
    ),
  );
  await page.click('button[title="Switch theme"]');
  await page.close();

  assert.deepEqual(seen, {
    headerFocused: true,
    headerClicked: false,
    narrow: 1,
    wide: 1,
    controlBackground: "rgb(255, 255, 255)",
    pointed: [9, "1", true, "false"],
    away: [9, "0", false, "false"],
    awayShown: [9, "0", false, "true", true],
    back: [9, "1", true, "true"],
    toggleBackground: "rgb(255, 255, 255)",
    keyboard: ["icon-button tree-data", [9, "1", true, "false"]],
    dark: ["rgb(26, 26, 26)", "rgb(26, 26, 26)"],
  });
});

test("Folder untouched: opening every kind of data file writes nothing into the folder", async () => {
  await writeData();
  const before = snapshotOf(path.join(root, "store"));
  const page = await openData("store/visits.csv");

  for (const file of [
    "store/shop.sqlite",
    "store/shop.duckdb",
    "store/visits.parquet",
    "store/kit.json",
    "store/people.yaml",
    "store/visits.jsonl",
    "store/shop.sqlite?table=orders",
  ]) {
    await page.goto(`${base}/${file}`);
    await page.waitForSelector(".markdown-body h1");
  }

  assert.deepEqual(snapshotOf(path.join(root, "store")), before);
  await page.close();
});

test("Merged cells: rows a cell spans down sort together, and a merged header narrows as its columns hide", async () => {
  write({
    "spans/table.md": [
      "# Spans",
      "",
      '<table><thead><tr><th colspan="2">Who</th><th>Score</th></tr></thead><tbody>',
      '<tr><td rowspan="2">Red</td><td>b</td><td>2</td></tr>',
      "<tr><td>c</td><td>9</td></tr>",
      "<tr><td>Blue</td><td>a</td><td>5</td></tr>",
      "</tbody></table>",
    ].join("\n"),
  });

  const page = await open("spans/table.md");
  await page.click("th:text-is('Score')");
  await page.click("th:text-is('Score')");
  assert.deepEqual(await cells(page, 0, 0), ["Blue", "Red", "c"], "Red's two rows stay together");
  await panel(page, 0);
  await page.uncheck(".table-panel label:has-text('Who') >> nth=1 >> input");
  assert.deepEqual(
    await page.$eval("th:text-is('Who')", (cell) => [
      (cell as HTMLTableCellElement).colSpan,
      (cell as HTMLElement).hidden,
    ]),
    [1, false],
    "the merged header spans the one column still shown",
  );
  assert.deepEqual(
    await page.$$eval(".markdown-body td", (all) =>
      all.flatMap((cell) => ((cell as HTMLElement).hidden ? [cell.textContent] : [])),
    ),
    ["a", "b", "c"],
  );
  await page.close();
});

test("Rarer inputs: merged cells, a save under the filter panel, long lists, chart links and long view addresses", async () => {
  write({
    "rare/merged.md": [
      "# Merged",
      "",
      '<table><thead><tr><th colspan="2">Name</th><th>Score</th></tr></thead><tbody>',
      "<tr><td>b</td><td>x</td><td>2</td></tr>",
      '<tr><td colspan="2">a</td><td>10</td></tr>',
      "<tr><td>c</td><td>y</td><td>1</td></tr>",
      "</tbody></table>",
    ].join("\n"),
    "rare/save.md": "# Save\n\n| City | Visits |\n|---|---|\n| Oslo | 3 |\n| Lima | 4 |\n",
    "rare/big.json": JSON.stringify(Array.from({ length: 6000 }, (_, id) => ({ id }))),
    "rare/chart.md": [
      "# Chart",
      "",
      "```vega-lite",
      '{"data": {"values": [{"a": 1, "u": "javascript:alert(1)"}]}, "mark": "bar",',
      ' "encoding": {"x": {"field": "a", "type": "quantitative"}, "href": {"field": "u"}}}',
      "```",
    ].join("\n"),
  });

  const merged = await open("rare/merged.md");
  await merged.click("th:text-is('Score')");
  assert.deepEqual(await cells(merged, 0, 0), ["c", "b", "a"], "sorted by the score column");
  await panel(merged, 0);
  await merged.uncheck(".table-panel label:has-text('Score') input");
  assert.deepEqual(
    await merged.$$eval(".markdown-body td", (all) =>
      all.flatMap((cell) => ((cell as HTMLElement).hidden ? [cell.textContent] : [])),
    ),
    ["1", "2", "10"],
    "only the score column hides",
  );
  await merged.close();

  const save = await open("rare/save.md");
  await panel(save, 0);
  const field = await save.$(".table-panel input[data-key='all']");
  await save.keyboard.type("o");
  assert.equal(
    await save.evaluate((held) => document.activeElement === held, field),
    true,
    "typing keeps the field it types into",
  );
  write({
    "rare/save.md":
      "# Save\n\n| City | Visits |\n|---|---|\n| Oslo | 3 |\n| Lima | 4 |\n| Rome | 5 |\n",
  });
  await save.waitForFunction(
    () => document.querySelectorAll(".markdown-body tbody tr").length === 3,
  );
  assert.equal(await save.isVisible(".table-panel"), true, "the panel stays open");
  assert.equal(
    await save.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value),
    "o",
    "the filter keeps focus and text",
  );
  await save.close();

  const big = await context.newPage();
  await big.goto(`${base}/rare/big.json`);
  await big.click(".data-switch:text-is('Table')");
  await big.waitForSelector(".markdown-body tbody tr");
  assert.equal(await big.locator(".markdown-body tbody tr").count(), 5000);
  assert.match((await big.textContent(".markdown-body")) ?? "", /The first 5,000 of 6,000 records/);
  await big.close();

  const errors: string[] = [];
  const chart = await context.newPage();
  chart.on("pageerror", (error) => errors.push(error.message));
  await chart.goto(`${base}/rare/chart.md`);
  await chart.waitForSelector(".embed-chart .chart svg");
  await chart.waitForTimeout(500);
  assert.deepEqual(errors, [], "a link the chart refuses throws nothing");
  await chart.close();

  const view = Buffer.from(
    JSON.stringify({ "rare/save.md~@0": { filter: "x".repeat(21_000) } }),
  ).toString("base64url");
  assert.equal((await fetch(`${base}/rare/save.md?view=${view}`)).status, 200);
});

async function treeNames(page: Page, folder: string): Promise<string[]> {
  return page.$$eval(`.tree li[data-path="${folder}"] > ul > li`, (items) =>
    items.map((item) => item.textContent ?? ""),
  );
}
