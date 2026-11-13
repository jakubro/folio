import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { api, type Refusal } from "../src/server/api.ts"
import { type Block, versionOf } from "../src/server/blocks.ts"
import { conventionsOf } from "../src/server/conventions.ts"
import { Data } from "../src/server/data.ts"
import { documentsOf } from "../src/server/documents.ts"
import { guarded, within } from "../src/server/failures.ts"
import { healthOf } from "../src/server/health.ts"
import { createHandler, listen, listenFree } from "../src/server/http.ts"
import { impactOf } from "../src/server/impact.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"
import { presenceOf } from "../src/server/presence.ts"
import { pageState } from "../src/server/versions.ts"
import { rewriting } from "./rewriting.ts"
import { served } from "./served.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-")))
const assets = fs.mkdtempSync(path.join(os.tmpdir(), "folio-assets-"))
const lines: string[] = []
const levels: string[] = []
const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-model-"))
const model = new Model(root, store, indexer, () => {})
const data = new Data(root, store)
const server = http.createServer(
  createHandler(root, assets, "build-1", model, data, (line, level) => {
    lines.push(line)
    levels.push(`${line} ${level}`)
  }),
)
let base = ""

for (const [name, content] of Object.entries({
  "guide.md": "# Guide\n{include: part.md}",
  "part.md": "included",
  "flow.mmd": "graph LR\n a-->b",
  "img/logo.svg": "<svg/>",
  "img/photo.png": "png-bytes",
  "notes/a.md": "a",
  "secret.env": "TOKEN=1",
  "data/scores.csv": "name,score\nada,3\nbob,12\n",
})) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  fs.writeFileSync(path.join(root, name), content)
}

fs.writeFileSync(path.join(assets, "page.js"), "console.log(1)")

before(async () => {
  base = `http://localhost:${await listen(server, 0)}`
  await model.start()
})

after(() => {
  void indexer.close()
  model.close()
  server.close()
})

function get(
  urlPath: string,
  host?: string,
  origin = base,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `${origin}${urlPath}`,
      host ? { headers: { host } } : {},
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          body += chunk
        })
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        )
      },
    )
    request.on("error", reject)
  })
}

test("serves the page shell for markdown, mermaid and folders", async () => {
  for (const urlPath of ["/guide.md", "/flow.mmd", "/", "/notes/"]) {
    const response = await get(urlPath)
    assert.equal(response.status, 200, urlPath)
    assert.match(response.headers["content-type"] ?? "", /^text\/html/)
    assert.match(response.body, /<script type="module" src="\/\?asset=page\.js">/)
  }

  assert.match((await get("/guide.md")).body, /<title>guide\.md<\/title>/)
  assert.match(
    (await get("/notes/")).body,
    new RegExp(
      `<html lang="en" data-root="${path.basename(root)}" data-folder="${root}" data-build="build-1">`,
    ),
  )
})

test("every page shell names the F as its tab's icon", async () => {
  for (const urlPath of ["/guide.md", "/flow.mmd", "/", "/notes/"]) {
    const href =
      /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)">/.exec(
        (await get(urlPath)).body,
      )?.[1]
    assert.ok(href, urlPath)
    assert.equal(
      decodeURIComponent(href),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#93c5fd"/><path d="M16 7H9v11M9 12h5" fill="none" stroke="#1e3a8a" stroke-width="2"/></svg>',
    )
  }
})

test("/favicon.ico answers the F, unless the folder holds a favicon.ico of its own", async () => {
  const drawn = await get("/favicon.ico")
  assert.equal(drawn.status, 200)
  assert.equal(drawn.headers["content-type"], "image/svg+xml")
  assert.equal(
    drawn.body,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#93c5fd"/><path d="M16 7H9v11M9 12h5" fill="none" stroke="#1e3a8a" stroke-width="2"/></svg>',
  )

  assert.equal((await get("/favicon.ico?v=2")).status, 404)

  fs.mkdirSync(path.join(root, "favicon.ico"))
  try {
    assert.equal((await get("/favicon.ico")).status, 301)
  } finally {
    fs.rmdirSync(path.join(root, "favicon.ico"))
  }

  fs.writeFileSync(path.join(root, "favicon.ico"), "the folder's own")
  try {
    const own = await get("/favicon.ico")
    assert.equal(own.headers["content-type"], "image/x-icon")
    assert.equal(own.body, "the folder's own")
  } finally {
    fs.rmSync(path.join(root, "favicon.ico"))
  }
})

test("serves raw text with includes expanded and a version", async () => {
  const response = await get("/guide.md?raw")

  assert.equal(response.body, "# Guide\nincluded")
  assert.match(String(response.headers["x-folio-version"]), /^[0-9a-f]{16}$/)
  assert.equal((await get("/img/photo.png?raw")).status, 404)
})

test("serves a page's neighbours as JSON, and nothing for a folder", async () => {
  const response = await get("/guide.md?step")

  assert.match(response.headers["content-type"] ?? "", /^application\/json/)
  assert.deepEqual(JSON.parse(response.body), { previous: "flow.mmd", next: "part.md" })
  assert.equal((await get("/notes/?step")).status, 404)
})

test("serves one tree level as JSON", async () => {
  const response = await get("/?tree")

  assert.deepEqual(JSON.parse(response.body).entries, [
    { name: "img", kind: "folder" },
    { name: "notes", kind: "folder" },
    { name: "flow.mmd", kind: "mermaid" },
    { name: "guide.md", kind: "markdown" },
    { name: "part.md", kind: "markdown" },
  ])
  assert.equal((await get("/guide.md?tree")).status, 404)
})

test("serves images with their type, sandboxing SVG", async () => {
  const png = await get("/img/photo.png")
  const svg = await get("/img/logo.svg")

  assert.equal(png.body, "png-bytes")
  assert.equal(png.headers["content-type"], "image/png")
  assert.equal(svg.headers["content-type"], "image/svg+xml")
  assert.equal(svg.headers["content-security-policy"], "sandbox")
})

test("answers an unchanged image with 304", async () => {
  const { headers } = await get("/img/photo.png")
  const response = await new Promise<number>((resolve) => {
    http.get(`${base}/img/photo.png`, { headers: { "if-none-match": headers.etag } }, (r) => {
      r.resume()
      resolve(r.statusCode ?? 0)
    })
  })

  assert.equal(response, 304)
})

test("answers a data file's column values for a filter and search, and refuses a column not named by its place", async () => {
  const search = encodeURIComponent(JSON.stringify({ terms: [[1, '"12"']], joins: [], hidden: [] }))
  const all = JSON.parse((await get("/data/scores.csv?data&values=0")).body)
  const searched = JSON.parse((await get(`/data/scores.csv?data&values=0&search=${search}`)).body)

  assert.deepEqual(all, {
    values: [
      ["ada", 1],
      ["bob", 1],
    ],
  })
  assert.deepEqual(searched, { values: [["bob", 1]] })
  assert.equal((await get("/data/scores.csv?data&values=name")).status, 400)
})

test("redirects a folder without its trailing slash", async () => {
  const response = await get("/notes")

  assert.equal(response.status, 301)
  assert.equal(response.headers.location, "/notes/")
})

test("serves a data file's page shell, its rows as JSON, and lists data files only when asked", async () => {
  const shell = await get("/data/scores.csv")
  const page = JSON.parse((await get("/data/scores.csv?data")).body)

  assert.equal(shell.status, 200)
  assert.match(shell.body, /<script type="module" src="\/\?asset=page\.js">/)
  assert.equal(page.format, "csv")
  assert.deepEqual(page.grid.rows, [
    ["ada", 3],
    ["bob", 12],
  ])
  assert.equal((await get("/data/scores.csv?page")).status, 404)
  assert.equal((await get("/data/scores.csv?raw")).status, 404)
  assert.equal((await get("/guide.md?data")).status, 404)
  assert.deepEqual(JSON.parse((await get("/data/?tree&data")).body).entries, [
    { name: "scores.csv", kind: "data" },
  ])
  assert.deepEqual(JSON.parse((await get("/data/?tree")).body).entries, [])
})

test("serves what a document embeds, resolved against its folder or the root, and nothing for a non-document", async () => {
  const embed = async (from: string, reference: string) =>
    JSON.parse((await get(`/${from}?embed=${encodeURIComponent(reference)}`)).body)

  assert.equal((await embed("notes/a.md", "../data/scores.csv#1.score")).value, 12)
  assert.equal((await embed("guide.md", "/data/scores.csv#0.name")).value, "ada")
  assert.equal((await embed("guide.md", "data/scores.csv")).grid.rows.length, 2)
  assert.equal(
    (await embed("guide.md", "data/absent.csv")).error,
    "No data file at data/absent.csv.",
  )
  assert.equal((await embed("guide.md", "secret.env")).error, "No data file at secret.env.")
  assert.equal(
    (await embed("guide.md", "../outside.csv")).error,
    "../outside.csv is outside the served folder.",
  )
  assert.equal(
    (await embed("guide.md", "#absent")).error,
    "No query named absent in this document.",
  )
  assert.equal((await get("/data/scores.csv?embed=x.csv")).status, 404)
})

test("a result too large to send whole is cut short and said so, and the server goes on answering", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-huge-")))
  fs.writeFileSync(
    path.join(folder, "huge.md"),
    "```sql query\nselect repeat('a', 100000) as text from range(10000)\n```\n",
  )
  const own = new Data(folder, fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-huge-data-")))
  const quiet = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-huge-model-")),
    indexer,
    () => {},
  )
  const other = http.createServer(createHandler(folder, assets, "build-1", quiet, own, () => {}))
  const otherBase = `http://localhost:${await listen(other, 0)}`

  try {
    const response = await fetch(`${otherBase}/huge.md?embed=${encodeURIComponent("#@1")}`)
    const body = await response.text()
    const embedded = JSON.parse(body)

    assert.equal(response.status, 200)
    assert.ok(body.length < 20 * 1024 * 1024, `answered ${body.length} bytes`)
    assert.equal(embedded.grid.partial, true)
    assert.ok(embedded.grid.rows.length > 0)
    assert.equal(embedded.grid.rows[0][0].length, 20_001)
    assert.equal((await fetch(`${otherBase}/huge.md?raw`)).status, 200)
  } finally {
    other.close()
    quiet.close()
    await own.close()
  }
})

test("a YAML file or chart description that refers to itself is refused in place, never taking the server down", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-cycle-")))
  fs.writeFileSync(path.join(folder, "self.yaml"), "name: &a\n  self: *a\n")
  fs.writeFileSync(
    path.join(folder, "page.md"),
    "{table: self.yaml}\n\n```vega-lite\ndata: &d\n  url: self.yaml\n  again: *d\nmark: bar\n```\n",
  )
  const own = new Data(folder, fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-cycle-data-")))
  const quiet = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-cycle-model-")),
    indexer,
    () => {},
  )
  const other = http.createServer(createHandler(folder, assets, "build-1", quiet, own, () => {}))
  const otherBase = `http://localhost:${await listen(other, 0)}`

  try {
    await quiet.start()
    const embedded = await (await fetch(`${otherBase}/page.md?embed=self.yaml`)).json()
    const page = await (await fetch(`${otherBase}/self.yaml?data`)).json()
    const modelled = await fetch(`${otherBase}/page.md?model`)

    assert.equal(embedded.error, "The file refers to itself at name.self.")
    assert.equal(page.error, "The file refers to itself at name.self.")
    assert.equal(modelled.status, 200)
    assert.deepEqual((await modelled.json()).data, ["self.yaml"])
  } finally {
    other.close()
    quiet.close()
    await own.close()
  }
})

test("a page read before, and its read record, answer at once while slow work no tab waits on fills the engine", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-lane-")))
  fs.writeFileSync(path.join(folder, "t.csv"), "a\n1\n")
  fs.writeFileSync(path.join(folder, "q.sql"), "select * from 't.csv'")
  fs.writeFileSync(path.join(folder, "page.md"), "# Page\n\n{table: q.sql}\n")
  const busy = new Data(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-lane-data-")),
    4000,
  )
  const reading = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-lane-model-")),
    indexer,
    () => {},
  )
  const other = http.createServer(createHandler(folder, assets, "build-1", reading, busy, () => {}))
  const otherBase = `http://localhost:${await listen(other, 0)}`
  const slow = "select sum(hash(a.range + b.range)) from range(200000) a, range(200000) b"
  const background: Promise<unknown>[] = []

  try {
    await reading.start()
    await reading.reads.read(
      "page.md",
      (reading.held("page.md") ?? []).map((block) => ({
        id: block.id,
        version: versionOf(block),
        embeds: { "page.md\nq.sql": "seen" },
      })),
    )
    background.push(...[1, 2].map(() => busy.query(slow, folder).catch((error: Error) => error)))
    await new Promise((resolve) => setTimeout(resolve, 300))

    const started = Date.now()
    const waited = await Promise.all(
      ["?page", "?read"].map(async (asked) => {
        const answered = await fetch(`${otherBase}/page.md${asked}`)
        return `${asked} ${answered.status} ${Date.now() - started < 2000 ? "at once" : "late"}`
      }),
    )

    assert.deepEqual(waited, ["?page 200 at once", "?read 200 at once"])
  } finally {
    await Promise.all(background)
    other.close()
    reading.close()
    await busy.close()
  }
})

test("refuses what is not renderable or not inside the folder", async () => {
  for (const urlPath of [
    "/secret.env",
    "/missing.md",
    "/%2e%2e/etc/passwd",
    "/notes/%2e%2e%2f%2e%2e%2fx.md",
    "/%E0%A4%A",
  ]) {
    assert.ok([400, 404].includes((await get(urlPath)).status), urlPath)
  }
})

test("an address that serves nothing gets the page shell marked missing, with a 404; a query gets plain text", async () => {
  for (const urlPath of ["/missing.md", "/nope/", "/secret.env", "/img/absent.png"]) {
    const response = await get(urlPath)

    assert.equal(response.status, 404, urlPath)
    assert.match(response.headers["content-type"] ?? "", /^text\/html/, urlPath)
    assert.match(String(response.headers["content-security-policy"]), /default-src 'self'/, urlPath)
    assert.match(response.body, /<html [^>]* data-missing>/, urlPath)
    assert.doesNotMatch(response.body, /TOKEN/, urlPath)
  }

  assert.doesNotMatch((await get("/guide.md")).body, /data-missing/)

  for (const urlPath of ["/missing.md?raw", "/missing.md?page", "/missing.md?api=document"]) {
    const response = await get(urlPath)

    assert.equal(response.status, 404, urlPath)
    assert.match(response.headers["content-type"] ?? "", /^text\/plain/, urlPath)
  }
})

test("tells what is known of an address: a history kept there, and documents of the same file name", async () => {
  assert.deepEqual(JSON.parse((await get("/elsewhere/a.md?not-found")).body), {
    history: false,
    named: ["notes/a.md"],
    ready: true,
  })
  assert.deepEqual(JSON.parse((await get("/never/was.md?not-found")).body), {
    history: false,
    named: [],
    ready: true,
  })
})

test("tells where a document moved from an address it left, and that Folio is still reading", async () => {
  await model.history.saved("old/route.md", "# Route\n", Date.now())
  await model.history.rename("old/route.md", "new/path.md")
  assert.deepEqual(JSON.parse((await get("/old/route.md?not-found")).body), {
    history: true,
    moved: "new/path.md",
    named: [],
    ready: true,
  })
  await model.history.saved("old/route.md", "# Another route\n", Date.now())
  await model.history.removed("old/route.md", Date.now())
  assert.deepEqual(JSON.parse((await get("/old/route.md?not-found")).body), {
    history: true,
    named: [],
    ready: true,
  })

  const tracked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-moved-")))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@a",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@a",
  }
  fs.writeFileSync(path.join(tracked, "leaving.md"), "# Leaving\n")
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "-qm", "leaving"],
  ]) {
    execFileSync("git", args, { cwd: tracked, env })
  }
  const moving = new Model(
    tracked,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-")),
    indexer,
    () => {},
  )
  const served = http.createServer(
    createHandler(tracked, assets, "build-1", moving, data, () => {}),
  )
  const origin = `http://localhost:${await listen(served, 0)}`
  await moving.history.saved("leaving.md", "# Leaving, edited\n", Date.now())
  fs.renameSync(path.join(tracked, "leaving.md"), path.join(tracked, "arrived.md"))
  await moving.history.rename("leaving.md", "arrived.md")
  const moved = JSON.parse((await get("/leaving.md?not-found", undefined, origin)).body).moved

  served.close()
  moving.close()
  assert.equal(moved, "arrived.md")

  const reading = new Model(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-")),
    indexer,
    () => {},
  )
  const early = http.createServer(createHandler(root, assets, "build-1", reading, data, () => {}))
  const { body } = await get(
    "/gone.md?not-found",
    undefined,
    `http://localhost:${await listen(early, 0)}`,
  )

  early.close()
  reading.close()
  assert.equal(JSON.parse(body).ready, false)
})

test("serves bundled assets by name only", async () => {
  assert.equal((await get("/?asset=page.js")).body, "console.log(1)")
  assert.equal((await get("/notes/?asset=page.js")).status, 200)
  assert.equal((await get("/?asset=../package.json")).status, 404)
  assert.equal((await get("/?asset=missing.js")).status, 404)
})

test("serves a chunk the page script imports by its absolute asset address", async () => {
  assert.equal((await get("/?asset=/page.js")).body, "console.log(1)")
  assert.equal((await get("/?asset=//page.js")).status, 404)
  assert.equal((await get("/?asset=/../package.json")).status, 404)
})

test("refuses a request whose Host is not a localhost name", async () => {
  assert.equal((await get("/guide.md", "attacker.example:80")).status, 403)
  assert.equal((await get("/guide.md", "127.0.0.1:1")).status, 200)
})

test("logs one line per request, a request answered with a failure as a problem", async () => {
  lines.length = 0
  levels.length = 0
  await get("/guide.md")
  await get("/missing.md")
  await get("/guide.md?raw", "example.com")
  await get("/favicon.ico")
  await get("/.well-known/appspecific/com.chrome.devtools.json")
  await get("/missing.md?page")
  await get("/missing.md?raw")
  for (const address of ["/img/missing.png", "/gone.md"]) {
    await new Promise((resolve) =>
      http.request(`${base}${address}`, { method: "HEAD" }, resolve).end(),
    )
  }
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(levels, [
    "GET /guide.md 200 request",
    "GET /missing.md 404 warning",
    "GET /guide.md?raw 403 warning",
    "GET /favicon.ico 200 request",
    "GET /.well-known/appspecific/com.chrome.devtools.json 404 request",
    "GET /missing.md?page 404 request",
    "GET /missing.md?raw 404 warning",
    "HEAD /img/missing.png 404 request",
    "HEAD /gone.md 404 warning",
  ])
})

test("an unexpected failure answers a fixed text naming the part it escaped, the innermost first, and logs one line with the reason; a refusal answers as before", async () => {
  const said: string[] = []
  const stopped = guarded("data engine", {
    page: () => Promise.reject(new Error("engine stopped")),
    dependencies: () => Promise.reject(new Error("engine gone")),
  }) as unknown as Data
  const other = http.createServer(
    createHandler(root, assets, "build-1", model, stopped, (line, level) =>
      said.push(`${line} ${level}`),
    ),
  )
  const otherBase = `http://localhost:${await listen(other, 0)}`
  const conventions = conventionsOf(model) as unknown as Record<string, unknown>
  const history = model.history as unknown as Record<string, unknown>
  const health = healthOf(model, data) as unknown as Record<string, unknown>
  // The model's impact keeps the first Data it gets; the failing handler must not hand it the stub.
  impactOf(model, data)
  const where =
    "failed while answering this request. The reason is in Folio's log, in the terminal running it.\n"
  conventions.kindOf = () => {
    throw new Error("alias unresolved")
  }
  history.lastDigest = () => {
    throw new Error("history unreadable")
  }
  health.state = () => Promise.reject(new Error("health stuck"))

  try {
    const answers: string[] = []

    for (const address of [
      "/?api=documents",
      "/?digest-data&from=0&to=1",
      "/data/scores.csv?data",
      "/guide.md?api=document",
      "/?api=health",
      "/?api=needs",
      "/?api=query",
    ]) {
      const answered = await fetch(`${otherBase}${address}`)
      answers.push(`${answered.status} ${await answered.text()}`)
    }

    assert.deepEqual(answers, [
      `500 Reading the folder's FOLIO.md declarations ${where}`,
      `500 Folio's history ${where}`,
      `500 Folio's data engine ${where}`,
      `500 Folio's data engine ${where}`,
      `500 Folio's health check ${where}`,
      `500 Folio's health check ${where}`,
      "400 This resource needs sql.\n",
    ])

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(said, [
      "GET /?api=documents 500: alias unresolved error",
      "GET /?digest-data&from=0&to=1 500: history unreadable error",
      "GET /data/scores.csv?data 500: engine stopped error",
      "GET /guide.md?api=document 500: engine gone error",
      "GET /?api=health 500: health stuck error",
      "GET /?api=needs 500: health stuck error",
      "GET /?api=query 400 warning",
    ])
  } finally {
    delete conventions.kindOf
    delete history.lastDigest
    delete health.state
    other.close()
  }
})

test("a query failing inside the declarations, history or read record answers like any unexpected failure; the query's own errors keep 400 and their reason", async () => {
  const said: string[] = []
  const serve = async (tables: Data) => {
    const other = http.createServer(
      createHandler(root, assets, "build-1", model, tables, (line, level) =>
        said.push(`${line} ${level}`),
      ),
    )
    return { other, at: `http://localhost:${await listen(other, 0)}` }
  }
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-query-"))
  const declared = guarded("data engine", new Data(root, scratch()))
  const failing = (part: "history" | "read record") => {
    const tables = guarded("data engine", new Data(root, scratch()))
    tables.useDocuments({
      ready: true,
      versionOf: () => "1",
      table: () =>
        within(part, () => {
          throw new Error(`${part} unreadable`)
        }),
    })
    return tables
  }
  const conventions = conventionsOf(model) as unknown as Record<string, unknown>
  const where =
    "failed while answering this request. The reason is in Folio's log, in the terminal running it.\n"
  const ask = async (at: string, sql: string) => {
    const answered = await fetch(`${at}/?api=query&sql=${encodeURIComponent(sql)}`)
    return `${answered.status} ${await answered.text()}`
  }

  declared.useDocuments(documentsOf(model))
  conventions.kindOf = () => {
    throw new Error("alias unresolved")
  }
  const servers = await Promise.all(
    [declared, failing("history"), failing("read record")].map(serve),
  )

  try {
    const [declarations, history, record] = servers.map(({ at }) => at)

    assert.deepEqual(
      [
        await ask(declarations, "select path from folio.links"),
        await ask(history, "select path from folio.links"),
        await ask(record, "select path from folio.links"),
        await ask(declarations, "select * from kind.nothing"),
        await ask(declarations, "select * from 'data/missing.csv'"),
      ],
      [
        `500 Reading the folder's FOLIO.md declarations ${where}`,
        `500 Folio's history ${where}`,
        `500 Folio's read record ${where}`,
        "400 No kind is named nothing: a declaration names the kinds a query reads.\n",
        `400 No data file at data/missing.csv. The served folder is ${root}: a path in a query is relative to the query's folder, from the served folder after a slash, or absolute under it.\n`,
      ],
    )

    const column = await ask(declarations, "select nope from 'data/scores.csv'")
    assert.match(column, /^400 .*"nope"/)
    assert.doesNotMatch(column, /failed while answering/)

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(said.slice(0, 3), [
      "GET /?api=query&sql=select%20path%20from%20folio.links 500: alias unresolved error",
      "GET /?api=query&sql=select%20path%20from%20folio.links 500: history unreadable error",
      "GET /?api=query&sql=select%20path%20from%20folio.links 500: read record unreadable error",
    ])
  } finally {
    delete conventions.kindOf

    for (const { other } of servers) {
      other.close()
    }
  }
})

test("rejects a taken port with an error naming it, leaving nothing waiting to hear the server listen", async () => {
  const port = (server.address() as { port: number }).port
  const refused = http.createServer()
  const waiting = refused.listenerCount("listening")

  await assert.rejects(listen(refused, port), {
    message: `Port ${port} is already in use.`,
  })
  assert.equal(refused.listenerCount("listening"), waiting)
})

test("without a port given, Folio passes over ports another program or another folder's Folio holds", async () => {
  const [first, ...held] = await holding(3, [undefined, "/elsewhere"])
  const moved = http.createServer()

  try {
    assert.equal(await listenFree(moved, first, root), first + 2)
  } finally {
    moved.close()
    await Promise.all(held.map((one) => new Promise((resolve) => one.close(resolve))))
  }
})

test("without a port given, Folio does not serve a folder a Folio serves on a port it passes, and names that address", async () => {
  const [first, ...held] = await holding(3, ["/elsewhere", root])
  const refused = http.createServer()

  try {
    await assert.rejects(listenFree(refused, first, root), {
      message: `${root} is already served at http://localhost:${first + 1}/`,
    })
    assert.equal(refused.listening, false)
  } finally {
    await Promise.all(held.map((one) => new Promise((resolve) => one.close(resolve))))
  }
})

test("shows a document's model as its blocks, its own text with includes unexpanded", async () => {
  const response = await get("/guide.md?model")
  const view = JSON.parse(response.body)

  assert.equal(response.headers["content-type"], "application/json")
  assert.equal(view.path, "guide.md")
  assert.equal(view.kind, "markdown")
  assert.deepEqual(
    view.blocks.map((block: { kind: string; lines: number[]; text: string }) => [
      block.kind,
      block.lines,
      block.text,
    ]),
    [
      ["heading", [1, 1], "# Guide"],
      ["paragraph", [2, 2], "{include: part.md}"],
    ],
  )
  assert.ok(view.blocks.every((block: { id: string }) => /^[0-9a-f]{8}$/.test(block.id)))
  assert.deepEqual(
    view.page.map((block: { kind: string; source: string; lines: number[]; at: number[] }) => [
      block.kind,
      block.source,
      block.lines,
      block.at,
    ]),
    [
      ["heading", "guide.md", [1, 1], [1, 1]],
      ["paragraph", "guide.md", [2, 2], [2, 2]],
      ["paragraph", "part.md", [1, 1], [2, 2]],
    ],
  )
})

test("lists the links into a page with a version, and nothing for an image", async () => {
  const content = JSON.parse((await get("/part.md?links")).body)

  assert.deepEqual(content.links, [])
  assert.match(content.version, /^[0-9a-f]{16}$/)
  assert.equal((await get("/img/photo.png?links")).status, 404)
})

test("serves a page whose included file a program is rewriting in place with the text it writes", async () => {
  const folder = await servedApart(indexer, {
    "page.md": "# Page\n\n{include: part.md}\n",
    "part.md": "The old part.\n",
  })
  const rewriter = await rewriting(path.join(folder.root, "part.md"), "The new part.\n")

  try {
    const page = await (await fetch(`${folder.base}/page.md?page`)).json()
    assert.equal(page.text, "# Page\n\nThe new part.\n\n")
  } finally {
    rewriter.kill()
    await folder.close()
  }
})

test("serves a page emptied on purpose without the title of its text before", async () => {
  const stalled = {
    split: (text: string, kind: "markdown" | "mermaid", previous?: Block[]) =>
      text === "" ? new Promise(() => {}) : indexer.split(text, kind, previous),
  } as unknown as Indexer
  const folder = await servedApart(stalled, { "pump.md": "# Pump\n\nIt runs.\n" })

  try {
    fs.writeFileSync(path.join(folder.root, "pump.md"), "")
    const page = await (await fetch(`${folder.base}/pump.md?page`)).json()
    assert.deepEqual([page.text, page.title], ["", null])
  } finally {
    await folder.close()
  }
})

test("serves a page its parser cannot split at once, without block sources, never failing", async () => {
  const failing = {
    split: () => Promise.reject(new Error("parser failed")),
  } as unknown as Indexer
  const broken = new Model(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-broken-")),
    failing,
    () => {},
  )
  const other = http.createServer(createHandler(root, assets, "build-1", broken, data, () => {}))
  const otherBase = `http://localhost:${await listen(other, 0)}`

  try {
    const first = await (await fetch(`${otherBase}/guide.md?page`)).json()
    assert.equal(first.text, "# Guide\nincluded")
    assert.match(first.version, /-partial$/)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const response = await fetch(`${otherBase}/guide.md?page`)
    const settled = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(settled.blocks, [])
    assert.doesNotMatch(settled.version, /-partial$/)
  } finally {
    broken.close()
    other.close()
  }
})

test("serves a page as its expanded text, its version and the blocks every file it read places on it", async () => {
  const response = await get("/guide.md?page")
  const content = JSON.parse(response.body)

  assert.equal(response.headers["content-type"], "application/json")
  assert.equal(content.text, "# Guide\nincluded")
  assert.equal(content.version, (await get("/guide.md?raw")).headers["x-folio-version"])
  assert.deepEqual(
    content.blocks.map((block: { source: string; lines: number[] }) => [block.source, block.lines]),
    [
      ["guide.md", [1, 1]],
      ["guide.md", [2, 2]],
      ["part.md", [1, 1]],
    ],
  )
  assert.equal((await get("/img/photo.png?page")).status, 404)
  assert.equal((await get("/missing.md?page")).status, 404)
})

test("a page opened has its blocks' past worked out ahead, those its includes bring in too; one fetched before it is opened has not", async () => {
  const prepared: string[] = []
  const prepare = model.history.prepare.bind(model.history)
  model.history.prepare = (urlPath, current) => {
    prepared.push(urlPath)
    return prepare(urlPath, current)
  }

  try {
    assert.equal((await get("/guide.md?page&ahead")).status, 200)
    assert.deepEqual(prepared, [])
    assert.equal((await get("/guide.md?page")).status, 200)
    assert.deepEqual(prepared, ["guide.md", "part.md"])
  } finally {
    model.history.prepare = prepare
  }
})

test("shows how far the model has got for a folder, and nothing for an image or a missing file", async () => {
  assert.deepEqual(
    (({ ready, documents }) => ({ ready, documents }))(JSON.parse((await get("/?model")).body)),
    { ready: true, documents: 4 },
  )
  assert.equal(JSON.parse((await get("/notes/?model")).body).documents, 1)
  assert.equal((await get("/img/logo.svg?model")).status, 404)
  assert.equal((await get("/missing.md?model")).status, 404)
})

test("served from inside a repository, history reads nothing outside the folder", async () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-repo-")))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@a",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@a",
  }
  fs.mkdirSync(path.join(outer, "served"))
  fs.writeFileSync(path.join(outer, "secret.md"), "# Secret words\n")
  fs.writeFileSync(path.join(outer, "served/page.md"), "# Page\n")
  fs.symlinkSync("../secret.md", path.join(outer, "served/link.md"))
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "-q", "-m", "s"],
  ]) {
    execFileSync("git", args, { cwd: outer, env })
  }
  const folder = path.join(outer, "served")
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-repo-model-"))
  const own = new Model(folder, store, indexer, () => {})
  const other = http.createServer(
    createHandler(folder, assets, "build-1", own, new Data(folder, store), () => {}),
  )
  const otherBase = `http://localhost:${await listen(other, 0)}`
  const secret = createHash("sha1").update("blob 15\0# Secret words\n").digest("hex")

  try {
    const names = [":(top)secret.md", ":/secret.md", "*.md", "link.md"]
    const asked = names.flatMap((name) => [
      `/${encodeURIComponent(name)}?versions`,
      `/${encodeURIComponent(name)}?version=${secret}`,
      `/${encodeURIComponent(name)}?block-history=x`,
    ])

    for (const address of [...asked, `/page.md?version=${secret}`]) {
      const response = await fetch(`${otherBase}${address}`)
      const body = await response.text()
      assert.doesNotMatch(body, /Secret words/, address)
      assert.ok(response.status === 404 || !/"versions":\[\{/.test(body), `${address}: ${body}`)
    }

    assert.equal((await fetch(`${otherBase}/link.md?history`)).status, 404)
    assert.match(await (await fetch(`${otherBase}/page.md?versions`)).text(), /"versions":\[\{/)
  } finally {
    other.close()
    own.close()
  }
})

test("used-by says it is not ready while the folder is still being read, never an empty list", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-ready-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-ready-model-"))
  fs.writeFileSync(path.join(folder, "pumps.csv"), "n\n3\n")
  fs.writeFileSync(path.join(folder, "report.md"), "{table: pumps.csv}\n")
  const own = new Model(folder, store, indexer, () => {})
  const other = http.createServer(
    createHandler(folder, assets, "build-1", own, new Data(folder, store), () => {}),
  )
  const otherBase = `http://localhost:${await listen(other, 0)}`

  try {
    const early = await (await fetch(`${otherBase}/pumps.csv?used-by`)).json()
    await own.start()
    const later = await (await fetch(`${otherBase}/pumps.csv?used-by`)).json()

    assert.deepEqual(early, { ready: false, documents: [] })
    assert.deepEqual(later, { ready: true, documents: [{ source: "report.md", how: "embeds" }] })
  } finally {
    other.close()
    own.close()
  }
})

function getWith(
  urlPath: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${urlPath}`, { headers }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        body += chunk
      })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on("error", reject)
  })
}

test("the API lists its resources and answers each as JSON, refusing what names nothing", async () => {
  const json = async (urlPath: string) => {
    const response = await get(urlPath)
    assert.equal(response.status, 200, `${urlPath}: ${response.body}`)
    assert.match(response.headers["content-type"] ?? "", /^application\/json/)
    return JSON.parse(response.body)
  }
  const index = await json("/?api")

  assert.ok(index.resources.document.address.includes("?api=document"))
  assert.deepEqual(
    (await json("/notes/?api=documents")).documents.map(({ path: at }: { path: string }) => at),
    ["notes/a.md"],
  )

  const guide = await json("/guide.md?api=document")
  assert.equal(guide.path, "guide.md")
  assert.deepEqual(
    [...new Set(guide.page.map(({ source }: { source: string }) => source))],
    ["guide.md", "part.md"],
  )
  assert.deepEqual(
    (await json("/data/?api=query&sql=select name from 'scores.csv' order by score desc")).rows,
    [["bob"], ["ada"]],
  )
  assert.equal((await json("/?api=health&wait")).ready, true)
  assert.deepEqual((await json("/?api=changes")).documents, [])
  assert.deepEqual((await json("/?api=reads")).documents, [])

  assert.equal((await get("/?api=nothing")).status, 404)
  assert.equal((await get("/data/scores.csv?api=document")).status, 404)
  assert.equal((await get("/?api=query")).status, 400)

  const before = fs.readdirSync(root).sort()
  const written = await get("/?api=query&sql=copy (select 1) to 'written.csv'")
  assert.equal(written.status, 400)
  assert.match(written.body, /Only one SELECT/)
  assert.deepEqual(fs.readdirSync(root).sort(), before)
})

test("the API takes a path absolute under the served folder, and each refusal of a path names the served folder", async () => {
  const answered = async (urlPath: string) => {
    const response = await get(urlPath)
    return `${response.status} ${response.body}`
  }
  const sql = (folder: string, query: string) =>
    answered(`${folder}?api=query&sql=${encodeURIComponent(query)}`)
  const rule = "a path is relative to it, or absolute under it."

  assert.equal(
    await answered(`${root}/guide.md?api=document`),
    await answered("/guide.md?api=document"),
  )
  assert.equal(
    await answered(`${root}/data/?api=documents`),
    await answered("/data/?api=documents"),
  )
  assert.equal(
    await answered(`/guide.md?api=provenance&block=x&source=${root}/part.md`),
    await answered("/guide.md?api=provenance&block=x&source=part.md"),
  )
  assert.equal(
    await sql("/", `select count(1) from '${root}/data/scores.csv'`),
    `200 ${JSON.stringify({ columns: [{ name: "count(1)", type: "BIGINT" }], rows: [[2]], total: 1, partial: false, files: ["data/scores.csv"] })}`,
  )
  assert.equal(
    await sql(`${root}/data/`, "select count(1) from 'scores.csv'"),
    await sql("/data/", "select count(1) from 'scores.csv'"),
  )
  assert.equal(
    JSON.parse(
      (
        await get(
          `/guide.md?api=embed&reference=${encodeURIComponent(`${root}/data/scores.csv#1.score`)}`,
        )
      ).body,
    ).value,
    12,
  )

  assert.equal(
    await answered("/elsewhere/guide.md?api=document"),
    `404 elsewhere/guide.md is no document of the served folder, ${root}: ${rule}\n`,
  )
  assert.equal(
    await answered("/guide.md?api=provenance&block=x&source=/etc/hosts"),
    `404 /etc/hosts is outside the served folder, ${root}: ${rule}\n`,
  )
  assert.equal(
    await answered("/guide.md?api=provenance&block=x&source=elsewhere/part.md"),
    `404 elsewhere/part.md is no document of the served folder, ${root}: ${rule}\n`,
  )
  assert.equal(
    await answered("/elsewhere/guide.md?api=related&block=x"),
    `404 elsewhere/guide.md is no document of the served folder, ${root}: ${rule}\n`,
  )

  // A folder inside the served one whose path spells the served folder's own is read as written.
  const twin = root.slice(1)
  fs.mkdirSync(path.join(root, twin), { recursive: true })
  fs.writeFileSync(path.join(root, twin, "guide.md"), "# Twin\n")

  try {
    assert.match(
      await answered(`/${twin}/guide.md?api=history`),
      new RegExp(`"path":"${twin}/guide.md"`),
    )
    assert.match(
      await answered(`/guide.md?api=provenance&block=x&source=${twin}/guide.md`),
      /^404 No such block on this page\./,
    )
  } finally {
    fs.rmSync(path.join(root, twin.split("/")[0]), { recursive: true, force: true })
  }
  assert.equal(
    await sql("/", `select * from '${root}/data/absent.csv'`),
    `400 No data file at ${root}/data/absent.csv. The served folder is ${root}: a path in a query is relative to the query's folder, from the served folder after a slash, or absolute under it.\n`,
  )
  assert.equal(
    await sql("/data/", "select * from '../../outside.csv'"),
    `400 ../../outside.csv is outside the served folder. The served folder is ${root}: a path in a query is relative to the query's folder, from the served folder after a slash, or absolute under it.\n`,
  )
})

test("health, needs, changes and stale narrow to a document or the folder under a path, and refuse a path that is neither", async () => {
  const old = (Date.now() - 2 * 365 * 86_400_000) / 1000
  const fixture = await served(
    indexer,
    {
      "top.md": "# Top\n\nSee [gone](gone.md).\n",
      "notes/b.md": "# B\n\nSee [gone](gone.md).\n",
      "notes/c.md": "# C\n\nSee [gone](gone.md).\n",
      "notesy/d.md": "# D\n\nSee [gone](gone.md).\n",
      "notes/x.csv": "a\n1\n",
    },
    (folder) => {
      for (const name of ["top.md", "notes/b.md", "notes/c.md", "notesy/d.md"]) {
        fs.utimesSync(path.join(folder, name), old, old)
      }
    },
  )
  const asked = (resource: string, at: string) =>
    api(fixture.root, fixture.model, fixture.data, at, new URLSearchParams({ api: resource }))
  const paths = async (resource: string, key: string, at: string) =>
    ((await asked(resource, at)) as Record<string, { path: string }[]>)[key].map(
      ({ path: found }) => found,
    )

  try {
    for (const read of ["top.md", "notes/b.md"]) {
      const blocks = fixture.model.held(read) ?? []
      await fixture.model.reads.read(
        read,
        blocks.map((block) => ({ id: block.id, version: versionOf(block) })),
      )
      fs.writeFileSync(path.join(fixture.root, read), "# Edited\n\nSee [gone](gone.md).\n")
    }

    for (let tries = 0; (await paths("changes", "documents", "")).length < 2; tries++) {
      assert.ok(tries < 200, "the edits never showed")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.deepEqual(await paths("health", "problems", ""), [
      "notes/b.md",
      "notes/c.md",
      "notesy/d.md",
      "top.md",
    ])
    assert.deepEqual(await paths("health", "problems", "notes/"), ["notes/b.md", "notes/c.md"])
    assert.deepEqual(await paths("health", "problems", "notes"), ["notes/b.md", "notes/c.md"])
    assert.deepEqual(await paths("health", "problems", "notes/c.md"), ["notes/c.md"])
    assert.deepEqual(await paths("stale", "documents", "notes/"), ["notes/c.md"])
    assert.deepEqual(await paths("needs", "needs", "notes/"), ["notes/b.md", "notes/b.md"])
    assert.deepEqual(await paths("needs", "needs", "top.md"), ["top.md", "top.md"])
    assert.deepEqual(await paths("changes", "documents", "notes/"), ["notes/b.md"])
    assert.deepEqual(await paths("changes", "documents", "notesy"), [])
    assert.notEqual(
      ((await asked("health", "notes/")) as { version: string }).version,
      ((await asked("health", "")) as { version: string }).version,
    )
    for (const nowhere of ["nope/", "notes/x.csv"]) {
      await assert.rejects(asked("health", nowhere), (error: Refusal) => {
        assert.equal(error.status, 404)
        assert.equal(
          error.message,
          `${nowhere} is no document or folder of the served folder, ${fixture.root}: a path is relative to it, or absolute under it.`,
        )
        return true
      })
    }
  } finally {
    fixture.model.close()
    await fixture.data.close()
  }
})

test("a path or block naming nothing is refused naming the served folder; a missing file something reads, and a document history holds, keep their answers", async () => {
  const fixture = await served(indexer, {
    "report.md": "# Report\n\n{include: parts/gone.md}\n\n{table: data.csv}\n",
    "data.csv": "n\n3\n",
    "lonely.csv": "x\n1\n",
    "notes/a.md": "# A\n",
  })
  const asked = (resource: string, at: string, more: Record<string, string> = {}) =>
    api(
      fixture.root,
      fixture.model,
      fixture.data,
      at,
      new URLSearchParams({ api: resource, ...more }),
    )
  const refused = (
    resource: string,
    at: string,
    message: string,
    more: Record<string, string> = {},
  ) =>
    assert.rejects(asked(resource, at, more), (error: Refusal) => {
      assert.equal(error.status, 404)
      assert.equal(error.message, message)
      return true
    })
  const rule = "a path is relative to it, or absolute under it."

  try {
    await fixture.model.history.saved("gone/old.md", "# Old\n", Date.now() - 2000)
    await fixture.model.history.removed("gone/old.md", Date.now() - 1000)

    await refused(
      "used-by",
      "nope/wettest.sql",
      `nope/wettest.sql is no file of the served folder, ${fixture.root}, and nothing reads it: ${rule}`,
    )
    await refused(
      "used-by",
      "notes",
      `notes is no file of the served folder, ${fixture.root}, and nothing reads it: ${rule}`,
    )
    assert.deepEqual(await asked("used-by", "parts/gone.md"), {
      ready: true,
      documents: [{ source: "report.md", how: "includes" }],
    })
    assert.deepEqual(await asked("used-by", "lonely.csv"), { ready: true, documents: [] })

    for (const resource of ["documents", "reads"]) {
      await refused(
        resource,
        "nope/",
        `nope/ is no folder of the served folder, ${fixture.root}: ${rule}`,
      )
    }
    await refused(
      "documents",
      "report.md",
      `report.md is no folder of the served folder, ${fixture.root}: ${rule}`,
    )
    await refused(
      "query",
      "nope/",
      `nope/ is no folder of the served folder, ${fixture.root}: ${rule}`,
      { sql: "select 1" },
    )
    assert.deepEqual(await asked("documents", "notes/"), {
      ready: true,
      documents: [{ path: "notes/a.md", kind: null }],
    })
    assert.deepEqual(await asked("reads", "notes/"), { documents: [] })
    assert.deepEqual(
      ((await asked("query", "notes/", { sql: "select 1 as n" })) as { rows: unknown[] }).rows,
      [[1]],
    )

    const modes: Record<string, string>[] = [
      {},
      { version: "0".repeat(40) },
      { reference: "data.csv" },
      { block: "zzzzzzzz" },
    ]

    for (const more of modes) {
      await refused(
        "history",
        "never-existed.md",
        `never-existed.md is no document of the served folder, ${fixture.root}, now or in its history: ${rule}`,
        more,
      )
    }
    await refused("history", "report.md", "No version of report.md holds the block zzzzzzzz.", {
      block: "zzzzzzzz",
    })

    for (let save = 0; save < 201; save++) {
      await fixture.model.history.saved("many.md", `# Draft ${save}\n`, Date.now() - 400_000 + save)
    }
    await refused(
      "history",
      "many.md",
      "No version of many.md among its newest 200 holds the block zzzzzzzz.",
      { block: "zzzzzzzz" },
    )

    const gone = (await asked("history", "gone/old.md")) as { versions: { removed?: true }[] }
    assert.deepEqual(
      gone.versions.map(({ removed }) => removed ?? false),
      [true, false],
    )

    const [heading] = fixture.model.held("report.md") ?? []
    const texts = (await asked("history", "report.md", { block: heading.id })) as {
      versions: { text?: string }[]
    }
    assert.deepEqual(
      texts.versions.map(({ text }) => text),
      ["# Report"],
    )
  } finally {
    fixture.model.close()
    await fixture.data.close()
  }
})

test("kinds answers each where, pattern and field option as the FOLIO.md writes them", async () => {
  const fixture = await served(indexer, {
    "FOLIO.md": [
      "# Declared\n",
      "```yaml folio",
      "kinds:",
      "  ticket:",
      "    where: [tickets/**/*.md, archive/*.md]",
      "    fields:",
      "      id: {from: name, pattern: '^([A-Z]-\\d+)/?'}",
      "      size: {from: label, label: Size, empty: [None, N/A]}",
      "      whole: {from: name, pattern: ''}",
      "health:",
      "  - where: drafts/**",
      "    skip: [link]",
      "```\n",
    ].join("\n"),
    "stations/FOLIO.md":
      "# Stations\n\n```yaml folio\nkinds:\n  station:\n    where: '*.md'\n```\n",
    "tickets/T-7_pump.md": "# Pump\n\n**Size:** none\n",
  })
  const asked = (resource: string, at: string) =>
    api(fixture.root, fixture.model, fixture.data, at, new URLSearchParams({ api: resource }))

  try {
    const { kinds, health } = JSON.parse(JSON.stringify(await asked("kinds", "stations/"))) as {
      kinds: unknown[]
      health: unknown[]
    }
    const { conventions } = (await asked("document", "tickets/T-7_pump.md")) as {
      conventions: { fields: Record<string, unknown> }
    }

    assert.deepEqual(kinds, [
      {
        name: "ticket",
        declaredIn: "FOLIO.md",
        where: ["tickets/**/*.md", "archive/*.md"],
        fields: {
          id: {
            from: "name",
            type: "text",
            of: "text",
            key: "id",
            pattern: "^([A-Z]-\\d+)/?",
            by: "id",
            empty: [],
          },
          size: {
            from: "label",
            type: "text",
            of: "text",
            key: "Size",
            by: "id",
            empty: ["None", "N/A"],
          },
          whole: {
            from: "name",
            type: "text",
            of: "text",
            key: "whole",
            pattern: "",
            by: "id",
            empty: [],
          },
        },
      },
      { name: "station", declaredIn: "stations/FOLIO.md", where: ["*.md"], fields: {} },
    ])
    assert.deepEqual(health, [
      { declaredIn: "FOLIO.md", where: ["drafts/**"], skip: ["link"], error: [] },
    ])
    assert.deepEqual(conventions.fields, { id: "T-7", size: null, whole: "" })
  } finally {
    fixture.model.close()
    await fixture.data.close()
  }
})

test("kinds and reads take a folder with or without its trailing slash, and a path naming nothing as a document", async () => {
  const declared = (severity: string) =>
    `# Declared\n\n\`\`\`yaml folio\nrules:\n  titled:\n    query: select path from folio.documents where false\n    severity: ${severity}\n\`\`\`\n`
  const fixture = await served(indexer, {
    "FOLIO.md": declared("warning"),
    "stations/FOLIO.md": declared("error"),
    "stations/alpha.md": "# Alpha\n",
    "notes/a.md": "# A\n",
    "notesy/b.md": "# B\n",
  })
  const asked = (resource: string, at: string) =>
    api(fixture.root, fixture.model, fixture.data, at, new URLSearchParams({ api: resource }))
  const kinds = async (at: string) => {
    const { declarations, rules } = (await asked("kinds", at)) as {
      declarations: string[]
      rules: { name: string; declaredIn: string; severity: string }[]
    }
    return {
      declarations,
      rules: rules.map(({ name, declaredIn, severity }) => [name, declaredIn, severity]),
    }
  }
  const station = {
    declarations: ["FOLIO.md", "stations/FOLIO.md"],
    rules: [["titled", "stations/FOLIO.md", "error"]],
  }

  try {
    assert.deepEqual(await kinds("stations"), station)
    assert.deepEqual(await kinds("stations/"), station)
    assert.deepEqual(await kinds("stations/new.md"), station)
    assert.deepEqual(await kinds("drafts"), {
      declarations: ["FOLIO.md"],
      rules: [["titled", "FOLIO.md", "warning"]],
    })

    for (const read of ["notes/a.md", "notesy/b.md"]) {
      const blocks = fixture.model.held(read) ?? []
      await fixture.model.reads.read(
        read,
        blocks.map((block) => ({ id: block.id, version: versionOf(block) })),
      )
    }

    for (const at of ["notes", "notes/"]) {
      const { documents } = (await asked("reads", at)) as { documents: { path: string }[] }
      assert.deepEqual(
        documents.map(({ path: found }) => found),
        ["notes/a.md"],
      )
    }
  } finally {
    fixture.model.close()
    await fixture.data.close()
  }
})

test("the API answers every time as ISO 8601 and takes a digest's period as ISO, refusing milliseconds", async () => {
  const fixture = await served(indexer, { "log.md": "# Log\n\nFirst.\n\nSecond.\n" })
  const asked = (at: string, query: Record<string, string>) =>
    api(fixture.root, fixture.model, fixture.data, at, new URLSearchParams(query))
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

  try {
    const blocks = fixture.model.held("log.md") ?? []
    await fixture.model.reads.read(
      "log.md",
      blocks.map((block) => ({ id: block.id, version: versionOf(block) })),
    )
    fs.writeFileSync(path.join(fixture.root, "log.md"), "# Log\n\nFirst, edited.\n\nThird.\n")
    await fixture.model.settled()
    await fixture.model.settled()

    const read = (await asked("log.md", { api: "reads" })) as {
      marks: { at?: unknown }[]
      removed: { at?: unknown }[]
    }
    const history = (await asked("log.md", { api: "history" })) as { versions: { at: unknown }[] }
    const block = (await asked("log.md", { api: "history", block: blocks[0].id })) as {
      versions: { at: unknown }[]
    }
    const period = (await asked("", {
      api: "digest",
      from: "2026-11-02",
      to: "2026-11-02T09:00:00+01:00",
    })) as { from: unknown; to: unknown }
    const unzoned = (await asked("", {
      api: "digest",
      from: "2026-11-02T08:00",
      to: "2026-11-02T08:00:00.5",
    })) as { from: unknown; to: unknown }

    assert.ok(read.marks.length > 0 && read.removed.length > 0, JSON.stringify(read))
    for (const { at } of [...read.marks, ...read.removed, ...history.versions, ...block.versions]) {
      assert.match(String(at), iso)
    }
    assert.deepEqual(period, {
      ...period,
      from: "2026-11-02T00:00:00.000Z",
      to: "2026-11-02T08:00:00.000Z",
    })
    assert.deepEqual(
      [unzoned.from, unzoned.to],
      ["2026-11-02T08:00:00.000Z", "2026-11-02T08:00:00.500Z"],
    )
    const newest = history.versions[0] as unknown as { id: string; at: string }
    const through = (await asked("", { api: "digest", from: "2000-01-01", to: newest.at })) as {
      documents: { path: string; to?: string }[]
    }
    assert.equal(through.documents.find(({ path: at }) => at === "log.md")?.to, newest.id)
    const second = Math.floor(Date.now() / 1000) + 60
    fs.writeFileSync(path.join(fixture.root, "log.md"), "# Log\n\nFirst, edited.\n\nThird, late.\n")
    fs.utimesSync(path.join(fixture.root, "log.md"), second, second + 0.0009995)
    assert.ok(fs.statSync(path.join(fixture.root, "log.md")).mtimeMs % 1 > 0.9992, "a late mtime")
    await fixture.model.settled()
    await fixture.model.settled()
    const late = ((await asked("log.md", { api: "history" })) as typeof history).versions[0] as {
      id: string
      at: string
    }
    const reached = (await asked("", { api: "digest", from: "2000-01-01", to: late.at })) as {
      documents: { path: string; to?: string }[]
    }
    assert.equal(
      reached.documents.find(({ path: at }) => at === "log.md")?.to,
      late.id,
      "a time late in its millisecond",
    )
    assert.deepEqual(
      [
        ((await asked("", { api: "digest", from: "2026-11-02t08:00z" })) as { from: string }).from,
        ((await asked("", { api: "digest", from: "2026-11-02T09:00+01" })) as { from: string })
          .from,
      ],
      ["2026-11-02T08:00:00.000Z", "2026-11-02T08:00:00.000Z"],
    )
    await assert.rejects(asked("", { api: "digest", from: "2026-02-30" }), /2026-02-30 is no time/)
    await assert.rejects(asked("", { api: "digest", from: "1793743622799" }), (error: Refusal) => {
      assert.equal(error.status, 400)
      assert.equal(
        error.message,
        "from 1793743622799 is no time Folio reads: it reads an ISO 8601 date, 2026-11-02, or a date and time to the minute or finer with an optional offset - Z, +01 or +01:00 - as 2026-11-02T09:00:00+01:00; a date alone is midnight UTC, a time without an offset UTC.",
      )
      return true
    })
  } finally {
    fixture.model.close()
    await fixture.data.close()
  }
})

test("asked about a document in a dot-folder or node_modules, the API reads it then and answers as for any other; the folder's lists still leave it out", async () => {
  const fixture = await served(indexer, {
    "FOLIO.md":
      "# Kinds\n\n```yaml folio\nkinds:\n  draft:\n    where: .drafts/*.md\n    fields:\n      grams: {from: frontmatter}\n```\n",
    "plan.md": "# Plan\n\nSee [the probe](.drafts/probe.md#probe).\n",
    ".drafts/probe.md":
      "---\ngrams: 5\n---\n# Probe\n\nSee [gone](gone.md).\n\nThe count is {value: data.csv#0.n}.\n\n{include: part.md}\n\n{include: kept.md#kept}\n",
    ".drafts/part.md": "Brought in from beside it.\n",
    ".drafts/kept.md": "# Kept\n\nA kept section.\n\n# Other\n\nNot this.\n",
    ".drafts/data.csv": "n\n3\n",
    "node_modules/pkg/README.md": "# Pkg\n\nA readme.\n",
  })
  const asked = (at: string, query: Record<string, string>) =>
    api(fixture.root, fixture.model, fixture.data, at, new URLSearchParams(query))
  type Shown = {
    blocks: { id: string; kind: string; text: string }[]
    page: { source: string }[]
    conventions: { kind?: string; fields?: Record<string, unknown> }
    data: string[]
  }
  const linkProblems = async () =>
    (
      (await asked("", { api: "health" })) as { problems: { path: string; kind: string }[] }
    ).problems
      .filter(({ kind }) => kind === "link")
      .map(({ path: at }) => at)

  try {
    const before = await linkProblems()
    const draft = (await asked(".drafts/probe.md", { api: "document" })) as Shown
    const counted = draft.blocks.find(({ text }) => text.startsWith("The count"))

    assert.deepEqual(
      draft.blocks.map(({ kind, text }) => `${kind} ${text}`),
      [
        "frontmatter --- grams: 5 ---",
        "heading # Probe",
        "paragraph See [gone](gone.md).",
        "paragraph The count is {value: data.csv#0.n}.",
        "paragraph {include: part.md}",
        "paragraph {include: kept.md#kept}",
      ],
    )
    assert.deepEqual(
      [".drafts/part.md", ".drafts/kept.md"].filter((included) =>
        draft.page.some(({ source }) => source === included),
      ),
      [".drafts/part.md", ".drafts/kept.md"],
      "an included draft, whole and a section of one",
    )
    assert.deepEqual(
      fixture.model
        .backlinks(
          ".drafts/probe.md",
          pageState(fixture.root, path.join(fixture.root, ".drafts/probe.md"), fixture.model)
            .blocks,
        )
        .map(({ source, part }) => [source, part]),
      [["plan.md", "Probe"]],
    )
    assert.deepEqual([draft.conventions.kind, draft.conventions.fields], ["draft", { grams: "5" }])
    assert.deepEqual(draft.data, [".drafts/data.csv"])
    const traced = (await asked(".drafts/probe.md", {
      api: "provenance",
      block: counted?.id ?? "",
    })) as { lines: number[]; changed?: string }
    assert.deepEqual(traced.lines, [8, 8])
    assert.match(traced.changed ?? "", /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(
      await linkProblems(),
      before,
      "health is the same whether or not a tool read the draft",
    )
    assert.deepEqual(
      ((await asked("node_modules/pkg/README.md", { api: "document" })) as Shown).blocks.map(
        ({ text }) => text,
      ),
      ["# Pkg", "A readme."],
    )

    fs.writeFileSync(path.join(fixture.root, ".drafts/probe.md"), "# Probe\n\nRewritten.\n")
    const heading = draft.blocks.find(({ kind }) => kind === "heading")?.id
    const rewritten = (await asked(".drafts/probe.md", { api: "document" })) as Shown
    assert.deepEqual(
      rewritten.blocks.map(({ text }) => text),
      ["# Probe", "Rewritten."],
    )
    assert.equal(rewritten.blocks[0].id, heading, "an unchanged block keeps its id")
    assert.deepEqual(
      ((await asked("", { api: "documents" })) as { documents: { path: string }[] }).documents.map(
        ({ path: found }) => found,
      ),
      ["FOLIO.md", "plan.md"],
    )
    assert.ok(!(await linkProblems()).some((at) => at.startsWith(".drafts/")))
  } finally {
    fixture.model.close()
    await fixture.data.close()
  }
})

test("a document's link to a document the model leaves out names nothing of its kind, whether or not a tool read it", async () => {
  const fixture = await served(indexer, {
    "FOLIO.md":
      "# Kinds\n\n```yaml folio\nkinds:\n  draft:\n    where: .drafts/*.md\n  plan:\n    where: plan.md\n    fields:\n      probe: {from: label, type: list, of: link, to: draft}\n```\n",
    "plan.md": "# Plan\n\n**Probe:** [the probe](.drafts/probe.md)\n",
    ".drafts/probe.md": "# Probe\n\nA draft.\n",
  })

  try {
    await api(
      fixture.root,
      fixture.model,
      fixture.data,
      ".drafts/probe.md",
      new URLSearchParams({ api: "document" }),
    )
    assert.deepEqual(
      (await healthOf(fixture.model, fixture.data).state()).problems
        .filter(({ kind }) => kind === "field")
        .map(({ path: at, what }) => [at, what.endsWith("names no draft")]),
      [["plan.md", true]],
    )
  } finally {
    fixture.model.close()
    await fixture.data.close()
  }
})

test("the API refuses another site's page, a foreign Origin or Host, and anything but reading", async () => {
  assert.equal((await getWith("/?api=health", { origin: "https://evil.example" })).status, 403)
  assert.equal((await getWith("/?api=health", { "sec-fetch-site": "cross-site" })).status, 403)
  assert.equal((await get("/?api=health", "evil.example")).status, 403)
  assert.equal((await getWith("/?api=health", { origin: "http://localhost:8640" })).status, 200)

  const posted = await new Promise<number>((resolve, reject) => {
    const request = http.request(`${base}/?api=health`, { method: "POST" }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on("error", reject)
    request.end()
  })
  assert.equal(posted, 405)
})

test("a query that fails through the API names files by their place in the folder, without the engine's statement", async () => {
  fs.writeFileSync(path.join(root, "data/broken.json"), '{"a": [1, 2,')

  try {
    const malformed = await get(
      `/data/?api=query&sql=${encodeURIComponent("select * from 'broken.json'")}`,
    )
    assert.equal(malformed.status, 400)
    assert.match(malformed.body, /data\/broken\.json/)
    assert.ok(!malformed.body.includes(root), malformed.body)

    const unknown = await get(
      `/data/?api=query&sql=${encodeURIComponent("select nope from 'scores.csv'")}`,
    )
    assert.equal(unknown.status, 400)
    assert.match(unknown.body, /nope/)
    assert.doesNotMatch(unknown.body, /LINE \d+:|folio_view|\^/)
  } finally {
    fs.rmSync(path.join(root, "data/broken.json"))
  }
})

test("while sharing is paused, the views of what the reader read answer only that, except to Folio's own pages", async () => {
  const views = [
    "/notes/a.md?read",
    "/notes/a.md?page",
    "/?changed",
    "/?needs-data",
    "/?stale-data",
  ]
  presenceOf(model).pause(true)

  try {
    for (const view of views) {
      assert.equal(JSON.parse((await get(view)).body).paused, true, view)
      const own = await getWith(view, { "sec-fetch-site": "same-origin" })
      assert.equal(own.status, 200, view)
      assert.equal(JSON.parse(own.body).paused, undefined, view)
    }
  } finally {
    presenceOf(model).pause(false)
  }

  for (const view of views) {
    assert.equal(JSON.parse((await get(view)).body).paused, undefined, view)
  }
})

async function servedApart(parser: Indexer, files: Record<string, string>) {
  const { root: folder, model: own, data: engine } = await served(parser, files)
  const other = http.createServer(createHandler(folder, assets, "build-1", own, engine, () => {}))
  const at = `http://localhost:${await listen(other, 0)}`

  return {
    root: folder,
    base: at,
    close: async () => {
      own.close()
      await engine.close()
      other.close()
    },
  }
}

/** `count` free ports in a row, the first held: undefined by a non-Folio server, a path by a Folio of it. */
async function holding(
  count: number,
  roots: (string | undefined)[],
): Promise<[number, ...http.Server[]]> {
  for (;;) {
    const probe = http.createServer()
    const first = await listen(probe, 0)
    probe.close()
    const servers: http.Server[] = []

    try {
      for (let at = 0; at < count; at++) {
        const folio = roots[at]
        const one = http.createServer((request, response) => {
          response.setHeader("Content-Type", "application/json")
          response.end(folio && request.url === "/?api" ? JSON.stringify({ root: folio }) : "no")
        })
        await listen(one, first + at)
        servers.push(one)
      }
    } catch {
      await Promise.all(servers.map((one) => new Promise((resolve) => one.close(resolve))))
      continue
    }

    const free = servers.splice(roots.length)
    await Promise.all(free.map((one) => new Promise((resolve) => one.close(resolve))))
    return [first, ...servers]
  }
}
