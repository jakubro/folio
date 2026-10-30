import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, test } from "node:test"
import { versionOf } from "../src/server/blocks.ts"
import { Indexer } from "../src/server/indexer.ts"
import { needsOf } from "../src/server/needs.ts"
import { served } from "./served.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))

after(() => indexer.close())

const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``

test("what needs the reader: errors, problems in what they read, declared attention, then changes", async () => {
  const { root, model, data } = await served(indexer, {
    "FOLIO.md": `# Needs\n\n${fence(
      [
        "rules:",
        "  no-draft:",
        "    message: '{path} is a draft'",
        "    query: select path from folio.documents where path like '%draft%'",
        "attention:",
        "  in-review:",
        "    message: '{path} waits for review'",
        "    query: select path from 'review.csv'",
      ].join("\n"),
    )}\n`,
    "read.md": "# Read\n\nSee [nowhere](nowhere.md).\n\nA paragraph.\n",
    "unread.md": "# Unread\n\nSee [nowhere](nowhere.md).\n",
    "draft.md": "# Draft\n",
    "review.csv": "path\nunread.md\n",
  })
  const until = async (test: () => Promise<boolean>) => {
    for (let tries = 0; !(await test()); tries++) {
      assert.ok(tries < 200, "timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const listed = async () =>
    (await needsOf(model, data)).needs.map(
      ({ source, path: at, what }) => `${source} ${at} ${what}`,
    )

  try {
    const blocks = model.held("read.md") ?? []
    await model.reads.read(
      "read.md",
      blocks.map((block) => ({ id: block.id, version: versionOf(block) })),
      Date.now(),
    )

    assert.deepEqual(await listed(), [
      "error draft.md rule: draft.md is a draft",
      "problem read.md link: Links to nowhere.md, which is not there",
      "attention unread.md unread.md waits for review",
    ])

    fs.writeFileSync(
      path.join(root, "read.md"),
      "# Read\n\nSee [nowhere](nowhere.md).\n\nEdited.\n",
    )
    await until(async () => (await listed()).some((line) => line.startsWith("changed")))
    assert.match(
      (await listed()).at(-1) ?? "",
      /^changed read\.md 2 blocks changed since you read it$/,
    )

    fs.writeFileSync(path.join(root, "review.csv"), "path\n")
    fs.rmSync(path.join(root, "draft.md"))
    await until(async () => !(await listed()).some((line) => /^(error|attention)/.test(line)))
  } finally {
    model.close()
    await data.close()
  }
})

test("a message filled from a kind's date field writes the date as it is", async () => {
  const { model, data } = await served(indexer, {
    "FOLIO.md": `# Gauges\n\n${fence(
      [
        "kinds:",
        "  gauge:",
        "    where: 'gauges/*.md'",
        "    fields:",
        "      calibrated: {from: label, type: date}",
        "attention:",
        "  calibration:",
        "    message: 'Calibration due - last done {calibrated}'",
        "    query: select path, calibrated from kind.gauge",
      ].join("\n"),
    )}\n`,
    "gauges/north.md": "# North\n\n**Calibrated:** 2026-04-12\n",
  })

  try {
    assert.deepEqual(
      (await needsOf(model, data)).needs.map(({ path: at, what }) => `${at} ${what}`),
      ["gauges/north.md Calibration due - last done 2026-04-12"],
    )
  } finally {
    model.close()
    await data.close()
  }
})
