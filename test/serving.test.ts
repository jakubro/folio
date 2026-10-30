import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { modelStore } from "../src/server/model.ts"
import { recordServing, servingAbove, servingAt } from "../src/server/serving.ts"

const SERVING = new URL("../src/server/serving.ts", import.meta.url).pathname

test("a running folio's record names its port, and the nearest folder served at or above a folder wins", () => {
  const env = { XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "folio-serving-state-")) }
  const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-serving-")))
  const plans = path.join(notes, "plans")

  recordServing(modelStore(notes, env), 8641)
  recordServing(modelStore(plans, env), 8642)

  assert.deepEqual(servingAt(notes, env), { port: 8641 })
  assert.equal(servingAt(path.join(notes, "other"), env), undefined)
  assert.deepEqual(servingAbove(path.join(plans, "q3", "draft"), env), {
    root: plans,
    reach: { port: 8642 },
  })
  assert.deepEqual(servingAbove(path.join(notes, "other"), env), {
    root: notes,
    reach: { port: 8641 },
  })
  assert.equal(servingAbove(path.dirname(notes), env), undefined)
  assert.equal(servingAt(notes, { XDG_STATE_HOME: path.join(env.XDG_STATE_HOME, "x") }), undefined)
})

test("a folio killed without stopping leaves a record that names no folio; one stopping removes its own record only", () => {
  const env = { XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "folio-serving-state-")) }
  const killed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-serving-")))
  const stopped = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-serving-")))
  const taken = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-serving-")))
  const serve = (folder: string, port: number, end: string) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { recordServing } from ${JSON.stringify(SERVING)}; recordServing(process.argv[1], ${port}); ${end}`,
        modelStore(folder, env),
      ],
      { encoding: "utf8" },
    )
  const record = (folder: string) => path.join(modelStore(folder, env), "serving.json")

  assert.equal(serve(killed, 9101, "process.kill(process.pid, 'SIGKILL');").signal, "SIGKILL")
  assert.equal(JSON.parse(fs.readFileSync(record(killed), "utf8")).port, 9101)
  assert.equal(servingAt(killed, env), undefined)

  assert.equal(serve(stopped, 9102, "").status, 0)
  assert.equal(fs.existsSync(record(stopped)), false)

  const later = serve(
    taken,
    9103,
    `import fs from "node:fs"; fs.writeFileSync(process.argv[1] + "/serving.json", JSON.stringify({ port: 9104, pid: ${process.pid}, start: "0" }));`,
  )
  assert.equal(later.status, 0, later.stderr)
  assert.deepEqual(servingAt(taken, env), { port: 9104 })
})
