import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Data } from "../src/server/data.ts"
import { documentsOf } from "../src/server/documents.ts"
import { healthOf } from "../src/server/health.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))

after(() => indexer.close())

async function served<D extends Data>(
  files: Record<string, string>,
  Kind: new (root: string, store: string) => D = Data as never,
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-store-"))

  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }

  const model = new Model(root, store, indexer, () => {})
  const data = new Kind(root, store)
  await model.start()
  return { root, model, data, health: healthOf(model, data) }
}

test("a failing query reads the same on every check, naming its file as written", async () => {
  const { model, data, health } = await served({
    "rates.csv": "arm,pct\nA,1\n",
    "report.md": "# Report\n\n```sql query\nselect nothing from 'rates.csv'\n```\n",
  })

  try {
    const first = await health.state()
    const second = await health.state()

    assert.equal(second.version, first.version)
    assert.deepEqual(
      first.problems.map(({ kind, what }) => [kind, what]),
      [
        [
          "query",
          'The query fails: Binder Error: Referenced column "nothing" not found in FROM clause! Candidate bindings: "pct"',
        ],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

class CountingData extends Data {
  embeds: string[] = []

  override async embedReference(from: string, reference: string) {
    this.embeds.push(`${path.basename(from)} ${reference}`)
    return super.embedReference(from, reference)
  }
}

async function until(test: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; !(await test()); tries++) {
    assert.ok(tries < 200, "timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test("a check under way counts the documents it works through, and keeps its count once done", async () => {
  const notes = Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [`notes/n${i}.md`, `# Note ${i}\n`]),
  )
  const { model, data, health } = await served(notes)
  const seen: { checked: number; of: number }[] = []
  let done = false
  const watch = () => {
    if (health.progress) {
      seen.push({ ...health.progress })
    }

    if (!done) {
      setImmediate(watch)
    }
  }

  try {
    assert.equal(health.progress, undefined)
    watch()
    await health.state()
    done = true

    assert.ok(seen.length > 0, "the check was seen under way")
    assert.ok(
      seen.every(({ checked, of }) => of === 150 && checked <= 150),
      JSON.stringify(seen),
    )
    assert.ok(
      seen.some(({ checked }) => checked > 0 && checked < 150),
      JSON.stringify(seen),
    )
    assert.deepEqual(health.progress, { checked: 150, of: 150 })
  } finally {
    done = true
    model.close()
    await data.close()
  }
})

test("health checks again only what changed, and answers a tab with only what moved", async () => {
  const { root, model, data, health } = await served(
    {
      "n.csv": "n\n1\n",
      "a.md": "# A\n\nA has {value: n.csv#0.n}.\n",
      "b.md": "# B\n\nB has {value: n.csv#0.n}.\n",
      "target.md": "# Target\n\n## Kept\n\nText.\n",
      "linker.md": "# Linker\n\nSee [kept](target.md#kept).\n",
    },
    CountingData,
  )

  try {
    const first = await health.state()
    assert.deepEqual(first.problems, [])
    assert.deepEqual(data.embeds.sort(), ["a.md n.csv#0.n", "b.md n.csv#0.n"])

    data.embeds = []
    const again = await health.state()
    assert.equal(again.version, first.version)
    assert.deepEqual(data.embeds, [], "nothing changed, nothing checked again")

    fs.writeFileSync(path.join(root, "a.md"), "# A\n\nA now has {value: n.csv#0.missing}.\n")
    fs.writeFileSync(path.join(root, "target.md"), "# Target\n\n## Renamed\n\nText.\n")
    await until(async () => (await health.state()).problems.length === 2)
    assert.deepEqual(
      [...new Set(data.embeds)],
      ["a.md n.csv#0.missing"],
      "only the edited document is checked",
    )

    const moved = await health.since(first.version)
    assert.ok("since" in moved)
    assert.deepEqual(moved.added.map(({ path: p, kind }) => [p, kind]).sort(), [
      ["a.md", "data"],
      ["linker.md", "link"],
    ])
    assert.deepEqual(moved.removed, [])

    fs.writeFileSync(path.join(root, "target.md"), "# Target\n\n## Kept\n\nText.\n")
    await until(async () => (await health.state()).problems.length === 1)
    const back = await health.since(moved.version)
    assert.ok("since" in back)
    assert.deepEqual(back.added, [])
    assert.equal(back.removed.length, 1)
  } finally {
    model.close()
    await data.close()
  }
})

test("a restart reuses the last results of documents unchanged since, and checks the rest again", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-store-"))
  const files: Record<string, string> = {
    "n.csv": "n\n1\n",
    "kept.md": "# Kept\n\nKept has {value: n.csv#0.n}.\n",
    "edited.md": "# Edited\n\nEdited has {value: n.csv#0.n}.\n",
    "linker.md": "# Linker\n\nSee [later](later/page.md).\n",
  }

  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), text)
  }

  const start = async () => {
    const model = new Model(root, store, indexer, () => {})
    const data = new CountingData(root, store)
    await model.start()
    return { model, data, health: healthOf(model, data) }
  }
  const first = await start()

  try {
    assert.deepEqual(
      (await first.health.state()).problems.map(({ path: p, kind }) => [p, kind]),
      [["linker.md", "link"]],
    )
    await first.health.flush()
  } finally {
    first.model.close()
    await first.data.close()
  }

  fs.writeFileSync(path.join(root, "edited.md"), "# Edited\n\nEdited now has {value: n.csv#0.n}.\n")
  fs.mkdirSync(path.join(root, "later"))
  fs.writeFileSync(path.join(root, "later/page.md"), "# Later\n")
  const second = await start()

  try {
    assert.deepEqual((await second.health.state()).problems, [], "the link found its target")
    assert.deepEqual(second.data.embeds, ["edited.md n.csv#0.n"], "only the edited one ran again")
  } finally {
    second.model.close()
    await second.data.close()
  }
})

test("a document removed while folio was stopped breaks the links to it on the next start", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-store-"))
  fs.writeFileSync(path.join(root, "linker.md"), "# Linker\n\nSee [target](target.md).\n")
  fs.writeFileSync(path.join(root, "target.md"), "# Target\n")
  const start = async () => {
    const model = new Model(root, store, indexer, () => {})
    const data = new Data(root, store)
    await model.start()
    return { model, data, health: healthOf(model, data) }
  }
  const first = await start()

  try {
    assert.deepEqual((await first.health.state()).problems, [])
    await first.health.flush()
  } finally {
    first.model.close()
    await first.data.close()
  }

  fs.rmSync(path.join(root, "target.md"))
  const second = await start()

  try {
    assert.deepEqual(
      (await second.health.state()).problems.map(({ path: at, kind }) => [at, kind]),
      [["linker.md", "link"]],
    )
  } finally {
    second.model.close()
    await second.data.close()
  }
})

test("a file that is no document, created where a link points, clears the link at once", async () => {
  const { root, model, data, health } = await served(
    {
      "page.md": "# Page\n\n[the file](files/report.pdf)\n",
      "files/other.txt": "x",
    },
    CountingData,
  )

  try {
    assert.equal((await health.state()).problems.length, 1)
    fs.writeFileSync(path.join(root, "files/report.pdf"), "%PDF")
    await until(async () => (await health.state()).problems.length === 0)
  } finally {
    model.close()
    await data.close()
  }
})

test("health asked the moment a fix is saved answers with the fix, never the check before it", async () => {
  const { root, model, data, health } = await served({
    "FOLIO.md": [
      "# Conventions",
      "",
      "```yaml folio",
      "rules:",
      "  owned:",
      "    query: select path from folio.documents where path like 'notes/%' and path not in (select path from folio.frontmatter where key = 'owner')",
      "    message: no owner",
      "```",
      "",
    ].join("\n"),
    "notes/a.md": "# Alpha\n\nNo owner yet.\n",
  })
  data.useDocuments(documentsOf(model))
  const rules = async () =>
    (await health.state()).problems.filter(({ kind }) => kind === "rule").map(({ path }) => path)

  try {
    assert.deepEqual(await rules(), ["notes/a.md"])
    fs.writeFileSync(path.join(root, "notes/a.md"), "---\nowner: bo\n---\n# Alpha\n")
    assert.deepEqual(await rules(), [])
  } finally {
    model.close()
    await data.close()
  }
})

test("a diagram that parses but cannot be laid out is listed, with the useful lines of a parse error", async () => {
  const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``
  const { model, data, health } = await served({
    "diagrams.md": [
      "# Diagrams",
      fence("gantt\n  dateFormat YYYY-MM-DD\n  section S\n  a : 2024-13-45, 3d"),
      fence("mindmap\n  root\n    a"),
      fence("flowchart TD\n  A[Start] --> B{Ok?}"),
      fence("flowchart LR\n  A-->"),
    ].join("\n\n"),
  })

  try {
    const { problems } = await health.state()

    assert.deepEqual(
      problems.map(({ line, what }) => [line, what.replace(/Expecting .*/, "Expecting ...")]),
      [
        [3, "The diagram cannot be drawn: Invalid date:2024-13-45"],
        [21, "The diagram cannot be drawn: Parse error on line 3: Expecting ..."],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a tab told of a problem that then changed and went is told it went", async () => {
  const { root, model, data, health } = await served({
    "page.md": "# Page\n\nSee [the file](gone.md) for the valves and the pumps.\n",
  })

  try {
    const first = await health.state()
    assert.equal(first.problems.length, 1)
    const block = first.problems[0].block

    fs.writeFileSync(
      path.join(root, "page.md"),
      "# Page\n\nQuite other words around [it](gone.md).\n",
    )
    await until(async () => (await health.state()).problems[0]?.block !== block)
    fs.writeFileSync(path.join(root, "page.md"), "# Page\n\nQuite other words, no link.\n")
    await until(async () => (await health.state()).problems.length === 0)

    const moved = await health.since(first.version)
    assert.ok("since" in moved)
    assert.deepEqual(moved.added, [])
    assert.equal(moved.removed.length, 1, "the tab's entry is removed")
  } finally {
    model.close()
    await data.close()
  }
})

test("files created in folders not there yet clear what pointed at them", async () => {
  const { root, model, data, health } = await served({
    "page.md": "# Page\n\n[the report](new/deep/report.pdf)\n",
    "query.md": "# Query\n\n```sql query\nselect count(*) as n from 'data/x.csv'\n```\n",
  })

  try {
    assert.deepEqual((await health.state()).problems.map(({ kind }) => kind).sort(), [
      "link",
      "query",
    ])
    fs.mkdirSync(path.join(root, "new/deep"), { recursive: true })
    fs.writeFileSync(path.join(root, "new/deep/report.pdf"), "%PDF")
    fs.mkdirSync(path.join(root, "data"))
    fs.writeFileSync(path.join(root, "data/x.csv"), "n\n1\n")
    await until(async () => (await health.state()).problems.length === 0)
  } finally {
    model.close()
    await data.close()
  }
})

test("a diagram, chart and query are checked as the page shows them, includes expanded", async () => {
  const { model, data, health } = await served({
    "n.csv": "n\n1\n",
    "flow.mmd": "flowchart TD\n  A[Start] --> B{Ok?}",
    "count.sql": "select count(*) as n from 'n.csv'",
    "chart.json":
      '{"data": {"url": "n.csv"}, "mark": "bar", "encoding": {"y": {"field": "n", "type": "quantitative"}}}',
    "page.md": [
      "# Page",
      "```mermaid\n{include: flow.mmd}\n```",
      "```sql query\n{include: count.sql}\n```",
      "```vega-lite\n{include: chart.json}\n```",
      "```sql query\nselect '\\{include: x}' as s\n```",
    ].join("\n\n"),
  })

  try {
    assert.deepEqual((await health.state()).problems, [])
    assert.deepEqual(
      data.documentQueries(path.join(model.root, "page.md")).map(({ line, sql }) => [line, sql]),
      [
        [7, "select count(*) as n from 'n.csv'"],
        [15, "select '{include: x}' as s"],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a missing image is a broken link, and a figure left unchecked by choice is no problem, its include listed once", async () => {
  const { model, data, health } = await served({
    "n.csv": "n\n81\n",
    "page.md":
      '# Page\n\n![k](img/none.png)\n\nTied <data value="n.csv#0.n">{include: nope.md}</data>, ranged <data value="n.csv#0.n">29-56%</data>.\n',
  })

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ kind, what }) => [kind, what]),
      [
        ["link", "Links to img/none.png, which is not there"],
        ["include", "Includes nope.md, which is not there"],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a figure tied to a whole table or a row is data that cannot be read as one figure", async () => {
  const { model, data, health } = await served({
    "n.csv": "n\n81\n82\n",
    "page.md":
      '# Page\n\nWhole <data value="n.csv">81</data>, row <data value="n.csv#0">81</data>.\n',
  })

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ kind, what }) => [kind, what]),
      [
        ["data", "n.csv: Not a single value: name a row and column, as in #0.total."],
        ["data", "n.csv#0: Not a single value."],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

class SlowOnceData extends Data {
  slow = true

  override async embedReference(from: string, reference: string) {
    const embedded = await super.embedReference(from, reference)
    return this.slow
      ? { ...embedded, error: "The query ran longer than 10 s and was stopped." }
      : embedded
  }
}

test("a check that only ran out of time is checked again on the next check", async () => {
  const { root, model, data, health } = await served(
    {
      "n.csv": "n\n1\n",
      "slow.md": "# Slow\n\nIt has {value: n.csv#0.n}.\n",
      "elsewhere/other.md": "# Other\n",
    },
    SlowOnceData,
  )

  try {
    assert.equal((await health.state()).problems.length, 1)
    data.slow = false
    fs.writeFileSync(path.join(root, "elsewhere/other.md"), "# Other, edited\n")
    await until(async () => (await health.state()).problems.length === 0)
  } finally {
    model.close()
    await data.close()
  }
})

test("a check that only ran out of time before a restart is checked again after it", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-store-"))
  fs.writeFileSync(path.join(root, "n.csv"), "n\n1\n")
  fs.writeFileSync(path.join(root, "slow.md"), "# Slow\n\nIt has {value: n.csv#0.n}.\n")
  const start = async (data: Data) => {
    const model = new Model(root, store, indexer, () => {})
    await model.start()
    return { model, data, health: healthOf(model, data) }
  }
  const first = await start(new SlowOnceData(root, store))

  try {
    assert.equal((await first.health.state()).problems.length, 1)
    await first.health.flush()
  } finally {
    first.model.close()
    await first.data.close()
  }

  const second = await start(new Data(root, store))

  try {
    assert.deepEqual((await second.health.state()).problems, [])
  } finally {
    second.model.close()
    await second.data.close()
  }
})

class QueryCountingData extends Data {
  queries: string[] = []

  override async embedQuery(sql: string, folder: string, from: string, name: string) {
    this.queries.push(sql)
    return super.embedQuery(sql, folder, from, name)
  }
}

test("a change runs again only the rules and queries reading the tables it moved, and an id gone is missed", async () => {
  const rule = "select path from kind.part where grams is null"
  const tasks = "select count(*) as n from folio.tasks where not done"
  const { root, model, data, health } = await served(
    {
      "FOLIO.md": [
        "# Workshop",
        "",
        "```yaml folio",
        "kinds:",
        "  part:",
        "    where: parts/*.md",
        "    fields:",
        "      id: {from: name, pattern: '^([a-z]+-\\d+)'}",
        "      grams: {from: label, type: number}",
        "      fits: {from: label, type: list, of: link, to: part, empty: None}",
        "rules:",
        "  weighed:",
        `    query: ${rule}`,
        "```",
        "",
      ].join("\n"),
      "parts/gear-1.md": "# gear-1\n\n**Grams:** 3\n\n**Fits:** gear-2\n",
      "parts/gear-2.md": "# gear-2\n\n**Grams:** 5\n\n**Fits:** None\n",
      "report.md": `# Report\n\n\`\`\`sql query\n${tasks}\n\`\`\`\n`,
      "notes/plain.md": "# Plain\n\nSome text.\n",
    },
    QueryCountingData,
  )
  data.useDocuments(documentsOf(model))
  const settled = async (file: string, text: string, marker: string) => {
    fs.writeFileSync(path.join(root, file), text)
    await until(async () => model.held(file)?.some((block) => block.text.includes(marker)) ?? false)
    data.queries = []
    visited = 0
    await health.state()
    return [...new Set(data.queries)].sort()
  }
  // A check after a save never walks every document in the folder.
  let visited = 0
  const every = model.paths.bind(model)
  model.paths = () => {
    visited++
    return every()
  }

  try {
    assert.deepEqual((await health.state()).problems, [])

    assert.deepEqual(await settled("notes/plain.md", "# Plain\n\nOther text.\n", "Other"), [])
    assert.equal(visited, 0)
    assert.deepEqual(await settled("notes/plain.md", "# Plain\n\n- [ ] do it\n", "do it"), [tasks])
    assert.deepEqual(
      await settled(
        "parts/gear-1.md",
        "# gear-1\n\n**Grams:** 3\n\n**Fits:** gear-2\n\nA note no field reads.\n",
        "no field reads",
      ),
      [],
      "a part edited outside its fields runs nothing again",
    )
    assert.deepEqual(
      await settled(
        "parts/gear-1.md",
        "# gear-1\n\n**Grams:** 4\n\n**Fits:** gear-2\n",
        "Grams:** 4",
      ),
      [rule],
    )

    fs.rmSync(path.join(root, "parts/gear-2.md"))
    await until(async () =>
      (await health.state()).problems.some(({ what }) => what === "fits: gear-2 names no part"),
    )
  } finally {
    model.close()
    await data.close()
  }
})
