import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { check } from "../src/server/check.ts"
import { modelStore } from "../src/server/model.ts"
import { recordServing } from "../src/server/serving.ts"

const CLI = new URL("../src/cli.ts", import.meta.url).pathname

test("a running folio slow to work out health is waited for, and a failure is said rather than thrown", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-")))
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-socket-")), "s")
  let healthy = true
  const server = http.createServer((request, response) => {
    if (request.url === "/?api") {
      response.end(JSON.stringify({ root }))
    } else if (healthy) {
      setTimeout(() => {
        response.end(
          JSON.stringify({
            ready: true,
            problems: [
              { kind: "rule", path: "a.md", line: 3, severity: "error", what: "a.md is a draft" },
            ],
          }),
        )
      }, 1500)
    } else {
      response.end("not JSON")
    }
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  const unused = () => {
    throw new Error("the running folio should have answered")
  }

  try {
    const said: string[] = []
    assert.equal(
      await check(
        root,
        { port: 1, socket },
        unused,
        (line) => said.push(line),
        () => {},
      ),
      1,
    )
    assert.deepEqual(said, [
      "a.md:3  error  rule  a.md is a draft",
      "folio check: 1 error, 0 other problems",
    ])

    healthy = false
    const failed: string[] = []
    assert.equal(
      await check(
        root,
        { port: 1, socket },
        unused,
        (line) => failed.push(line),
        () => {},
      ),
      2,
    )
    assert.match(failed[0], /^folio check: no health could be worked out: /)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("waiting on a running folio, the live line follows its reading and then its health, and is gone before the problems print", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-")))
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-socket-")), "s")
  const counts = [12, 340]
  const server = http.createServer((request, response) => {
    if (request.url === "/?api") {
      response.end(JSON.stringify({ root }))
    } else if (request.url === "/?model") {
      const documents = counts.shift()
      response.end(JSON.stringify({ ready: documents === undefined, documents: documents ?? 693 }))
    } else {
      setTimeout(() => {
        response.end(
          JSON.stringify({
            ready: true,
            problems: [{ kind: "link", path: "a.md", line: 1, what: "Links to b.md" }],
          }),
        )
      }, 300)
    }
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  const events: string[] = []

  try {
    const code = await check(
      root,
      { port: 1, socket },
      () => {
        throw new Error("the running folio should have answered")
      },
      (line) => events.push(`print ${line}`),
      (text) => events.push(`line ${typeof text === "function" ? text() : text}`),
    )

    assert.equal(code, 0)
    assert.deepEqual(events, [
      `line waiting for the folio on ${socket}, reading the folder: 12 documents`,
      `line waiting for the folio on ${socket}, reading the folder: 340 documents`,
      `line waiting for the folio on ${socket}, checking health`,
      "line undefined",
      "print a.md:1  -  link  Links to b.md",
      "print folio check: 0 errors, 1 other problem",
    ])
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a rule's warning prints as warning and any other problem that is no error as -, as the reference says", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-")))
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-socket-")), "s")
  const server = http.createServer((request, response) => {
    response.end(
      JSON.stringify(
        request.url === "/?api"
          ? { root }
          : {
              ready: true,
              problems: [
                { kind: "rule", path: "a.md", line: 2, severity: "warning", what: "a.md is long" },
                { kind: "link", path: "b.md", line: 4, what: "Links to c.md, which is not there" },
              ],
            },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))

  try {
    const said: string[] = []
    await check(
      root,
      { port: 1, socket },
      () => {
        throw new Error("the running folio should have answered")
      },
      (line) => said.push(line),
      () => {},
    )
    assert.deepEqual(said.slice(0, 2), [
      "a.md:2  warning  rule  a.md is long",
      "b.md:4  -        link  Links to c.md, which is not there",
    ])

    const reference = fs.readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8")
    const described = reference.split("\n").find((line) => line.startsWith("`folio check` prints"))
    assert.match(described ?? "", /`error`, `warning` for a rule's warning, or `-`/)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("given no port or socket, folio check asks the folio its folder's record names; a record a killed folio left, or a port given, is not followed", async () => {
  const env = {
    ...process.env,
    XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-state-")),
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-")))
  fs.writeFileSync(path.join(root, "a.md"), "# A\n")
  const asked: string[] = []
  const server = http.createServer((request, response) => {
    asked.push(request.url ?? "")
    response.end(
      JSON.stringify(
        request.url === "/?api"
          ? { root }
          : request.url === "/?model"
            ? { ready: true, documents: 1 }
            : {
                ready: true,
                problems: [
                  { kind: "rule", path: "a.md", line: 1, severity: "error", what: "moved" },
                ],
              },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  const store = modelStore(root, env)
  const run = (...args: string[]) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, "check", root, ...args], { env })
      let out = ""
      child.stdout.on("data", (chunk) => {
        out += chunk
      })
      child.once("exit", (status) => resolve({ status, out }))
    })

  try {
    recordServing(store, port)
    const moved = await run()
    assert.equal(moved.status, 1, moved.out)
    assert.match(moved.out, /^a\.md:1 {2}error {2}rule {2}moved\n/)

    const given = await run("--port", "1")
    assert.equal(given.status, 0, given.out)
    assert.equal(given.out, "folio check: 0 errors, 0 other problems\n")

    fs.writeFileSync(
      path.join(store, "serving.json"),
      JSON.stringify({ port, pid: spawnSync(process.execPath, ["-e", ""]).pid, start: "1" }),
    )
    const before = asked.length
    const killed = await run()
    assert.equal(killed.status, 0, killed.out)
    assert.equal(asked.length, before, "the killed folio's port is never asked")
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
