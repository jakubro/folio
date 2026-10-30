import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { test } from "node:test"
import { stripVTControlCharacters } from "node:util"
import { HELP } from "../src/server/args.ts"
import { clientName, helpText, terminal } from "../src/server/terminal.ts"

const ESCAPE = "\x1b["

for (const name of ["NO_COLOR", "FORCE_COLOR", "NODE_DISABLE_COLORS"]) {
  delete process.env[name]
}

function stream(tty: boolean): { out: NodeJS.WriteStream; written: () => string } {
  let text = ""
  const out = new Writable({
    write(chunk, _encoding, done) {
      text += chunk
      done()
    },
  }) as unknown as NodeJS.WriteStream

  Object.assign(out, { isTTY: tty, getColorDepth: () => 8, hasColors: () => tty })
  return { out, written: () => text }
}

test("prints pages opened and problems, requests and updates only when verbose", () => {
  for (const verbose of [false, true]) {
    const { out, written } = stream(false)
    const { log } = terminal(out, verbose)

    log("GET /a.md 200", "request")
    log("update page /a.md -> tab 1", "update")
    log("opened /a.md", "opened")
    log("GET /gone.md 404", "warning")
    log("model: cannot index b.md: broken")

    assert.deepEqual(
      written()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(/^\d\d:\d\d:\d\d /, "")),
      [
        ...(verbose ? ["GET /a.md 200", "update page /a.md -> tab 1"] : []),
        "opened /a.md",
        "GET /gone.md 404",
        "model: cannot index b.md: broken",
      ],
      `verbose: ${verbose}`,
    )
    assert.ok(!written().includes(ESCAPE), "piped output carries no colour")
  }
})

test("on a terminal, colours problems by severity and keeps a progress line under the last line", () => {
  const { out, written } = stream(true)
  const output = terminal(out, false)

  output.progress("reading the folder: 12 documents")
  output.log("GET /gone.md 404", "warning")
  output.log("model: cannot store a.md: full")
  output.progress(undefined)

  const text = written()
  assert.ok(text.includes(`${ESCAPE}33mGET /gone.md 404${ESCAPE}39m`), text)
  assert.ok(text.includes(`${ESCAPE}31mmodel: cannot store a.md: full${ESCAPE}39m`), text)
  assert.equal(text.split("reading the folder: 12 documents").length - 1, 3, text)
  assert.ok(text.endsWith("\r\x1b[2K"), "the progress line is cleared at the end")
})

test("a progress line turns its spinner on its own, reading a function's text again each turn, until cleared", async () => {
  const { out, written } = stream(true)
  const output = terminal(out, false)
  let documents = 0

  output.progress(() => `reading the folder: ${documents} documents`)
  documents = 40
  await new Promise((resolve) => setTimeout(resolve, 400))
  output.progress(undefined)
  const cleared = written()
  await new Promise((resolve) => setTimeout(resolve, 200))

  const lines = cleared.split("\r\x1b[2K").filter(Boolean).map(stripVTControlCharacters)
  assert.match(lines[0], /^\S+ reading the folder: 0 documents$/)
  assert.match(lines.at(-1) ?? "", /^\S+ reading the folder: 40 documents$/)
  assert.ok(new Set(lines.map((line) => line.split(" ")[0])).size >= 3, cleared)
  assert.equal(written(), cleared, "nothing is drawn once the line is cleared")
})

test("a progress line wider than the terminal is cut short of its edge, so clearing it leaves no row behind", () => {
  const { out, written } = stream(true)
  Object.assign(out, { columns: 40 })
  const output = terminal(out, false)

  output.progress(
    "waiting for the folio at http://localhost:8640/, reading the folder: 693 documents",
  )
  output.progress(undefined)

  const [line] = written().split("\r\x1b[2K").filter(Boolean).map(stripVTControlCharacters)
  assert.equal(line.length, 39, line)
  assert.match(line, /^\S+ waiting for the folio at http:\/\/local$/)
})

test("a piped progress line prints nothing", async () => {
  const { out, written } = stream(false)
  const output = terminal(out, false)

  output.progress("reading the folder: 12 documents")
  output.progress(() => "checking health: 3 of 9 documents")
  await new Promise((resolve) => setTimeout(resolve, 200))
  output.progress(undefined)
  assert.equal(written(), "")
})

test("help pages lay their rows in columns, plain when piped", () => {
  const { out } = stream(false)
  const text = helpText(HELP.check, out)

  assert.ok(!text.includes(ESCAPE))
  assert.match(text, /^folio check - /)
  assert.match(
    text,
    /\nExit codes\n {2}0 {2}No problem is an error\n {2}1 {2}A problem is an error\n/,
  )
  assert.match(text, /\n {2}-p, --port N {3}Ask the folio serving FOLDER on this port/)
  assert.match(text, /\n {2}--socket PATH {2}Ask/)
})

test("a client is named as it names itself, and not at all when its name is empty", () => {
  assert.equal(clientName({ name: "Code", version: "1.96.0" }), "Code 1.96.0")
  assert.equal(clientName({ name: "Code", version: "" }), "Code")
  assert.equal(clientName({ name: "", version: "1.96.0" }), undefined)
  assert.equal(clientName({ name: 7 }), undefined)
  assert.equal(clientName(undefined), undefined)
})
