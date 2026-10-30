import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { after, test } from "node:test"
import { versionOf } from "../src/server/blocks.ts"
import { Indexer } from "../src/server/indexer.ts"
import { staleOf } from "../src/server/stale.ts"
import { served } from "./served.ts"

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url))

after(() => indexer.close())

const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``
const TWO_YEARS = 2 * 365 * 86_400_000

test("outlived documents: unchanged for a year, never read, linked from nowhere, or as a folder declares", async () => {
  const old = (Date.now() - TWO_YEARS) / 1000
  const { root, model, data } = await served(
    indexer,
    {
      "old.md": "# Old\n",
      "linked.md": "# Linked\n",
      "read.md": "# Read\n",
      "recent.md": "# Recent\n\nSee [linked](linked.md).\n",
      "archive/FOLIO.md": `# Archive\n\n${fence("stale:\n  query: select path from folio.documents where path like 'archive/closed/%'")}\n`,
      "archive/closed/done.md": "# Done\n",
      "archive/open.md": "# Open\n",
    },
    (folder) => {
      for (const name of [
        "old.md",
        "linked.md",
        "read.md",
        "archive/open.md",
        "archive/FOLIO.md",
        "archive/closed/done.md",
      ]) {
        fs.utimesSync(path.join(folder, name), old, old)
      }
    },
  )

  const listed = async () => (await staleOf(model, data)).documents.map(({ path: at }) => at).sort()
  const until = async (test: () => Promise<boolean>) => {
    for (let tries = 0; !(await test()); tries++) {
      assert.ok(tries < 200, "timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  try {
    const [heading] = model.held("read.md") ?? []
    await model.reads.read("read.md", [{ id: heading.id, version: versionOf(heading) }])
    const before = (fs.readdirSync(root, { recursive: true }) as string[]).sort()

    assert.deepEqual(await listed(), ["archive/closed/done.md", "old.md"])
    assert.deepEqual((fs.readdirSync(root, { recursive: true }) as string[]).sort(), before)

    fs.writeFileSync(
      path.join(root, "recent.md"),
      "# Recent\n\nSee [linked](linked.md) and [old](old.md).\n",
    )
    await until(async () => !(await listed()).includes("old.md"))

    fs.writeFileSync(path.join(root, "recent.md"), "# Recent\n")
    await until(async () => (await listed()).includes("linked.md"))
    fs.writeFileSync(path.join(root, "linked.md"), "# Linked, edited\n")
    await until(async () => !(await listed()).includes("linked.md"))

    fs.writeFileSync(
      path.join(root, "recent.md"),
      "# Recent\n\nSee [done](archive/closed/done.md).\n",
    )
    await until(async () => !(await listed()).includes("archive/closed/done.md"))
  } finally {
    model.close()
    await data.close()
  }
})

test("a document's age is its last commit, not its file time, which a checkout resets", async () => {
  const committed = new Date(Date.now() - TWO_YEARS).toISOString()
  const { model, data } = await served(indexer, { "notes/kept.md": "# Kept\n" }, (folder) => {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: folder,
        env: { ...process.env, GIT_AUTHOR_DATE: committed, GIT_COMMITTER_DATE: committed },
      })
    git("init", "-q")
    git("-c", "user.name=a", "-c", "user.email=a@b", "add", ".")
    git("-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "-m", "kept")
  })

  try {
    assert.deepEqual(
      (await staleOf(model, data)).documents.map(({ path: at }) => at),
      ["notes/kept.md"],
    )
  } finally {
    model.close()
    await data.close()
  }
})
