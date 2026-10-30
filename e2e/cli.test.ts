/** Headless run of folio's command line as a person reads it: help, errors, a running folio's output, check. */

import assert from "node:assert/strict"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { CLI, context, ENV, freePort, until, writeIn } from "./harness.ts"

const ESCAPE = "\x1b["
const VERSION = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
).version
const PIPED = { ...ENV, NO_COLOR: undefined, FORCE_COLOR: undefined }

function inTerminal(args: string[]): { stdout: string; status: number | null } {
  const command = [process.execPath, CLI, ...args].map((part) => `'${part}'`).join(" ")
  const result = spawnSync("script", ["-qec", command, "/dev/null"], {
    encoding: "utf8",
    env: { ...PIPED, TERM: "xterm-256color" },
  })

  return { stdout: result.stdout, status: result.status }
}

function folio(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: PIPED })
}

test("Help, Command help, Version: laid out, coloured on a terminal, and exit 0", () => {
  for (const flag of ["--help", "-h"]) {
    const { stdout, status } = folio([flag])

    assert.equal(status, 0, flag)
    assert.ok(!stdout.includes(ESCAPE), `${flag} piped carries no colour`)

    for (const section of ["Usage", "Commands", "Options", "Examples"]) {
      assert.match(stdout, new RegExp(`\\n${section}\\n`), `${flag}: ${section}`)
    }

    assert.match(stdout, /\n {2}--verbose {6}Print every request and update/)
  }

  for (const command of ["check", "lsp", "mcp"]) {
    const { stdout, status } = folio([command, "--help"])

    assert.equal(status, 0, command)
    assert.match(stdout, new RegExp(`^folio ${command} - `), command)

    for (const section of ["Usage", "Options", "Exit codes", "Examples"]) {
      assert.match(stdout, new RegExp(`\\n${section}\\n`), `${command}: ${section}`)
    }

    assert.equal(/\nArguments\n/.test(stdout), command !== "mcp", `${command}: arguments`)
  }

  assert.match(folio(["check", "--help"]).stdout, /\n {2}1 {2}A problem is an error\n/)

  const coloured = inTerminal(["--help"])
  assert.equal(coloured.status, 0)
  assert.ok(coloured.stdout.includes(`${ESCAPE}1mUsage`), "headings bold on a terminal")
  assert.ok(coloured.stdout.includes(`${ESCAPE}36m-p, --port N`), "options coloured on a terminal")

  const version = folio(["--version"])
  assert.equal(version.status, 0)
  assert.equal(version.stdout, `folio ${VERSION}\n`)
})

test("Bad option, Not a folder: one line naming what is wrong, after a bad option the usage; exit 2", () => {
  const bad = folio(["--prot", "9000"])
  const [first, usage] = bad.stderr.split("\n")

  assert.equal(bad.status, 2)
  assert.equal(first, "Unknown option --prot.")
  assert.match(usage, /^Usage: folio \[FOLDER\] \[--port N\]/)

  const missing = folio(["/nope-not-a-folder"])
  assert.equal(missing.status, 2)
  assert.equal(missing.stderr, "Not a folder: /nope-not-a-folder\n")
})

test("Start, Opening pages, Problems, Every request, Piped: a running folio prints what a person watching wants", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-cli-")))
  writeIn(folder, {
    "a.md": "# A\n\nSee [b](b.md).\n",
    "b.md": "# B\n\nBack to [a](a.md), on to [gone](gone.md) or [the logo](logo.svg).\n",
    "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  })
  const started: ChildProcess[] = []
  const serve = async (...extra: string[]) => {
    const port = await freePort()
    const child = spawn(process.execPath, [CLI, folder, "--port", String(port), ...extra], {
      env: PIPED,
    })
    let said = ""
    started.push(child)
    child.stdout?.on("data", (chunk) => {
      said += chunk
    })
    await until(() => said.includes("documents in"))
    return { base: `http://localhost:${port}`, said: () => said }
  }
  const browse = async (base: string) => {
    const page = await context.newPage()
    await page.addInitScript(() => {
      const sockets: WebSocket[] = []
      const Socket = window.WebSocket
      ;(window as unknown as { sockets: WebSocket[] }).sockets = sockets
      window.WebSocket = class extends Socket {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args)
          sockets.push(this)
        }
      }
    })
    await page.goto(`${base}/a.md`)
    await page.waitForSelector(".markdown-body > h1")
    await page.waitForTimeout(500)
    await page.evaluate(() => (window as unknown as { sockets: WebSocket[] }).sockets[0].close())
    await page.waitForFunction(
      () =>
        (window as unknown as { sockets: WebSocket[] }).sockets[1]?.readyState === WebSocket.OPEN,
    )
    await page.waitForTimeout(500)
    await page.click('.markdown-body a[href="b.md"]')
    await page.waitForSelector(".markdown-body > h1:text('B')")
    await page.waitForTimeout(500)
    await page.hover('.markdown-body a[href="gone.md"]')
    await page.waitForTimeout(500)
    await page.click('.markdown-body a[href="gone.md"]')
    await page.waitForSelector(".markdown-body > h1:text('Not found')")
    await page.waitForTimeout(500)
    await page.close()

    const image = await context.newPage()
    await image.goto(`${base}/b.md`)
    await image.waitForSelector(".markdown-body > h1")
    await image.waitForTimeout(500)
    await image.click('.markdown-body a[href="logo.svg"]')
    await image.waitForURL(`${base}/logo.svg`)
    await image.close()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const lines = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\d\d:\d\d:\d\d /, "TIME "))

  try {
    const quiet = await serve()
    await browse(quiet.base)
    const said = lines(quiet.said())

    assert.ok(!quiet.said().includes(ESCAPE), "piped output carries no colour")
    assert.deepEqual(said.slice(0, 2), [`folio serving ${folder}`, `  at ${quiet.base}/`])
    assert.match(said[2], /^TIME read 2 documents in \d+\.\d s$/)
    assert.deepEqual(said.slice(3), [
      "TIME opened /a.md",
      "TIME opened /b.md",
      "TIME GET /gone.md 404",
      "TIME opened /gone.md",
      "TIME opened /b.md",
    ])

    const verbose = await serve("--verbose")
    await browse(verbose.base)
    const all = lines(verbose.said())
    assert.ok(all.includes("TIME GET /a.md 200"), all.join("\n"))
    assert.ok(all.includes("TIME opened /b.md"))
    assert.ok(
      all.some((line) => /^TIME GET \/\?asset=page\.js 200$/.test(line)),
      "every request is printed",
    )
  } finally {
    for (const child of started) {
      child.kill()
    }

    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("Start on a terminal: a coloured summary and a live progress line while folio reads the folder", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-cli-tty-")))
  writeIn(
    folder,
    Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`n${i}.md`, `# Note ${i}\n`])),
  )
  const port = await freePort()
  const command = [process.execPath, CLI, folder, "--port", String(port)]
    .map((part) => `'${part}'`)
    .join(" ")
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    env: { ...PIPED, TERM: "xterm-256color" },
    detached: true,
  })
  let said = ""
  child.stdout?.on("data", (chunk) => {
    said += chunk
  })

  try {
    await until(() => said.includes("documents in"))
    assert.ok(said.includes(`${ESCAPE}1mfolio`), said)
    assert.match(said, /reading the folder: \d+ documents/)
    const cleared = said.indexOf(`\r${ESCAPE}2K`)
    assert.ok(cleared >= 0 && cleared < said.indexOf("read 50 documents in"), said)
  } finally {
    process.kill(-(child.pid as number), "SIGTERM")
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test("Check, Check piped, Reading, Checking, Done: one aligned line a problem, path:line first, severity coloured and a live line first on a terminal", () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-cli-check-")))
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-cli-check-state-"))
  writeIn(folder, {
    "FOLIO.md":
      "# Rules\n\n```yaml folio\nrules:\n  no-draft:\n    message: '{path} is a draft'\n    query: select path from folio.documents where path like '%draft%'\n```\n",
    "notes/draft.md": "# Draft\n",
    "notes/long-name.md": "# Long\n\nSee [gone](gone.md).\n",
  })
  const env = { ...PIPED, XDG_STATE_HOME: state }

  try {
    const piped = spawnSync(process.execPath, [CLI, "check", folder, "--port", "1"], {
      encoding: "utf8",
      env,
    })
    assert.equal(piped.status, 1)
    assert.ok(!piped.stdout.includes(ESCAPE))
    assert.deepEqual(piped.stdout.split("\n").filter(Boolean), [
      "notes/long-name.md:3  -      link  Links to notes/gone.md, which is not there",
      "notes/draft.md:1      error  rule  notes/draft.md is a draft",
      "folio check: 1 error, 1 other problem",
    ])

    const command = [process.execPath, CLI, "check", folder, "--port", "1"]
      .map((part) => `'${part}'`)
      .join(" ")
    const terminal = spawnSync("script", ["-qec", command, "/dev/null"], {
      encoding: "utf8",
      env: { ...env, TERM: "xterm-256color" },
    })
    assert.equal(terminal.status, 1)
    assert.ok(terminal.stdout.includes(`${ESCAPE}31merror`), terminal.stdout)
    assert.ok(terminal.stdout.includes(`${ESCAPE}31mfolio check: 1 error`), terminal.stdout)
    const cleared = terminal.stdout.lastIndexOf(`\r${ESCAPE}2K`)
    const live = terminal.stdout.slice(0, cleared)
    assert.match(live, /reading the folder: \d+ documents/)
    assert.match(live, /checking health: \d+ of \d+ documents/)
    assert.ok(
      terminal.stdout.slice(cleared + 5).startsWith("notes/long-name.md:3  "),
      "the live line is gone and path:line comes first",
    )
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
    fs.rmSync(state, { recursive: true, force: true })
  }
})
