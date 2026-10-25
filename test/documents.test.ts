import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { documentsOf } from "../src/server/documents.ts";
import { Indexer } from "../src/server/indexer.ts";
import { kindDefinition } from "../src/server/kinds.ts";
import { served as servedFolder } from "./served.ts";

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url));

after(() => indexer.close());

const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;

const served = (files: Record<string, string>) => servedFolder(indexer, files);

const FOLDER = {
  "FOLIO.md": `# Conventions\n\n${fence(
    [
      "kinds:",
      "  part:",
      "    where: bins/**/gear-*.md",
      "    fields:",
      "      id: {from: name, pattern: '^([a-z]+-\\d+)'}",
      "      bin: {from: folder}",
      "      grams: {from: label, type: number}",
      "      fits: {from: label, type: list, of: link, to: part, empty: None}",
      "  memo:",
      "    where: memos/*.md",
    ].join("\n"),
  )}\n`,
  "bins/stock/gear-1_one.md":
    "# gear-1 One\n\n**Grams:** 3\n\n**Fits:** gear-2\n\n- [ ] weigh it\n- [x] cut it\n\nSee [two](../retired/gear-2_two.md#two).\n",
  "bins/retired/gear-2_two.md":
    "# gear-2 Two\n\n**Grams:** 5\n\n**Fits:** None\n\n| a | b |\n|---|---|\n| 1 | x \\| y |\n",
  "notes/plain.md": "---\nowner: ann\ntags: [x, y]\n---\n# Plain\n\n## Later\n\n- [ ] follow up\n",
  "limits.csv": "id,limit\ngear-1,4\ngear-2,4\n",
};

test("a kind is a table with a row per document and a column per field, joined like any other", async () => {
  const { root, model, data } = await served(FOLDER);

  try {
    const { grid } = await data.query(
      "select id, bin, grams, fits from kind.part order by id",
      root,
    );
    assert.deepEqual(
      grid.columns.map(({ name, type }) => `${name} ${type}`),
      ["id VARCHAR", "bin VARCHAR", "grams DOUBLE", "fits VARCHAR[]"],
    );
    assert.deepEqual(grid.rows, [
      ["gear-1", "stock", 3, '["bins/retired/gear-2_two.md"]'],
      ["gear-2", "retired", 5, "[]"],
    ]);

    const joined = await data.query(
      "select p.id from kind.part p join 'limits.csv' l on p.id = l.id where p.grams > l.limit",
      root,
    );
    assert.deepEqual(joined.grid.rows, [["gear-2"]]);

    const memos = await data.query("select * from kind.memo", root);
    assert.deepEqual(
      memos.grid.columns.map(({ name }) => name),
      ["path"],
    );
    assert.deepEqual(memos.grid.rows, []);

    await assert.rejects(
      data.query("select * from kind.nothing", root),
      /No kind is named nothing/,
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("every document's structure reads as tables without any declaration", async () => {
  const { root, model, data } = await served(FOLDER);
  const rows = async (sql: string) => (await data.query(sql, root)).grid.rows;

  try {
    assert.deepEqual(
      await rows("select path, line, text from folio.tasks where not done order by path"),
      [
        ["bins/stock/gear-1_one.md", 7, "weigh it"],
        ["notes/plain.md", 9, "follow up"],
      ],
    );
    assert.deepEqual(
      await rows("select path, target, fragment from folio.links where target like '%gear-2%'"),
      [["bins/stock/gear-1_one.md", "bins/retired/gear-2_two.md", "two"]],
    );
    assert.deepEqual(await rows("select key, value from folio.frontmatter order by key"), [
      ["owner", "ann"],
      ["tags", '["x","y"]'],
    ]);
    assert.deepEqual(
      await rows(
        "select level, text from folio.headings where path = 'notes/plain.md' order by line",
      ),
      [
        [1, "Plain"],
        [2, "Later"],
      ],
    );
    assert.deepEqual(await rows("select header, cells from folio.tables"), [
      ['["a","b"]', '["1","x | y"]'],
    ]);
    assert.deepEqual(
      await rows("select path, kind from folio.documents where kind is not null order by path"),
      [
        ["bins/retired/gear-2_two.md", "part"],
        ["bins/stock/gear-1_one.md", "part"],
      ],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a query over documents is versioned by them, so it reads again when one changes", async () => {
  const { root, model, data } = await served({
    ...FOLDER,
    "report.md":
      "# Report\n\n```sql query open\nselect count(*) as n from folio.tasks where not done\n```\n",
  });
  const report = path.join(root, "report.md");

  try {
    const before = await data.reads(report, "#open");
    assert.deepEqual(before.tables, ["folio.tasks"]);

    fs.writeFileSync(path.join(root, "notes/plain.md"), "# Plain\n\n- [x] follow up\n");
    for (let tries = 0; (await data.reads(report, "#open")).version === before.version; tries++) {
      assert.ok(tries < 200, "the version never moved");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal((await data.embedReference(report, "#open#0.n")).value, 1);
  } finally {
    model.close();
    await data.close();
  }
});

test("a kind's copy stays while another kind whose name it begins is read", async () => {
  const { root, store, model, data } = await served({
    "FOLIO.md": `# Kinds\n\n${fence("kinds:\n  a:\n    where: a/*.md\n  a-b:\n    where: b/*.md")}\n`,
    "a/one.md": "# One\n",
    "b/two.md": "# Two\n",
  });
  const copies = () =>
    fs
      .readdirSync(store, { recursive: true })
      .map((name) => path.basename(String(name)))
      .filter((name) => name.startsWith("kind.a-b") && name.endsWith(".jsonl"));

  try {
    await data.query('select * from kind."a-b"', root);
    for (const name of fs.readdirSync(store, { recursive: true }).map(String)) {
      fs.utimesSync(path.join(store, name), 0, 0);
    }
    await data.query("select * from kind.a", root);
    assert.equal(copies().length, 1);
  } finally {
    model.close();
    await data.close();
  }
});

test("a kind cannot name a field path, the column every kind has", () => {
  assert.equal(
    kindDefinition("part", { where: "*.md", fields: { path: { from: "name" } } }),
    "part.path: path is the document's own column, so no field takes the name.",
  );
});

test("a quote's tasks, headings and tables are read like any other", async () => {
  const { root, model, data } = await served({
    "quoted.md":
      "# Quoted\n\n> ## Note\n>\n> - [ ] call back\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n## Note\n",
  });
  const rows = async (sql: string) => (await data.query(sql, root)).grid.rows;

  try {
    assert.deepEqual(await rows("select line, text from folio.tasks"), [[5, "call back"]]);
    assert.deepEqual(
      await rows("select line, level, text, anchor from folio.headings order by line"),
      [
        [1, 1, "Quoted", "quoted"],
        [3, 2, "Note", "note"],
        [11, 2, "Note", "note-1"],
      ],
    );
    assert.deepEqual(await rows("select line, header, cells from folio.tables"), [
      [7, '["a","b"]', '["1","2"]'],
    ]);
  } finally {
    model.close();
    await data.close();
  }
});

test("a link's context never cuts a character in two, so the links table still reads", async () => {
  const { root, model, data } = await served({
    "emoji.md": `# Emoji\n\nx${"\u{1F600}".repeat(50)} [link](a.md) ${"\u{1F600}".repeat(50)}y\n`,
  });

  try {
    const [[context]] = (await data.query("select context from folio.links", root)).grid.rows;
    assert.doesNotMatch(
      String(context),
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    assert.match(String(context), /^\.\.\.\u{1F600}+ link \u{1F600}+\.\.\.$/u);
  } finally {
    model.close();
    await data.close();
  }
});

test("headings in raw HTML are headings too, anchored as the page anchors them", async () => {
  const { root, model, data } = await served({
    "html.md": '# Top\n\n<div>\n<h2>Inside</h2>\n<h3 id="own">Named</h3>\n</div>\n\n## Inside\n',
  });

  try {
    assert.deepEqual(
      (await data.query("select line, level, text, anchor from folio.headings order by line", root))
        .grid.rows,
      [
        [1, 1, "Top", "top"],
        [4, 2, "Inside", "inside"],
        [5, 3, "Named", "own"],
        [8, 2, "Inside", "inside-1"],
      ],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a kind's times keep their offsets as UTC, and a field a deeper declaration types apart reads per document", async () => {
  const { root, model, data } = await served({
    "FOLIO.md": `# K\n\n${fence(
      "kinds:\n  part:\n    where: '**/gear-*.md'\n    fields:\n      stocked: {from: label, type: date}\n      grams: {from: label, type: number}",
    )}\n`,
    "team/FOLIO.md": `# T\n\n${fence(
      "kinds:\n  part:\n    where: 'gear-*.md'\n    fields:\n      stocked: {from: label, type: date}\n      grams: {from: label}",
    )}\n`,
    "bins/gear-1.md": "# gear-1\n\n**Stocked:** 2026-10-16T10:30Z\n\n**Grams:** 3\n",
    "bins/gear-2.md": "# gear-2\n\n**Stocked:** 2026-10-16 10:30+02:00\n\n**Grams:** 5\n",
    "bins/gear-3.md": "# gear-3\n\n**Stocked:** 2026-10-16T09:15\n",
    "team/gear-4.md": "# gear-4\n\n**Stocked:** 2026-10-17\n\n**Grams:** heavy\n",
  });

  try {
    const { grid } = await data.query(
      "select path, strftime(stocked, '%Y-%m-%d %H:%M') as stocked, grams from kind.part order by path",
      root,
    );
    assert.deepEqual(grid.rows, [
      ["bins/gear-1.md", "2026-10-16 10:30", "3"],
      ["bins/gear-2.md", "2026-10-16 08:30", "5"],
      ["bins/gear-3.md", "2026-10-16 09:15", null],
      ["team/gear-4.md", "2026-10-17 00:00", "heavy"],
    ]);
  } finally {
    model.close();
    await data.close();
  }
});

test("a document table read again at the same version is not built again", async () => {
  const { root, model, data } = await served(FOLDER);
  const documents = documentsOf(model);
  const table = documents.table.bind(documents);
  let built = 0;
  documents.table = (schema, name) => {
    built++;
    return table(schema, name);
  };

  try {
    await data.query("select count(*) from kind.part", root);
    await data.query("select count(*) from kind.part", root);
    assert.equal(built, 1);
  } finally {
    model.close();
    await data.close();
  }
});

test("an id a list field names that is nowhere is a null in its list, not the text null", async () => {
  const { root, model, data } = await served({
    ...FOLDER,
    "bins/stock/gear-1_one.md": "# gear-1 One\n\n**Grams:** 3\n\n**Fits:** gear-2, gear-9\n",
  });

  try {
    const { grid } = await data.query(
      "select fits[1] as found, fits[2] is null as missing, len(fits) as n from kind.part where id = 'gear-1'",
      root,
    );
    assert.deepEqual(grid.rows, [["bins/retired/gear-2_two.md", true, 2]]);
  } finally {
    model.close();
    await data.close();
  }
});

test("included headings, labels and tasks count in the file holding them, not in the page including them", async () => {
  const { root, model, data } = await served({
    ...FOLDER,
    "bins/stock/gear-3_three.md": "# gear-3 Three\n\n{include: ../../parts/part.md}\n",
    "parts/part.md": "## Brought in\n\n**Grams:** 9\n\n- [ ] included task\n",
  });
  const rows = async (sql: string) => (await data.query(sql, root)).grid.rows;

  try {
    assert.deepEqual(
      await rows(
        "select path, text from folio.headings where path in ('bins/stock/gear-3_three.md', 'parts/part.md') order by path, line",
      ),
      [
        ["bins/stock/gear-3_three.md", "gear-3 Three"],
        ["parts/part.md", "Brought in"],
      ],
    );
    assert.deepEqual(await rows("select grams from kind.part where id = 'gear-3'"), [[null]]);
    assert.deepEqual(await rows("select path from folio.tasks where text = 'included task'"), [
      ["parts/part.md"],
    ]);
  } finally {
    model.close();
    await data.close();
  }
});
