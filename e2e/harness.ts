/** Fixture folders, a folio server and a headless Chromium for the browser tests; each test file gets its own. */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

export const CLI = path.join(import.meta.dirname, "../dist/cli.js");
export const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-")));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-state-"));
export const ENV = { ...process.env, XDG_STATE_HOME: state };

export const FILES: Record<string, string> = {
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
  "notes/parts/inline.md": [
    "<u>underlined</u> <small>fine print</small> <cite>A Title</cite> <dfn>term</dfn> plain",
    "",
    '<big>big</big> <font color="red">red</font>',
    "",
    "<center>centered</center>",
    "",
    "Marked later.",
  ].join("\n"),
  "data/table.csv": "a,b",
  "data/table.txt": "a b",
  ".git/HEAD.md": "x",
  ".cache/x.md": "x",
  "node_modules/pkg/README.md": "x",
};

let server: ChildProcess;
export let port = 0;
export let base = "";
export let output = "";
export let browser: Browser;
export let context: BrowserContext;

before(async () => {
  write(FILES);
  port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, [CLI, root, "--port", String(port)], { env: ENV });
  server.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  await until(() => output.includes(base));
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

export function visible(page: Page, text: string): Promise<boolean> {
  return page.evaluate(
    (t) =>
      [...document.querySelectorAll(".markdown-body p")]
        .find((p) => p.textContent === t)
        ?.checkVisibility() ?? false,
    text,
  );
}

export const LEDGER = [
  "# Ledger",
  "",
  "Above the tables.",
  "",
  "| Name | Score |",
  "|---|---|",
  "| a | 2 |",
  "",
  "| Item | Count | Note |",
  "|---|---|---|",
  "| pear | 10 | ripe |",
  "| apple | 9 | green |",
  "| fig | 100 | dried |",
  "| kiwi |  | none |",
  "",
  "| loose | 3 |",
  "| other | 1 | extra |",
  "",
  "Between.",
  "",
  "| 5 | five |",
  "|---|---|",
  "| 7 | seven |",
  "| 6 | six |",
  "",
  "| Run | Value |",
  "|---|---|",
  ...Array.from({ length: 300 }, (_, i) => `| run-${i + 1} | ${(i * 7) % 300} |`),
  "",
  "Below the tables.",
].join("\n");

export async function open(urlPath: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/${urlPath}`);
  await page.waitForSelector(".markdown-body > *");
  await page.waitForSelector(".tree .current");
  // The first subscription lands after the first render; saves before it would go unheard.
  await page.waitForTimeout(300);
  return page;
}

export async function pathOf(page: Page): Promise<string> {
  return page.evaluate(() => decodeURIComponent(location.pathname).slice(1));
}

export async function settled(urlPath: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/${urlPath}`);
  await landed(page);
  return page;
}

/**
 * The tree loads beside the content and reveals its current file once its folders are open.
 * A page served before its blocks were parsed is redrawn once they are, so a test touching it waits.
 */
export async function sourced(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector(".markdown-body > [data-folio-source]:not([data-folio-id])"),
  );
  await page.waitForTimeout(100);
}

export async function landed(page: Page): Promise<void> {
  await page.waitForSelector(".markdown-body > *");
  await page.waitForSelector(".tree .current");
  await page.waitForTimeout(300);
}

/** Marks the frame and the document, so a reload or a rebuilt frame shows as a lost mark. */
export async function keepFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as { kept?: boolean }).kept = true;

    for (const selector of [".bar", ".tree", ".outline"]) {
      (document.querySelector(selector) as HTMLElement).dataset.kept = "";
    }
  });
}

export async function frameOf(page: Page) {
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

export function write(files: Record<string, string | Buffer>): void {
  writeIn(root, files);
}

export function writeIn(folder: string, files: Record<string, string | Buffer>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
}

export async function mark(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.querySelector(".markdown-body") as HTMLElement).dataset.mark = "";
  });
}

export async function marked(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (document.querySelector(".markdown-body") as HTMLElement).dataset.mark === "",
  );
}

export async function waitText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (t) => document.querySelector(".markdown-body")?.textContent?.includes(t),
    text,
  );
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !(await condition()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(await condition(), "the condition never held");
}

export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function cells(page: Page, table: number, column: number): Promise<string[]> {
  return page.evaluate(
    ([t, c]) =>
      [...document.querySelectorAll(".markdown-body table")[t].querySelectorAll("tbody tr")]
        .filter((row) => !(row as HTMLElement).hidden)
        .map((row) => (row as HTMLTableRowElement).cells[c]?.textContent ?? ""),
    [table, column],
  );
}

export async function panel(page: Page, table: number): Promise<void> {
  await page.hover(`.markdown-body table >> nth=${table}`);
  await page.click(".table-control");
  await page.waitForSelector(".table-panel:not([hidden])");
}

export async function caption(page: Page, table: number): Promise<string | null> {
  return page.evaluate(
    (t) =>
      document.querySelectorAll(".markdown-body table")[t].querySelector("caption")?.textContent ??
      null,
    table,
  );
}

export async function writeData(): Promise<void> {
  if (fs.existsSync(path.join(root, "store/shop.duckdb"))) {
    write({ "store/visits.csv": "city,visits\nOslo,1204\nLima,87\nRome,9\n" });
    return;
  }

  write({
    "store/index.md": "# Store\n\n[Visits](visits.csv)",
    "store/visits.csv": "city,visits\nOslo,1204\nLima,87\nRome,9\n",
    "store/visits.tsv": "city\tvisits\nOslo\t1204\n",
    "store/visits.jsonl": '{"city":"Oslo","visits":1204}\n{"city":"Lima","visits":87}\n',
    "store/kit.json": '{"name":"kit","parts":[{"id":1},{"id":2}]}',
    "store/people.yaml": "- name: ada\n  age: 36\n- name: bob\n",
    "store/broken.csv": Buffer.from("city,visits\nOslo,1204\nL\xffma,87\nRome,9\n", "latin1"),
  });

  const sqlite = new DatabaseSync(path.join(root, "store/shop.sqlite"));
  sqlite.exec(
    `pragma journal_mode = wal; create table orders (id integer, item text); ${Array.from({ length: 12 }, (_, i) => `insert into orders values (${i}, 'item ${i}');`).join(" ")}`,
  );
  sqlite.close();

  const duck = await DuckDBInstance.create(path.join(root, "store/shop.duckdb"));
  const connection = await duck.connect();
  await connection.run("create table stock as select range as id from range(3)");
  await connection.run(
    `copy (select range as n from range(3)) to '${path.join(root, "store/visits.parquet")}' (format parquet)`,
  );
  await connection.run(
    `copy (select range as n from range(6000)) to '${path.join(root, "store/many.parquet")}' (format parquet)`,
  );
  connection.closeSync();
  duck.closeSync();
}

export async function openData(urlPath: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/${urlPath}`);
  await page.waitForSelector(".markdown-body > h1");
  await page.waitForTimeout(300);
  return page;
}

export function snapshotOf(folder: string): string[] {
  return fs
    .readdirSync(folder)
    .sort()
    .map((name) => {
      const stat = fs.statSync(path.join(folder, name));
      return `${name} ${stat.size} ${stat.mtimeMs}`;
    });
}

/** A folio of its own on a fresh folder and port, sharing the suite's state folder. */
export async function serveFolder(
  folder: string,
): Promise<{ base: string; stop: () => void; stopped: Promise<unknown> }> {
  const own = await freePort();
  let said = "";
  const child = spawn(process.execPath, [CLI, folder, "--port", String(own)], { env: ENV });
  child.stdout?.on("data", (chunk) => {
    said += chunk;
  });
  await until(() => said.includes("serving"));
  await until(() => said.includes("model:"));
  return {
    base: `http://localhost:${own}`,
    stop: () => child.kill(),
    stopped: new Promise((resolve) => child.once("exit", resolve)),
  };
}

export function snapshotTree(folder: string): string[] {
  return (fs.readdirSync(folder, { recursive: true }) as string[]).sort().map((name) => {
    const stat = fs.statSync(path.join(folder, name));
    return `${name} ${stat.size} ${stat.mtimeMs}`;
  });
}
