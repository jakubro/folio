import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Data } from "../src/server/data.ts"
import { healthOf } from "../src/server/health.ts"
import { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"
import { Saved, savedOf } from "../src/server/saved.ts"
import { served as servedFolder } from "./served.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))

after(() => indexer.close())

/** Only root can give a file to another owner. */
const ROOT = process.getuid?.() === 0
const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``
const LOOP = [
  "# Loop",
  "",
  "<!-- folio view: #n -->",
  "<!-- /folio view -->",
  "",
  "```sql query n",
  "select coalesce(sum(try_cast(x.cells[1] as integer)), 0) + 1 as n from folio.tables x where x.path = 'loop.md'",
  "```",
  "",
].join("\n")
const PLAN = [
  "# Rota",
  "",
  "Kept by hand.",
  "",
  "<!-- folio view: #open -->",
  "<!-- /folio view -->",
  "",
  "Also by hand.",
  "",
  "```sql query open",
  "select name, size from 'tasks.csv' where not done order by name",
  "```",
  "",
].join("\n")

async function served(files: Record<string, string>) {
  const { root, model, data } = await servedFolder(indexer, files)
  const saved = savedOf(model, data)
  saved.start()
  const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8")
  const write = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text)
  const until = async (test: () => boolean) => {
    for (let tries = 0; !test(); tries++) {
      assert.ok(tries < 200, "timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    await saved.settled()
  }
  return { root, model, data, saved, read, write, until }
}

function rewritingFdinfo(held: [number | undefined, string][], rewrite: (info: string) => string) {
  const readFile = fs.readFileSync
  fs.readFileSync = ((at: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const info = (readFile as (...all: unknown[]) => unknown)(at, ...rest)
    const [, pid, descriptor] = String(at).match(/^\/proc\/(\d+)\/fdinfo\/(\d+)$/) ?? []
    const file = held.find(([writer]) => String(writer) === pid)?.[1]

    return file && fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`) === file
      ? rewrite(String(info))
      : info
  }) as typeof fs.readFileSync

  return () => {
    fs.readFileSync = readFile
  }
}

async function killedWhileWriting(root: string, store: string, ...at: string[]) {
  const killed = spawn(process.execPath, [
    new URL("./killed-writer.ts", import.meta.url).pathname,
    root,
    store,
    ...at,
  ])
  return new Promise((resolve) => killed.once("exit", (_, how) => resolve(how)))
}

async function restarted(root: string, store: string) {
  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store)
  data.useBlocks((at, text) => model.blocksReady(at, text))
  await model.start()
  const close = async () => {
    model.close()
    await data.close()
  }
  return { ...clocked(root, new Saved(model, data, 0)), close }
}

test("a marked view is written as markdown and rewritten as its result moves, nothing else touched", async () => {
  const { model, data, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: jobs/*.md")}\n`,
    "jobs/rota.md": PLAN,
    "jobs/tasks.csv": "name,size,done\nwire,3,false\npaint,5,true\n",
    "notes/same.md": PLAN.replace("tasks.csv", "../jobs/tasks.csv"),
  })

  try {
    await until(() => read("jobs/rota.md").includes("| wire | 3 |"))
    assert.equal(
      read("jobs/rota.md"),
      PLAN.replace(
        "<!-- folio view: #open -->\n",
        "<!-- folio view: #open -->\n\n| name | size |\n| --- | --- |\n| wire | 3 |\n\n",
      ),
    )
    assert.equal(read("notes/same.md"), PLAN.replace("tasks.csv", "../jobs/tasks.csv"))

    write("jobs/tasks.csv", "name,size,done\nwire,3,false\nseal,1,false\npaint,5,true\n")
    await until(() => read("jobs/rota.md").includes("| seal | 1 |"))
    const now = read("jobs/rota.md")
    assert.equal(now.split("<!-- folio view")[0], PLAN.split("<!-- folio view")[0])
    assert.equal(now.split("<!-- /folio view -->")[1], PLAN.split("<!-- /folio view -->")[1])
    assert.deepEqual(fs.readdirSync(path.dirname(path.join(model.root, "jobs/rota.md"))).sort(), [
      "rota.md",
      "tasks.csv",
    ])
    assert.deepEqual((await healthOf(model, data).state()).problems, [])
  } finally {
    model.close()
    await data.close()
  }
})

test("a hand edit of a view is replaced and reported until the document next changes; a broken view is left as it was", async () => {
  const { model, data, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '**'")}\n`,
    "rota.md": PLAN,
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })
  const views = async () =>
    (await healthOf(model, data).state()).problems
      .filter(({ kind }) => kind === "view")
      .map(({ path: at, line, what }) => `${at}:${line} ${what}`)

  try {
    await until(() => read("rota.md").includes("| wire | 3 |"))
    const written = read("rota.md")

    write("rota.md", written.replace("| wire | 3 |", "| wire | 300 |"))
    await until(() => read("rota.md") === written)
    assert.deepEqual(await views(), [
      "rota.md:5 A hand edit of the view #open was replaced; the edit is kept in the document's history.",
    ])
    assert.ok(
      (await model.history.versions("rota.md")).length >= 3,
      "the hand-edited text is one of the document's versions",
    )

    write("rota.md", read("rota.md").replace("Also by hand.", "Also by hand, edited."))
    await until(() => read("rota.md").includes("edited."))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await views(), [])

    const broken = read("rota.md").replace("from 'tasks.csv'", "from 'missing.csv'")
    write("rota.md", broken)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(read("rota.md"), broken)
    assert.deepEqual(await views(), [
      "rota.md:5 The view #open cannot be written: No data file at missing.csv.",
    ])
  } finally {
    model.close()
    await data.close()
  }
})

test("a document no declaration saves is never written, and an unclosed view is reported", async () => {
  const { model, data, read, until, saved } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: kept/*.md")}\n`,
    "rota.md": PLAN,
    "kept/open.md": "# Open\n\n<!-- folio view: ../tasks.csv -->\n\nNo end.\n",
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })

  try {
    await until(() => saved.problems("kept/open.md").length > 0)
    assert.equal(read("rota.md"), PLAN)
    assert.equal(read("kept/open.md"), "# Open\n\n<!-- folio view: ../tasks.csv -->\n\nNo end.\n")
    assert.match(saved.problems("kept/open.md")[0].what, /no closing <!-- \/folio view --> line/)
  } finally {
    model.close()
    await data.close()
  }
})

test("an edit landing while a view's result is worked out is never written over", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-saved-race-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-saved-race-store-"))
  const file = path.join(root, "rota.md")
  fs.writeFileSync(path.join(root, "FOLIO.md"), `# Saved\n\n${fence("save:\n  - where: '*.md'")}\n`)
  fs.writeFileSync(path.join(root, "tasks.csv"), "name,size,done\nwire,3,false\n")
  fs.writeFileSync(file, PLAN)
  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store)
  data.useBlocks((at, text) => model.blocksReady(at, text))
  let edits = 0
  const racing = Object.assign(Object.create(data), {
    embedReference: async (from: string, reference: string) => {
      if (edits++ === 0) {
        fs.writeFileSync(file, PLAN.replace("Kept by hand.", "Edited meanwhile."))
      }

      return data.embedReference(from, reference)
    },
  }) as Data
  await model.start()
  const saved = savedOf(model, racing)
  saved.start()

  try {
    for (let tries = 0; !fs.readFileSync(file, "utf8").includes("| wire | 3 |"); tries++) {
      assert.ok(tries < 200, "timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    await saved.settled()
    assert.match(fs.readFileSync(file, "utf8"), /Edited meanwhile\./)
    assert.ok(edits >= 2, "the view was worked out again on the edited text")
  } finally {
    model.close()
    await data.close()
  }
})

test("a declared digest is written into the folder and kept current; a new period starts a new one or moves the declared one on", async () => {
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Digests\n\n${fence("digests:\n  - path: digests/{week}.md\n    period: week\n  - path: today.md\n    period: day")}\n`,
    "notes/a.md": "# A\n\nFirst.\n",
  })
  let now = new Date(2026, 9, 14, 12).getTime()
  const { saved, read, until } = clocked(root, new Saved(model, data, 0, () => now))

  try {
    await until(() => fs.existsSync(path.join(root, "digests/2026-W42.md")))
    await until(() => read("digests/2026-W42.md").includes("Nothing has changed yet."))
    assert.match(
      read("digests/2026-W42.md"),
      /^# Digest\n[\s\S]*Changes in the week of 2026-10-12\./,
    )
    assert.match(read("today.md"), /Changes on 2026-10-14\./)

    now = Date.now()
    fs.writeFileSync(path.join(root, "notes/a.md"), "# A\n\nSecond.\n")
    const week = (() => {
      const monday = new Date(now)
      monday.setHours(0, 0, 0, 0)
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
      return monday
    })()
    const thursday = new Date(week.getTime() + 3 * 86_400_000)
    const first = new Date(thursday.getFullYear(), 0, 1).getTime()
    const label = `${thursday.getFullYear()}-W${String(Math.floor((thursday.getTime() - first) / (7 * 86_400_000)) + 1).padStart(2, "0")}`
    await until(
      () =>
        fs.existsSync(path.join(root, `digests/${label}.md`)) &&
        read(`digests/${label}.md`).includes("[a.md](../notes/a.md) - "),
    )
    assert.ok(fs.existsSync(path.join(root, "digests/2026-W42.md")), "the old week's digest stays")
    await until(() => read("today.md").includes("[a.md](notes/a.md) - "))
    assert.doesNotMatch(read("today.md"), /digests\/|today\.md\]/)

    const written = read("today.md")
    fs.writeFileSync(path.join(root, "today.md"), written.replace("[a.md]", "[edited by hand]"))
    await until(() => read("today.md") === written)
    assert.match(
      saved.problems("today.md")[0]?.what ?? "",
      /A hand edit of the view digest was replaced/,
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a folder that declares no digest has none written", async () => {
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '**'")}\n`,
    "notes/a.md": "# A\n\n<!-- folio view: digest -->\n<!-- /folio view -->\n",
  })
  const saved = new Saved(model, data, 0)
  saved.start()

  try {
    const before = (fs.readdirSync(root, { recursive: true }) as string[]).sort()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await saved.settled()
    assert.deepEqual((fs.readdirSync(root, { recursive: true }) as string[]).sort(), before)
    assert.match(
      saved.problems("notes/a.md")[0]?.what ?? "",
      /written only into a document declared under digests/,
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a marker inside a code fence is an example, and a symlinked saved document stays a link", async () => {
  const example = "```markdown\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n```\n"
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '**'")}\n`,
    "how.md": `# How\n\n${example}`,
    "real/rota.md": "# Rota\n\n<!-- folio view: ../tasks.csv -->\n<!-- /folio view -->\n",
    "tasks.csv": "name\nwire\n",
  })
  fs.symlinkSync(path.join(root, "real/rota.md"), path.join(root, "rota.md"))
  const saved = new Saved(model, data, 0)
  saved.start()

  try {
    for (
      let tries = 0;
      !fs.readFileSync(path.join(root, "real/rota.md"), "utf8").includes("| wire |");
      tries++
    ) {
      assert.ok(tries < 200, "timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    await saved.settled()
    assert.equal(fs.readFileSync(path.join(root, "how.md"), "utf8"), `# How\n\n${example}`)
    assert.ok(fs.lstatSync(path.join(root, "rota.md")).isSymbolicLink())
  } finally {
    model.close()
    await data.close()
  }
})

test("digest weeks are ISO weeks in summer time too; a day just over is written once more; past digests rest", async () => {
  const zone = process.env.TZ
  process.env.TZ = "Europe/Lisbon"
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Digests\n\n${fence("save:\n  - where: '**'\ndigests:\n  - path: weeks/{week}.md\n    period: week\n  - path: days/{day}.md\n    period: day")}\n`,
    "days/2026-03-01.md":
      "# Digest\n\n<!-- folio view: digest -->\nlong ago\n<!-- /folio view -->\n",
    "notes/a.md": "# A\n",
  })
  let now = new Date(2026, 2, 30, 23, 59).getTime()
  const { saved, read, until } = clocked(root, new Saved(model, data, 3_600_000, () => now))

  try {
    await until(() => fs.existsSync(path.join(root, "weeks/2026-W14.md")))
    assert.equal(fs.existsSync(path.join(root, "weeks/2026-W13.md")), false)
    assert.match(read("days/2026-03-01.md"), /long ago/)
    assert.deepEqual(saved.problems("days/2026-03-01.md"), [])

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const day = (at: Date) =>
      `days/${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}.md`
    now = Date.now()
    fs.writeFileSync(path.join(root, "notes/tick.md"), "# Tick\n")
    await until(() => fs.existsSync(path.join(root, day(today))))
    const before = read(day(today))
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    now = tomorrow.getTime() + 60_000
    fs.writeFileSync(path.join(root, "notes/late.md"), "# Late\n")
    await until(() => fs.existsSync(path.join(root, day(tomorrow))))
    await until(() => read(day(today)) !== before)
    assert.match(read(day(today)), /\[late\.md\]\(\.\.\/notes\/late\.md\)/)
  } finally {
    process.env.TZ = zone
    model.close()
    await data.close()
  }
})

test("a day digest's week is the ISO week of that day, across a whole week and a year's end", async () => {
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Digests\n\n${fence("digests:\n  - path: digests/{week}/{day}.md\n    period: day\n  - path: weeks/{week}.md\n    period: week")}\n`,
    "notes/a.md": "# A\n",
  })
  let now = new Date(2024, 0, 1, 12).getTime()
  const { until } = clocked(root, new Saved(model, data, 0, () => now))
  const filed: Record<string, string> = {
    "2024-01-01": "2024-W01",
    "2024-01-02": "2024-W01",
    "2024-01-03": "2024-W01",
    "2024-01-04": "2024-W01",
    "2024-01-05": "2024-W01",
    "2024-01-06": "2024-W01",
    "2024-01-07": "2024-W01",
    "2024-12-29": "2024-W52",
    "2025-12-31": "2026-W01",
    "2027-01-02": "2026-W53",
  }

  const filedAs = (day: string) =>
    fs.existsSync(path.join(root, "digests"))
      ? fs
          .readdirSync(path.join(root, "digests"), { recursive: true })
          .map(String)
          .filter((found) => found.endsWith(`/${day}.md`))
      : []

  try {
    for (const day of Object.keys(filed)) {
      const [year, month, date] = day.split("-").map(Number)
      now = new Date(year, month - 1, date, 12).getTime()
      fs.writeFileSync(path.join(root, "notes/a.md"), `# A\n\n${day}\n`)
      await until(() => filedAs(day).length > 0)
    }

    assert.deepEqual(
      Object.keys(filed).map(filedAs),
      Object.entries(filed).map(([day, week]) => [`${week}/${day}.md`]),
    )
    assert.deepEqual(
      ["2024-W01.md", "2024-W52.md", "2026-W01.md", "2026-W53.md"].filter(
        (week) => !fs.existsSync(path.join(root, "weeks", week)),
      ),
      [],
    )
  } finally {
    model.close()
    await data.close()
  }
})

function clocked(root: string, saved: Saved) {
  saved.start()
  return {
    saved,
    read: (name: string) => fs.readFileSync(path.join(root, name), "utf8"),
    until: async (test: () => boolean) => {
      for (let tries = 0; !test(); tries++) {
        assert.ok(tries < 200, "timed out")
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      await saved.settled()
    },
  }
}

test("a view whose result moves with each of its own writes is stopped and reported, not rewritten forever", async () => {
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '*.md'")}\n`,
    "loop.md": LOOP,
  })
  const saved = new Saved(model, data, 0)
  saved.start()

  try {
    for (let tries = 0; saved.problems("loop.md").length === 0; tries++) {
      assert.ok(tries < 400, "the view never stopped")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.match(saved.problems("loop.md")[0].what, /changes with every write into this document/)
    const stopped = fs.readFileSync(path.join(root, "loop.md"), "utf8")
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await saved.settled()
    assert.equal(fs.readFileSync(path.join(root, "loop.md"), "utf8"), stopped)
  } finally {
    model.close()
    await data.close()
  }
})

test("a view reading its own document is stopped too when a hard link or a link to the document sits beside it", async () => {
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '*.md'")}\n`,
    "loop.md": LOOP,
  })
  fs.linkSync(path.join(root, "loop.md"), path.join(root, "loop.keep"))
  fs.symlinkSync("loop.md", path.join(root, "loop.txt"))
  const saved = new Saved(model, data, 0)
  saved.start()

  try {
    for (let tries = 0; saved.problems("loop.md").length === 0; tries++) {
      assert.ok(
        tries < 400,
        `the view never stopped: ${fs.readFileSync(path.join(root, "loop.md"), "utf8").match(/\| (\d+) \|/)?.[1]}`,
      )
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.match(saved.problems("loop.md")[0].what, /changes with every write into this document/)
  } finally {
    model.close()
    await data.close()
  }
})

test("a result holding a view's own markers or a fence stays inside its region, and the file never grows", async () => {
  const doc = [
    "# Odd",
    "",
    "<!-- folio view: odd.json#close -->",
    "<!-- /folio view -->",
    "",
    "<!-- folio view: odd.json#fence -->",
    "<!-- /folio view -->",
    "",
    "Tail.",
    "",
  ].join("\n")
  const { root, model, data, saved, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: odd.md")}\n`,
    "odd.md": doc,
    "odd.json": JSON.stringify({
      close: "<!-- /folio view -->",
      fence: "```\n<!-- folio view: odd.json#close -->",
    }),
  })

  try {
    await until(() => read("odd.md").includes("Tail.") && read("odd.md") !== doc)
    const written = read("odd.md")
    assert.equal(
      written,
      doc
        .replace("#close -->\n", "#close -->\n\n\\<!-- /folio view -->\n\n")
        .replace("#fence -->\n", "#fence -->\n\n\\```\n\\<!-- folio view: odd.json#close -->\n\n"),
    )

    for (const name of ["one.md", "two.md", "three.md"]) {
      write(name, `# ${name}\n`)
      await until(() => model.hashOf(name) !== undefined)
    }

    assert.equal(read("odd.md"), written)
    assert.deepEqual(saved.problems("odd.md"), [])
    assert.ok(fs.statSync(path.join(root, "odd.md")).size === Buffer.byteLength(written))
  } finally {
    model.close()
    await data.close()
  }
})

test("a file another program is still writing is written only once it is done, never cut short", async () => {
  const { root, model, data, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
    "rota.md": PLAN,
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })
  const long = Array.from({ length: 60 }, (_, at) => `Line ${at} written slowly by hand.`).join(
    "\n",
  )
  const typed = `${PLAN}\n${long}\n`

  try {
    await until(() => read("rota.md").includes("| wire | 3 |"))
    const writer = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       const text = process.argv[1];
       const handle = fs.openSync(process.argv[2], "w");
       const pieces = text.match(/[\\s\\S]{1,400}/g);
       let at = 0;
       const next = () => {
         if (at === pieces.length) { fs.closeSync(handle); return; }
         fs.writeSync(handle, pieces[at++]);
         setTimeout(next, 150);
       };
       next();`,
      typed,
      path.join(root, "rota.md"),
    ])
    await new Promise((resolve) => setTimeout(resolve, 200))
    write("tasks.csv", "name,size,done\nwire,3,false\nseal,1,false\n")
    await new Promise((resolve) => writer.once("exit", resolve))
    await until(() => read("rota.md").includes("| seal | 1 |"))

    assert.equal(
      read("rota.md"),
      typed.replace(
        "<!-- folio view: #open -->\n",
        "<!-- folio view: #open -->\n\n| name | size |\n| --- | --- |\n| seal | 1 |\n| wire | 3 |\n\n",
      ),
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a write keeps the bytes outside the region, the file's mode, owner and hard links", async () => {
  const odd = Buffer.concat([
    Buffer.from("# Rota\n\nLatin-1 by hand: caf"),
    Buffer.from([0xe9, 0xff, 0xfe]),
    Buffer.from(".\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n\nAfter: "),
    Buffer.from([0x80, 0x81]),
    Buffer.from("\n"),
  ])
  const { root, model, data, read, until } = await servedFolder(
    indexer,
    {
      "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '*.md'")}\n`,
      "private.md": "# Private\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
      "script.md": "# Script\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
      "linked.md": "# Linked\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
      "tasks.csv": "name\nwire\n",
    },
    (at) => {
      fs.writeFileSync(path.join(at, "odd.md"), odd)
      fs.chmodSync(path.join(at, "private.md"), 0o600)
      fs.chmodSync(path.join(at, "script.md"), 0o755)
      if (ROOT) {
        fs.chownSync(path.join(at, "private.md"), 4321, 4321)
      }
      fs.linkSync(path.join(at, "linked.md"), path.join(at, "other-name.md"))
    },
  ).then(({ root, model, data }) => {
    const saved = new Saved(model, data, 0)
    saved.start()
    return { ...clocked(root, saved), root, model, data }
  })

  try {
    for (const name of ["odd.md", "private.md", "script.md", "linked.md"]) {
      await until(() => read(name).includes("| wire |"))
    }

    const bytes = fs.readFileSync(path.join(root, "odd.md"))
    assert.equal(
      bytes.subarray(0, bytes.indexOf("<!--")).compare(odd.subarray(0, odd.indexOf("<!--"))),
      0,
    )
    assert.deepEqual([...bytes.subarray(bytes.indexOf("After: ") + 7)], [0x80, 0x81, 0x0a])

    const mode = (name: string) => (fs.statSync(path.join(root, name)).mode & 0o777).toString(8)
    assert.equal(mode("private.md"), "600")
    assert.equal(mode("script.md"), "755")
    assert.equal(fs.statSync(path.join(root, "private.md")).uid, ROOT ? 4321 : process.getuid?.())
    assert.equal(
      fs.statSync(path.join(root, "linked.md")).ino,
      fs.statSync(path.join(root, "other-name.md")).ino,
    )
    assert.equal(fs.statSync(path.join(root, "linked.md")).nlink, 2)
  } finally {
    model.close()
    await data.close()
  }
})

test("nothing outside the folder is written through a digest or document that links out", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "folio-saved-outside-"))
  const theirs = "# Theirs\n\n<!-- folio view: digest -->\n<!-- /folio view -->\n"
  fs.writeFileSync(path.join(outside, "today.md"), theirs)
  fs.writeFileSync(path.join(outside, "doc.md"), theirs.replace("digest", "tasks.csv"))
  const { root, model, data } = await servedFolder(
    indexer,
    {
      "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '**'\ndigests:\n  - path: today.md\n    period: day")}\n`,
      "tasks.csv": "name\nwire\n",
    },
    (at) => {
      fs.symlinkSync(path.join(outside, "today.md"), path.join(at, "today.md"))
      fs.symlinkSync(path.join(outside, "doc.md"), path.join(at, "doc.md"))
    },
  )
  const { saved, until } = clocked(root, new Saved(model, data, 0))

  try {
    await until(() => saved.problems("FOLIO.md").length > 0)
    assert.match(
      saved.problems("FOLIO.md")[0].what,
      /today\.md is not written: its path is a link that leads nowhere inside/,
    )
    assert.equal(fs.readFileSync(path.join(outside, "today.md"), "utf8"), theirs)
    assert.equal(
      fs.readFileSync(path.join(outside, "doc.md"), "utf8"),
      theirs.replace("digest", "tasks.csv"),
    )
    assert.deepEqual(fs.readdirSync(outside).sort(), ["doc.md", "today.md"])
  } finally {
    model.close()
    await data.close()
  }
})

test("a stocktake reading the folder's documents ends complete after fifty parts arrive in quick succession", async () => {
  const stocktake = [
    "# Stocktake",
    "",
    "<!-- folio view: #open -->",
    "<!-- /folio view -->",
    "",
    "```sql query open",
    "select count(*) as parts from kind.part p",
    "```",
    "",
  ].join("\n")
  const { model, data, saved, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: stocktake.md\nkinds:\n  part:\n    where: parts/*.md")}\n`,
    "stocktake.md": stocktake,
    "parts/gear-0.md": "# gear-0\n",
  })

  try {
    await until(() => read("stocktake.md").includes("| 1 |"))

    for (let at = 1; at < 50; at++) {
      write(`parts/gear-${at}.md`, `# gear-${at}\n`)
      await new Promise((resolve) => setTimeout(resolve, 150))
    }

    await until(() => read("stocktake.md").includes("| 50 |"))
    assert.deepEqual(saved.problems("stocktake.md"), [])
  } finally {
    model.close()
    await data.close()
  }
})

test("a file turned to CRLF is no hand edit, and its region is written in CRLF", async () => {
  const { model, data, saved, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
    "rota.md": PLAN,
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })

  try {
    await until(() => read("rota.md").includes("| wire | 3 |"))
    write("rota.md", read("rota.md").replaceAll("\n", "\r\n"))
    await until(() => model.hashOf("rota.md") !== undefined && read("rota.md").includes("\r\n"))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await saved.settled()
    assert.deepEqual(saved.problems("rota.md"), [])

    write("tasks.csv", "name,size,done\nwire,3,false\nseal,1,false\n")
    await until(() => read("rota.md").includes("| seal | 1 |"))
    assert.doesNotMatch(read("rota.md"), /[^\r]\n/)
    assert.deepEqual(saved.problems("rota.md"), [])
  } finally {
    model.close()
    await data.close()
  }
})

test("a folio killed while writing leaves no copy in the folder once it starts again", async () => {
  const { root, store, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
    "rota.md": PLAN,
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })
  model.close()
  await data.close()
  assert.equal(await killedWhileWriting(root, store), "SIGKILL")
  const leftovers = () => fs.readdirSync(root).filter((name) => name.endsWith(".folio"))
  assert.equal(leftovers().length, 1, "the killed folio left its copy")
  const { read, until, close } = await restarted(root, store)

  try {
    await until(() => read("rota.md").includes("| wire | 3 |"))
    assert.deepEqual(leftovers(), [])
  } finally {
    await close()
  }
})

test("a folio killed halfway through writing over a hard-linked document finishes the write when it starts again, unless the document changed since", async () => {
  const written = PLAN.replace(
    "<!-- folio view: #open -->\n",
    "<!-- folio view: #open -->\n\n| name | size |\n| --- | --- |\n| wire | 3 |\n\n",
  )

  for (const edit of [undefined, "Edited by hand after folio stopped."]) {
    const { root, store, model, data } = await servedFolder(indexer, {
      "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
      "rota.md": PLAN,
      "tasks.csv": "name,size,done\nwire,3,false\n",
    })
    model.close()
    await data.close()
    fs.linkSync(path.join(root, "rota.md"), path.join(root, "rota.keep"))
    assert.equal(await killedWhileWriting(root, store, "in-place"), "SIGKILL")
    const half = fs.readFileSync(path.join(root, "rota.md"), "utf8")
    assert.ok(half !== PLAN && half !== written, "the killed folio cut its write short")

    if (edit) {
      fs.writeFileSync(path.join(root, "rota.md"), PLAN.replace("Kept by hand.", edit))
    }

    const { read, until, close } = await restarted(root, store)

    try {
      await until(() => read("rota.md").includes("| wire | 3 |"))
      assert.equal(read("rota.md"), edit ? written.replace("Kept by hand.", edit) : written)
      assert.equal(read("rota.keep"), read("rota.md"))
      assert.deepEqual(
        fs.readdirSync(root).filter((name) => name.endsWith(".folio")),
        [],
      )
    } finally {
      await close()
    }
  }
})

test("an empty region that cannot be written is left empty, a marker after a BOM works, and no digest goes into a dot-folder", async () => {
  const { root, model, data, read, until } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '*.md'\ndigests:\n  - path: .digests/{day}.md\n    period: day")}\n`,
    "rota.md":
      "# Rota\n\n<!-- folio view: missing.csv -->\n<!-- /folio view -->\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
    "first.md": "\uFEFF<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
    "tasks.csv": "name\nwire\n",
  }).then(({ root, model, data }) => ({
    ...clocked(root, new Saved(model, data, 0)),
    root,
    model,
    data,
  }))

  try {
    await until(() => read("rota.md").includes("| wire |") && read("first.md").includes("| wire |"))
    assert.match(read("rota.md"), /<!-- folio view: missing\.csv -->\n<!-- \/folio view -->\n/)
    assert.ok(read("first.md").startsWith("\uFEFF<!-- folio view: tasks.csv -->\n\n| name |"))
    assert.equal(fs.existsSync(path.join(root, ".digests")), false)
    const problems = (await healthOf(model, data).state()).problems.map(({ what }) => what)
    assert.ok(
      problems.some((what) => /never under a dot-name/.test(what)),
      problems.join("\n"),
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a carriage return inside a result is a line break written once, never rewritten pass after pass", async () => {
  const doc =
    "# Odd\n\n<!-- folio view: odd.json#crlf -->\n<!-- /folio view -->\n\n<!-- folio view: odd.json#cr -->\n<!-- /folio view -->\n"
  const { root, model, data, saved, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: odd.md")}\n`,
    "odd.md": doc,
    "odd.json": JSON.stringify({ crlf: "first\r\nsecond", cr: "x\r```" }),
  })

  try {
    await until(() => read("odd.md") !== doc)
    const written = read("odd.md")
    assert.equal(
      written,
      doc
        .replace("#crlf -->\n", "#crlf -->\n\nfirst\nsecond\n\n")
        .replace("#cr -->\n", "#cr -->\n\nx\n\\```\n\n"),
    )
    const { mtimeMs } = fs.statSync(path.join(root, "odd.md"))

    write("other.md", "# Other\n")
    await until(() => model.hashOf("other.md") !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await saved.settled()
    assert.equal(fs.statSync(path.join(root, "odd.md")).mtimeMs, mtimeMs, "not written again")
    assert.deepEqual(saved.problems("odd.md"), [])
  } finally {
    model.close()
    await data.close()
  }
})

test("a data file changing beside a view that reads the folder's documents is no echo of folio's own write", async () => {
  const doc = [
    "# Status",
    "",
    "<!-- folio view: #status -->",
    "<!-- /folio view -->",
    "",
    "```sql query status",
    "select (select count(*) from folio.documents d) * 1000 + (select max(n) from 'tick.csv' t) as total",
    "```",
    "",
  ].join("\n")
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: status.md")}\n`,
    "status.md": doc,
    "tick.csv": "n\n0\n",
  })
  const saved = new Saved(model, data, 0)
  const read = () => fs.readFileSync(path.join(root, "status.md"), "utf8")
  saved.start()

  try {
    for (let tries = 0; !read().includes("| 2000 |"); tries++) {
      assert.ok(tries < 200, "timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    for (let at = 1; at <= 12; at++) {
      fs.writeFileSync(path.join(root, "tick.csv"), `n\n${at}\n`)
      await new Promise((resolve) => setTimeout(resolve, 120))
    }

    await new Promise((resolve) => setTimeout(resolve, 800))
    await saved.settled()
    assert.match(read(), /\| 2012 \|/)
    assert.deepEqual(saved.problems("status.md"), [])
  } finally {
    model.close()
    await data.close()
  }
})

test("a program holding a file open to append is waited for even when folio wrote the file last", async () => {
  const { root, model, data, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
    "rota.md": PLAN,
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })

  try {
    await until(() => read("rota.md").includes("| wire | 3 |"))
    const writer = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       const handle = fs.openSync(process.argv[1], "a");
       setTimeout(() => { fs.writeSync(handle, "Appended late.\\n"); fs.closeSync(handle); }, 2500);`,
      path.join(root, "rota.md"),
    ])
    await new Promise((resolve) => setTimeout(resolve, 300))
    write("tasks.csv", "name,size,done\nwire,3,false\nseal,1,false\n")
    await new Promise((resolve) => writer.once("exit", resolve))
    await until(() => read("rota.md").includes("| seal | 1 |"))
    assert.match(read("rota.md"), /Appended late\.\n$/)
  } finally {
    model.close()
    await data.close()
  }
})

test("a program writing another file that shares the document's inode number holds no write", async () => {
  const { root, model, data, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
    "rota.md": PLAN,
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })
  const others = [
    path.join(fs.mkdtempSync("/dev/shm/folio-"), "log"),
    path.join(root, "beside.log"),
  ]
  const writers = others.map((other) =>
    spawn(process.execPath, [
      "-e",
      `require("node:fs").openSync(process.argv[1], "w"); setTimeout(() => {}, 6000);`,
      other,
    ]),
  )
  // Inode numbers repeat across filesystems and across btrfs subvolumes of one; each writer's is made to collide.
  const restore = rewritingFdinfo(
    writers.map((writer, n) => [writer.pid, others[n]]),
    (info) => info.replace(/^ino:.*$/m, `ino:\t${fs.statSync(path.join(root, "rota.md")).ino}`),
  )

  try {
    await until(() => read("rota.md").includes("| wire | 3 |"))
    await new Promise((resolve) => setTimeout(resolve, 300))
    write("tasks.csv", "name,size,done\nwire,3,false\nseal,1,false\n")
    await until(() => read("rota.md").includes("| seal | 1 |"))
    assert.deepEqual(
      writers.map((writer) => writer.exitCode),
      [null, null],
    )
  } finally {
    restore()
    for (const writer of writers) {
      writer.kill()
    }
    model.close()
    await data.close()
    fs.rmSync(path.dirname(others[0]), { recursive: true, force: true })
  }
})

test("on a kernel naming no inode, a program appending through another hard link is waited for", async () => {
  const { root, model, data, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
    "rota.md": PLAN,
    "tasks.csv": "name,size,done\nwire,3,false\n",
  })
  const keep = path.join(root, "rota.keep")

  try {
    await until(() => read("rota.md").includes("| wire | 3 |"))
    fs.linkSync(path.join(root, "rota.md"), keep)
    const started = Date.now()
    const writer = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       const handle = fs.openSync(process.argv[1], "a");
       setTimeout(() => { fs.writeSync(handle, "Appended late.\\n"); fs.closeSync(handle); }, 2500);`,
      keep,
    ])
    const restore = rewritingFdinfo([[writer.pid, keep]], (info) => info.replace(/^ino:.*\n/m, ""))

    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      write("tasks.csv", "name,size,done\nwire,3,false\nseal,1,false\n")
      await until(() => read("rota.md").includes("| seal | 1 |"))
      assert.ok(Date.now() - started >= 2500, `written ${Date.now() - started} ms in, while held`)
      assert.match(read("rota.md"), /Appended late\.\n/)
    } finally {
      restore()
      writer.kill()
    }
  } finally {
    model.close()
    await data.close()
  }
})

test("a file dated in the future is still written, and one folio cannot write is reported without stopping the others", async () => {
  const { root, model, data, saved, read, write, until } = await served({
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: '*.md'")}\n`,
    "ahead.md": "# Ahead\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
    "locked.md": "# Locked\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
    "z-after.md": "# After\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
    [`${"n".repeat(230)}.md`]: "# Long\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
    "tasks.csv": "name\nwire\n",
  })
  const later = new Date(Date.now() + 86_400_000)
  const rename = fs.renameSync

  try {
    await until(() => read("z-after.md").includes("| wire |"))
    assert.match(read(`${"n".repeat(230)}.md`), /\| wire \|/)
    fs.utimesSync(path.join(root, "ahead.md"), later, later)
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("locked.md")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
      }

      rename(from, to)
    }
    write("tasks.csv", "name\nseal\n")
    await until(
      () => read("ahead.md").includes("| seal |") && read("z-after.md").includes("| seal |"),
    )
    assert.match(read("locked.md"), /\| wire \|/)
    assert.match(
      saved.problems("locked.md")[0]?.what ?? "",
      /cannot be written into this document: EACCES/,
    )
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.endsWith(".folio")),
      [],
      "the copy of the document folio could not write is gone",
    )
  } finally {
    fs.renameSync = rename
    model.close()
    await data.close()
  }
})

test("a change landing while folio checks for writers is no echo of its own write", async () => {
  const doc = [
    "# Status",
    "",
    "<!-- folio view: #status -->",
    "<!-- /folio view -->",
    "",
    "```sql query status",
    "select (select count(*) from folio.documents d) * 1000 + (select max(n) from 'tick.csv' t) as total",
    "```",
    "",
  ].join("\n")
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: status.md")}\n`,
    "status.md": doc,
    "tick.csv": "n\n0\n",
  })
  const readdir = fs.readdirSync
  let ticks = 0
  // Another program saves the CSV while each write's scan for writers runs, as on a busy host.
  fs.readdirSync = ((at: fs.PathLike, ...rest: unknown[]) => {
    if (String(at) === "/proc" && ticks < 12) {
      ticks++
      fs.writeFileSync(path.join(root, "tick.csv"), `n\n${ticks}\n`)
    }

    return (readdir as (...all: unknown[]) => unknown)(at, ...rest)
  }) as typeof fs.readdirSync
  const saved = new Saved(model, data, 0)
  const read = () => fs.readFileSync(path.join(root, "status.md"), "utf8")
  saved.start()

  try {
    for (let tries = 0; !read().includes("| 2012 |"); tries++) {
      assert.ok(
        tries < 400,
        `stopped at ${read().match(/\| (\d+) \|/)?.[1]}: ${JSON.stringify(saved.problems("status.md"))}`,
      )
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    await saved.settled()
    assert.deepEqual(saved.problems("status.md"), [])
  } finally {
    fs.readdirSync = readdir
    model.close()
    await data.close()
  }
})

test("a digest that cannot be created is listed and stops no other view", async () => {
  const { root, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md\ndigests:\n  - path: notes.txt/{day}.md\n    period: day\n  - path: taken.md\n    period: day")}\n`,
    "notes.txt": "a plain file where the digest's folder would be\n",
    "taken.md/kept.txt": "a folder where the digest would be\n",
    "rota.md": "# Rota\n\n<!-- folio view: tasks.csv -->\n<!-- /folio view -->\n",
    "tasks.csv": "name\nwire\n",
  })
  const { saved, read, until } = clocked(root, new Saved(model, data, 0))

  try {
    await until(() => read("rota.md").includes("| wire |"))
    await until(() => saved.problems("FOLIO.md").length === 2)
    assert.deepEqual(
      saved.problems("FOLIO.md").map(({ what }) => what.replace(/\d{4}-\d\d-\d\d/, "DAY")),
      [
        "The digest notes.txt/DAY.md cannot be created: EEXIST.",
        "The digest taken.md cannot be created: EISDIR.",
      ],
    )
  } finally {
    model.close()
    await data.close()
  }
})

test("a copy noted by a folio stopped before copies were named apart is swept too, and a lone CR in a cell keeps its row", async () => {
  const { root, store, model, data } = await servedFolder(indexer, {
    "FOLIO.md": `# Saved\n\n${fence("save:\n  - where: rota.md")}\n`,
    "rota.md":
      "# Rota\n\n<!-- folio view: #q -->\n<!-- /folio view -->\n\n```sql query q\nselect 'wire' as name, 'one' || chr(13) || 'two' as note\n```\n",
  })
  const left = path.join(root, ".rota.md.0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.folio")
  fs.writeFileSync(left, "half a copy")
  fs.writeFileSync(
    path.join(store, "writing.json"),
    JSON.stringify({ [left]: { pid: 2 ** 22 + 7, start: "1" } }),
  )
  const { saved, read, until } = clocked(root, new Saved(model, data, 0))

  try {
    await until(() => read("rota.md").includes("| wire |"))
    assert.equal(fs.existsSync(left), false)
    assert.match(read("rota.md"), /\n\| wire \| one two \|\n/)
    assert.deepEqual(saved.problems("rota.md"), [])
  } finally {
    model.close()
    await data.close()
  }
})
