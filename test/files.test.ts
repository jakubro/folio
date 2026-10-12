import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { confine, listing, neighbours, renderable } from "../src/server/files.ts";

function fixture(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-files-")));

  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }

  return root;
}

test("confine keeps every path inside the served folder", () => {
  const outside = fixture({ "secret.md": "x" });
  const root = fixture({ "notes/a.md": "a" });
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "escape.md"));
  fs.symlinkSync(path.join(root, "notes"), path.join(root, "alias"));

  assert.equal(confine(root, ""), root);
  assert.equal(confine(root, "notes/a.md"), path.join(root, "notes/a.md"));
  assert.equal(confine(root, "alias/a.md"), path.join(root, "notes/a.md"));
  assert.equal(confine(root, "../secret.md"), undefined);
  assert.equal(confine(root, "notes/../../secret.md"), undefined);
  assert.equal(confine(root, `../${path.basename(outside)}/secret.md`), undefined);
  assert.equal(confine(root, "escape.md"), undefined);
  assert.equal(confine(root, "missing.md"), undefined);
  assert.equal(confine(root, "notes/a.md\0.png"), undefined);
});

test("renderable serves markdown, mermaid and images only, judged by the real target", () => {
  const root = fixture({ "a.md": "", "b.mmd": "", "c.PNG": "", ".env": "", "d.txt": "" });
  fs.symlinkSync(path.join(root, "d.txt"), path.join(root, "disguised.md"));
  fs.mkdirSync(path.join(root, "folder.md"));

  assert.equal(renderable(root, "a.md")?.kind, "markdown");
  assert.equal(renderable(root, "b.mmd")?.kind, "mermaid");
  assert.equal(renderable(root, "c.PNG")?.kind, "image");

  for (const name of [".env", "d.txt", "disguised.md", "folder.md"]) {
    assert.equal(renderable(root, name), undefined, name);
  }
});

test("listing shows renderable files and folders holding them, folders first", () => {
  const root = fixture({
    "z.md": "",
    "b.png": "",
    "readme.txt": "",
    "docs/deep/er/x.md": "",
    "data/table.csv": "",
    "vendor/node_modules/pkg/README.md": "",
    ".git/HEAD.md": "",
    ".hidden/a.md": "",
    "node_modules/b.md": "",
    "Item 10.md": "",
    "Item 9.md": "",
  });
  fs.symlinkSync(path.join(root, "docs"), path.join(root, "linked"));
  fs.symlinkSync(path.join(root, "readme.txt"), path.join(root, "disguised.md"));

  assert.deepEqual(listing(root, ""), [
    { name: "docs", kind: "folder" },
    { name: "b.png", kind: "image" },
    { name: "Item 9.md", kind: "markdown" },
    { name: "Item 10.md", kind: "markdown" },
    { name: "z.md", kind: "markdown" },
  ]);
  assert.deepEqual(listing(root, "docs/deep"), [{ name: "er", kind: "folder" }]);
});

test("listing refuses files, missing folders and folders outside the root", () => {
  const root = fixture({ "a.md": "" });

  assert.equal(listing(root, "a.md"), undefined);
  assert.equal(listing(root, "missing"), undefined);
  assert.equal(listing(root, ".."), undefined);
});

test("neighbours walk every page in tree order across folders, passing over images", () => {
  const root = fixture({
    "guide/extra/more.md": "",
    "guide/intro.md": "",
    "guide/setup.md": "",
    "guide/shot.png": "",
    "notes/todo.md": "",
    "pics/only.png": "",
    "flow.mmd": "",
    "index.md": "",
    "readme.md": "",
  });
  const order = [
    "guide/extra/more.md",
    "guide/intro.md",
    "guide/setup.md",
    "notes/todo.md",
    "flow.mmd",
    "index.md",
    "readme.md",
  ];
  const walk = (start: string, key: "previous" | "next") => {
    const seen = [start];

    for (let at = neighbours(root, start)?.[key]; at; at = neighbours(root, at)?.[key]) {
      seen.push(at);
    }

    return seen;
  };

  assert.deepEqual(walk("guide/extra/more.md", "next"), order);
  assert.deepEqual(walk("readme.md", "previous"), [...order].reverse());
  assert.deepEqual(neighbours(root, "guide/extra/more.md"), {
    previous: null,
    next: "guide/intro.md",
  });
  assert.deepEqual(neighbours(root, "readme.md"), { previous: "index.md", next: null });
});

test("neighbours answer pages only, and nothing for a page the tree does not list", () => {
  const root = fixture({ "a.md": "", "b.png": "", "notes/c.md": "", ".hidden/d.md": "" });

  for (const urlPath of ["", "notes", "b.png", "missing.md"]) {
    assert.equal(neighbours(root, urlPath), undefined, urlPath);
  }

  assert.deepEqual(neighbours(root, ".hidden/d.md"), { previous: null, next: null });
});
