import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { api } from "../src/server/api.ts"
import { componentsOf } from "../src/server/components.ts"
import { conventionsOf } from "../src/server/conventions.ts"
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

async function restarted(
  text: string,
  older: (stored: { format: number; check: object }) => void,
): Promise<(string | number)[][]> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-store-"))
  fs.writeFileSync(path.join(root, "a.md"), text)
  const start = async () => {
    const model = new Model(root, store, indexer, () => {})
    const data = new Data(root, store)
    await model.start()
    return { model, data, health: healthOf(model, data) }
  }
  const first = await start()

  try {
    await first.health.state()
    await first.health.flush()
  } finally {
    first.model.close()
    await first.data.close()
  }

  const kept = path.join(store, "health")

  for (const name of fs.readdirSync(kept)) {
    const stored = JSON.parse(fs.readFileSync(path.join(kept, name), "utf8"))
    older(stored)
    fs.writeFileSync(path.join(kept, name), JSON.stringify(stored))
  }

  const second = await start()

  try {
    return (await second.health.state()).problems.map(({ path: at, kind, line }) => [
      at,
      kind,
      line,
    ])
  } finally {
    second.model.close()
    await second.data.close()
  }
}

class HeldData extends Data {
  held: Promise<void> | undefined
  letGo = () => {}

  hold(): void {
    this.held = new Promise((resolve) => {
      this.letGo = () => {
        this.held = undefined
        resolve()
      }
    })
  }

  override async embedReference(from: string, reference: string) {
    if (path.basename(from) === "a.md") {
      await this.held
    }

    return super.embedReference(from, reference)
  }
}

async function asked(
  root: string,
  model: Model,
  data: Data,
  at: string,
  query: string,
): Promise<
  Record<string, unknown> & {
    problems?: { path: string; kind: string }[]
    needs?: { path: string; source: string }[]
  }
> {
  return (await api(root, model, data, at, new URLSearchParams(query))) as never
}

test("the whole folder answers at once with the problems last checked while a check runs, and a path once checked", async () => {
  const { root, model, data } = await served(
    {
      "n.csv": "n\n1\n",
      "a.md": "# A\n\nA has {value: n.csv#0.n}.\n",
      "notes/b.md": "# B\n\nSee [a](../a.md).\n",
      "FOLIO.md": "# Folder\n\n```yaml folio\nhealth:\n  - where: '**'\n    error: [link]\n```\n",
    },
    HeldData,
  )
  const problems = (answer: { problems?: { path: string; kind: string }[] }) =>
    (answer.problems ?? []).map(({ path: at, kind }) => `${at} ${kind}`)
  const needs = (answer: { needs?: { path: string; source: string }[] }) =>
    (answer.needs ?? []).map(({ path: at, source }) => `${source} ${at}`)

  try {
    assert.deepEqual(problems(await asked(root, model, data, "", "api=health&wait")), [])
    assert.equal((await asked(root, model, data, "", "api=health")).checking, false)
    assert.deepEqual(needs(await asked(root, model, data, "", "api=needs")), [])

    data.hold()
    fs.writeFileSync(path.join(root, "a.md"), "# A\n\nA now has {value: n.csv#0.n}.\n")
    fs.writeFileSync(path.join(root, "notes/b.md"), "# B\n\nSee [gone](../gone.md).\n")
    await until(async () => (await asked(root, model, data, "", "api=health")).checking === true)

    const started = Date.now()
    const whole = await asked(root, model, data, "", "api=health")
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`)
    assert.deepEqual([whole.ready, whole.checking, problems(whole)], [true, true, []])

    const document = await asked(root, model, data, "notes/b.md", "api=health")
    assert.deepEqual(
      [document.checking, problems(document)],
      [false, ["notes/b.md link"]],
      "the path is checked while the check of a.md is held",
    )
    assert.deepEqual(problems(await asked(root, model, data, "notes/", "api=health")), [
      "notes/b.md link",
    ])

    const after = await asked(root, model, data, "", "api=health")
    assert.deepEqual(
      [after.checking, problems(after)],
      [true, ["notes/b.md link"]],
      "the whole folder as last checked takes in what a path's check found",
    )

    const allNeeds = await asked(root, model, data, "", "api=needs")
    assert.deepEqual(
      [allNeeds.checking, needs(allNeeds)],
      [true, ["error notes/b.md"]],
      "as last checked, the path's check included",
    )
    assert.deepEqual(needs(await asked(root, model, data, "notes/b.md", "api=needs")), [
      "error notes/b.md",
    ])

    let waited = false
    const wait = asked(root, model, data, "", "api=health&wait").then((answer) => {
      waited = true
      return answer
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(waited, false, "wait answers only once the whole folder is checked")
    data.letGo()
    const checked = await wait
    assert.deepEqual([checked.checking, problems(checked)], [false, ["notes/b.md link"]])

    fs.writeFileSync(path.join(root, "notes/b.md"), "# B\n\nSee [a](../a.md).\n")
    assert.deepEqual(problems(await asked(root, model, data, "notes/b.md", "api=health")), [])
  } finally {
    data.letGo()
    model.close()
    await data.close()
  }
})

test("a check started before an edit and ending after a path's check never puts back what the edit fixed", async () => {
  const { root, model, data } = await served(
    {
      "n.csv": "n\n1\n",
      "a.md": "# A\n\nSee [gone](gone.md), with {value: n.csv#0.n}.\n",
    },
    HeldData,
  )
  const health = healthOf(model, data)

  try {
    data.hold()
    const first = health.state()
    await until(async () => health.progress !== undefined)
    fs.writeFileSync(path.join(root, "a.md"), "# A\n\nSee [n](n.csv), with {value: n.csv#0.n}.\n")
    await until(async () => model.held("a.md")?.some(({ text }) => text.includes("[n]")) === true)

    const pending = health.checkedAt("a.md")
    data.letGo()
    assert.deepEqual((await pending).problems, [])
    await first
    assert.deepEqual(
      (await health.checkedAt("a.md")).problems,
      [],
      "the check that read a.md before the edit lands no result",
    )
  } finally {
    data.letGo()
    model.close()
    await data.close()
  }
})

test("a change taken by a path's check is never lost while a whole check reads the document it changed", async () => {
  const { root, model, data } = await served(
    {
      "n.csv": "n\n1\n",
      "a.md": "# A\n\nSee [n](n.csv), with {value: n.csv#0.n}.\n",
      "other.md": "# Other\n",
    },
    HeldData,
  )
  const health = healthOf(model, data)
  const listed = (state: { problems: { path: string; kind: string }[] }) =>
    state.problems.map(({ path: at, kind }) => `${at} ${kind}`)

  try {
    assert.deepEqual(listed(await health.state()), [])
    data.hold()
    fs.writeFileSync(
      path.join(root, "a.md"),
      "# A\n\nSee [n](n.csv), now with {value: n.csv#0.n}.\n",
    )
    await until(async () => model.held("a.md")?.some(({ text }) => text.includes("now")) === true)
    const whole = health.state()
    await until(async () => health.progress?.of === 1)
    fs.writeFileSync(
      path.join(root, "a.md"),
      "# A\n\nSee [gone](gone.md), now with {value: n.csv#0.n}.\n",
    )
    await until(async () => model.held("a.md")?.some(({ text }) => text.includes("gone")) === true)

    assert.deepEqual(listed(await health.checkedAt("other.md")), [])
    data.letGo()
    await whole
    assert.deepEqual(listed(await health.state()), ["a.md link"])
  } finally {
    data.letGo()
    model.close()
    await data.close()
  }
})

test("the exact answer holds a change a path's check under way took", async () => {
  const { root, model, data } = await served(
    { "n.csv": "n\n1\n", "a.md": "# A\n\nSee [n](n.csv), with {value: n.csv#0.n}.\n" },
    HeldData,
  )

  try {
    assert.deepEqual((await asked(root, model, data, "", "api=health&wait")).problems, [])
    data.hold()
    fs.writeFileSync(
      path.join(root, "a.md"),
      "# A\n\nSee [gone](gone.md), with {value: n.csv#0.n}.\n",
    )
    await until(async () => model.held("a.md")?.some(({ text }) => text.includes("gone")) === true)
    const atPath = asked(root, model, data, "a.md", "api=health")
    await new Promise((resolve) => setTimeout(resolve, 300))

    let waited = false
    const exact = asked(root, model, data, "", "api=health&wait").then((answer) => {
      waited = true
      return answer
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(waited, false, "the exact answer waits until the change is checked")
    data.letGo()
    await atPath
    assert.deepEqual(
      ((await exact).problems ?? []).map(({ path: at, kind }) => `${at} ${kind}`),
      ["a.md link"],
    )
  } finally {
    data.letGo()
    model.close()
    await data.close()
  }
})

test("the exact answer asked during a whole check holds a change a path's check took after it", async () => {
  const holds = new Map<string, () => void>()
  const held = new Map<string, Promise<void>>()
  const hold = (name: string) =>
    held.set(name, new Promise((resolve) => holds.set(name, () => resolve(undefined))))
  const letGo = (name: string) => {
    holds.get(name)?.()
    held.delete(name)
  }

  class TwoHeld extends Data {
    override async embedReference(from: string, reference: string) {
      await held.get(path.basename(from))
      return super.embedReference(from, reference)
    }
  }

  const { root, model, data } = await served(
    {
      "a/n.csv": "n\n1\n",
      "a/a.md": "# A\n\nSee [n](n.csv), with {value: n.csv#0.n}.\n",
      "b/m.csv": "n\n1\n",
      "b/z.md": "# Z\n\nWith {value: m.csv#0.n}.\n",
    },
    TwoHeld,
  )
  const health = healthOf(model, data)

  try {
    assert.deepEqual((await health.state()).problems, [])
    hold("a.md")
    fs.writeFileSync(
      path.join(root, "a/a.md"),
      "# A\n\nSee [n](n.csv), now with {value: n.csv#0.n}.\n",
    )
    await until(async () => model.held("a/a.md")?.some(({ text }) => text.includes("now")) === true)
    const before = health.progress
    const whole = health.state()
    await until(async () => health.progress !== undefined && health.progress !== before)
    fs.writeFileSync(
      path.join(root, "b/z.md"),
      "# Z\n\nSee [gone](gone.md), with {value: m.csv#0.n}.\n",
    )
    await until(
      async () => model.held("b/z.md")?.some(({ text }) => text.includes("gone")) === true,
    )

    const exact = asked(root, model, data, "", "api=health&wait")
    await new Promise((resolve) => setTimeout(resolve, 100))
    hold("z.md")
    const atPath = asked(root, model, data, "b/z.md", "api=health")
    await new Promise((resolve) => setTimeout(resolve, 100))
    letGo("a.md")
    await whole
    await new Promise((resolve) => setTimeout(resolve, 300))
    letGo("z.md")
    await atPath
    assert.deepEqual(
      ((await exact).problems ?? []).map(({ path: at, kind }) => `${at} ${kind}`),
      ["b/z.md link"],
    )
  } finally {
    letGo("a.md")
    letGo("z.md")
    model.close()
    await data.close()
  }
})

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

test("a document removed while Folio was stopped breaks the links to it on the next start", async () => {
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

test("a result kept before frontmatter links were checked is checked again on the next start", async () => {
  assert.deepEqual(
    await restarted('---\nparent: "[B](./b.md)"\n---\n# A\n', (stored) => {
      stored.format = 3
      stored.check = { ...stored.check, problems: [], links: [] }
    }),
    [["a.md", "link", 2]],
  )
})

test("a link in frontmatter to a file not there is a broken link at its line, and one that is there no problem", async () => {
  const { model, data, health } = await served({
    "notes/a.md":
      '---\ntitle: A\ndependencies:\n  - id: "[B](./b.md)"\n  - id: "[C](../closed/c.md)"\n---\n# A\n',
    "notes/b.md": "# B\n",
  })

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ kind, path: at, line, what }) => [
        kind,
        at,
        line,
        what,
      ]),
      [["link", "notes/a.md", 5, "Links to closed/c.md, which is not there"]],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("frontmatter that is not YAML is an error at the line the parser stopped at, on its frontmatter block; quoted, it leaves and the fields read", async () => {
  const { root, model, data, health } = await served({
    "FOLIO.md": [
      "# Stations",
      "",
      "```yaml folio",
      "kinds:",
      "  station:",
      "    where: stations/*.md",
      "    fields:",
      "      elevation: {from: frontmatter, type: number}",
      "```",
      "",
    ].join("\n"),
    "stations/north.md": "---\nelevation: 412\nnote: a: b\n---\n# North\n",
    "stations/south.md": "---\nelevation: 380\n---\n# South\n",
    "empty.md": "---\n---\n# Empty\n",
  })

  try {
    const block = model.held("stations/north.md")?.find(({ kind }) => kind === "frontmatter")?.id

    assert.ok(block)
    assert.deepEqual((await health.state()).problems, [
      {
        kind: "frontmatter",
        path: "stations/north.md",
        line: 3,
        block,
        severity: "error",
        what: "The frontmatter is not YAML: Nested mappings are not allowed in compact mappings",
      },
    ])
    assert.deepEqual(conventionsOf(model).describe("stations/north.md").fields, {})

    fs.writeFileSync(
      path.join(root, "stations/north.md"),
      '---\nelevation: 412\nnote: "a: b"\n---\n# North\n',
    )
    await until(async () => (await health.state()).problems.length === 0)
    assert.deepEqual(conventionsOf(model).describe("stations/north.md").fields, { elevation: 412 })
  } finally {
    model.close()
    await data.close()
  }
})

test("an alias in frontmatter whose anchor is never set is listed at the alias's line", async () => {
  const { model, data, health } = await served({
    "a.md": "---\ntitle: A\nparent: *nope\n---\n# A\n",
  })

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ kind, line, what }) => [kind, line, what]),
      [
        [
          "frontmatter",
          3,
          "The frontmatter is not YAML: Unresolved alias (the anchor must be set before the alias): nope",
        ],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("frontmatter opened by a fence with trailing spaces is listed at the faulty line", async () => {
  const { model, data, health } = await served({
    "a.md": "---  \ntitle: A\nwhy: a: b\n---\n# A\n",
  })

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ kind, line }) => [kind, line]),
      [["frontmatter", 3]],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("frontmatter that is a list or a bare value is an error at its opening line; an empty one is not", async () => {
  const { model, data, health } = await served({
    "a.md": "---\n- a\n---\n# A\n",
    "b.md": "---\njust words\n---\n# B\n",
    "c.md": "---\n---\n# C\n",
  })

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ path: at, kind, line, what }) => [
        at,
        kind,
        line,
        what,
      ]),
      [
        ["a.md", "frontmatter", 1, "The frontmatter is not a map of keys"],
        ["b.md", "frontmatter", 1, "The frontmatter is not a map of keys"],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a result kept before frontmatter was checked is checked again on the next start", async () => {
  assert.deepEqual(
    await restarted("---\nwhy: a: b\n---\n# A\n", (stored) => {
      stored.format = 4
      stored.check = { ...stored.check, problems: [] }
    }),
    [["a.md", "frontmatter", 2]],
  )
})

const COMPONENTS = [
  "# Page",
  "```component levels\ndata:\n  rows: rows.csv\n```",
  "```component list\ndata:\n  rows: missing.csv\n```",
  "```component nowhere\n```",
  "```component\n```",
  "```component list\ndata: [\n```",
  "```component list\n{include: absent.md}\n```",
].join("\n\n")

test("a failing query and a chart's missing data in tilde fences are listed as in backtick fences", async () => {
  const query = (fence: string) =>
    `# Query\n\n${fence}sql query\nselect nothing from 'rates.csv'\n${fence}\n`
  const chart = (fence: string) =>
    `# Chart\n\n${fence}vega-lite\n{"data": {"url": "absent.csv"}, "mark": "bar"}\n${fence}\n`
  const { model, data, health } = await served({
    "rates.csv": "arm,pct\nA,1\n",
    "ticks/query.md": query("```"),
    "ticks/chart.md": chart("```"),
    "tildes/query.md": query("~~~"),
    "tildes/chart.md": chart("~~~"),
  })

  try {
    const { problems } = await health.state()
    const listed = (folder: string) =>
      problems
        .filter(({ path: at }) => at.startsWith(folder))
        .map(({ path: at, kind, line }) => [at.slice(folder.length), kind, line])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))

    assert.deepEqual(listed("tildes/"), [
      ["chart.md", "data", 3],
      ["query.md", "query", 3],
    ])
    assert.deepEqual(listed("tildes/"), listed("ticks/"))
  } finally {
    model.close()
    await data.close()
  }
})

test("a component fence unread, drawn by no script or by two, or reading missing data is listed", async () => {
  const { root, model, data, health } = await served({
    "rows.csv": "n\n1\n",
    "lib/a/levels.js": "export default () => {}\n",
    "lib/b/levels.js": "export default () => {}\n",
    "lib/b/list.js": "export default () => {}\n",
    "page.md": COMPONENTS,
  })
  componentsOf(model).use([path.join(root, "lib/a"), path.join(root, "lib/b")])

  try {
    const problems = (await health.state()).problems.map(({ kind, line, what }) => [
      kind,
      line,
      what,
    ])
    const [include, clash, nowhere, unnamed, unread, missing, ...rest] = problems

    assert.deepEqual(
      [include, clash, nowhere, unnamed],
      [
        ["include", 24, "Includes absent.md, which is not there"],
        ["component", 3, "levels.js is in lib/a and lib/b; pages draw the one in lib/a."],
        ["component", 13, "No components folder holds nowhere.js."],
        ["component", 16, "A component fence names its component after the word component."],
      ],
    )
    assert.deepEqual(unread.slice(0, 2), ["component", 19])
    assert.match(String(unread[2]), /^The fence is not YAML: /)
    assert.deepEqual(missing.slice(0, 2), ["data", 8])
    assert.match(String(missing[2]), /^missing\.csv: /)
    assert.deepEqual(rest, [])

    fs.writeFileSync(path.join(root, "lib/a/nowhere.js"), "export default () => {}\n")
    await until(async () =>
      (await health.state()).problems.every(({ what }) => !what.includes("nowhere")),
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a component is missing while no components folder is named, and a kept result follows the folders", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-health-store-"))

  fs.mkdirSync(path.join(root, "lib/a"), { recursive: true })
  fs.writeFileSync(path.join(root, "lib/a/levels.js"), "export default () => {}\n")
  fs.writeFileSync(path.join(root, "page.md"), "# Page\n\n```component levels\n```\n")

  const start = async (folders: string[]) => {
    const model = new Model(root, store, indexer, () => {})
    const data = new Data(root, store)
    componentsOf(model).use(folders.map((folder) => path.join(root, folder)))
    await model.start()
    const health = healthOf(model, data)
    const whats = (await health.state()).problems.map(({ what }) => what)
    await health.flush()
    model.close()
    await data.close()
    return whats
  }

  assert.deepEqual(await start([]), [
    "No components folder holds levels.js: none was named with --components.",
  ])
  assert.deepEqual(await start(["lib/a"]), [], "the folder named finds it")
  assert.deepEqual(await start(["lib/a"]), [], "kept")
  fs.mkdirSync(path.join(root, "lib/b"))
  fs.copyFileSync(path.join(root, "lib/a/levels.js"), path.join(root, "lib/b/levels.js"))
  assert.deepEqual(await start(["lib/b", "lib/a"]), [
    "levels.js is in lib/b and lib/a; pages draw the one in lib/b.",
  ])
})

test("a component fence inside a list item or a quote is checked as one at the top", async () => {
  const { model, data, health } = await served({
    "page.md": [
      "# Page",
      "",
      "- item",
      "",
      "  ```component nested",
      "  ```",
      "",
      "> ```component quoted",
      "> ```",
    ].join("\n"),
  })

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ kind, line, what }) => [kind, line, what]),
      [
        ["component", 3, "No components folder holds nested.js: none was named with --components."],
        ["component", 8, "No components folder holds quoted.js: none was named with --components."],
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a component sharing a block with a chart has its entries read, and a linked script found once written", async () => {
  const { root, model, data, health } = await served({
    "n.csv": "n\n1\n",
    "page.md": [
      "# Page",
      "",
      "- ```vega-lite",
      '  {"data": {"url": "n.csv"}, "mark": "bar", "encoding": {"y": {"field": "n", "type": "quantitative"}}}',
      "  ```",
      "- ```component pending",
      "  data:",
      "    rows: absent.csv",
      "  ```",
    ].join("\n"),
  })

  fs.mkdirSync(path.join(root, "lib"))
  fs.symlinkSync("../out/pending.js", path.join(root, "lib/pending.js"))
  componentsOf(model).use([path.join(root, "lib")])

  try {
    const problems = (await health.state()).problems.map(({ kind, what }) => [
      kind,
      what.split(":")[0],
    ])
    assert.deepEqual(problems, [
      ["component", "No components folder holds pending.js."],
      ["data", "absent.csv"],
    ])

    fs.mkdirSync(path.join(root, "out"))
    fs.writeFileSync(path.join(root, "out/pending.js"), "export default () => {}\n")
    await until(async () =>
      (await health.state()).problems.every(({ kind }) => kind !== "component"),
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a component whose script links through a linked folder to a file not there yet is found once it is written", async () => {
  const { root, model, data, health } = await served({
    "page.md": "# Page\n\n```component pending\n```\n",
  })

  fs.mkdirSync(path.join(root, "lib"))
  fs.mkdirSync(path.join(root, "dist"))
  fs.symlinkSync("dist", path.join(root, "build"))
  fs.symlinkSync("../build/pending.js", path.join(root, "lib/pending.js"))
  componentsOf(model).use([path.join(root, "lib")])

  try {
    assert.deepEqual(
      (await health.state()).problems.map(({ what }) => what),
      ["No components folder holds pending.js."],
    )

    fs.writeFileSync(path.join(root, "dist/pending.js"), "export default () => {}\n")
    await until(async () => (await health.state()).problems.length === 0)
  } finally {
    model.close()
    await data.close()
  }
})
