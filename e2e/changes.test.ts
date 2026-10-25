/** Headless Chromium run of folio's documented behaviour: what is new, catch-up, history, impact and digests. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { context, serveFolder, snapshotTree, waitFor, waitText, writeIn } from "./harness.ts";

test("Never read, Open a changed page, Previous version, Clears by reading, Removed, While open, Whitespace: a page marks what is new to its reader", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-marks-")));
  const plan = (parts: Record<string, string>) =>
    [
      "# Plan",
      parts.table ?? "| Pump | Hours |\n|---|---|\n| north | 6 |",
      parts.alpha ?? "The north pump runs at night and stops at dawn.",
      parts.beta ?? "Valves close when the tank is full.",
      parts.gamma ?? "Filters are cleaned every Monday.",
      parts.delta ?? "The spare gasket sits in the shed.",
      ...(parts.epsilon ? [parts.epsilon] : []),
    ].join("\n\n");
  writeIn(folder, { "duty.md": plan({}) });
  const served = await serveFolder(folder);
  const marksOf = (page: Page) =>
    page.$$eval(".read-mark:not([hidden]):not(.clearing)", (found) =>
      found.map((mark) => mark.className.replace("read-mark ", "")).sort(),
    );
  const openPlan = async () => {
    const page = await context.newPage();
    await page.goto(`${served.base}/duty.md`);
    await page.waitForSelector(".markdown-body > [data-folio-version]");
    return page;
  };

  try {
    let page = await openPlan();

    assert.deepEqual(await marksOf(page), [], "a page never read has no marks");
    await page.waitForTimeout(2500);
    await page.close();

    writeIn(folder, {
      "duty.md": plan({
        alpha: "The north pump runs at night and stops at sunrise.",
        beta: "Valves close when the tank is nearly full.",
        epsilon: "A new paragraph about the backup generator.",
      }),
    });
    await waitFor(async () => {
      const response = await fetch(`${served.base}/duty.md?read`);
      return ((await response.json()) as { marks: unknown[] }).marks.length === 3;
    });
    page = await openPlan();
    await page.waitForSelector(".read-mark");

    assert.deepEqual(await marksOf(page), ["mark-changed", "mark-changed", "mark-new"]);

    await page.click(".read-mark.mark-changed >> nth=0");
    const shown = await page.$eval(".mark-panel", (panel) => ({
      hidden: (panel as HTMLElement).hidden,
      removed: [...panel.querySelectorAll("del")].map((d) => d.textContent),
      added: [...panel.querySelectorAll("ins")].map((i) => i.textContent),
    }));

    assert.deepEqual(shown, { hidden: false, removed: ["dawn"], added: ["sunrise"] });
    await page.waitForTimeout(2500);
    assert.deepEqual(
      await marksOf(page),
      ["mark-changed"],
      "the block being compared stays marked",
    );

    await page.keyboard.press("Escape");
    await page.waitForTimeout(2500);
    assert.deepEqual(await marksOf(page), [], "marks clear once read");

    writeIn(folder, {
      "duty.md": plan({
        alpha: "The north pump runs at night and stops at sunrise.",
        beta: "Valves close when the tank is nearly full.",
        epsilon: "A new paragraph about the backup generator.",
        delta: "The spare gasket sits in the shed by the gate.",
      }),
    });
    await page.waitForSelector(".read-mark.mark-changed");
    assert.deepEqual(await marksOf(page), ["mark-changed"], "a change to the open page is marked");
    await page.waitForTimeout(2500);

    writeIn(folder, {
      "duty.md": plan({
        alpha: "The north pump runs at night and stops at sunrise.",
        beta: "Valves close when the tank is nearly full.",
        epsilon: "A new paragraph about the backup generator.",
        delta: "The spare gasket sits in the shed by the gate.",
        gamma: "",
      }).replace("\n\n\n\n", "\n\n"),
    });
    await page.waitForSelector(".read-mark.mark-removed");
    await page.click(".read-mark.mark-removed");
    assert.equal(
      await page.$eval(".mark-panel del", (d) => d.textContent),
      "Filters are cleaned every Monday.",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2500);
    assert.deepEqual(await marksOf(page), [], "a removed block's tick clears once seen");

    writeIn(folder, {
      "duty.md": plan({
        table: "|  Pump  |  Hours  |\n| ----- | ------- |\n|  north  |  6  |",
        alpha: "The north  pump runs at night\nand stops at sunrise.",
        beta: "Valves close when the tank is nearly full.",
        epsilon: "A new paragraph about the backup generator.",
        delta: "The spare gasket sits in the shed by the gate.",
        gamma: "",
      }).replace("\n\n\n\n", "\n\n"),
    });
    // Rewrapped, the paragraph spans two lines: the model has the rewrite once it says so.
    await waitFor(async () => {
      const response = await fetch(`${served.base}/duty.md?read`);
      const { blocks } = (await response.json()) as { blocks: { lines: number[] }[] };
      return blocks.some(({ lines }) => lines[1] - lines[0] === 1 && lines[0] > 5);
    });
    const rewritten = await (await fetch(`${served.base}/duty.md?read`)).json();
    await page.waitForTimeout(500);

    assert.deepEqual([rewritten.marks, rewritten.removed], [[], []]);
    assert.deepEqual(await marksOf(page), [], "spacing and padding mark nothing");
    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Tree marks, Catch-up view, Open from it, Empties by reading, Unread documents, Live: the folder shows what changed since it was read", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-catchup-")));
  const text = (title: string, extra = "") =>
    `# ${title}\n\nThe ${title} pump runs at night.\n\nIts valves close when full.${extra}\n`;
  writeIn(folder, {
    "docs/a.md": text("alpha"),
    "docs/b.md": text("beta"),
    "notes/c.md": text("gamma"),
    "unread.md": text("delta"),
  });
  const served = await serveFolder(folder);
  const listed = async () => {
    const response = await fetch(`${served.base}/?changed`);
    const { documents } = (await response.json()) as {
      documents: { path: string; blocks: number }[];
    };
    return documents.map(({ path: listedPath, blocks }) => `${listedPath} ${blocks}`);
  };

  try {
    for (const name of ["docs/a.md", "docs/b.md", "notes/c.md"]) {
      const page = await context.newPage();
      await page.goto(`${served.base}/${name}`);
      await page.waitForSelector(".markdown-body > [data-folio-version]");
      await page.waitForTimeout(2500);
      await page.close();
    }

    writeIn(folder, {
      "unread.md": text("delta", "\n\nMore about delta."),
      "new.md": "# New\n\nA page nobody has read.\n",
      "docs/a.md": text("alpha", "\n\nA new paragraph.").replace("night", "night and day"),
    });
    await waitFor(async () => (await listed()).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    writeIn(folder, { "notes/c.md": text("gamma").replace("night", "dusk") });
    await waitFor(async () => (await listed()).length === 2);

    assert.deepEqual(await listed(), ["notes/c.md 1", "docs/a.md 2"]);

    // A save that changes no block leaves the change's time where it was.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(folder, "docs/a.md"), later, later);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(await listed(), ["notes/c.md 1", "docs/a.md 2"]);

    const page = await context.newPage();
    await page.goto(`${served.base}/?catch-up`);
    await page.waitForSelector(".catch-up li");
    const view = await page.evaluate(() => ({
      title: document.title,
      entries: [...document.querySelectorAll(".catch-up li")].map((item) =>
        item.textContent?.replace(/changed, .*/, "changed"),
      ),
      badge: (document.querySelector(".catch-up-link") as HTMLElement).dataset.count,
    }));

    assert.deepEqual(view, {
      title: "Catch up",
      entries: ["notes/c.md1 block changed", "docs/a.md2 blocks changed"],
      badge: "2",
    });
    await page.waitForSelector('.tree li[data-path="docs"] > .tree-row.holds-changed');
    await page.waitForSelector('.tree li[data-path="notes"] > .tree-row.holds-changed');
    assert.equal(await page.locator(".tree .holds-changed, .tree .changed").count(), 2);

    writeIn(folder, { "docs/b.md": text("beta").replace("valves", "gates") });
    await page.waitForFunction(() => document.querySelectorAll(".catch-up li").length === 3);

    await page.click('.catch-up a[href="/notes/c.md"]');
    await page.waitForSelector(".read-mark.mark-changed");
    await page.waitForSelector('.tree li[data-path="notes/c.md"] > .tree-row.changed');
    await page.waitForTimeout(2500);
    await page.waitForSelector('.tree li[data-path="notes/c.md"] > .tree-row:not(.changed)');

    assert.deepEqual(await listed(), ["docs/b.md 1", "docs/a.md 2"]);
    assert.equal(
      await page.locator('.tree li[data-path="notes"] > .tree-row.holds-changed').count(),
      0,
    );
    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Timeline, Past version, Compare, A block's past, Nested repositories, No history, Value history, Folder untouched: history of a document and of a value", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-history-")));
  const commit = (date: string, cwd = folder, name = "Ada Pump") => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: "pump@example.com",
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: "pump@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };

    if (!fs.existsSync(path.join(cwd, ".git"))) {
      spawnSync("git", ["init", "-q"], { cwd, env });
    }

    spawnSync("git", ["add", "."], { cwd, env });
    spawnSync("git", ["commit", "-q", "-m", "snapshot"], { cwd, env });
  };
  const log = (night: string) =>
    `# Log\n\nThe north pump runs at ${night}.\n\nValves close when full.\n`;
  writeIn(folder, {
    ".gitignore": "scratch/\n",
    "notes/log.md": log("night"),
    "report.md": "# Report\n\nPumps counted: {value: data.csv#0.n}.\n",
    "data.csv": "n\n3\n",
    "scratch/loose.md": "# Loose\n\nFirst draft.\n",
  });
  commit("2024-03-01T09:00:00Z");
  writeIn(folder, { "notes/log.md": log("night and at dawn") });
  commit("2024-03-02T09:00:00Z");
  writeIn(folder, { "module/page.md": "# Module\n\nInside.\n" });
  commit("2024-04-01T09:00:00Z", path.join(folder, "module"), "Bo Valve");
  const repositories = () => [
    ...snapshotTree(path.join(folder, ".git")),
    ...snapshotTree(path.join(folder, "module/.git")),
  ];
  const before = repositories();
  const served = await serveFolder(folder);
  const json = async (address: string) => (await fetch(`${served.base}/${address}`)).json();

  try {
    writeIn(folder, { "notes/log.md": log("night, at dawn and at noon") });
    writeIn(folder, { "scratch/loose.md": "# Loose\n\nSecond draft.\n" });
    await waitFor(async () => (await json("notes/log.md?versions")).versions.length === 3);
    await waitFor(async () => (await json("scratch/loose.md?versions")).versions.length === 2);

    const page = await context.newPage();
    await page.goto(`${served.base}/notes/log.md?history`);
    await page.waitForSelector(".history-timeline li");
    const rows = await page.$$eval(".history-timeline li", (items) =>
      items.map((item) => item.querySelector(".history-detail")?.textContent),
    );

    assert.equal(await page.title(), "History of log.md");
    assert.deepEqual(rows, ["saved, on disk", "committed by Ada Pump", "committed by Ada Pump"]);

    await page.click(".history-timeline li:last-child a");
    await page.waitForSelector(".history-banner");
    assert.match(
      await page.$eval(".markdown-body", (e) => e.textContent ?? ""),
      /read only[\s\S]*runs at night\./,
    );

    await page.goto(`${served.base}/notes/log.md?history`);
    await page.waitForSelector(".history-timeline li");
    await page.check(".history-timeline li:nth-child(1) input");
    await page.check(".history-timeline li:nth-child(3) input");
    await page.click(".history-compare");
    await page.waitForSelector(".history-compare-table tbody tr");
    const compared = await page.$$eval(".history-compare-table tbody tr", (found) =>
      found.map((row) => [
        row.className,
        [...row.querySelectorAll("del")].map((d) => d.textContent).join("|"),
        [...row.querySelectorAll("ins")].map((i) => i.textContent).join("|"),
      ]),
    );

    assert.deepEqual(compared, [
      ["history-same", "", ""],
      ["history-changed", "", ", at dawn and at noon"],
      ["history-same", "", ""],
    ]);

    await page.goto(`${served.base}/notes/log.md`);
    await page.waitForSelector(".markdown-body > p[data-folio-id]");
    await page.hover(".markdown-body > p >> nth=0");
    const past = await page.$eval(".block-history", (link) => (link as HTMLAnchorElement).href);
    await page.goto(past);
    await page.waitForSelector(".history-block li");
    const texts = await page.$$eval(".history-block li pre", (found) =>
      found.map((pre) => pre.textContent),
    );

    assert.deepEqual(texts, [
      "The north pump runs at night, at dawn and at noon.",
      "The north pump runs at night and at dawn.",
      "The north pump runs at night.",
    ]);

    const nested = await json("module/page.md?versions");
    const loose = await json("scratch/loose.md?versions");

    assert.deepEqual(
      nested.versions.map((version: { by?: string }) => version.by),
      ["Bo Valve"],
    );
    assert.deepEqual(
      loose.versions.map((version: { seen: string[] }) => version.seen.sort()),
      [["file", "saved"], ["saved"]],
    );
    assert.match(
      (await json(`scratch/loose.md?version=${loose.versions[1].id}`)).text,
      /First draft/,
      "an untracked file keeps the text folio first knew",
    );

    const report = await context.newPage();
    await report.goto(`${served.base}/report.md`);
    await waitText(report, "Pumps counted: 3.");
    writeIn(folder, { "data.csv": "n\n5\n" });
    await waitText(report, "Pumps counted: 5.");
    await report.goto(
      `${served.base}/report.md?history&embed=${encodeURIComponent("data.csv#0.n")}`,
    );
    await report.waitForSelector(".history-timeline li");

    assert.deepEqual(
      await report.$$eval(".history-timeline li code", (found) => found.map((c) => c.textContent)),
      ["5", "3"],
    );
    assert.deepEqual(repositories(), before, "no repository is written");
    await report.close();
    await page.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Old file time, Included file, Unchanged content, Ordinary save: the upstream note follows what a file holds", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-upstream-")));
  writeIn(folder, {
    "data.csv": "n\n3\n",
    "parts/intro.md": "The intro says the pumps are new.\n",
    "report.md": "# Report\n\nPumps counted: {value: data.csv#0.n}.\n\n{include: parts/intro.md}\n",
  });
  const served = await serveFolder(folder);
  const upstream = async () =>
    (
      (await (await fetch(`${served.base}/report.md?read`)).json()) as {
        upstream: { path: string; how: string; at: string }[];
      }
    ).upstream;
  const read = async (shown: string) => {
    const page = await context.newPage();
    await page.goto(`${served.base}/report.md`);
    await waitText(page, shown);
    await page.waitForTimeout(2500);
    await page.close();
    await waitFor(async () => (await upstream()).length === 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  const long = new Date("2020-01-01T00:00:00Z");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));
  const named = async () => (await upstream()).map(({ path: p, how }) => `${p} ${how}`);

  try {
    await waitFor(async () => (await fetch(`${served.base}/report.md?model`)).ok);
    await read("Pumps counted: 3.");
    const rows: [string, string[]][] = [];

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(folder, "data.csv"), later, later);
    await settle();
    rows.push(["unchanged content", await named()]);

    const restored = Date.now();
    fs.writeFileSync(path.join(folder, "data.csv"), "n\n5\n");
    fs.utimesSync(path.join(folder, "data.csv"), long, long);
    await settle();
    rows.push(["old file time", await named()]);
    const at = (await upstream()).find(({ path: p }) => p === "data.csv")?.at;
    rows.push(["time shown", [String(at !== undefined && Date.parse(at) >= restored - 1000)]]);

    fs.writeFileSync(path.join(folder, "parts/intro.md"), "The intro says the pumps are old.\n");
    fs.utimesSync(path.join(folder, "parts/intro.md"), long, long);
    await settle();
    rows.push(["included file", await named()]);

    await read("Pumps counted: 5.");
    fs.writeFileSync(path.join(folder, "data.csv"), "n\n7\n");
    await settle();
    rows.push(["ordinary save", await named()]);

    assert.deepEqual(rows, [
      ["unchanged content", []],
      ["old file time", ["data.csv embeds"]],
      ["time shown", ["true"]],
      ["included file", ["parts/intro.md includes", "data.csv embeds"]],
      ["ordinary save", ["data.csv embeds"]],
    ]);
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("What it affects, What changed upstream, Counts as new, Broken link, Unaffected: a change names what it affects", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-impact-")));
  const notes = (text: string) => `# Notes\n\n${text}\n`;
  writeIn(folder, {
    "data.csv": "n\n3\n",
    "parts/intro.md": "The intro says the pumps are new.\n",
    "notes.md": notes("The valve note says valves close when full."),
    "lonely.md": "# Lonely\n\nNothing reaches this page.\n",
  });
  const served = await serveFolder(folder);
  const json = async (address: string) => (await fetch(`${served.base}/${address}`)).json();

  try {
    await waitFor(async () => (await fetch(`${served.base}/notes.md?model`)).ok);
    const { blocks } = await json("notes.md?model");
    writeIn(folder, {
      "report.md": [
        "# Report",
        "Pumps counted: {value: data.csv#0.n}.",
        "{include: parts/intro.md}",
        `See [the valve note](notes.md#^${blocks[1].id}).`,
      ].join("\n\n"),
    });
    await waitFor(async () => (await fetch(`${served.base}/report.md?model`)).ok);

    assert.deepEqual((await json("data.csv?used-by")).documents, [
      { source: "report.md", how: "embeds" },
    ]);
    assert.deepEqual((await json("parts/intro.md?used-by")).documents, [
      { source: "report.md", how: "includes" },
    ]);
    assert.deepEqual((await json("lonely.md?used-by")).documents, []);

    const page = await context.newPage();
    await page.goto(`${served.base}/data.csv`);
    await page.waitForSelector(".used-by:not([hidden]) li");
    assert.match(
      (await page.textContent(".used-by li")) ?? "",
      /report\.md embeds or queries its data/,
    );

    await page.goto(`${served.base}/report.md`);
    await waitText(page, "Pumps counted: 3.");
    await page.waitForTimeout(2500);
    await page.close();

    writeIn(folder, { "lonely.md": "# Lonely\n\nStill nothing reaches this page.\n" });
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.deepEqual((await json("report.md?read")).marks, [], "an unrelated change marks nothing");
    assert.deepEqual((await json("?changed")).documents, []);

    writeIn(folder, { "data.csv": "n\n5\n" });
    await waitFor(async () => (await json("report.md?read")).marks.length === 1);
    const read = await json("report.md?read");

    assert.deepEqual(
      read.marks.map(({ mark, data }: { mark: string; data?: string[] }) => [mark, data]),
      [["changed", ["data.csv#0.n"]]],
    );
    assert.deepEqual(
      read.upstream.map(({ path: p, how }: { path: string; how: string }) => [p, how]),
      [["data.csv", "embeds"]],
    );
    assert.deepEqual(
      (await json("?changed")).documents.map((d: { path: string }) => d.path),
      ["report.md"],
    );

    writeIn(folder, {
      "notes.md": notes("The valve note says valves close when the tank is full."),
    });
    await waitFor(async () => (await json("report.md?read")).links.length === 1);
    assert.equal((await json("report.md?read")).links[0].state, "changed");
    writeIn(folder, { "notes.md": "# Notes\n" });
    await waitFor(async () => (await json("report.md?read")).links[0]?.state === "gone");

    writeIn(folder, { "parts/intro.md": "The intro says the pumps are old.\n" });
    await waitFor(async () =>
      (await json("?changed")).documents.some(
        (d: { path: string; blocks: number }) => d.path === "report.md" && d.blocks === 2,
      ),
    );
    const again = await context.newPage();
    await again.goto(`${served.base}/report.md`);
    await again.waitForSelector(".upstream-note:not([hidden])");
    const shown = await again.evaluate(() => ({
      note: document.querySelector(".upstream-note")?.textContent ?? "",
      marks: document.querySelectorAll(".read-mark.mark-changed").length,
      gone: document.querySelectorAll(".markdown-body a.link-gone").length,
    }));

    assert.match(shown.note, /parts\/intro\.md \(included,[\s\S]*data\.csv \(embedded data,/);
    assert.equal(shown.marks, 2, "the changed value and the changed include are marked");
    assert.equal(shown.gone, 1, "the link to the deleted block says so");
    const [download] = await Promise.all([
      again.waitForEvent("download"),
      again.click('button[title="Freeze this page into one HTML file"]'),
    ]);
    const saved = path.join(os.tmpdir(), `folio-impact-${process.pid}.html`);
    await download.saveAs(saved);
    const frozen = fs.readFileSync(saved, "utf8");
    fs.rmSync(saved);

    assert.doesNotMatch(
      frozen,
      /class="[^"]*link-(gone|changed)|data-folio-title=/,
      "a snapshot carries no marks",
    );
    assert.match(frozen, /the valve note/);
    await again.close();
  } finally {
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Pick a period, Contents, Busy periods, Open from it, Freeze, Folder untouched: digests of a period", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-digest-")));
  const commit = (date: string) => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada Pump",
      GIT_AUTHOR_EMAIL: "pump@example.com",
      GIT_COMMITTER_NAME: "Ada Pump",
      GIT_COMMITTER_EMAIL: "pump@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };

    if (!fs.existsSync(path.join(folder, ".git"))) {
      spawnSync("git", ["init", "-q"], { cwd: folder, env });
    }

    spawnSync("git", ["add", "-A", "."], { cwd: folder, env });
    spawnSync("git", ["commit", "-q", "-m", "snapshot"], { cwd: folder, env });
  };
  writeIn(folder, {
    "pumps/old.md": "# Old\n\nThe pump runs at night.\n\nValves close.\n",
    "pumps/gone.md": "# Gone\n\nSoon removed.\n",
    "valves/kept.md": "# Kept\n\nUnchanged.\n",
    "report.md": "# Report\n\nCounted: {value: data.csv#0.n}.\n",
    "data.csv": "n\n3\n",
  });
  commit("2024-05-01T09:00:00");
  writeIn(folder, {
    "pumps/old.md": "# Old\n\nThe pump runs at night and dawn.\n\nValves close.\n",
  });
  fs.rmSync(path.join(folder, "pumps/gone.md"));
  writeIn(folder, { "valves/new.md": "# New\n\nA new valve page.\n" });
  commit("2024-05-03T09:00:00");
  writeIn(
    folder,
    Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`busy/page-${i}.md`, `# Page ${i}\n\nWords.\n`]),
    ),
  );
  commit("2024-05-10T09:00:00");
  const served = await serveFolder(folder);
  const page = await context.newPage();

  try {
    await page.goto(`${served.base}/?digest&from=2024-05-02&to=2024-05-04`);
    await page.waitForSelector(".digest-folder");
    const contents = await page.evaluate(() => ({
      title: document.title,
      folders: [...document.querySelectorAll(".digest-folder > summary")].map((s) => s.textContent),
      documents: [...document.querySelectorAll(".digest-document > summary")].map(
        (s) => s.textContent,
      ),
      removed: [...document.querySelectorAll(".digest-block del")].map((d) => d.textContent),
      added: [...document.querySelectorAll(".digest-block ins")].map((i) => i.textContent),
      open: [...document.querySelectorAll("details.digest-folder")].every(
        (d) => (d as HTMLDetailsElement).open,
      ),
    }));

    assert.deepEqual(contents, {
      title: "Digest",
      folders: ["pumps - 2 documents", "valves - 1 document"],
      documents: ["pumps/gone.md removed", "pumps/old.md changed", "valves/new.md created"],
      removed: [],
      added: [" and dawn"],
      open: true,
    });

    await page.goto(`${served.base}/?digest&from=2024-05-09&to=2024-05-11`);
    await page.waitForSelector(".digest-folder");
    assert.equal(
      await page.$$eval("details.digest-folder", (found) =>
        found.some((d) => (d as HTMLDetailsElement).open),
      ),
      false,
      "a busy period opens folded",
    );
    assert.equal(await page.locator(".digest-document").count(), 60);

    const report = await context.newPage();
    await report.goto(`${served.base}/report.md`);
    await waitText(report, "Counted: 3.");
    const between = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeIn(folder, { "data.csv": "n\n5\n" });
    await waitText(report, "Counted: 5.");
    await report.close();
    const digest = await (
      await fetch(`${served.base}/?digest-data&from=${between}&to=${Date.now()}`)
    ).json();

    assert.deepEqual(
      digest.values.map(
        (v: { document: string; reference: string; before: string; after: string }) => [
          v.document,
          v.reference,
          v.before,
          v.after,
        ],
      ),
      [["report.md", "data.csv#0.n", "3", "5"]],
    );

    const whole = await (await fetch(`${served.base}/?digest-data&from=0&to=${Date.now()}`)).json();
    const first = await (await fetch(`${served.base}/?digest-data&from=0&to=${between}`)).json();

    assert.deepEqual(
      whole.values.map((v: { before: string; after: string }) => [v.before, v.after]),
      [["3", "5"]],
      "a value first shown in the period starts from that showing",
    );
    assert.deepEqual(first.values, [], "a value shown once has not moved");

    const sinceLast = async () =>
      (await (await fetch(`${served.base}/?digest-data&since-last&to=${Date.now()}`)).json()).from;
    const unseen = await sinceLast();
    await fetch(`${served.base}/?digest-data&from=0&to=${Date.now() + 86_400_000}`);

    assert.equal(await sinceLast(), unseen, "fetching a digest moves nothing");

    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const before = Date.now();
    await page.goto(`${served.base}/?digest&from=2024-05-02&to=${date}`);
    await page.waitForSelector(".digest h1");
    await waitFor(async () => (await sinceLast()) !== unseen);
    const seen = await sinceLast();

    assert.ok(seen >= before && seen <= Date.now(), `a range ending today ends now: ${seen}`);

    await page.goto(`${served.base}/?digest&from=2024-05-02&to=2024-05-04`);
    await page.waitForSelector(".digest h1");
    await page.waitForTimeout(500);
    assert.equal(
      await sinceLast(),
      seen,
      "a digest of the past leaves the last digest's end alone",
    );

    for (const period of ["", "&period=week", "&period=since-last"]) {
      await page.goto(`${served.base}/?digest${period}`);
      await page.waitForSelector(".digest h1");
      assert.match((await page.textContent(".digest h1")) ?? "", /^Digest: /);
    }

    const untouched = snapshotTree(folder);
    await page.goto(`${served.base}/?digest&from=2024-05-02&to=2024-05-04`);
    await page.waitForSelector(".digest-folder");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click('button[title="Freeze this page into one HTML file"]'),
    ]);
    const saved = path.join(os.tmpdir(), `folio-digest-${process.pid}.html`);
    await download.saveAs(saved);

    assert.equal(download.suggestedFilename(), "digest.html");
    assert.match(fs.readFileSync(saved, "utf8"), /pumps\/old\.md[\s\S]*and dawn/);
    fs.rmSync(saved);

    await page.click('.digest-document a[href*="old.md"]');
    await page.waitForSelector(".history-compare-table tbody tr");
    assert.equal(await page.locator(".history-compare-table .history-changed").count(), 1);
    assert.deepEqual(snapshotTree(folder), untouched, "nothing is written into the folder");
  } finally {
    await page.close();
    served.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
