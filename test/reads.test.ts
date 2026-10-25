import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Block, blocks, blockVersion, versionOf } from "../src/server/blocks.ts";
import { Reads } from "../src/server/reads.ts";

const PUMP = "# Pumps\n\nThe north pump runs at night.\n\nValves close when full.\n";

test("prose collapses whitespace, a table ignores its padding, and code counts every character", () => {
  const table = "| Pump | Hours |\n|---|---|\n| north | 6 |";
  const prose = (text: string) => blockVersion(text, "paragraph");

  assert.equal(
    blockVersion(table, "table"),
    blockVersion("|Pump|Hours|\n|-|-|\n|north|6|", "table"),
  );
  assert.equal(
    blockVersion(table, "table"),
    blockVersion("|  Pump  |  Hours  |\n| ----- | ------- |\n|  north  |  6  |", "table"),
  );
  assert.notEqual(blockVersion(table, "table"), blockVersion(table.replace("6", "7"), "table"));
  assert.equal(prose("Valves close\nwhen full."), prose("Valves  close when   full."));
  assert.notEqual(prose("foo bar"), prose("foobar"));
  assert.notEqual(prose("Valves close."), prose("valves close."));
  assert.notEqual(
    blockVersion("```py\nif a:\n  b\n```", "code"),
    blockVersion("```py\nif a:\n    b\n```", "code"),
  );
  assert.notEqual(
    blockVersion("a: 1\nb:\n  c: 2", "frontmatter"),
    blockVersion("a: 1\nb:\nc: 2", "frontmatter"),
  );
});

test("the first read keeps the blocks present then; a read records version, time and text", async () => {
  const { reads, held } = setup(PUMP);
  const [, paragraph] = held.get("pumps.md") as Block[];

  await reads.read("pumps.md", [{ id: paragraph.id, version: versionOf(paragraph) }], 1000);
  const record = reads.get("pumps.md");

  assert.deepEqual(
    record?.order,
    (held.get("pumps.md") as Block[]).map((block) => block.id),
  );
  assert.deepEqual(record?.blocks[paragraph.id], {
    version: versionOf(paragraph),
    at: 1000,
    text: "The north pump runs at night.",
  });
  assert.equal(Object.values(record?.blocks ?? {}).filter((entry) => entry.at).length, 1);
  assert.equal(Object.keys(record?.blocks ?? {}).length, 3);
});

test("a read of a version the model no longer holds records nothing", async () => {
  const { reads, held } = setup(PUMP);
  const [heading] = held.get("pumps.md") as Block[];

  await reads.read(
    "pumps.md",
    [{ id: heading.id, version: blockVersion("# Old title", "heading") }],
    1000,
  );
  assert.equal(reads.get("pumps.md")?.blocks[heading.id].at, undefined);
});

test("a read block that has gone keeps its place in the order until forgotten", async () => {
  const { reads, held } = setup(PUMP);
  const before = held.get("pumps.md") as Block[];
  const seen = before.map((block) => ({ id: block.id, version: versionOf(block) }));

  await reads.read("pumps.md", seen, 1000);
  const after = blocks(
    "# Pumps\n\nValves close when full.\n\nA new paragraph.\n",
    "markdown",
    before,
  );
  held.set("pumps.md", after);
  await reads.read("pumps.md", [{ id: after[2].id, version: versionOf(after[2]) }], 2000);
  const order = reads.get("pumps.md")?.order;

  assert.deepEqual(order, [before[0].id, before[1].id, before[2].id, after[2].id]);
  await reads.forget("pumps.md", [before[1].id, before[0].id]);
  assert.deepEqual(reads.get("pumps.md")?.order, [before[0].id, before[2].id, after[2].id]);
  assert.equal(reads.get("pumps.md")?.blocks[before[1].id], undefined);
});

test("a block present at the first read but never read is dropped once it has gone", async () => {
  const { reads, held } = setup(PUMP);
  const before = held.get("pumps.md") as Block[];

  await reads.read("pumps.md", [{ id: before[0].id, version: versionOf(before[0]) }], 1);
  const after = blocks("# Pumps\n", "markdown", before);
  held.set("pumps.md", after);
  await reads.read("pumps.md", [{ id: before[0].id, version: versionOf(before[0]) }], 2);

  assert.deepEqual(Object.keys(reads.get("pumps.md")?.blocks ?? {}), [before[0].id]);
});

test("records survive a restart, and nothing is written for a document outside the model", async () => {
  const { reads, held, store } = setup(PUMP);
  const [heading] = held.get("pumps.md") as Block[];

  await reads.read("pumps.md", [{ id: heading.id, version: versionOf(heading) }], 1000);
  await reads.read("absent.md", [{ id: "x", version: "y" }], 1000);
  await reads.flush();
  const again = new Reads(
    store,
    (urlPath) => held.get(urlPath),
    () => {},
  );
  await again.load();

  assert.equal(again.get("pumps.md")?.blocks[heading.id].at, 1000);
  assert.equal(again.get("absent.md"), undefined);
  assert.equal(fs.readdirSync(path.join(store, "reads")).length, 1);
});

function setup(text: string): { reads: Reads; held: Map<string, Block[]>; store: string } {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-reads-"));
  const held = new Map([["pumps.md", blocks(text, "markdown")]]);
  return {
    reads: new Reads(
      store,
      (urlPath) => held.get(urlPath),
      () => {},
    ),
    held,
    store,
  };
}

test("marks blocks new or changed since read, and read blocks gone from beside what the page shows", async () => {
  const { reads, held } = setup(PUMP);
  const before = held.get("pumps.md") as Block[];
  const seen = before.map((block) => ({ id: block.id, version: versionOf(block) }));

  assert.deepEqual(reads.marks(page(before), "pumps.md"), { marks: [], removed: [], links: [] });
  await reads.read("pumps.md", seen, 1000);
  const after = blocks(
    "# Pumps\n\nThe north pump runs at night and in the rain.\n\nA gauge was fitted.\n",
    "markdown",
    before,
  );
  held.set("pumps.md", after);
  const { marks, removed } = reads.marks(page(after), "pumps.md");

  assert.deepEqual(
    marks.map(({ mark, before: was }) => [mark, was]),
    [
      ["changed", "The north pump runs at night."],
      ["new", undefined],
    ],
  );
  assert.deepEqual(
    removed.map(({ text, after: previous }) => [text, previous]),
    [["Valves close when full.", after[1].id]],
  );
  assert.deepEqual(reads.marks(page(after.slice(0, 1)), "other.md").removed, []);
});

function page(shown: Block[]) {
  return shown.map((block) => ({ source: "pumps.md", id: block.id, version: versionOf(block) }));
}

test("a page lists in catch-up the blocks added to or removed from a part it read through an include", async () => {
  const { reads, held } = setup(PUMP);
  const part = blocks(
    "## Valves\n\nValves close when full.\n\nThey open at dawn.\n\n## Gauges\n\nGauges read in bar.\n",
    "markdown",
  );
  held.set("report.md", blocks("# Report\n", "markdown"));
  held.set("part.md", part);
  const shown = part.slice(0, 3).map((block) => ({ id: block.id, version: versionOf(block) }));

  await reads.read("part.md", shown, 1000, "report.md");
  assert.deepEqual(reads.changed(), []);

  held.set(
    "part.md",
    blocks(
      "## Valves\n\nValves close when full.\n\nA new valve rule.\n\n## Gauges\n\nGauges read in kPa now.\n",
      "markdown",
      part,
    ),
  );
  const listed = reads.changed().map(({ path: p, blocks: n }) => [p, n]);

  assert.deepEqual(listed, [
    ["part.md", 2],
    ["report.md", 2],
  ]);
});

test("a changed document is timed by when its marked change happened", async () => {
  const { reads, held } = setup(PUMP);
  const before = held.get("pumps.md") as Block[];

  await reads.read(
    "pumps.md",
    before.map((block) => ({ id: block.id, version: versionOf(block) })),
    1000,
  );
  const after = blocks(PUMP.replace("at night", "at night and dawn"), "markdown", before);
  after[0].seen = 500;
  after[1].seen = 7000;
  after[2].seen = 900;
  held.set("pumps.md", after);

  assert.deepEqual(
    reads.changed().map(({ path: p, at }) => [p, at]),
    [["pumps.md", 7000]],
  );
});

test("compacting a table's padding keeps the table's identity and version", () => {
  const padded =
    "# Crew\n\n| name  | shift |\n|-------|-------|\n| ann   | 3     |\n| bo    | 4     |\n";
  const compact = "# Crew\n\n|name|shift|\n|-|-|\n|ann|3|\n|bo|4|\n";
  const before = blocks(padded, "markdown");
  const after = blocks(compact, "markdown", before);

  assert.equal(after[1].id, before[1].id);
  assert.equal(versionOf(after[1]), versionOf(before[1]));
});

test("indentation that nests a list item is a change; indentation that nests nothing is not", () => {
  const list = (text: string) => blockVersion(text, "list");

  assert.notEqual(list("- pumps\n- valves"), list("- pumps\n  - valves"));
  assert.equal(list("- pumps\n  - valves"), list("- pumps\n    - valves"));
  assert.equal(list("- pumps run\n  at night"), list("- pumps run at night"));
  assert.notEqual(list("- pumps\n- valves"), list("- pumps\n- gates"));
});

test("line endings never make a version, in code or prose", () => {
  for (const [text, kind] of [
    ["```\nif a:\n  b\n```", "code"],
    ["Valves close\nwhen full.", "paragraph"],
    ["| a | b |\n|---|---|\n| 1 | 2 |", "table"],
    ["- a\n  - b", "list"],
    ["a: 1\nb: 2", "frontmatter"],
  ]) {
    assert.equal(blockVersion(text.replaceAll("\n", "\r\n"), kind), blockVersion(text, kind), kind);
  }
});

test("a list's version moves with the number it starts at and with code inside it, fenced or indented, not with renumbering", () => {
  const list = (text: string) => blockVersion(text, "list");

  assert.notEqual(list("1. one\n2. two"), list("5. one\n6. two"));
  assert.equal(list("1. one\n2. two\n3. three"), list("1. one\n1. two\n1. three"));
  assert.notEqual(
    list("- run\n\n  ```sh\n  if ok; then\n    go\n  fi\n  ```"),
    list("- run\n\n  ```sh\n  if ok; then\n  go\n  fi\n  ```"),
  );
  assert.notEqual(list("- run\n\n      if ok\n        go"), list("- run\n\n      if ok\n      go"));
  assert.equal(list("- one\n  goes on"), list("- one goes on"));
});
