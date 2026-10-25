import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { conventionsOf } from "../src/server/conventions.ts";
import { Data } from "../src/server/data.ts";
import { documentsOf } from "../src/server/documents.ts";
import { healthOf } from "../src/server/health.ts";
import { Indexer } from "../src/server/indexer.ts";
import { Model } from "../src/server/model.ts";

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url));

after(() => indexer.close());

async function served(files: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-conventions-")));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-conventions-store-"));

  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }

  const model = new Model(root, store, indexer, () => {});
  await model.start();
  return { root, model, data: new Data(root, store) };
}

const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;

async function until(test: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; !(await test()); tries++) {
    assert.ok(tries < 200, "timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a declaration applies to its folder and below, a deeper one adding to it and overriding it by name", async () => {
  const { root, model, data } = await served({
    "FOLIO.md": `# Conventions\n\nWhy these exist.\n\n${fence("kinds:\n  note:\n    where: '**/*.md'\nhealth:\n  - where: old/**\n    skip: all")}\n\nMore prose.\n\n${fence("rules:\n  titled:\n    query: select 1")}\n`,
    "team/FOLIO.md": `# Team\n\n${fence("kinds:\n  note:\n    where: notes/*.md\n  plan:\n    where: plans/*.md\nhealth:\n  - where: drafts/**\n    skip: [link]")}\n`,
    "team/notes/a.md": "# A\n",
    "elsewhere/b.md": "# B\n",
  });
  const conventions = conventionsOf(model);

  try {
    assert.deepEqual(conventions.describe("team/notes/a.md").declarations, [
      "FOLIO.md",
      "team/FOLIO.md",
    ]);
    assert.deepEqual(conventions.describe("elsewhere/b.md").declarations, ["FOLIO.md"]);

    const layered = conventions.layered("team/notes/a.md");
    assert.deepEqual(
      layered.kinds.map(({ name, definition, from }) => [
        name,
        String(definition.where),
        from.path,
      ]),
      [
        ["note", String(/^notes\/[^/]*\.md$/), "team/FOLIO.md"],
        ["plan", String(/^plans\/[^/]*\.md$/), "team/FOLIO.md"],
      ],
    );
    assert.deepEqual(
      layered.rules.map(({ name }) => name),
      ["titled"],
    );
    assert.deepEqual(
      layered.health.map(({ definition, from }) => [
        definition.where.map(String),
        definition.skip,
        from.folder,
      ]),
      [
        [[String(/^old\/.*$/)], "all", ""],
        [[String(/^drafts\/.*$/)], ["link"], "team"],
      ],
    );

    fs.writeFileSync(path.join(root, "team/FOLIO.md"), `# Team\n\n${fence("kinds: {}")}\n`);
    await until(() => conventions.layered("team/notes/a.md").kinds[0]?.from.path === "FOLIO.md");
  } finally {
    model.close();
    await data.close();
  }
});

test("only yaml folio fences of FOLIO.md declare: a plain yaml fence, another fence and an old folio.md do not", async () => {
  const { model, data } = await served({
    "FOLIO.md": [
      "# Conventions",
      "",
      fence("kinds:\n  note: {where: '*.md'}"),
      "",
      "```yaml\nkinds:\n  example: {where: '*.md'}\n```",
      "",
      "```folio\nkinds:\n  old: {where: '*.md'}\n```",
      "",
      "```sql query\nselect 1\n```",
      "",
    ].join("\n"),
    "team/folio.md": `# Old name\n\n${fence("kinds:\n  team: {where: '*.md'}")}\n`,
    "a.md": "# A\n",
    "team/b.md": "# B\n",
  });
  const conventions = conventionsOf(model);

  try {
    assert.deepEqual(
      conventions.layered("team/b.md").kinds.map(({ name }) => name),
      ["note"],
    );
    assert.deepEqual(conventions.describe("team/b.md").declarations, ["FOLIO.md"]);
    assert.deepEqual(conventions.declaration("team/folio.md"), undefined);
    assert.deepEqual((await healthOf(model, data).state()).problems, []);
  } finally {
    model.close();
    await data.close();
  }
});

test("a declaration that cannot be read is listed in health, and its other fences still apply", async () => {
  const { model, data } = await served({
    "FOLIO.md": [
      "# Conventions",
      "",
      fence("kinds:\n  note: {where: '*.md'}"),
      "",
      fence("kinds: [unclosed"),
      "",
      fence("colours:\n  red: 1"),
      "",
      fence("- not a map"),
      "",
      fence("health:\n  where: x"),
      "",
    ].join("\n"),
    "a.md": "# A\n",
  });

  try {
    assert.deepEqual(
      (await healthOf(model, data).state()).problems.map(({ kind, line, what }) => [
        kind,
        line,
        what,
      ]),
      [
        [
          "declaration",
          9,
          "The declaration cannot be read: Flow sequence in block collection must be sufficiently indented and end with a ]",
        ],
        [
          "declaration",
          13,
          "No section is named colours: a declaration holds kinds, rules, health, save, digests, attention and stale.",
        ],
        [
          "declaration",
          18,
          "A declaration is a map of sections: kinds, rules, health, save, digests, attention and stale.",
        ],
        ["declaration", 22, "health is a list."],
      ],
    );
    assert.deepEqual(
      conventionsOf(model)
        .layered("a.md")
        .kinds.map(({ name }) => name),
      ["note"],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a kind places documents by where they live and reads typed fields from their text and place", async () => {
  const part = (id: string, fits: string) =>
    `---\ngrams: 5\n---\n# ${id} A part\n\n**Fits:** ${fits}\n\n**Stocked:** 2026-10-20\n\n## Use\n\nHolds the drive shaft.\n\n## Makers\n\n- [Noor](../../makers/noor.md)\n- [Lev](../../makers/lev.md)\n`;
  const { root, model, data } = await served({
    "FOLIO.md": `# Workshop\n\n${fence(
      [
        "kinds:",
        "  part:",
        "    where: parts/**/gear-*.md",
        "    fields:",
        "      id: {from: name, pattern: '^([a-z]+-\\d+)'}",
        "      bin: {from: folder}",
        "      grams: {from: frontmatter, type: number}",
        "      stocked: {from: label, type: date}",
        "      fits: {from: label, type: list, of: link, to: part, empty: None}",
        "      use: {from: section}",
        "      makers: {from: section, type: list, of: link}",
      ].join("\n"),
    )}\n`,
    "parts/stock/gear-1_first.md": part("gear-1", "gear-2"),
    "parts/retired/gear-2_second.md": part("gear-2", "once the frame is welded").replace(
      "2026-10-20",
      "soon",
    ),
    "parts/retired/gear-3_third.md": part("gear-3", "None"),
    "parts/README.md": "# Not a part\n",
  });
  const conventions = conventionsOf(model);
  const written = fs.readdirSync(root, { recursive: true }).map(String).sort();
  const before = written.map((name) => fs.statSync(path.join(root, name)).mtimeMs);

  try {
    assert.deepEqual(conventions.describe("parts/stock/gear-1_first.md"), {
      declarations: ["FOLIO.md"],
      kind: "part",
      declaredIn: "FOLIO.md",
      fields: {
        id: "gear-1",
        bin: "stock",
        grams: 5,
        stocked: "2026-10-20",
        fits: ["parts/retired/gear-2_second.md"],
        use: "Holds the drive shaft.",
        makers: ["makers/noor.md", "makers/lev.md"],
      },
    });
    assert.equal(conventions.describe("parts/README.md").kind, undefined);
    assert.deepEqual(conventions.describe("parts/retired/gear-3_third.md").fields?.fits, []);
    assert.deepEqual(
      (await healthOf(model, data).state()).problems
        .filter(({ kind }) => kind === "field")
        .map(({ path: at, line, what }) => [at, line, what]),
      [
        ["parts/retired/gear-2_second.md", 6, "fits: once the frame is welded names no part"],
        ["parts/retired/gear-2_second.md", 8, "stocked: soon is not a date"],
      ],
    );
    assert.deepEqual(
      written.map((name) => fs.statSync(path.join(root, name)).mtimeMs),
      before,
      "no document is written",
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a field refuses a day its month lacks and text that is no link, takes a link to the web, and keeps commas inside link text", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# Kinds\n\n${fence(
      [
        "kinds:",
        "  part:",
        "    where: parts/gear-*.md",
        "    fields:",
        "      stocked: {from: label, type: date}",
        "      datasheet: {from: label, type: link}",
        "      makers: {from: label, type: list, of: link}",
        "      supplier: {from: label, type: link}",
      ].join("\n"),
    )}\n`,
    "parts/gear-1.md":
      "# gear-1\n\n**Stocked:** 2026-02-30\n\n**Datasheet:** https://example.com/parts/1\n\n**Makers:** [Noor, the founder](noor.md), [Lev](lev.md)\n\n**Supplier:** TBD\n",
  });

  try {
    assert.deepEqual(conventionsOf(model).describe("parts/gear-1.md").fields, {
      stocked: null,
      datasheet: "https://example.com/parts/1",
      makers: ["parts/noor.md", "parts/lev.md"],
      supplier: null,
    });
    assert.deepEqual(
      (await healthOf(model, data).state()).problems
        .filter(({ kind }) => kind === "field")
        .map(({ what }) => what),
      ["stocked: 2026-02-30 is not a date", "supplier: TBD is not a link"],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a kind that cannot be read is listed where it is declared, and the declaration's other kinds still apply", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# K\n\n${fence("kinds:\n  good:\n    where: '*.md'\n  bad:\n    where: '*.md'\n    fields:\n      n: {from: guess}")}\n`,
    "a.md": "# A\n",
  });

  try {
    assert.deepEqual(
      (await healthOf(model, data).state()).problems.map(({ kind, line, what }) => [
        kind,
        line,
        what,
      ]),
      [["declaration", 7, "bad.n: from is one of frontmatter, label, section, folder, name"]],
    );
    assert.equal(conventionsOf(model).describe("a.md").kind, "good");
  } finally {
    model.close();
    await data.close();
  }
});

test("a rule lists each row its query returns where the row lands, with its message and severity", async () => {
  const rules = [
    "rules:",
    "  weighed:",
    "    query: select path, id from kind.part where grams is null",
    "    message: '{id} has no weight'",
    "  retired-heavy:",
    "    severity: warning",
    "    query: select path from kind.part where bin = 'retired' and grams > 3",
    "    message: Retired while heavy",
    "  weighed-gently:",
    "    severity: warning",
    "    query: select path, id from kind.part where grams is null",
    "    message: '{id} has no weight'",
    "  broken:",
    "    query: select nothing from kind.part",
    "  pathless:",
    "    query: select 1 as n",
  ].join("\n");
  const { root, model, data } = await served({
    "FOLIO.md": `# Rules\n\nWhy each exists.\n\n${fence(
      "kinds:\n  part:\n    where: parts/**/gear-*.md\n    fields:\n      id: {from: name, pattern: '^([a-z]+-\\d+)'}\n      bin: {from: folder}\n      grams: {from: label, type: number}",
    )}\n\n${fence(rules)}\n`,
    "parts/stock/gear-1.md": "# gear-1\n\nNot weighed yet.\n",
    "parts/retired/gear-2.md": "# gear-2\n\n**Grams:** 5\n",
    "parts/retired/team/FOLIO.md": `# Team\n\n${fence("rules:\n  retired-heavy:\n    query: select 'parts/stock/gear-1.md' as path")}\n`,
    "parts/retired/team/gear-3.md": "# gear-3\n\n**Grams:** 8\n",
  });
  data.useDocuments(documentsOf(model));
  const health = healthOf(model, data);
  const listed = async () =>
    (await health.state()).problems
      .filter(({ kind }) => kind === "rule")
      .map(({ path: at, line, severity, what, block }) => [
        at,
        line,
        severity,
        what,
        Boolean(block),
      ]);

  try {
    assert.deepEqual(await listed(), [
      [
        "FOLIO.md",
        28,
        "error",
        'The rule broken cannot run: Binder Error: Referenced column "nothing" not found in FROM clause! Candidate bindings: "path"',
        true,
      ],
      [
        "FOLIO.md",
        30,
        "error",
        "The rule pathless cannot run: it returns no path column, so its violations land nowhere.",
        true,
      ],
      ["parts/retired/gear-2.md", 1, "warning", "Retired while heavy", true],
      ["parts/stock/gear-1.md", 1, "error", "gear-1 has no weight", true],
      ["parts/stock/gear-1.md", 1, "warning", "gear-1 has no weight", true],
    ]);

    fs.writeFileSync(path.join(root, "parts/stock/gear-1.md"), "# gear-1\n\n**Grams:** 2\n");
    await until(async () => !(await listed()).some(([at]) => at === "parts/stock/gear-1.md"));
    fs.writeFileSync(path.join(root, "parts/stock/gear-1.md"), "# gear-1\n\nWeight forgotten.\n");
    await until(async () => (await listed()).some(([at]) => at === "parts/stock/gear-1.md"));
  } finally {
    model.close();
    await data.close();
  }
});

test("a declaration scopes health by folder and kind of check, and only health", async () => {
  const { root, model, data } = await served({
    "FOLIO.md": `# Scope\n\nCopies keep their links to the original only.\n\n${fence(
      [
        "kinds:",
        "  note:",
        "    where: '**/*.md'",
        "    fields:",
        "      size: {from: label, type: number}",
        "health:",
        "  - where: copies/**",
        "    skip: all",
        "  - where: archive/**",
        "    skip: [link]",
      ].join("\n"),
    )}\n`,
    "copies/a.md": "# A\n\n[gone](nowhere.md)\n\n**Size:** big\n",
    "archive/b.md": "# B\n\n[gone](nowhere.md)\n\n**Size:** big\n",
    "team/FOLIO.md": `# Team\n\n${fence("health:\n  - where: '*.md'\n    skip: [link]")}\n`,
    "team/c.md": "# C\n\n[gone](nowhere.md)\n",
    "d.md": "# D\n\n[gone](nowhere.md)\n",
  });
  data.useDocuments(documentsOf(model));
  const health = healthOf(model, data);
  const listed = async () =>
    (await health.state()).problems.map(({ kind, path: at }) => `${kind} ${at}`).sort();

  try {
    assert.deepEqual(await listed(), ["field archive/b.md", "link d.md"]);
    assert.deepEqual(
      (
        await data.query(
          "select path from folio.links where url = 'nowhere.md' order by path",
          root,
        )
      ).grid.rows,
      [["archive/b.md"], ["copies/a.md"], ["d.md"], ["team/c.md"]],
      "a scoped-out folder is still queryable",
    );

    fs.writeFileSync(
      path.join(root, "FOLIO.md"),
      `# Scope\n\n${fence("health:\n  - where: copies/**\n    skip: all\n  - where: archive/**\n    skip: [colour]")}\n`,
    );
    await until(async () => (await listed()).includes("link archive/b.md"));
    assert.deepEqual(
      (await health.state()).problems
        .filter(({ kind }) => kind === "declaration")
        .map(({ line, what }) => `${line} ${what}`),
      [
        "7 Health skips all, or kinds of check among figure, link, include, loop, diagram, chart, query, data, declaration, field, rule, view; not colour.",
      ],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("each row a rule returns is its own entry, and a rule past the row limit says how many it returned", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# Rules\n\n${fence(
      [
        "rules:",
        "  twice:",
        "    query: select 'a.md' as path from range(2)",
        "    message: Same row",
        "  many:",
        "    severity: warning",
        "    query: select 'a.md' as path, i + 1 as line from range(10005) t(i)",
      ].join("\n"),
    )}\n`,
    "a.md": "# A\n",
  });

  try {
    const problems = (await healthOf(model, data).state()).problems.filter(
      ({ kind }) => kind === "rule",
    );
    assert.equal(problems.filter(({ what }) => what === "Same row").length, 2);
    assert.equal(problems.filter(({ what }) => what === "many").length, 10_000);
    assert.deepEqual(
      problems.filter(({ path: at }) => at === "FOLIO.md").map(({ what }) => what),
      ["The rule many returns more rows than health lists: 10,000 of 10,005 shown."],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a label starts any line of a paragraph or list item, numbered ones too, and a text field reads as plain text", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# K\n\n${fence(
      [
        "kinds:",
        "  part:",
        "    where: 'parts/*.md'",
        "    fields:",
        "      material: {from: label}",
        "      maker: {from: label}",
        "      grams: {from: label, type: number}",
        "      stocked: {from: label, type: date}",
        "      use: {from: section}",
      ].join("\n"),
    )}\n`,
    "parts/gear-1.md": [
      "# gear-1",
      "",
      "**Material:** Brass <br />",
      "**Maker:** [Noor](noor.md) and <b>Lev</b>",
      "",
      "- a list item",
      "  Grams: 9",
      "",
      "1. Stocked: 2026-10-20",
      "",
      "## Use",
      "",
      "Holds the *drive* shaft, see [here](x.md).",
      "",
    ].join("\n"),
  });

  try {
    assert.deepEqual(conventionsOf(model).describe("parts/gear-1.md").fields, {
      material: "Brass",
      maker: "Noor and Lev",
      grams: 9,
      stocked: "2026-10-20",
      use: "Holds the drive shaft, see here.",
    });
  } finally {
    model.close();
    await data.close();
  }
});

test("a where naming a folder as it is, which places nothing, is a problem of its declaration", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# K\n\n${fence(
      [
        "kinds:",
        "  part:",
        "    where: parts",
        "health:",
        "  - where: archive/",
        "    skip: [link]",
      ].join("\n"),
    )}\n`,
    "parts/gear-1.md": "# gear-1\n",
    "archive/old.md": "# Old\n",
  });

  try {
    assert.deepEqual(
      (await healthOf(model, data).state()).problems.map(({ kind, line, what }) => [
        kind,
        line,
        what,
      ]),
      [
        [
          "declaration",
          6,
          "The kind part places nothing at parts, a folder: parts/** places every document in it.",
        ],
        [
          "declaration",
          8,
          "This entry skips nothing at archive, a folder: archive/** skips every document in it.",
        ],
      ],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a health entry counts kinds of check as errors where it applies, and nothing else changes", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# Severity\n\n${fence("health:\n  - where: strict/**\n    error: [include]\n  - where: '**'\n    error: nothing")}\n`,
    "strict/a.md": "# A\n\n{include: missing.md}\n\n[gone](nowhere.md)\n",
    "loose/b.md": "# B\n\n{include: missing.md}\n",
  });
  const health = healthOf(model, data);

  try {
    assert.deepEqual(
      (await health.state()).problems
        .map(({ kind, path: at, severity }) => `${kind} ${at} ${severity ?? "-"}`)
        .sort(),
      [
        "declaration FOLIO.md -",
        "include loose/b.md -",
        "include strict/a.md error",
        "link strict/a.md -",
      ],
    );
    assert.match(
      (await health.state()).problems.find(({ kind }) => kind === "declaration")?.what ?? "",
      /Health counts as errors all, or kinds of check among .*; not nothing\./,
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a list of links reads the links in a line carrying notes, tags and punctuation, and the ids its prose names", async () => {
  const part = (fits: string) => `# Part\n\n**Fits:** ${fits}\n`;
  const { model, data } = await served({
    "FOLIO.md": `# Workshop\n\n${fence(
      [
        "kinds:",
        "  part:",
        "    where: parts/*.md",
        "    fields:",
        "      id: {from: name, pattern: '^([a-z]+-\\d+)'}",
        "      fits: {from: label, type: list, of: link, to: part, empty: [None, None., \u2014]}",
      ].join("\n"),
    )}\n`,
    "parts/gear-12.md": "# gear-12\n",
    "parts/gear-14.md": "# gear-14\n",
    "parts/axle-3.md": "# axle-3\n",
    "parts/axle-5.md": "# axle-5\n",
    "parts/noted.md": part("[gear-12](gear-12.md) (left side) <br/>"),
    "parts/both.md": part("[gear-12](gear-12.md) (left side), [gear-14](gear-14.md) (spare)"),
    "parts/empty.md": part("None <br/>"),
    "parts/stopped.md": part("axle-5."),
    "parts/gone.md": part("[gear-99](gear-99.md) (gone)"),
    "parts/prose.md": part("once the frame is welded"),
    "parts/context.md": part("None. Pairs with [axle-3](axle-3.md)"),
    "parts/mentioned.md": part("after axle-5"),
    "parts/moved.md": part("[axle-3](old/axle-3.md), later"),
  });
  const fits = (name: string) => conventionsOf(model).describe(`parts/${name}.md`).fields?.fits;
  data.useDocuments(documentsOf(model));

  try {
    assert.deepEqual(fits("noted"), ["parts/gear-12.md"]);
    assert.deepEqual(fits("both"), ["parts/gear-12.md", "parts/gear-14.md"]);
    assert.deepEqual(fits("empty"), []);
    assert.deepEqual(fits("stopped"), ["parts/axle-5.md"]);
    assert.deepEqual(fits("gone"), [null]);
    assert.deepEqual(fits("prose"), [null]);
    assert.deepEqual(fits("context"), []);
    assert.deepEqual(fits("mentioned"), ["parts/axle-5.md"]);
    assert.deepEqual(fits("moved"), ["parts/axle-3.md"]);
    assert.deepEqual(
      (await healthOf(model, data).state()).problems
        .filter(({ kind }) => kind === "field")
        .map(({ path: at, what }) => [at, what])
        .sort(),
      [
        ["parts/gone.md", "fits: [gear-99](gear-99.md) names no part"],
        ["parts/prose.md", "fits: once the frame is welded names no part"],
      ],
    );
    assert.deepEqual(
      (
        await data.query(
          "select p.path, f from kind.part p, unnest(p.fits) as u(f) where p.path in ('parts/noted.md', 'parts/both.md', 'parts/stopped.md') order by p.path, f",
          model.root,
        )
      ).grid.rows,
      [
        ["parts/both.md", "parts/gear-12.md"],
        ["parts/both.md", "parts/gear-14.md"],
        ["parts/noted.md", "parts/gear-12.md"],
        ["parts/stopped.md", "parts/axle-5.md"],
      ],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a note split at a comma, a link to the web or in angle brackets and a document's own id stay notes, and each listed item is its own line", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# Workshop\n\n${fence(
      [
        "kinds:",
        "  part:",
        "    where: parts/*.md",
        "    fields:",
        "      id: {from: name, pattern: '^([a-z]+-\\d+)'}",
        "      fits: {from: label, type: list, of: link, to: part, empty: None}",
        "      spares: {from: section, type: list, of: link, to: part}",
      ].join("\n"),
    )}\n`,
    "parts/gear-12.md": "# gear-12\n",
    "parts/gear-14.md": "# gear-14\n\n**Fits:** mount gear-14 after gear-12\n",
    "parts/split.md": "# Split\n\n**Fits:** [gear-12](gear-12.md) - needed for the drive, brakes\n",
    "parts/web.md":
      "# Web\n\n**Fits:** [catalogue 12](https://example.com/catalogue/12) (stocked)\n",
    "parts/angle.md": "# Angle\n\n**Fits:** [c](<gear-12.md>) (angle), [d](<frame>)\n",
    "parts/listed.md":
      "# Listed\n\n## Spares\n\nThese, in order:\n\n- [gear-12](gear-12.md)\n- once the frame\n  is welded\n",
  });
  const field = (name: string, key: string) =>
    (conventionsOf(model).describe(`parts/${name}.md`).fields as Record<string, unknown>)[key];

  try {
    assert.deepEqual(field("gear-14", "fits"), ["parts/gear-12.md"]);
    assert.deepEqual(field("split", "fits"), ["parts/gear-12.md"]);
    assert.deepEqual(field("web", "fits"), ["https://example.com/catalogue/12"]);
    assert.deepEqual(field("angle", "fits"), ["parts/gear-12.md", null]);
    assert.deepEqual(field("listed", "spares"), ["parts/gear-12.md", null]);
    assert.deepEqual(
      (await healthOf(model, data).state()).problems
        .filter(({ kind }) => kind === "field")
        .map(({ path: at, what }) => [at, what]),
      [
        ["parts/angle.md", "fits: [d](<frame>) names no part"],
        ["parts/listed.md", "spares: once the frame is welded names no part"],
      ],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("among ids without digits, a missing one in a list of them is still reported", async () => {
  const { model, data } = await served({
    "FOLIO.md": `# Pages\n\n${fence(
      [
        "kinds:",
        "  page:",
        "    where: pages/*.md",
        "    fields:",
        "      id: {from: name}",
        "      after: {from: label, type: list, of: link, to: page}",
      ].join("\n"),
    )}\n`,
    "pages/alpha.md": "# Alpha\n",
    "pages/beta.md": "# Beta\n\n**After:** alpha, gamma\n",
  });

  try {
    assert.deepEqual(conventionsOf(model).describe("pages/beta.md").fields?.after, [
      "pages/alpha.md",
      null,
    ]);
    assert.deepEqual(
      (await healthOf(model, data).state()).problems
        .filter(({ kind }) => kind === "field")
        .map(({ what }) => what),
      ["after: gamma names no page"],
    );
  } finally {
    model.close();
    await data.close();
  }
});
