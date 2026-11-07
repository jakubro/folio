import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import WebSocket from "ws"
import { blockVersion } from "../src/server/blocks.ts"
import { Data } from "../src/server/data.ts"
import { Hub, type Subscription } from "../src/server/events.ts"
import { createHandler, listen } from "../src/server/http.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"

interface Event {
  event: string
  data: { type?: string; kind?: string; path?: string; version?: string | null }
}

/** The hub needs only that block sources settle, not what they are; no worker thread is started for it. */
const indexer = { split: async () => [], close: async () => {} } as unknown as Indexer
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-")))
const log: string[] = []
const hub = new Hub(root, "build-1", (line) => log.push(line), 200)
const model = new Model(
  root,
  fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-model-")),
  indexer,
  () => {},
)
const data = new Data(root, fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-data-")))
const server = http.createServer(createHandler(root, root, "build-1", model, data, () => {}))
hub.attach(server)
hub.follow(model)
hub.read(data)
let base = ""

for (const [name, content] of Object.entries({
  "page.md": "# Page\n{include: parts/part.md}\n![](img/pic.png)",
  "parts/part.md": "part",
  "other.md": "other",
  "img/pic.png": "v1",
  "tree/a.md": "a",
  "figures/scores.csv": "name,score\nada,3\n",
  "figures/total.sql": "select sum(score) as total from 'scores.csv'",
  "figures/page.md": "{table: scores.csv}\n\n{value: total.sql#0.total}\n",
})) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  fs.writeFileSync(path.join(root, name), content)
}

before(async () => {
  base = `http://localhost:${await listen(server, 0)}`
})

after(async () => {
  await data.close()
  void indexer.close()
  model.close()
  server.closeAllConnections()
  server.close()
})

class Tab {
  readonly events: Event[] = []
  readonly socket: WebSocket

  constructor(options: WebSocket.ClientOptions = {}, origin = base) {
    this.socket = new WebSocket(`${origin.replace("http", "ws")}/?events`, {
      origin,
      ...options,
    })
    this.socket.on("message", (data) => {
      const message = JSON.parse(String(data))
      this.events.push({ event: message.type, data: message })
    })
    this.socket.on("error", () => {})
  }

  async connected(): Promise<this> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve) => this.socket.once("open", resolve))
    }

    return this
  }

  /** The server applies a subscription as it arrives; the pause lets it land before asserting. */
  async subscribe(subscription: Subscription): Promise<void> {
    this.socket.send(JSON.stringify({ type: "subscribe", ...subscription }))
    await sleep(50)
  }

  changes(): Event["data"][] {
    return this.events.filter((e) => e.event === "change").map((e) => e.data)
  }

  async next(event: string, timeoutMs = 2000): Promise<Event> {
    const deadline = Date.now() + timeoutMs
    const seen = this.events.length

    while (Date.now() < deadline) {
      const found = this.events.slice(seen).find((e) => e.event === event)

      if (found) {
        return found
      }

      await sleep(10)
    }

    throw new Error(`no ${event} event within ${timeoutMs} ms`)
  }

  close(): void {
    this.socket.terminate()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A version still parsing its block sources changes once they are ready, so tests wait for that. */
async function versionOf(urlPath: string): Promise<string> {
  for (;;) {
    const version = (await fetch(`${base}/${urlPath}?raw`)).headers.get("x-folio-version") ?? ""

    if (!version.endsWith("-partial")) {
      return version
    }

    await sleep(20)
  }
}

async function folderVersion(urlPath: string): Promise<string> {
  return (await (await fetch(`${base}/${urlPath}?tree`)).json()).version
}

test("a tab hears which build the server runs as soon as it connects", async () => {
  const tab = await new Tab().connected()
  await sleep(50)

  assert.deepEqual(tab.events.find((e) => e.event === "hello")?.data, {
    type: "hello",
    build: "build-1",
  })
  tab.close()
})

test("a subscription holding current versions hears nothing until something changes", async () => {
  const tab = await new Tab().connected()

  await tab.subscribe({ page: { "page.md": await versionOf("page.md") } })
  await sleep(150)
  assert.deepEqual(tab.changes(), [])
  tab.close()
})

test("a subscription holding stale versions is answered at once", async () => {
  const tab = await new Tab().connected()

  await tab.subscribe({ page: { "page.md": "stale" }, folders: { tree: "stale" } })
  await sleep(100)

  assert.deepEqual(
    tab.changes().map((c) => [c.kind, c.path]),
    [
      ["page", "page.md"],
      ["folder", "tree"],
    ],
  )
  tab.close()
})

test("saving the page or a file it includes updates it; saving another file does not", async () => {
  const tab = await new Tab().connected()
  await tab.subscribe({ page: { "page.md": await versionOf("page.md") } })

  fs.writeFileSync(path.join(root, "other.md"), "other, edited")
  await sleep(300)
  assert.deepEqual(tab.changes(), [])

  fs.writeFileSync(path.join(root, "parts/part.md"), "part, edited")
  const change = (await tab.next("change")).data
  assert.deepEqual([change.kind, change.path], ["page", "page.md"])
  assert.equal(change.version?.replace(/-partial$/, ""), await versionOf("page.md"))

  const tmp = path.join(root, ".page.md.tmp")
  fs.writeFileSync(tmp, "# Page, saved by rename")
  fs.renameSync(tmp, path.join(root, "page.md"))
  assert.equal((await tab.next("change")).data.path, "page.md")
  tab.close()
})

test("an embedded image updates on save", async () => {
  const tab = await new Tab().connected()
  const image = (await fetch(`${base}/img/pic.png`)).headers.get("etag")?.replaceAll('"', "") ?? ""
  await tab.subscribe({ images: { "img/pic.png": image } })

  await sleep(20)
  fs.writeFileSync(path.join(root, "img/pic.png"), "version two")
  assert.equal((await tab.next("change")).data.kind, "image")
  tab.close()
})

test("adding a file to an open folder updates the folder", async () => {
  const tab = await new Tab().connected()
  await tab.subscribe({ folders: { tree: await folderVersion("tree") } })

  fs.writeFileSync(path.join(root, "tree/notes.txt"), "not renderable")
  await sleep(300)
  assert.deepEqual(tab.changes(), [])

  fs.writeFileSync(path.join(root, "tree/b.md"), "b")
  assert.deepEqual((await tab.next("change")).data.path, "tree")
  tab.close()
})

test("a closed socket releases every watch it held", async () => {
  const tab = await new Tab().connected()
  await tab.subscribe({ page: { "page.md": "" }, folders: { tree: "" } })
  assert.deepEqual(hub.registry.folders.sort(), [root, path.join(root, "tree")])

  tab.close()
  await sleep(100)
  assert.deepEqual(hub.registry.folders, [])
})

test("replacing a subscription releases what it no longer names", async () => {
  const tab = await new Tab().connected()
  await tab.subscribe({ folders: { tree: "" } })
  await tab.subscribe({ page: { "other.md": "" } })

  assert.deepEqual(hub.registry.folders, [root])
  tab.close()
})

test("every tab hears a heartbeat", async () => {
  const tab = await new Tab().connected()

  await tab.next("ping", 1000)
  tab.close()
})

test("a missing file the tab knows is missing stays quiet until it appears", async () => {
  const tab = await new Tab().connected()
  await tab.subscribe({ page: { "later.md": null } })

  await sleep(150)
  assert.deepEqual(tab.changes(), [])

  fs.writeFileSync(path.join(root, "later.md"), "now here")
  assert.equal((await tab.next("change")).data.path, "later.md")
  tab.close()
})

test("a folder's first file saved into a new subfolder shows in the folder", async () => {
  const tab = await new Tab().connected()
  await tab.subscribe({ folders: { tree: await folderVersion("tree") } })

  fs.mkdirSync(path.join(root, "tree/fresh"))
  await sleep(300)
  await tab.subscribe({ folders: { tree: await folderVersion("tree") } })
  fs.writeFileSync(path.join(root, "tree/fresh/first.md"), "first")

  assert.equal((await tab.next("change")).data.path, "tree")
  tab.close()
})

test("an include whose folder does not exist yet updates the page once both are created", async () => {
  fs.writeFileSync(path.join(root, "waiting.md"), "[{include: later/part.md}]")
  const tab = await new Tab().connected()
  await tab.subscribe({ page: { "waiting.md": await versionOf("waiting.md") } })

  fs.mkdirSync(path.join(root, "later"))
  await sleep(300)
  fs.writeFileSync(path.join(root, "later/part.md"), "arrived")

  assert.equal((await tab.next("change")).data.path, "waiting.md")
  tab.close()
})

test("nothing outside the served folder is ever watched", async () => {
  const tab = await new Tab().connected()
  await tab.subscribe({
    page: { "../../outside/x.md": null },
    images: { "../elsewhere.png": null },
  })

  assert.ok(
    hub.registry.folders.every((dir) => dir === root || dir.startsWith(`${root}${path.sep}`)),
  )
  tab.close()
})

test("a tab that stops answering pings is dropped", async () => {
  const tab = await new Tab({ autoPong: false }).connected()
  const closed = new Promise((resolve) => tab.socket.once("close", resolve))

  const outcome = await Promise.race([closed.then(() => "closed"), sleep(2000).then(() => "open")])
  tab.close()

  assert.equal(outcome, "closed")
})

test("an update socket is logged when it opens", async () => {
  const tab = await new Tab().connected()
  tab.close()

  assert.ok(log.includes("GET /?events 101"))
})

test("a page a tab opens is logged once, as are each page and view it moves to, never a page shown again", async () => {
  const tab = await new Tab().connected()
  const other = await new Tab().connected()
  const tell = (to: Tab, message: object) =>
    to.socket.send(JSON.stringify({ type: "presence", ...message }))
  const opened = () => log.filter((line) => line.startsWith("opened "))
  const before = opened().length

  tell(tab, { page: "page.md" })
  tell(tab, { page: "page.md", source: "page.md", id: "abc" })
  tell(tab, {})
  tell(tab, { page: "page.md" })
  tell(tab, { page: "other.md" })
  tell(tab, { page: "", view: "health" })
  tell(tab, { page: "" })
  tell(other, { page: "other.md" })
  await new Promise((resolve) => setTimeout(resolve, 200))
  tab.close()
  other.close()

  assert.deepEqual(opened().slice(before), [
    "opened /page.md",
    "opened /other.md",
    "opened /?health",
    "opened /",
    "opened /other.md",
  ])
})

test("refuses an update socket from another site, another host or another address", async () => {
  const refused = (url: string, options: WebSocket.ClientOptions) =>
    new Promise<number>((resolve) => {
      const socket = new WebSocket(url, options)
      socket.on("unexpected-response", (_, response) => resolve(response.statusCode ?? 0))
      socket.on("open", () => resolve(101))
      socket.on("error", () => {})
    })
  const ws = base.replace("http", "ws")

  assert.equal(await refused(`${ws}/?events`, { origin: "https://attacker.example" }), 403)
  assert.equal(
    await refused(`${ws}/?events`, { origin: base, headers: { host: "attacker.example" } }),
    403,
  )
  assert.equal(await refused(`${ws}/page.md`, { origin: base }), 403)
})

test("a page served before its block sources are parsed is answered again once they are", async () => {
  fs.writeFileSync(path.join(root, "fresh.md"), "# Fresh\n\nNot parsed yet.")
  const partial = (await fetch(`${base}/fresh.md?raw`)).headers.get("x-folio-version") ?? ""
  const tab = await new Tab().connected()
  await tab.subscribe({ page: { "fresh.md": partial } })
  await sleep(100)

  assert.match(partial, /-partial$/)
  assert.deepEqual(
    tab.changes().map((change) => [change.path, change.version]),
    [["fresh.md", partial.replace(/-partial$/, "")]],
  )
  tab.close()
})

test("each update sent is logged", () => {
  assert.ok(log.some((line) => /^update page \/page\.md -> tab \d+$/.test(line)))
})

test("an embed is answered when a file it reads changes, through a query too, and not for others", async () => {
  const tab = await new Tab().connected()
  const embedVersion = async (reference: string) =>
    (await (await fetch(`${base}/figures/page.md?embed=${encodeURIComponent(reference)}`)).json())
      .version
  const table = "figures/page.md\nscores.csv"
  const query = "figures/page.md\ntotal.sql#0.total"

  await tab.subscribe({
    embeds: {
      [table]: await embedVersion("scores.csv"),
      [query]: await embedVersion("total.sql#0.total"),
    },
  })
  fs.writeFileSync(path.join(root, "figures/other.csv"), "a\n1\n")
  await sleep(300)
  assert.deepEqual(tab.changes(), [])

  fs.writeFileSync(path.join(root, "figures/scores.csv"), "name,score\nada,3\nbob,4\n")
  await tab.next("change")
  await sleep(200)
  assert.deepEqual(
    tab
      .changes()
      .map(({ kind, path: key }) => [kind, key])
      .sort(),
    [
      ["embed", table],
      ["embed", query],
    ],
  )
  tab.close()
})

test("a page's change reaches its tab while another item of the tab is still being worked out", async () => {
  const tab = await new Tab().connected()
  const slow = data as unknown as Record<string, unknown>
  slow.reads = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ files: [], version: "slow", dirs: [] }), 1500),
    )

  try {
    await tab.subscribe({
      page: { "page.md": await versionOf("page.md") },
      embeds: { "figures/page.md\nscores.csv": "stale" },
    })
    const started = Date.now()
    fs.writeFileSync(path.join(root, "page.md"), "# Page, saved while an embed is read")

    while (!tab.changes().some((change) => change.kind === "page")) {
      await sleep(10)
    }

    const waited = Date.now() - started
    assert.ok(waited < 1000, `the page's change waited ${waited} ms`)
  } finally {
    delete slow.reads
    tab.close()
  }
})

test("a page's marks and embeds reach its tab while slow work no tab waits on fills the engine", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-lane-")))
  fs.writeFileSync(path.join(folder, "t.csv"), "a\n1\n")
  fs.writeFileSync(path.join(folder, "q.sql"), "select * from 't.csv'")
  fs.writeFileSync(path.join(folder, "page.md"), "# Page\n\n{table: q.sql}\n")
  const parser = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))
  const reading = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-lane-model-")),
    parser,
    () => {},
  )
  const busy = new Data(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-lane-data-")),
    4000,
  )
  const lane = new Hub(folder, "build-1", () => {}, 200)
  const served = http.createServer(
    createHandler(folder, folder, "build-1", reading, busy, () => {}),
  )
  lane.attach(served)
  lane.follow(reading)
  lane.read(busy)
  const origin = `http://localhost:${await listen(served, 0)}`
  const slow = "select sum(hash(a.range + b.range)) from range(200000) a, range(200000) b"
  const background: Promise<unknown>[] = []

  try {
    await reading.start()
    await reading.reads.read(
      "page.md",
      (reading.held("page.md") ?? []).map((block) => ({
        id: block.id,
        version: blockVersion(block.text, block.kind),
        embeds: { "page.md\nq.sql": "seen" },
      })),
    )
    background.push(...[1, 2].map(() => busy.query(slow, folder).catch((error: Error) => error)))
    await sleep(300)
    const tab = await new Tab({}, origin).connected()
    const started = Date.now()
    await tab.subscribe({ reads: { "page.md": "stale" }, embeds: { "page.md\nq.sql": "stale" } })

    while (tab.changes().length < 2 && Date.now() - started < 2000) {
      await sleep(10)
    }

    tab.close()
    assert.deepEqual(
      tab
        .changes()
        .map(({ kind, path: key }) => [kind, key])
        .sort(),
      [
        ["embed", "page.md\nq.sql"],
        ["reads", "page.md"],
      ],
    )
  } finally {
    await Promise.all(background)
    served.closeAllConnections()
    served.close()
    reading.close()
    await busy.close()
    await parser.close()
  }
})
