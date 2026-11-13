import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Writers } from "../src/server/writers.ts"
import { rewriting } from "./rewriting.ts"

const HOLD = `const fs = require("node:fs")
fs.openSync(process.argv[1], process.argv[2])
process.stdout.write("open")
setTimeout(() => {}, 60000)`

async function holding(file: string, flags: string) {
  const holder = spawn(process.execPath, ["-e", HOLD, file, flags])
  await new Promise((resolve) => holder.stdout.once("data", resolve))
  return holder
}

test("a program holding a file open for writing holds it; one reading it, or gone, does not", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "folio-writers-"))
  const file = path.join(folder, "rota.md")
  fs.writeFileSync(file, "# Rota\n")
  const writers = new Writers()
  const reader = await holding(file, "r")
  const appender = await holding(file, "a")

  try {
    assert.equal(await writers.held(file, fs.statSync(file)), true)
    appender.kill()
    await new Promise((resolve) => appender.once("exit", resolve))
    assert.equal(await writers.held(file, fs.statSync(file)), false)
  } finally {
    reader.kill()
    appender.kill()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("a check whose thread dies answers held, so nothing is written over a writer it could not see", async () => {
  const writers = new Writers(new URL("data:text/javascript,process.exit(1)"))
  const file = fs.mkdtempSync(path.join(os.tmpdir(), "folio-writers-"))

  assert.equal(await writers.held(file, fs.statSync(file)), true)
  fs.rmSync(file, { recursive: true, force: true })
})

test("a file read empty while a program rewrites it in place reads as the text it writes", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "folio-writers-"))
  const file = path.join(folder, "rota.md")
  fs.writeFileSync(file, "# Rota\n")
  const rewriter = await rewriting(file, "# Rota, rewritten\n")

  try {
    assert.equal(fs.readFileSync(file, "utf8"), "")
    assert.equal((await new Writers().settled(file))?.text, "# Rota, rewritten\n")
  } finally {
    rewriter.kill()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("a file emptied on purpose reads empty, dated by its own time", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "folio-writers-"))
  const file = path.join(folder, "rota.md")
  fs.writeFileSync(file, "")
  const { mtimeMs } = fs.statSync(file)

  try {
    assert.deepEqual(await new Writers().settled(file), { text: "", at: mtimeMs })
    assert.equal(await new Writers().settled(path.join(folder, "gone.md")), undefined)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
