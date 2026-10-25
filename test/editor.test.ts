import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import {
  definition,
  type Edit,
  type Editor,
  findings,
  hover,
  moveFiles,
  movesInTurn,
  movesOf,
  references,
  renameHeading,
} from "../src/server/editor.ts";
import { linkTarget } from "../src/server/files.ts";
import { healthOf } from "../src/server/health.ts";
import { Indexer } from "../src/server/indexer.ts";
import type { Model } from "../src/server/model.ts";
import { served } from "./served.ts";

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url));

after(() => indexer.close());

const FILES = {
  "notes/a.md": "# Alpha\n\n## Pump section\n\nThe pump runs at noon. See [log](../log/day.md).\n",
  "notes/b.md": "# B\n\nSee [pump](a.md#pump-section) and [whole](a.md).\n",
  "log/day.md": "# Day\n",
  "rates.csv": "arm,pct\nA,0.8\n",
  "notes/c.md": '# C\n\nA wins with <data value="../rates.csv#0.pct">50%</data> of runs.\n',
};

async function opened(typed: Record<string, string> = {}) {
  const { root, model, data } = await served(indexer, FILES);
  const editor: Editor = {
    root,
    model,
    data,
    indexer,
    textOf: (urlPath) => typed[urlPath] ?? fs.readFileSync(path.join(root, urlPath), "utf8"),
  };
  return {
    editor,
    close: async () => {
      model.close();
      await data.close();
    },
  };
}

test("problems show as typed: a link to a heading not there, a missing include, a contradicted figure", async () => {
  const typed = "# B\n\nSee [pump](a.md#pumps) and [gone](nowhere.md).\n\n{include: missing.md}\n";
  const { editor, close } = await opened({ "notes/b.md": typed });

  try {
    assert.deepEqual(
      (await findings(editor, "notes/b.md")).map(({ line, start, end, what }) => [
        line,
        typed.split("\n")[line].slice(start, end),
        what,
      ]),
      [
        [2, "a.md#pumps", "Links to a heading not in notes/a.md: #pumps"],
        [2, "nowhere.md", "Links to notes/nowhere.md, which is not there"],
        [4, "missing.md", "Includes missing.md, which is not there"],
      ],
    );
    assert.deepEqual(
      (await findings(editor, "notes/c.md")).map(({ line, what }) => [line, what]),
      [[2, "50% is contradicted: the data says 80% (../rates.csv#0.pct)"]],
    );
  } finally {
    await close();
  }
});

test("go to, references, hover: a link leads to its heading, the heading finds its links, a block its provenance", async () => {
  const { editor, close } = await opened();

  try {
    assert.deepEqual(definition(editor, "notes/b.md", 2, 12), {
      path: "notes/a.md",
      line: 2,
      start: 0,
      end: 0,
    });
    assert.deepEqual(definition(editor, "notes/c.md", 2, 20), {
      path: "rates.csv",
      line: 0,
      start: 0,
      end: 0,
    });
    assert.deepEqual(await references(editor, "notes/a.md", 2), [
      { path: "notes/b.md", line: 2, start: 11, end: 28 },
    ]);
    assert.match(
      (await hover(editor, "notes/a.md", 4)) ?? "",
      /\*\*paragraph\*\*, lines 5-5 of `notes\/a\.md`/,
    );
  } finally {
    await close();
  }
});

test("renaming a heading or moving a file edits every link to it, and the moved file's own links", async () => {
  const { editor, close } = await opened();

  try {
    assert.deepEqual(await renameHeading(editor, "notes/a.md", 2, "Pump room"), [
      { path: "notes/a.md", line: 2, start: 3, end: 15, text: "Pump room" },
      { path: "notes/b.md", line: 2, start: 11, end: 28, text: "a.md#pump-room" },
    ]);
    const written = (at: string, line: number, start: number, end: number) =>
      FILES[at as keyof typeof FILES].split("\n")[line].slice(start, end);
    assert.deepEqual(
      (await moveFiles(editor, movesOf(editor.root, "notes/a.md", "archive/old/a.md"))).map(
        ({ path: at, line, start, end, text }) => [at, written(at, line, start, end), text],
      ),
      [
        ["notes/b.md", "a.md#pump-section", "../archive/old/a.md#pump-section"],
        ["notes/b.md", "a.md", "../archive/old/a.md"],
        ["notes/a.md", "../log/day.md", "../../log/day.md"],
      ],
    );
    assert.deepEqual(
      (await moveFiles(editor, movesOf(editor.root, "rates.csv", "data/rates.csv"))).map(
        ({ path: at, text }) => [at, text],
      ),
      [["notes/c.md", "../data/rates.csv#0.pct"]],
    );
  } finally {
    await close();
  }
});

test("code is not linked, anchors renumber, includes and self-links follow, unsaved files never crash", async () => {
  const typed = {
    "notes/new.md": "# New\n\n```md\n[x](missing.md)\n```\n",
    "notes/twin.md":
      "# Twin\n\n## Setup\n\n## Notes\n\nSee [setup](#setup) and [notes](#notes).\n\n{include: twin.md#notes}\n",
    "notes/c.md":
      '# C\n\nA wins <data class="x" value="#top#0.pct">80%</data>.\n\n```sql query top\nselect 0.8 as pct\n```\n\nSee [me](c.md#c).\n',
  };
  const { editor, close } = await opened(typed);

  try {
    assert.deepEqual(await findings(editor, "notes/new.md"), []);
    assert.deepEqual(definition(editor, "notes/c.md", 2, 20), {
      path: "notes/c.md",
      line: 4,
      start: 0,
      end: 0,
    });

    const renamed = (await renameHeading(editor, "notes/twin.md", 4, "Setup")) ?? [];
    const text = (edit: { path: string; line: number; start: number; end: number }) =>
      typed["notes/twin.md"].split("\n")[edit.line].slice(edit.start, edit.end);
    assert.deepEqual(
      renamed.map((edit) => [text(edit), edit.text]),
      [
        ["Notes", "Setup"],
        ["#notes", "#setup-1"],
        ["twin.md#notes", "twin.md#setup-1"],
      ],
    );

    assert.deepEqual(
      (await moveFiles(editor, movesOf(editor.root, "notes/c.md", "notes/d.md"))).map(
        ({ text: written }) => written,
      ),
      ["d.md#c"],
    );
  } finally {
    await close();
  }
});

const MOVING = {
  "index.md": [
    "# Index",
    "",
    "See [a](notes/a.md#pump) and `[a](notes/a.md#pump)`.",
    "",
    "Also \\`[e](notes/a.md#pump)\\` and [notes](notes/).",
    "",
    "Run `foo",
    "[m](notes/a.md#pump)` here.",
    "",
  ].join("\n"),
  "notes/a.md":
    "# Alpha\n\n## Pump\n\nSee [day](../log/day.md), [b](b.md) and `[day](../log/day.md)`.\n\n{include: ../log/day.md}\n\nUp [here](./) and [sub](sub/).\n",
  "notes/b.md":
    "# B\n\n<data value=../rates.csv#0.pct>80%</data> and {value: ../rates.csv#0.pct}.\n",
  "notes/sub/c.md": "# C\n",
  "log/day.md": "# Day\n",
  "rates.csv": "arm,pct\nA,0.8\n",
};

async function moving(files: Record<string, string> = MOVING, prepare?: (root: string) => void) {
  const { root, model, data } = await served(indexer, files, prepare);
  const editor: Editor = {
    root,
    model,
    data,
    indexer,
    textOf: (urlPath) => {
      try {
        return fs.readFileSync(path.join(root, urlPath), "utf8");
      } catch {
        return undefined;
      }
    },
  };
  const read = (at: string) => fs.readFileSync(path.join(root, at), "utf8");
  const shown = (
    edits: { path: string; line: number; start: number; end: number; text: string }[],
  ) =>
    [...edits]
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.start - b.start)
      .map(({ path: at, line, start, end, text }) => [
        at,
        read(at).split("\n")[line].slice(start, end),
        text,
      ]);
  const move = async (from: string, to: string) => {
    const edits = await moveFiles(editor, movesOf(root, from, to));
    const said = shown(edits);

    for (const at of new Set(edits.map(({ path: where }) => where))) {
      const lines = read(at).split("\n");

      for (const { line, start, end, text } of edits
        .filter(({ path: where }) => where === at)
        .sort((a, b) => b.line - a.line || b.start - a.start)) {
        lines[line] = lines[line].slice(0, start) + text + lines[line].slice(end);
      }

      fs.writeFileSync(path.join(root, at), lines.join("\n"));
    }

    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    fs.renameSync(path.join(root, from), path.join(root, to));
    return said;
  };
  // Health is asked only once the model holds the moved file, so a clean answer is about the new state.
  const broken = async (present: string) => {
    for (let tries = 0; model.hashOf(present) === undefined; tries++) {
      assert.ok(tries < 200, `the model never saw ${present}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    for (let tries = 0; ; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { problems } = await healthOf(model, data).state();
      const found = problems.filter(({ kind }) => ["link", "include", "data"].includes(kind));

      if (found.length === 0 || tries > 50) {
        return found.map(({ path: at, what }) => `${at}: ${what}`);
      }
    }
  };
  const close = async () => {
    model.close();
    await data.close();
  };

  return { editor, read, shown, move, broken, close };
}

test("a link inside inline code is neither renamed nor referenced, across lines too, and an escaped backtick is no code", async () => {
  const { editor, shown, close } = await moving();

  try {
    assert.deepEqual(shown((await renameHeading(editor, "notes/a.md", 2, "Valve")) ?? []), [
      ["index.md", "notes/a.md#pump", "notes/a.md#valve"],
      ["index.md", "notes/a.md#pump", "notes/a.md#valve"],
      ["notes/a.md", "Pump", "Valve"],
    ]);
    assert.deepEqual(
      (await references(editor, "notes/a.md", 2)).map(({ path: at, line, start }) => [
        at,
        line,
        start,
      ]),
      [
        ["index.md", 2, 8],
        ["index.md", 4, 11],
      ],
    );
  } finally {
    await close();
  }
});

test("a move to a name with a space keeps every include, embed, figure and link resolving", async () => {
  const { move, broken, close } = await moving();

  try {
    assert.deepEqual(await move("log/day.md", "log/a day.md"), [
      ["notes/a.md", "../log/day.md", "../log/a%20day.md"],
      ["notes/a.md", "../log/day.md", "../log/a day.md"],
    ]);
    assert.deepEqual(await move("rates.csv", "my rates.csv"), [
      ["notes/b.md", "../rates.csv#0.pct", '"../my rates.csv#0.pct"'],
      ["notes/b.md", "../rates.csv#0.pct", "../my rates.csv#0.pct"],
    ]);
    assert.deepEqual(await broken("log/a day.md"), []);
  } finally {
    await close();
  }
});

test("a folder's move edits the links into it and out of it, folders included, and leaves those between its files", async () => {
  const { read, move, broken, close } = await moving();

  try {
    assert.deepEqual(await move("notes", "archive/notes"), [
      ["index.md", "notes/a.md#pump", "archive/notes/a.md#pump"],
      ["index.md", "notes/a.md#pump", "archive/notes/a.md#pump"],
      ["index.md", "notes/", "archive/notes/"],
      ["notes/a.md", "../log/day.md", "../../log/day.md"],
      ["notes/a.md", "../log/day.md", "../../log/day.md"],
      ["notes/b.md", "../rates.csv#0.pct", "../../rates.csv#0.pct"],
      ["notes/b.md", "../rates.csv#0.pct", "../../rates.csv#0.pct"],
    ]);
    assert.match(read("archive/notes/a.md"), /\[b\]\(b\.md\)/);
    assert.match(read("archive/notes/a.md"), /`\[day\]\(\.\.\/log\/day\.md\)`/);
    assert.match(read("archive/notes/a.md"), /Up \[here\]\(\.\/\) and \[sub\]\(sub\/\)/);
    assert.deepEqual(await broken("archive/notes/a.md"), []);
  } finally {
    await close();
  }
});

test("a folder's move carries its dot-folders and node_modules: links into them follow, and documents in them are never read", async () => {
  const { editor, shown, move, broken, close } = await moving(
    {
      "index.md":
        "# Index\n\n![pic](notes/.attachments/pic.png), [dep](notes/node_modules/dep/readme.md) and [shots](notes/.attachments/).\n\nSee [draft](notes/.drafts/b.md) and [pkg](notes/node_modules/pkg/).\n",
      "notes/a.md":
        "# A\n\n![pic](.attachments/pic.png), [dep](node_modules/dep/readme.md), [pkg](node_modules/pkg/readme.md) and [log](../log.md).\n",
      "notes/.attachments/pic.png": "png",
      "notes/node_modules/dep/readme.md": "# Dep\n\nSee [up](../../../log.md).\n",
      "notes/.pnpm/pkg/readme.md": "# Pkg\n",
      "notes/.drafts/b.md":
        "# B\n\n## Pump\n\nSee [log](../../log.md), [here](#pump) and [again](b.md#pump).\n",
      "log.md": "# Log\n",
    },
    (root) => fs.symlinkSync("../.pnpm/pkg", path.join(root, "notes/node_modules/pkg")),
  );

  try {
    assert.deepEqual(
      shown(await moveFiles(editor, movesOf(editor.root, "notes/.drafts/b.md", "b.md"))),
      [["index.md", "notes/.drafts/b.md", "b.md"]],
    );
    assert.deepEqual(shown((await renameHeading(editor, "notes/.drafts/b.md", 2, "Valve")) ?? []), [
      ["notes/.drafts/b.md", "Pump", "Valve"],
      ["notes/.drafts/b.md", "#pump", "#valve"],
      ["notes/.drafts/b.md", "b.md#pump", "b.md#valve"],
    ]);
    assert.deepEqual(await move("notes", "archive/notes"), [
      ["index.md", "notes/.attachments/pic.png", "archive/notes/.attachments/pic.png"],
      ["index.md", "notes/node_modules/dep/readme.md", "archive/notes/node_modules/dep/readme.md"],
      ["index.md", "notes/.attachments/", "archive/notes/.attachments/"],
      ["index.md", "notes/.drafts/b.md", "archive/notes/.drafts/b.md"],
      ["index.md", "notes/node_modules/pkg/", "archive/notes/node_modules/pkg/"],
      ["notes/a.md", "../log.md", "../../log.md"],
    ]);
    assert.deepEqual(await broken("archive/notes/a.md"), []);
  } finally {
    await close();
  }
});

test("a move answers for addresses that decode to a path from the filesystem's root", async () => {
  const { move, close } = await moving({
    "index.md": "# Index\n\nSee [a](notes/a.md) and [x](%2F%2Fy).\n",
    "notes/a.md": "# A\n\n[x](/%2Fy), [log](../log.md) and {include: //y}.\n",
    "log.md": "# Log\n",
  });

  try {
    assert.deepEqual(await move("notes", "archive/notes"), [
      ["index.md", "notes/a.md", "archive/notes/a.md"],
      ["notes/a.md", "../log.md", "../../log.md"],
    ]);
  } finally {
    await close();
  }
});

test("embeds move wherever the folder model reads them, in frontmatter and math too", async () => {
  const { move, close } = await moving({
    "rates.csv": "arm,pct\nA,0.8\n",
    "front.md": '---\nk: "see {value: rates.csv#0.pct}"\n---\n\n# F\n',
    "math.md": "# M\n\n$$\n{value: rates.csv#0.pct}\n$$\n",
  });

  try {
    assert.deepEqual(await move("rates.csv", "data/rates.csv"), [
      ["front.md", "rates.csv#0.pct", "data/rates.csv#0.pct"],
      ["math.md", "rates.csv#0.pct", "data/rates.csv#0.pct"],
    ]);
  } finally {
    await close();
  }
});

test("a diagram's problems read its text as markdown, so a link in a code span is none", async () => {
  const { editor, close } = await moving({
    "flow.mmd": 'flowchart LR\n  A["`[doc](missing.md)`"] --> B\n',
  });

  try {
    assert.deepEqual(await findings(editor, "flow.mmd"), []);
  } finally {
    await close();
  }
});

test("a code span stays within its block and closes on a backtick after a backslash", async () => {
  const { root, model, data } = await served(indexer, {
    "t.md": "# T\n\n## Pump\n",
    "a.md": "# A\n\nUse `C:\\` then [r1](t.md#pump) and `z`.\n",
    "b.md": "# B\n\n- press ` to open\n- see [r2](t.md#pump) and `x`\n",
    "c.md": "# C\n\n| ` | tick |\n| [r3](t.md#pump) | `y` |\n",
    "d.md": "# D\n\n# The ` key\nSee [r4](t.md#pump) and `w`.\n",
    "e.md": "# E\n\nIn code: `[h3](t.md#pump)\\` here.\n",
  });
  const editor: Editor = {
    root,
    model,
    data,
    indexer,
    textOf: (urlPath) => fs.readFileSync(path.join(root, urlPath), "utf8"),
  };

  try {
    assert.deepEqual((await references(editor, "t.md", 2)).map(({ path: at }) => at).sort(), [
      "a.md",
      "b.md",
      "c.md",
      "d.md",
    ]);
    assert.deepEqual(
      ((await renameHeading(editor, "t.md", 2, "Valve")) ?? []).map(({ path: at }) => at).sort(),
      ["a.md", "b.md", "c.md", "d.md", "t.md"],
    );
  } finally {
    model.close();
    await data.close();
  }
});

test("a code span stays within one paragraph, heading or table cell, at any depth of list or quote", async () => {
  const files: Record<string, string> = {
    "t.md": "# T\n\n## Pump\n",
    "nested.md": "# N\n\n- Keys\n    - the ` key opens the console\n    - see [t](t.md) and `x`\n",
    "ordered.md": "# O\n\n1. Keys\n    1. the ` key\n    2. see [o](t.md#pump) and `x`\n",
    "break.md": "# B\n\nText ` here\n***\nSee [r](t.md#pump) and `y`.\n",
    "setext.md": "# S\n\nText ` here\n---\nSee [s](t.md#pump) and `y`.\n",
    "cells.md": "# C\n\n| a | b | c |\n|---|---|---|\n| ` | [c](t.md#pump) | ` |\n",
    "quote.md":
      "# Q\n\n> See [t](t.md) and `a\n> [q](t.md#pump) b`.\n\n> One `\n> > [d](t.md) two `\n",
  };
  const { root, model, data } = await served(indexer, files);
  const editor: Editor = {
    root,
    model,
    data,
    indexer,
    textOf: (urlPath) => fs.readFileSync(path.join(root, urlPath), "utf8"),
  };
  const shown = (edits: Edit[]) =>
    [...edits]
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.start - b.start)
      .map(({ path: at, line, start, end, text }) => [
        at,
        line,
        files[at].split("\n")[line].slice(start, end),
        text,
      ]);

  try {
    const moved = shown(await moveFiles(editor, movesOf(root, "t.md", "x/t.md")));
    assert.deepEqual(moved, [
      ["break.md", 4, "t.md#pump", "x/t.md#pump"],
      ["cells.md", 4, "t.md#pump", "x/t.md#pump"],
      ["nested.md", 4, "t.md", "x/t.md"],
      ["ordered.md", 4, "t.md#pump", "x/t.md#pump"],
      ["quote.md", 2, "t.md", "x/t.md"],
      ["quote.md", 6, "t.md", "x/t.md"],
      ["setext.md", 4, "t.md#pump", "x/t.md#pump"],
    ]);
    assert.deepEqual(
      moved.map(([at, , written]) => `${at} ${written}`).sort(),
      linksTo(model, "t.md"),
    );

    assert.deepEqual(shown((await renameHeading(editor, "t.md", 2, "Valve")) ?? []), [
      ["break.md", 4, "t.md#pump", "t.md#valve"],
      ["cells.md", 4, "t.md#pump", "t.md#valve"],
      ["ordered.md", 4, "t.md#pump", "t.md#valve"],
      ["setext.md", 4, "t.md#pump", "t.md#valve"],
      ["t.md", 2, "Pump", "Valve"],
    ]);
    assert.deepEqual((await references(editor, "t.md", 2)).map(({ path: at }) => at).sort(), [
      "break.md",
      "cells.md",
      "ordered.md",
      "setext.md",
    ]);

    assert.deepEqual(shown(await moveFiles(editor, movesOf(root, "quote.md", "sub/quote.md"))), [
      ["quote.md", 2, "t.md", "../t.md"],
      ["quote.md", 6, "t.md", "../t.md"],
    ]);
  } finally {
    model.close();
    await data.close();
  }
});

test("a link counts where the page reads one, past deep lists, quoted fences and lone pipe lines, never in code, HTML, math or frontmatter", async () => {
  const files: Record<string, string> = {
    "t.md": "# T\n\n## Pump\n",
    "indent.md": "# I\n\nRun `foo\n    - [i](t.md#pump) bar` here.\n\nAlso [real](t.md).\n",
    "deep.md":
      "# D\n\n- Keys\n    - the ` key\n          - see [d](t.md#pump) and `x`\n\nAlso [real](t.md).\n",
    "lone.md": "# L\n\n| a `x [l](t.md#pump) | z` |\n\nAlso [real](t.md).\n",
    "fence.md": "# F\n\n> ~~~\n> a ` b\n> ~~~\n> See [f](t.md#pump) and `y`.\n",
    "heading.md": "# H\n\n- # The ` key\n  See [h](t.md#pump) and `x`.\n",
    "block.md": "# K\n\nPara.\n\n    [k](t.md#pump) note\n\nAlso [real](t.md).\n",
    "def.md": "- x\n\n      [d]: t.md#pump\n\nAlso [real](t.md).\n",
    "table.md":
      "# R\n\nThe table below is loose, with no divider under its first row.\n\nIntro\n| `[c](t.md#pump)` | [r](t.md) |\n| x | y |\n",
    "comment.md": "# C\n\n<!-- `[c](t.md#pump)` -->\n\nAlso [real](t.md).\n",
    "math.md": "# M\n\n$$\n` [m](t.md#pump) `\n$$\n\nAlso [real](t.md).\n",
    "front.md": '---\nnote: "`[f](t.md#pump)`"\n---\n\n# F\n\nAlso [real](t.md).\n',
  };
  const { root, model, data } = await served(indexer, files);
  const editor: Editor = {
    root,
    model,
    data,
    indexer,
    textOf: (urlPath) => fs.readFileSync(path.join(root, urlPath), "utf8"),
  };

  try {
    const moved = (await moveFiles(editor, movesOf(root, "t.md", "x/t.md")))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ path: at, line, start, end, text }) => [
        at,
        line,
        files[at].split("\n")[line].slice(start, end),
        text,
      ]);
    assert.deepEqual(moved, [
      ["block.md", 6, "t.md", "x/t.md"],
      ["comment.md", 4, "t.md", "x/t.md"],
      ["deep.md", 6, "t.md", "x/t.md"],
      ["def.md", 4, "t.md", "x/t.md"],
      ["fence.md", 5, "t.md#pump", "x/t.md#pump"],
      ["front.md", 6, "t.md", "x/t.md"],
      ["heading.md", 3, "t.md#pump", "x/t.md#pump"],
      ["indent.md", 5, "t.md", "x/t.md"],
      ["lone.md", 4, "t.md", "x/t.md"],
      ["math.md", 6, "t.md", "x/t.md"],
      ["table.md", 5, "t.md", "x/t.md"],
    ]);
    assert.deepEqual(
      moved.map(([at, , written]) => `${at} ${written}`).sort(),
      linksTo(model, "t.md"),
    );
    assert.deepEqual((await references(editor, "t.md", 2)).map(({ path: at }) => at).sort(), [
      "fence.md",
      "heading.md",
    ]);
  } finally {
    model.close();
    await data.close();
  }
});

test("a move edits only the address of each link the page reads, keeping its title, angle brackets and query", async () => {
  const { read, move, broken, close } = await moving({
    "t.md": "# T\n\n## Top\n",
    "a b.md": "# AB\n",
    "doc.md": [
      "# Doc",
      "",
      "See [x](t.md 'T'), [y](<a b.md>) and [z](t.md?raw=1#top).",
      "",
      "A note[^1] and [l][t.md].",
      "",
      "[^1]: Note here.",
      "",
      "[t.md]: t.md",
      "",
    ].join("\n"),
  });

  try {
    await move("doc.md", "sub/doc.md");
    assert.equal(
      read("sub/doc.md"),
      [
        "# Doc",
        "",
        "See [x](../t.md 'T'), [y](<../a b.md>) and [z](../t.md?raw=1#top).",
        "",
        "A note[^1] and [l][t.md].",
        "",
        "[^1]: Note here.",
        "",
        "[t.md]: ../t.md",
        "",
      ].join("\n"),
    );
    assert.deepEqual(await broken("sub/doc.md"), []);

    assert.deepEqual(await move("t.md", "x/t.md"), [
      ["sub/doc.md", "../t.md", "../x/t.md"],
      ["sub/doc.md", "../t.md?raw=1#top", "../x/t.md?raw=1#top"],
      ["sub/doc.md", "../t.md", "../x/t.md"],
    ]);
    assert.deepEqual(await move("a b.md", "x/a b.md"), [
      ["sub/doc.md", "../a b.md", "../x/a b.md"],
    ]);
    assert.deepEqual(await broken("x/a b.md"), []);

    assert.deepEqual(await move("x/t.md", "x/C# (v2?.md"), [
      ["sub/doc.md", "../x/t.md", "../x/C%23%20%28v2%3F.md"],
      ["sub/doc.md", "../x/t.md?raw=1#top", "../x/C%23%20%28v2%3F.md?raw=1#top"],
      ["sub/doc.md", "../x/t.md", "../x/C%23%20%28v2%3F.md"],
    ]);
    assert.deepEqual(await broken("x/C# (v2?.md"), []);
  } finally {
    await close();
  }
});

test("a rewritten link stays one link, whatever its query or its file's new name holds", async () => {
  const { read, move, broken, close } = await moving({
    "a(.md": "# A\n",
    "t.md": "# Top\n",
    "doc.md": "# Doc\n\nSee [p](a(.md?q=)) and [t](t.md#top).\n",
  });

  try {
    assert.deepEqual(await move("a(.md", "b.md"), [["doc.md", "a(.md?q=)", "b.md?q=\\)"]]);
    assert.deepEqual(await move("t.md", "R&amp;D.md"), [
      ["doc.md", "t.md#top", "R%26amp;D.md#top"],
    ]);
    assert.equal(read("doc.md"), "# Doc\n\nSee [p](b.md?q=\\)) and [t](R%26amp;D.md#top).\n");
    assert.deepEqual(await broken("R&amp;D.md"), []);
  } finally {
    await close();
  }
});

test("renames in one request move in turn: a file renamed with its folder is linked where it ends up", async () => {
  const { editor, shown, close } = await moving({
    "index.md": "# I\n\nSee [a](notes/a.md) and [b](notes/b.md).\n",
    "notes/a.md": "# A\n\nUp [i](../index.md).\n",
    "notes/b.md": "# B\n",
  });
  const expected = [
    ["index.md", "notes/a.md", "archive/notes/z.md"],
    ["index.md", "notes/b.md", "archive/notes/b.md"],
    ["notes/a.md", "../index.md", "../../index.md"],
  ];

  try {
    assert.deepEqual(
      shown(
        await moveFiles(
          editor,
          movesInTurn(editor.root, [
            ["notes/a.md", "notes/z.md"],
            ["notes", "archive/notes"],
          ]),
        ),
      ),
      expected,
    );
    assert.deepEqual(
      shown(
        await moveFiles(
          editor,
          movesInTurn(editor.root, [
            ["notes", "archive/notes"],
            ["archive/notes/a.md", "archive/notes/z.md"],
          ]),
        ),
      ),
      expected,
    );
  } finally {
    await close();
  }
});

test("problems and go to read links as the page does: a footnote is none, a titled or angle-bracketed address is one", async () => {
  const typed = "# B\n\nSee [x](<gone b.md>), [y](a.md 'T') and[^1].\n\n[^1]: Note here.\n";
  const { editor, close } = await opened({ "notes/b.md": typed });

  try {
    assert.deepEqual(
      (await findings(editor, "notes/b.md")).map(({ line, start, end, what }) => [
        line,
        typed.split("\n")[line].slice(start, end),
        what,
      ]),
      [[2, "gone b.md", "Links to notes/gone b.md, which is not there"]],
    );
    assert.deepEqual(definition(editor, "notes/b.md", 2, 27), {
      path: "notes/a.md",
      line: 0,
      start: 0,
      end: 0,
    });
  } finally {
    await close();
  }
});

function linksTo(model: Model, target: string): string[] {
  return model
    .linkedFrom(target)
    .flatMap((source) =>
      (model.held(source) ?? [])
        .flatMap(({ links = [] }) => links)
        .filter(({ url }) => linkTarget(source, url)?.path === target)
        .map(({ url }) => `${source} ${url}`),
    )
    .sort();
}
