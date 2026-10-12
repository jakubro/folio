import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expand } from "../src/server/includes.ts";

function fixture(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-includes-")));

  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }

  return root;
}

test("replaces each token with the target's text verbatim, wherever it appears", () => {
  const root = fixture({
    "index.md":
      "```mermaid\n{include: parts/flow.mermaid}\n```\n<td>{include:parts/cell.md}</td>\n",
    "parts/flow.mermaid": "graph LR\n  a --> b\n",
    "parts/cell.md": "- one\n- two",
  });

  assert.deepEqual(expand(root, path.join(root, "index.md")), {
    text: "```mermaid\ngraph LR\n  a --> b\n\n```\n<td>- one\n- two</td>\n",
    files: [
      path.join(root, "index.md"),
      path.join(root, "parts/flow.mermaid"),
      path.join(root, "parts/cell.md"),
    ],
  });
});

test("resolves nested includes against each including file, and a leading slash against root", () => {
  const root = fixture({
    "a/page.md": "[{include: ../b/mid.md}]",
    "b/mid.md": "<{include: leaf.md}|{include: /top.md}>",
    "b/leaf.md": "leaf",
    "top.md": "top",
  });

  assert.equal(expand(root, path.join(root, "a/page.md")).text, "[<leaf|top>]");
});

test("expands an unresolved target, one outside root and a cycle to nothing", () => {
  const outside = fixture({ "secret.md": "secret" });
  const root = fixture({
    "page.md": `1{include: missing.md}2{include: ../${path.basename(outside)}/secret.md}3{include: loop.md}4`,
    "loop.md": "L{include: page.md}L",
  });
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md"));
  fs.appendFileSync(path.join(root, "page.md"), "{include: link.md}5{include: .}6");

  assert.equal(expand(root, path.join(root, "page.md")).text, "123LL456");
});

test("reports a missing target inside root as a dependency, never one outside", () => {
  const root = fixture({ "page.md": "{include: later.md}{include: ../../elsewhere.md}" });

  assert.deepEqual(expand(root, path.join(root, "page.md")).files, [
    path.join(root, "page.md"),
    path.join(root, "later.md"),
  ]);
});

test("includes the same file twice when it is not a cycle", () => {
  const root = fixture({ "page.md": "{include: x.md}+{include: x.md}", "x.md": "x" });

  assert.equal(expand(root, path.join(root, "page.md")).text, "x+x");
});
