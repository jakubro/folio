import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { Worker } from "node:worker_threads"
import WebSocket from "ws"
import { blockVersion } from "../src/server/blocks.ts"
import { componentsOf } from "../src/server/components.ts"
import { Data } from "../src/server/data.ts"
import { documentsOf } from "../src/server/documents.ts"
import { Hub, type Subscription } from "../src/server/events.ts"
import { createHandler, listen } from "../src/server/http.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"
import { savedOf } from "../src/server/saved.ts"
import { served as servedFolder } from "./served.ts"

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

test("a page's change leaves for its tab before another item's work that holds the thread", async () => {
  const slow = data as unknown as Record<string, unknown>
  slow.reads = (file: string, reference: string) => {
    if (reference !== "#total") {
      return Data.prototype.reads.call(data, file, reference)
    }

    for (const until = Date.now() + 600; Date.now() < until; ) {}
    return Promise.resolve({ files: [], version: "held", dirs: [] })
  }
  const subscription = {
    type: "subscribe",
    embeds: { "page.md\n#total": "stale" },
    page: { "page.md": await versionOf("page.md") },
  }
  // A tab on a thread of its own times what it hears while this one is held.
  const listener = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads")
    const WebSocket = require(workerData.ws)
    const socket = new WebSocket(workerData.url, { origin: workerData.origin })
    socket.on("open", () => socket.send(workerData.subscription))
    socket.on("message", (data) => parentPort.postMessage({ at: Date.now(), ...JSON.parse(String(data)) }))`,
    {
      eval: true,
      workerData: {
        ws: createRequire(import.meta.url).resolve("ws"),
        url: `${base.replace("http", "ws")}/?events`,
        origin: base,
        subscription: JSON.stringify(subscription),
      },
    },
  )
  const heard: (Event["data"] & { at: number })[] = []
  listener.on("message", (message) => heard.push(message))

  try {
    await sleep(1000)
    const started = Date.now()
    fs.writeFileSync(path.join(root, "page.md"), "# Page, saved while the thread is held")

    while (!heard.some((message) => message.kind === "page")) {
      await sleep(10)
    }

    const waited = (heard.find((message) => message.kind === "page")?.at ?? 0) - started
    assert.ok(waited < 400, `the page's change waited ${waited} ms`)
  } finally {
    delete slow.reads
    await sleep(700)
    await listener.terminate()
  }
})

test("a saved view's write reaches the tab open on its document without waiting for a burst of saves to settle", async () => {
  const parser = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))
  const {
    root: folder,
    model: viewing,
    data: viewed,
  } = await servedFolder(parser, {
    "FOLIO.md": "```yaml folio\nsave:\n  - where: [rota.md]\n```\n",
    "tasks.csv": "name\nwire\n",
    "rota.md": "# Rota\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
  })
  const viewer = new Hub(folder, "build-1", () => {}, 200)
  const shown = http.createServer(
    createHandler(folder, folder, "build-1", viewing, viewed, () => {}),
  )
  viewer.attach(shown)
  viewer.follow(viewing)
  viewer.read(viewed)
  const origin = `http://localhost:${await listen(shown, 0)}`
  const saved = savedOf(viewing, viewed)
  const written: number[] = []
  const rota = () => fs.readFileSync(path.join(folder, "rota.md"), "utf8")
  saved.listenWrites(() => written.push(Date.now()))
  saved.start()

  try {
    for (const until = Date.now() + 5000; !rota().includes("wire") && Date.now() < until; ) {
      await sleep(25)
    }

    await saved.settled()
    let version = "-partial"

    while (version.endsWith("-partial")) {
      version = (await fetch(`${origin}/rota.md?raw`)).headers.get("x-folio-version") ?? ""
    }

    const tab = await new Tab({}, origin).connected()
    let heard = 0
    tab.socket.on("message", (message) => {
      heard ||= JSON.parse(String(message)).kind === "page" ? Date.now() : 0
    })
    await tab.subscribe({ page: { "rota.md": version } })
    fs.writeFileSync(path.join(folder, "tasks.csv"), "name\nwire\nbolt\n")

    for (const until = Date.now() + 5000; !heard && Date.now() < until; ) {
      await sleep(10)
    }

    tab.close()
    assert.ok(rota().includes("bolt"), "the view was not written")
    assert.ok(heard > 0, "the tab never heard the write")
    const waited = heard - (written.at(-1) ?? 0)
    assert.ok(waited < 40, `the tab heard the write ${waited} ms after it landed`)
  } finally {
    await saved.settled()
    shown.closeAllConnections()
    shown.close()
    viewing.close()
    await viewed.close()
    await parser.close()
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

test("an embed reading the document tables is worked out once at a time however fast the folder changes, the last change included", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-burst-")))
  fs.writeFileSync(path.join(folder, "q.sql"), "select count(*) as n from folio.documents")
  fs.writeFileSync(path.join(folder, "page.md"), "# Page\n\n{value: q.sql#0.n}\n")
  const parser = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))
  const reading = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-burst-model-")),
    parser,
    () => {},
  )
  let running = 0
  let most = 0

  class SlowReads extends Data {
    override async reads(from: string, reference: string) {
      running++
      most = Math.max(most, running)

      try {
        await sleep(300)
        return await super.reads(from, reference)
      } finally {
        running--
      }
    }
  }

  const slowed = new SlowReads(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-burst-data-")),
  )
  slowed.useDocuments(documentsOf(reading))
  const burst = new Hub(folder, "build-1", () => {}, 200)
  const served = http.createServer(
    createHandler(folder, folder, "build-1", reading, slowed, () => {}),
  )
  burst.attach(served)
  burst.follow(reading)
  burst.read(slowed)
  const origin = `http://localhost:${await listen(served, 0)}`

  try {
    await reading.start()
    const tab = await new Tab({}, origin).connected()
    await tab.subscribe({ embeds: { "page.md\nq.sql": "stale" } })
    await sleep(500)
    most = 0

    for (let n = 0; n < 8; n++) {
      fs.writeFileSync(path.join(folder, `note-${n}.md`), `# Note ${n}\n`)
      await sleep(80)
    }

    const last = (await slowed.reads(path.join(folder, "page.md"), "q.sql")).version
    const deadline = Date.now() + 5000

    while (tab.changes().at(-1)?.version !== last && Date.now() < deadline) {
      await sleep(25)
    }

    tab.close()
    assert.equal(tab.changes().at(-1)?.version, last, "the last change lands")
    assert.ok(most <= 2, `${most} reads of the embed at once`)
  } finally {
    served.closeAllConnections()
    served.close()
    reading.close()
    await slowed.close()
    await parser.close()
  }
})

test("a subscription sent again works out only what it names anew or at a version behind", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-again-")))
  fs.writeFileSync(path.join(folder, "rows.csv"), "n\n1\n")
  fs.writeFileSync(path.join(folder, "q.sql"), "select sum(n) as n from 'rows.csv'")
  fs.writeFileSync(path.join(folder, "page.md"), "# Page\n\n{value: q.sql#0.n}\n")
  let asked = 0

  class CountedReads extends Data {
    override async reads(from: string, reference: string) {
      asked++
      return super.reads(from, reference)
    }
  }

  const counted = new CountedReads(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-again-data-")),
  )
  const again = new Hub(folder, "build-1", () => {}, 200)
  const served = http.createServer(
    createHandler(folder, folder, "build-1", model, counted, () => {}),
  )
  again.attach(served)
  again.read(counted)
  const origin = `http://localhost:${await listen(served, 0)}`
  const key = "page.md\nq.sql"

  const tab = await new Tab({}, origin).connected()
  const changed = async (seen: number) => {
    for (let tries = 0; tab.changes().length === seen && tries < 100; tries++) {
      await sleep(20)
    }
  }

  try {
    await tab.subscribe({ embeds: { [key]: "stale" } })
    await changed(0)
    const version = tab.changes().at(-1)?.version as string
    const first = asked

    for (let n = 0; n < 3; n++) {
      await tab.subscribe({ embeds: { [key]: version }, folders: { "": "stale" } })
    }

    await sleep(200)
    assert.equal(
      asked,
      first,
      "an embed named again at the version last sent is not worked out again",
    )

    const seen = tab.changes().length
    await tab.subscribe({ embeds: { [key]: "older" } })
    await changed(seen)
    assert.equal(asked, first + 1)
    assert.equal(tab.changes().at(-1)?.version, version)
  } finally {
    tab.close()
    served.closeAllConnections()
    served.close()
    await counted.close()
  }
})

test("an item whose refresh failed is worked out again when a subscription names it again", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-failed-")))
  fs.writeFileSync(path.join(folder, "rows.csv"), "n\n1\n")
  fs.writeFileSync(path.join(folder, "page.md"), "# Page\n\n{value: rows.csv#0.n}\n")
  let failing = true

  class FailingOnce extends Data {
    override async reads(from: string, reference: string) {
      if (failing) {
        failing = false
        throw new Error("not yet")
      }

      return super.reads(from, reference)
    }
  }

  const once = new FailingOnce(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-failed-data-")),
  )
  const retried = new Hub(folder, "build-1", () => {}, 200)
  const served = http.createServer(createHandler(folder, folder, "build-1", model, once, () => {}))
  retried.attach(served)
  retried.read(once)
  const origin = `http://localhost:${await listen(served, 0)}`
  const tab = await new Tab({}, origin).connected()

  try {
    await tab.subscribe({ embeds: { "page.md\nrows.csv#0.n": "stale" } })
    await sleep(200)
    assert.deepEqual(tab.changes(), [], "the first refresh failed")

    await tab.subscribe({ embeds: { "page.md\nrows.csv#0.n": "stale" } })

    for (let tries = 0; tab.changes().length === 0 && tries < 100; tries++) {
      await sleep(20)
    }

    assert.equal(tab.changes().length, 1)
  } finally {
    tab.close()
    served.closeAllConnections()
    served.close()
    await once.close()
  }
})

test("an embed worked out before the model hears a change in its folder is worked out again once it does", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-gap-")))
  fs.mkdirSync(path.join(folder, "logs/a"), { recursive: true })
  fs.writeFileSync(path.join(folder, "logs/a/x.csv"), "n\n1\n")
  fs.writeFileSync(path.join(folder, "q.sql"), "select count(*) as n from 'logs/**/*.csv'")
  fs.writeFileSync(path.join(folder, "page.md"), "# Page\n\n{value: q.sql#0.n}\n")
  const parser = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))
  const reading = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-gap-model-")),
    parser,
    () => {},
  )
  const walking = new Data(folder, fs.mkdtempSync(path.join(os.tmpdir(), "folio-events-gap-data-")))
  walking.useFolders(reading)
  const gap = new Hub(folder, "build-1", () => {}, 200)
  const served = http.createServer(
    createHandler(folder, folder, "build-1", reading, walking, () => {}),
  )
  gap.attach(served)
  gap.follow(reading)
  gap.read(walking)
  const origin = `http://localhost:${await listen(served, 0)}`
  const key = "page.md\nq.sql#0.n"
  const page = path.join(folder, "page.md")
  let tab: Tab | undefined

  try {
    await reading.start()
    await walking.reads(page, "q.sql")
    await walking.reads(page, "q.sql")
    fs.writeFileSync(path.join(folder, "logs/a/y.csv"), "n\n2\n")
    tab = await new Tab({}, origin).connected()
    await tab.subscribe({ embeds: { [key]: "stale" } })
    await sleep(500)
    await reading.settled()
    const fresh = (await walking.reads(page, "q.sql#0.n")).version
    const opened = tab

    for (let tries = 0; opened.changes().at(-1)?.version !== fresh && tries < 100; tries++) {
      await sleep(20)
    }

    assert.equal(tab.changes().at(-1)?.version, fresh)
  } finally {
    tab?.close()
    served.closeAllConnections()
    served.close()
    reading.close()
    await walking.close()
    await parser.close()
  }
})

test("a component's tab hears when its script is saved, and when an earlier folder's takes over", async () => {
  for (const folder of ["lib/a", "lib/b"]) {
    fs.mkdirSync(path.join(root, folder), { recursive: true })
  }

  fs.writeFileSync(path.join(root, "lib/b/levels.js"), "export default () => {}\n")
  componentsOf(model).use([path.join(root, "lib/a"), path.join(root, "lib/b")])

  const tab = await new Tab().connected()

  try {
    await tab.subscribe({ components: { levels: componentsOf(model).version("levels") } })
    await sleep(100)
    assert.deepEqual(tab.changes(), [])

    fs.writeFileSync(path.join(root, "lib/b/levels.js"), "export default () => 'saved'\n")
    const saved = (await tab.next("change")).data
    assert.equal(saved.kind, "component")
    assert.equal(saved.path, "levels")
    assert.match(saved.version ?? "", /^lib\/b\/levels\.js:/)

    fs.writeFileSync(path.join(root, "lib/a/levels.js"), "export default () => 'first'\n")
    assert.match((await tab.next("change")).data.version ?? "", /^lib\/a\/levels\.js:/)

    fs.rmSync(path.join(root, "lib"), { recursive: true })
    assert.equal((await tab.next("change")).data.version, null)
  } finally {
    tab.close()
    componentsOf(model).use([])
  }
})

test("a component's tab hears a save to the file its script links to, in a folder of its own", async () => {
  fs.mkdirSync(path.join(root, "linked/lib"), { recursive: true })
  fs.mkdirSync(path.join(root, "linked/build"), { recursive: true })
  fs.writeFileSync(path.join(root, "linked/build/levels.js"), "export default () => {}\n")
  fs.symlinkSync("../build/levels.js", path.join(root, "linked/lib/levels.js"))
  componentsOf(model).use([path.join(root, "linked/lib")])

  const tab = await new Tab().connected()

  try {
    await tab.subscribe({ components: { levels: componentsOf(model).version("levels") } })
    await sleep(100)
    assert.deepEqual(tab.changes(), [])

    fs.writeFileSync(
      path.join(root, "linked/build/levels.js"),
      "export default () => 'built again'\n",
    )
    const saved = (await tab.next("change")).data
    assert.equal(saved.kind, "component")
    assert.match(saved.version ?? "", /^linked\/build\/levels\.js:/)
  } finally {
    tab.close()
    componentsOf(model).use([])
    fs.rmSync(path.join(root, "linked"), { recursive: true })
  }
})

test("a component whose script links to a file not there yet draws once the file is written, and again once rewritten", async () => {
  fs.mkdirSync(path.join(root, "pending/lib"), { recursive: true })
  fs.symlinkSync("../out/levels.js", path.join(root, "pending/lib/levels.js"))
  componentsOf(model).use([path.join(root, "pending/lib")])
  const tab = await new Tab().connected()

  try {
    await tab.subscribe({ components: { levels: null } })
    await sleep(100)
    assert.deepEqual(tab.changes(), [])

    fs.mkdirSync(path.join(root, "pending/out"))
    fs.writeFileSync(path.join(root, "pending/out/levels.js"), "export default () => {}\n")
    assert.match((await tab.next("change")).data.version ?? "", /^pending\/out\/levels\.js:/)

    fs.rmSync(path.join(root, "pending/out/levels.js"))
    assert.equal((await tab.next("change")).data.version, null)
    fs.writeFileSync(path.join(root, "pending/out/levels.js"), "export default () => 'again'\n")
    assert.match((await tab.next("change")).data.version ?? "", /^pending\/out\/levels\.js:/)
  } finally {
    tab.close()
    componentsOf(model).use([])
    fs.rmSync(path.join(root, "pending"), { recursive: true })
  }
})

test("a component's tab hears a save to the file at the end of a chain of links", async () => {
  for (const folder of ["chain/lib", "chain/a", "chain/b"]) {
    fs.mkdirSync(path.join(root, folder), { recursive: true })
  }

  fs.writeFileSync(path.join(root, "chain/b/levels.js"), "export default () => {}\n")
  fs.symlinkSync("../b/levels.js", path.join(root, "chain/a/levels.js"))
  fs.symlinkSync("../a/levels.js", path.join(root, "chain/lib/levels.js"))
  componentsOf(model).use([path.join(root, "chain/lib")])
  const tab = await new Tab().connected()

  try {
    await tab.subscribe({ components: { levels: componentsOf(model).version("levels") } })
    await sleep(100)
    assert.deepEqual(tab.changes(), [])

    fs.writeFileSync(path.join(root, "chain/b/levels.js"), "export default () => 'saved'\n")
    assert.match((await tab.next("change")).data.version ?? "", /^chain\/b\/levels\.js:/)
  } finally {
    tab.close()
    componentsOf(model).use([])
    fs.rmSync(path.join(root, "chain"), { recursive: true })
  }
})
