import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { Components, componentFolders, componentsOf } from "../src/server/components.ts"
import { Data } from "../src/server/data.ts"
import { referencesIn } from "../src/server/embeds.ts"
import { createHandler, listen } from "../src/server/http.ts"
import type { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"

const indexer = { split: async () => [], close: async () => {} } as unknown as Indexer
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-components-")))
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-components-out-")))
const model = new Model(
  root,
  fs.mkdtempSync(path.join(os.tmpdir(), "folio-cs-")),
  indexer,
  () => {},
)
const data = new Data(root, fs.mkdtempSync(path.join(os.tmpdir(), "folio-cd-")))
const server = http.createServer(createHandler(root, root, "build-1", model, data, () => {}))
let base = ""

for (const [name, content] of Object.entries({
  "first/levels.js": "export default () => {}\n",
  "first/notes.txt": "not a script",
  "second/levels.js": "export default () => 'second'\n",
  "second/list.js": "export default () => 'list'\n",
  "second/bad name.js": "export default () => {}\n",
})) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  fs.writeFileSync(path.join(root, name), content)
}

fs.writeFileSync(path.join(outside, "leak.js"), "export default () => 'outside'\n")
fs.symlinkSync(path.join(outside, "leak.js"), path.join(root, "second/leak.js"))
fs.symlinkSync(outside, path.join(root, "away"))
componentsOf(model).use(
  componentFolders(
    root,
    ["first", "second"].map((at) => path.join(root, at)),
  ),
)

before(async () => {
  base = `http://localhost:${await listen(server, 0)}`
})

after(async () => {
  model.close()
  await data.close()
  server.close()
})

test("a components folder is a folder inside the served one, its links followed", () => {
  assert.throws(() => componentFolders(root, [outside]), {
    message: `A components folder must lie inside the folder Folio serves: ${outside} is outside ${root}.`,
  })
  assert.throws(() => componentFolders(root, [path.join(root, "away")]), {
    message: `A components folder must lie inside the folder Folio serves: ${path.join(root, "away")} is outside ${root}.`,
  })
  assert.throws(() => componentFolders(root, [path.join(root, "first/levels.js")]), {
    message: `Not a folder: ${path.join(root, "first/levels.js")}`,
  })
  assert.throws(() => componentFolders(root, [path.join(root, "absent")]), {
    message: `Not a folder: ${path.join(root, "absent")}`,
  })
})

test("a name draws from the first folder holding its script, and names every folder that does", () => {
  const components = componentsOf(model)

  assert.deepEqual(components.find("levels"), {
    drawn: path.join(root, "first/levels.js"),
    holders: [path.join(root, "first"), path.join(root, "second")],
  })
  assert.deepEqual(components.find("list"), {
    drawn: path.join(root, "second/list.js"),
    holders: [path.join(root, "second")],
  })
  assert.deepEqual(components.find("missing"), { holders: [] })
  assert.deepEqual(components.find("leak"), { holders: [] })
  assert.deepEqual(components.find("../first/levels"), { holders: [] })
  assert.match(components.version("levels") ?? "", /^first\/levels\.js:[\w.]+-\w+$/)
  assert.equal(components.version("missing"), null)
})

test("the listing names each folder and each component by the script it draws from", async () => {
  const response = await fetch(`${base}/?components`)
  const listed = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(listed.folders, ["first", "second"])
  assert.deepEqual(Object.keys(listed.components).sort(), ["levels", "list"])
  assert.equal(listed.components.levels.path, "first/levels.js")
  assert.deepEqual(listed.components.levels.shadowed, ["second/levels.js"])
  assert.equal(listed.components.list.path, "second/list.js")
  assert.equal(listed.components.list.shadowed, undefined)
})

test("a component's script is served as a module under its name, never at its own address", async () => {
  const script = await fetch(`${base}/notes/?component=levels`)

  assert.equal(script.status, 200)
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8")
  assert.equal(script.headers.get("cache-control"), "no-cache")
  assert.equal(await script.text(), "export default () => {}\n")

  for (const name of ["missing", "leak", "notes", "../first/levels", "bad name"]) {
    const refused = await fetch(`${base}/?component=${encodeURIComponent(name)}`)
    assert.equal(refused.status, 404, name)
    assert.equal(await refused.text(), "Not found.\n")
  }

  const own = await fetch(`${base}/first/levels.js`)
  assert.notEqual(own.headers.get("content-type"), "text/javascript; charset=utf-8")
})

test("a component fence's data entries are references, read as an embed reads them", () => {
  assert.deepEqual(
    referencesIn(
      [
        "```component levels",
        "data:",
        "  rows: data/rows.csv",
        "  totals: '#totals'",
        "title: Rain by station",
        "```",
        "",
        "~~~component list",
        "data:",
        "  items: items.yaml#entries",
        "~~~",
        "",
        "```component broken",
        "data: [",
        "```",
      ].join("\n"),
    ),
    ["data/rows.csv", "#totals", "items.yaml#entries"],
  )
})

test("the served folder named as a components folder lists as itself", () => {
  const components = new Components(root)

  components.use([root])
  assert.deepEqual(components.list().folders, ["."])
  assert.deepEqual(components.find("levels"), { holders: [] })
})

test("a name an object already answers to is a component like any other", () => {
  const folder = fs.mkdtempSync(path.join(root, "proto-"))
  const components = new Components(root)

  fs.writeFileSync(path.join(folder, "constructor.js"), "export default () => {}\n")
  fs.writeFileSync(path.join(folder, "toString.js"), "export default () => {}\n")
  components.use([folder])

  const { components: listed } = components.list()
  assert.deepEqual(Object.keys(listed).sort(), ["constructor", "toString"])
  assert.equal(
    Object.entries(listed).find(([name]) => name === "constructor")?.[1].path,
    `${path.basename(folder)}/constructor.js`,
  )
  assert.equal(({} as { shadowed?: unknown }).shadowed, undefined)
  fs.rmSync(folder, { recursive: true })
})

test("a components folder removed while Folio runs holds nothing, and the others still list", () => {
  const gone = fs.mkdtempSync(path.join(root, "gone-"))
  const components = new Components(root)

  fs.writeFileSync(path.join(gone, "levels.js"), "export default () => {}\n")
  components.use([gone, path.join(root, "second")])
  fs.rmSync(gone, { recursive: true })

  assert.deepEqual(Object.keys(components.list().components).sort(), ["levels", "list"])
  assert.equal(components.list().components.levels.path, "second/levels.js")
})

test("a components folder named twice counts once, and one turned into a file holds nothing", () => {
  const first = path.join(root, "first")

  assert.deepEqual(componentFolders(root, [first, `${first}/`, path.join(root, "second")]), [
    first,
    path.join(root, "second"),
  ])

  const turned = path.join(root, "turned")
  const components = new Components(root)
  fs.mkdirSync(turned)
  components.use([turned, path.join(root, "second")])
  fs.rmdirSync(turned)
  fs.writeFileSync(turned, "now a file")

  assert.deepEqual(Object.keys(components.list().components).sort(), ["levels", "list"])
  fs.rmSync(turned)
})

test("a script reached through a chain of links, or a linked folder, is watched in every folder on the way, by real path", () => {
  const base = fs.mkdtempSync(path.join(root, "chain-"))
  const components = new Components(root)

  for (const folder of ["lib", "a", "dist"]) {
    fs.mkdirSync(path.join(base, folder))
  }

  fs.symlinkSync("dist", path.join(base, "build"))
  fs.symlinkSync("../a/levels.js", path.join(base, "lib/levels.js"))
  fs.symlinkSync("../build/levels.js", path.join(base, "a/levels.js"))
  components.use([path.join(base, "lib")])

  assert.deepEqual(components.watched("levels"), [
    path.join(base, "lib"),
    path.join(base, "a"),
    path.join(base, "dist"),
  ])
  assert.deepEqual(components.find("levels"), { holders: [] })
  fs.writeFileSync(path.join(base, "dist/levels.js"), "export default () => {}\n")
  assert.equal(components.find("levels").drawn, path.join(base, "dist/levels.js"))
  fs.rmSync(base, { recursive: true })
})
