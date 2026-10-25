import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { markers, shown as spelledBack, unmarked } from "../src/client/unresolved.ts";
import { blocks } from "../src/server/blocks.ts";
import { expand } from "../src/server/includes.ts";

function fixture(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-includes-")));

  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }

  return root;
}

test("replaces each token with the target's text verbatim, wherever it appears", async () => {
  const root = fixture({
    "index.md":
      "```mermaid\n{include: parts/flow.mermaid}\n```\n<td>{include:parts/cell.md}</td>\n",
    "parts/flow.mermaid": "graph LR\n  a --> b\n",
    "parts/cell.md": "- one\n- two",
  });

  const { text, files } = await expand(root, path.join(root, "index.md"));

  assert.deepEqual(
    { text, files },
    {
      text: "```mermaid\ngraph LR\n  a --> b\n\n```\n<td>- one\n- two</td>\n",
      files: [
        path.join(root, "index.md"),
        path.join(root, "parts/flow.mermaid"),
        path.join(root, "parts/cell.md"),
      ],
    },
  );
});

test("resolves nested includes against each including file, and a leading slash against root", async () => {
  const root = fixture({
    "a/page.md": "[{include: ../b/mid.md}]",
    "b/mid.md": "<{include: leaf.md}|{include: /top.md}>",
    "b/leaf.md": "leaf",
    "top.md": "top",
  });

  assert.equal((await expand(root, path.join(root, "a/page.md"))).text, "[<leaf|top>]");
});

test("leaves an unresolved target, one outside root and a cycle as written, marked", async () => {
  const outside = fixture({ "secret.md": "secret" });
  const away = `../${path.basename(outside)}/secret.md`;
  const root = fixture({
    "page.md": `1{include: missing.md}2{include:${away}}3{include: loop.md}4`,
    "loop.md": "L{include: page.md}L",
  });
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md"));
  fs.appendFileSync(path.join(root, "page.md"), "{include: link.md}5{include: .}6");

  assert.equal(
    shown((await expand(root, path.join(root, "page.md"))).text),
    `1[missing 1 page.md|{include: missing.md}]2[missing 1 page.md|{include:${away}}]3` +
      "L[loop 1 loop.md|{include: page.md}]L4[missing 1 page.md|{include: link.md}]5" +
      "[missing 1 page.md|{include: .}]6",
  );
});

test("an escaped include stays as written without its backslash, unresolved, unmarked and unreported", () => {
  const root = fixture({
    "page.md": "a \\{include: x.md} b `\\{include: x.md}`\n",
    "x.md": "X",
  });
  const { text, problems } = expand(root, path.join(root, "page.md"));

  assert.equal(text, "a {include: x.md} b `{include: x.md}`\n");
  assert.deepEqual(problems, []);
});

test("an include resolves inside inline code and code blocks too, and is marked there when missing", () => {
  const root = fixture({
    "page.md": "`{include: x.md}` `{include: gone.md}`\n\n```\n{include: x.md}\n```\n",
    "x.md": "X",
  });
  const { text } = expand(root, path.join(root, "page.md"));

  assert.equal(shown(text), "`X` `[missing 1 page.md|{include: gone.md}]`\n\n```\nX\n```\n");
  assert.equal(unmarked(text), "`X` `{include: gone.md}`\n\n```\nX\n```\n");
});

test("reports a missing target inside root as a dependency, never one outside", async () => {
  const root = fixture({ "page.md": "{include: later.md}{include: ../../elsewhere.md}" });

  assert.deepEqual((await expand(root, path.join(root, "page.md"))).files, [
    path.join(root, "page.md"),
    path.join(root, "later.md"),
  ]);
});

test("includes the same file twice when it is not a cycle", async () => {
  const root = fixture({ "page.md": "{include: x.md}+{include: x.md}", "x.md": "x" });

  assert.equal((await expand(root, path.join(root, "page.md"))).text, "x+x");
});

test("maps each line of every file, once per place it is included, to the expanded lines it spans", async () => {
  const root = fixture({
    "page.md": "top\n{include: part.md}\nmid {include: part.md} end\nlast",
    "part.md": "p1\n{include: leaf.md}",
    "leaf.md": "l1\nl2",
  });
  const { text, instances } = await expand(root, path.join(root, "page.md"));

  assert.equal(text, "top\np1\nl1\nl2\nmid p1\nl1\nl2 end\nlast");
  assert.deepEqual(
    instances.map(({ file, starts, ends }) => [path.relative(root, file), starts, ends]),
    [
      ["page.md", [1, 2, 5, 8], [1, 4, 7, 8]],
      ["part.md", [2, 3], [2, 4]],
      ["leaf.md", [3, 4], [3, 4]],
      ["part.md", [5, 6], [5, 7]],
      ["leaf.md", [6, 7], [6, 7]],
    ],
  );
});

test("takes a heading's section up to the next heading of its level or higher, and a block by its id", async () => {
  const root = fixture({
    "design.md":
      "# Design\n\nIntro.\n\n## Retry policy\n\nBack off.\n\n### Limits\n\nThree.\n\n## Storage\n\nDisk.\n",
    "page.md": "{include: design.md#retry-policy}|{include: design.md#user-content-storage}",
  });
  const { text, instances } = await expand(root, path.join(root, "page.md"), parsed);

  assert.equal(
    text,
    "## Retry policy\n\nBack off.\n\n### Limits\n\nThree.\n\n|## Storage\n\nDisk.\n",
  );
  assert.deepEqual(
    instances.slice(1).map(({ first, starts }) => [first, starts.length]),
    [
      [5, 9],
      [13, 4],
    ],
  );

  const page = path.join(root, "block.md");
  fs.writeFileSync(page, "{include: design.md#^nope}");
  const id = (await expand(root, page, parsed)).text;
  assert.equal(shown(id), "[missing 1 block.md|{include: design.md#^nope}]");
});

test("shows what a part include cannot find, and keeps watching the file it names", async () => {
  const root = fixture({
    "page.md": "a {include: design.md#gone} b {include: absent.md#part} c {include: <x>.md#y}",
    "design.md": "# Design",
  });
  const { text, files } = await expand(root, path.join(root, "page.md"), parsed);

  assert.equal(
    shown(text),
    "a [missing 1 page.md|{include: design.md#gone}] b " +
      "[missing 1 page.md|{include: absent.md#part}] c " +
      "[missing 1 page.md|{include: <x>.md#y}]",
  );
  assert.deepEqual(files, [
    path.join(root, "page.md"),
    path.join(root, "design.md"),
    path.join(root, "absent.md"),
    path.join(root, "<x>.md"),
  ]);
});

test("a file whose name holds a # is still included whole, and a block found by the ids it is given", async () => {
  const root = fixture({
    "c#.md": "sharp",
    "doc.md": "Kept.\n\nOther.",
    "page.md": "{include: c#.md} {include: doc.md#^b2}",
  });
  const ids = (_file: string, text: string) =>
    text.split("\n\n").map((part, i) => ({
      id: `b${i + 1}`,
      kind: "paragraph",
      lines: [i * 2 + 1, i * 2 + 1] as [number, number],
      text: part,
    }));

  assert.equal((await expand(root, path.join(root, "page.md"), ids)).text, "sharp Other.\n");
});

/** A marked include drawn as [reason line file|literal], so expected texts read plainly. */
function shown(text: string): string {
  const spelled = spelledBack(text);
  let drawn = "";
  let last = 0;

  for (const { at, length, written, where } of markers(spelled)) {
    drawn += `${spelled.slice(last, at)}[${where.why} ${where.line} ${where.file}|${written}]`;
    last = at + length;
  }

  return drawn + spelled.slice(last);
}

function parsed(_file: string, text: string) {
  return blocks(text, "markdown");
}

test("records which file each expanded line starts with", () => {
  const root = fixture({
    "page.md": "See {include: word.md} here.\n{include: item.md}\nlast",
    "word.md": "folio",
    "item.md": "- item\n",
  });
  const { owners, instances } = expand(root, path.join(root, "page.md"));

  assert.deepEqual(
    owners.slice(1).map((owner) => path.basename(instances[owner].file)),
    ["page.md", "item.md", "page.md", "page.md"],
  );
});

test("a part keeps the line break after it, so what follows the include stays apart", () => {
  const root = fixture({
    "a.md": "# A\n\n## B\n\nlast\n",
    "page.md": "{include: a.md#b}\nafter\n",
  });

  assert.equal(expand(root, path.join(root, "page.md"), parsed).text, "## B\n\nlast\n\nafter\n");
});

test("a document includes a section of itself from outside it; a section holding its own include is a cycle", () => {
  const root = fixture({
    "page.md":
      "# Page\n\n{include: page.md#later}\n\n## Later\n\nLater text.\n\n## Loop\n\n{include: page.md#loop}\n",
  });
  const { text } = expand(root, path.join(root, "page.md"), parsed);

  assert.equal(
    shown(text),
    "# Page\n\n## Later\n\nLater text.\n\n\n\n## Later\n\nLater text.\n\n## Loop\n\n" +
      "[loop 11 page.md|{include: page.md#loop}]\n",
  );
});

test("a part at the end of a file without a final line break still stays apart from what follows", () => {
  const root = fixture({ "a.md": "# A\n\n## B\n\nlast", "page.md": "{include: a.md#b}\nafter\n" });

  assert.equal(expand(root, path.join(root, "page.md"), parsed).text, "## B\n\nlast\n\nafter\n");
});

test("a part reached again through another file is a cycle at once, shown by its marker", () => {
  const root = fixture({
    "a.md": "# A\n\n## X\n\n{include: b.md#y}\n",
    "b.md": "## Y\n\n{include: a.md#x}\n",
  });
  const { text } = expand(root, path.join(root, "a.md"), parsed);

  assert.equal(shown(text), "# A\n\n## X\n\n## Y\n\n[loop 3 b.md|{include: a.md#x}]\n\n");
});

test("a whole file holding a part being expanded is a cycle at once, shown by its marker", () => {
  const root = fixture({
    "page.md": "{include: a.md#x}\n",
    "a.md": "# A\n\n## X\n\n{include: b.md}\n\n## Other\n\no\n",
    "b.md": "B {include: a.md}\n",
  });

  assert.equal(
    shown(expand(root, path.join(root, "page.md"), parsed).text),
    "## X\n\nB [loop 1 b.md|{include: a.md}]\n\n\n\n",
  );
});

test("one section included twice, or by two files, is no cycle", () => {
  const root = fixture({
    "a.md": "## X\n\nx\n",
    "c.md": "{include: a.md#x}",
    "d.md": "{include: a.md#x}",
    "twice.md": "{include: a.md#x}{include: a.md#x}",
    "both.md": "{include: c.md}{include: d.md}",
  });

  assert.equal(expand(root, path.join(root, "twice.md"), parsed).text, "## X\n\nx\n## X\n\nx\n");
  assert.equal(expand(root, path.join(root, "both.md"), parsed).text, "## X\n\nx\n## X\n\nx\n");
});

test("names each include that finds nothing or leads back to itself, by the file and line holding it", () => {
  const root = fixture({
    "index.md": "# Index\n\n{include: a.md}\n\n{include: gone.md}\n\n{include: a.md#no-such}\n",
    "a.md": "# A\n\n{include: index.md}\n",
  });
  const index = path.join(root, "index.md");
  const a = path.join(root, "a.md");
  const { problems } = expand(root, index, (_file, text) => blocks(text, "markdown"));

  assert.deepEqual(problems, [
    { file: a, line: 3, column: 0, target: "index.md", why: "loop" },
    { file: index, line: 5, column: 0, target: "gone.md", why: "missing" },
    { file: index, line: 7, column: 0, target: "a.md#no-such", why: "missing" },
  ]);
});

test("a YAML flow map whose first key is include is no include", () => {
  const map = '{include: ["a.*"], exclude: [], sample: 0.5}';
  const root = fixture({ "page.md": `---\nfilter: ${map}\n---\n\nAlso ${map} in prose.\n` });
  const { text, problems } = expand(root, path.join(root, "page.md"));

  assert.equal(text, `---\nfilter: ${map}\n---\n\nAlso ${map} in prose.\n`);
  assert.deepEqual(problems, []);
});

test("two includes missing on one line are told apart by where on the line each stands", () => {
  const root = fixture({ "page.md": "A {include: x.md} and {include: y.md}.\n" });
  const { problems } = expand(root, path.join(root, "page.md"));

  assert.deepEqual(
    problems.map(({ line, column, target }) => [line, column, target]),
    [
      [1, 2, "x.md"],
      [1, 22, "y.md"],
    ],
  );
});
