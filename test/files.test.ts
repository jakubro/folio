import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { confine, listing, neighbours, renderable } from "../src/server/files.ts"

function fixture(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-files-")))

  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), content)
  }

  return root
}

test("confine keeps every path inside the served folder", () => {
  const outside = fixture({ "secret.md": "x" })
  const root = fixture({ "notes/a.md": "a" })
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "escape.md"))
  fs.symlinkSync(path.join(root, "notes"), path.join(root, "alias"))

  assert.equal(confine(root, ""), root)
  assert.equal(confine(root, "notes/a.md"), path.join(root, "notes/a.md"))
  assert.equal(confine(root, "alias/a.md"), path.join(root, "notes/a.md"))
  assert.equal(confine(root, "../secret.md"), undefined)
  assert.equal(confine(root, "notes/../../secret.md"), undefined)
  assert.equal(confine(root, `../${path.basename(outside)}/secret.md`), undefined)
  assert.equal(confine(root, "escape.md"), undefined)
  assert.equal(confine(root, "missing.md"), undefined)
  assert.equal(confine(root, "notes/a.md\0.png"), undefined)
})

test("renderable serves markdown, mermaid, images and data files only, judged by the real target", () => {
  const root = fixture({ "a.md": "", "b.mmd": "", "c.PNG": "", ".env": "", "d.txt": "" })
  fs.symlinkSync(path.join(root, "d.txt"), path.join(root, "disguised.md"))
  fs.mkdirSync(path.join(root, "folder.md"))

  assert.equal(renderable(root, "a.md")?.kind, "markdown")
  assert.equal(renderable(root, "b.mmd")?.kind, "mermaid")
  assert.equal(renderable(root, "c.PNG")?.kind, "image")

  for (const name of [".env", "d.txt", "disguised.md", "folder.md"]) {
    assert.equal(renderable(root, name), undefined, name)
  }
})

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
  })
  fs.symlinkSync(path.join(root, "docs"), path.join(root, "linked"))
  fs.symlinkSync(path.join(root, "readme.txt"), path.join(root, "disguised.md"))

  assert.deepEqual(listing(root, ""), [
    { name: "docs", kind: "folder" },
    { name: "b.png", kind: "image" },
    { name: "Item 9.md", kind: "markdown" },
    { name: "Item 10.md", kind: "markdown" },
    { name: "z.md", kind: "markdown" },
  ])
  assert.deepEqual(listing(root, "docs/deep"), [{ name: "er", kind: "folder" }])
})

test("data files render as data pages, and list only when data files are asked for", () => {
  const root = fixture({
    "a.md": "",
    "rows.csv": "",
    "deep/only/table.parquet": "",
    "conf/settings.YAML": "",
    "store/app.db": "",
    "notes.txt": "",
  })

  assert.equal(renderable(root, "rows.csv")?.kind, "data")
  assert.equal(renderable(root, "conf/settings.YAML")?.kind, "data")
  assert.equal(renderable(root, "store/app.db")?.kind, "data")
  assert.equal(renderable(root, "notes.txt"), undefined)
  assert.deepEqual(listing(root, ""), [{ name: "a.md", kind: "markdown" }])
  assert.deepEqual(listing(root, "", true), [
    { name: "conf", kind: "folder" },
    { name: "deep", kind: "folder" },
    { name: "store", kind: "folder" },
    { name: "a.md", kind: "markdown" },
    { name: "rows.csv", kind: "data" },
  ])
  assert.equal(neighbours(root, "rows.csv"), undefined)
})

test("a folder listed again shows a subfolder once a page appears deep inside it, and drops it once the page goes", async () => {
  const root = fixture({ "a.md": "", "deep/one/two/table.csv": "" })

  await settled()
  assert.deepEqual(listing(root, ""), [{ name: "a.md", kind: "markdown" }])

  fs.writeFileSync(path.join(root, "deep/one/two/page.md"), "")
  assert.deepEqual(listing(root, ""), [
    { name: "deep", kind: "folder" },
    { name: "a.md", kind: "markdown" },
  ])

  fs.rmSync(path.join(root, "deep/one/two/page.md"))
  assert.deepEqual(listing(root, ""), [{ name: "a.md", kind: "markdown" }])

  fs.mkdirSync(path.join(root, "deep/one/three"))
  fs.writeFileSync(path.join(root, "deep/one/three/note.md"), "")
  assert.deepEqual(listing(root, "")?.[0], { name: "deep", kind: "folder" })
})

test("a folder whose only page is a link is listed by where the link leads now, its answer kept or not", async () => {
  const outside = fixture({ "far.md": "" })
  const root = fixture({ "a.md": "", "away/target.md": "", "away/notes.txt": "" })

  fs.mkdirSync(path.join(root, "linked"))
  fs.symlinkSync(path.join(root, "away/target.md"), path.join(root, "linked/page.md"))
  fs.mkdirSync(path.join(root, "dangling"))
  fs.symlinkSync(path.join(root, "away/later.md"), path.join(root, "dangling/page.md"))
  await settled()

  const folders = () =>
    (listing(root, "") ?? []).filter(({ kind }) => kind === "folder").map(({ name }) => name)

  assert.deepEqual(folders(), ["away", "linked"])

  fs.rmSync(path.join(root, "linked/page.md"))
  fs.symlinkSync(path.join(outside, "far.md"), path.join(root, "linked/page.md"))
  await settled()
  fs.writeFileSync(path.join(root, "away/later.md"), "")
  assert.deepEqual(folders(), ["away", "dangling"])
})

test("a folder listed again is dropped once its page becomes a link to no page or sits behind a linked folder", () => {
  const root = fixture({
    "a.md": "",
    "away/notes.txt": "",
    "away/table.csv": "a\n1\n",
    "linked/page.md": "",
    "plain/page.md": "",
    "moved/inner/page.md": "",
  })
  const folders = (data = false) =>
    (listing(root, "", data) ?? []).filter(({ kind }) => kind === "folder").map(({ name }) => name)

  assert.deepEqual(folders(), ["linked", "moved", "plain"])
  assert.deepEqual(folders(true), ["away", "linked", "moved", "plain"])

  fs.rmSync(path.join(root, "linked/page.md"))
  fs.symlinkSync(path.join(root, "away/table.csv"), path.join(root, "linked/page.md"))
  fs.rmSync(path.join(root, "plain/page.md"))
  fs.symlinkSync(path.join(root, "away/notes.txt"), path.join(root, "plain/page.md"))
  fs.renameSync(path.join(root, "moved/inner"), path.join(root, "away/inner"))
  fs.symlinkSync(path.join(root, "away/inner"), path.join(root, "moved/inner"))

  assert.deepEqual(folders(), ["away"])
  assert.deepEqual(folders(true), ["away", "linked"])
})

test("listing refuses files, missing folders and folders outside the root", () => {
  const root = fixture({ "a.md": "" })

  assert.equal(listing(root, "a.md"), undefined)
  assert.equal(listing(root, "missing"), undefined)
  assert.equal(listing(root, ".."), undefined)
})

test("a file sorts before the files whose names extend it, the extension breaking a tie", () => {
  const root = fixture({
    "5.71.md": "",
    "5.70.B.md": "",
    "5.70.A.md": "",
    "5.70.1.md": "",
    "5.70.md": "",
    "5.7.md": "",
    "notes_2.md": "",
    "notes.md": "",
    "notes.csv": "",
    "README-old.md": "",
    "README.md": "",
    "5.70.x/a.md": "",
    "5.70/a.md": "",
  })
  const names = (data: boolean) => listing(root, "", data)?.map(({ name }) => name)

  assert.deepEqual(names(true), [
    "5.70",
    "5.70.x",
    "5.7.md",
    "5.70.md",
    "5.70.1.md",
    "5.70.A.md",
    "5.70.B.md",
    "5.71.md",
    "notes.csv",
    "notes.md",
    "notes_2.md",
    "README.md",
    "README-old.md",
  ])
  assert.deepEqual(neighbours(root, "5.70.md"), { previous: "5.7.md", next: "5.70.1.md" })
})

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
  })
  const order = [
    "guide/extra/more.md",
    "guide/intro.md",
    "guide/setup.md",
    "notes/todo.md",
    "flow.mmd",
    "index.md",
    "readme.md",
  ]
  const walk = (start: string, key: "previous" | "next") => {
    const seen = [start]

    for (let at = neighbours(root, start)?.[key]; at; at = neighbours(root, at)?.[key]) {
      seen.push(at)
    }

    return seen
  }

  assert.deepEqual(walk("guide/extra/more.md", "next"), order)
  assert.deepEqual(walk("readme.md", "previous"), [...order].reverse())
  assert.deepEqual(neighbours(root, "guide/extra/more.md"), {
    previous: null,
    next: "guide/intro.md",
  })
  assert.deepEqual(neighbours(root, "readme.md"), { previous: "index.md", next: null })
})

test("neighbours answer pages only, and nothing for a page the tree does not list", () => {
  const root = fixture({ "a.md": "", "b.png": "", "notes/c.md": "", ".hidden/d.md": "" })

  for (const urlPath of ["", "notes", "b.png", "missing.md"]) {
    assert.equal(neighbours(root, urlPath), undefined, urlPath)
  }

  assert.deepEqual(neighbours(root, ".hidden/d.md"), { previous: null, next: null })
})

/** Kept answers need change times a second old, and utimes moves a change time rather than aging it. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1100))
}
