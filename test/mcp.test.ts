import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { modelStore } from "../src/server/model.ts"
import { recordServing } from "../src/server/serving.ts"

test("a malformed message gets a JSON-RPC error and the server stays up; a version Folio does not speak is not echoed", async () => {
  const server = spawn(process.execPath, [
    new URL("../src/cli.ts", import.meta.url).pathname,
    "mcp",
    "--port",
    "1",
  ])
  const replies: {
    id: unknown
    result?: Record<string, unknown>
    error?: { code: number; message: string }
  }[] = []
  const batches: unknown[][] = []
  let heard = ""
  let said = ""
  server.stderr.on("data", (chunk) => {
    said += chunk
  })
  server.stdout.on("data", (chunk) => {
    heard += chunk
    const lines = heard.split("\n")
    heard = lines.pop() ?? ""

    for (const line of lines.filter(Boolean)) {
      const parsed = JSON.parse(line)

      if (Array.isArray(parsed)) {
        batches.push(parsed)
      }

      replies.push(...[parsed].flat())
    }
  })
  const sent = [
    "null",
    "[1, 2]",
    "{}",
    { id: 1, method: "tools/call", params: null },
    { id: 2, method: "tools/call", params: { name: "folio_health", arguments: "all" } },
    { id: 3, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    { id: 4, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    {
      id: 6,
      method: "tools/call",
      params: { name: "folio_document", arguments: { path: "\ud800" } },
    },
    { id: 9, method: "tools/call", params: { name: "constructor" } },
    [
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 8, method: "ping" },
    ],
    { id: 5, method: "ping" },
  ]

  try {
    for (const message of sent) {
      server.stdin.write(
        `${
          typeof message === "string"
            ? message
            : JSON.stringify(Array.isArray(message) ? message : { jsonrpc: "2.0", ...message })
        }\n`,
      )
    }

    for (let tries = 0; replies.length < 13; tries++) {
      assert.ok(tries < 200, `only ${replies.length} replies`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const byId = (id: unknown) => replies.find((reply) => reply.id === id)
    assert.deepEqual(
      replies.filter(({ id }) => id === null).map(({ error }) => error?.code),
      [-32600, -32600, -32600, -32600],
    )
    assert.equal(byId(1)?.error?.code, -32602)
    assert.equal(byId(2)?.error?.code, -32602)
    assert.equal(byId(3)?.result?.protocolVersion, "2025-06-18")
    assert.equal(byId(4)?.result?.protocolVersion, "2025-03-26")
    assert.deepEqual(byId(6)?.error, {
      code: -32603,
      message:
        "Internal error: folio mcp failed while answering this request. The reason is on its standard error, in the log your MCP client keeps.",
    })
    assert.match(said, /\btools\/call failed: URI malformed\n/)
    assert.equal((byId(9)?.result as { isError?: boolean } | undefined)?.isError, true)
    assert.deepEqual(
      batches.map((batch) => (batch as { id: unknown }[]).map(({ id }) => id)),
      [
        [null, null],
        [7, 8],
      ],
    )
    assert.deepEqual(byId(5)?.result, {})
    assert.equal(server.exitCode, null, "the server is still up")

    const reference = fs.readFileSync(
      new URL("../docs/reference/command-line.md", import.meta.url),
      "utf8",
    )
    assert.match(reference, /It speaks MCP 2025-06-18, and 2025-03-26 or 2024-11-05/)
  } finally {
    server.kill()
  }
})

test("on standard error, folio mcp names the Folio it reads, the agent, and every change in what answers there; standard output stays the protocol", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-"))
  const socket = path.join(dir, "folio.sock")
  const serving = async (root: string) => {
    fs.rmSync(socket, { force: true })
    const stand = http.createServer((request, response) => {
      response.end(
        JSON.stringify(request.url === "/?api" ? { root } : { ready: true, problems: [] }),
      )
    })
    await new Promise<void>((resolve) => stand.listen(socket, resolve))
    return () => new Promise<void>((resolve) => stand.close(() => resolve()))
  }
  const server = spawn(process.execPath, [
    new URL("../src/cli.ts", import.meta.url).pathname,
    "mcp",
    "--socket",
    socket,
  ])
  let said = ""
  let heard = ""
  server.stderr.on("data", (chunk) => {
    said += chunk
  })
  server.stdout.on("data", (chunk) => {
    heard += chunk
  })
  const lines = () =>
    said
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\d\d:\d\d:\d\d /, ""))
  const settle = async (count: number) => {
    for (let tries = 0; lines().length < count; tries++) {
      assert.ok(tries < 200, said)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  let id = 0
  const send = (method: string, params: object) =>
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`)
  const call = () => send("tools/call", { name: "folio_health", arguments: {} })

  try {
    await settle(2)
    send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: "Test Agent", version: "3" },
    })
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    )
    await settle(3)
    let stop = await serving("/notes/a")
    call()
    await settle(4)
    await stop()
    stop = await serving("/notes/b")
    call()
    await settle(5)
    await stop()
    call()
    await settle(6)
    server.stdin.end()
    await new Promise((resolve) => server.once("exit", resolve))

    assert.deepEqual(lines(), [
      `folio mcp reading the Folio on ${socket}`,
      "nothing answers there yet",
      "Test Agent 3 connected",
      "a Folio answers there now, serving /notes/a",
      "that Folio now serves /notes/b",
      "that Folio stopped answering",
      "Test Agent 3 left",
    ])
    assert.equal(server.exitCode, 0)
    assert.deepEqual(
      heard
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).id),
      [1, 2, 3, 4],
    )
  } finally {
    server.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the introduction names the moments to call a tool and who the reader is before it routes to every tool, within the 4,096 characters Claude Code keeps; every tool has a title, all four hints and described, typed arguments", async () => {
  const replies = await exchange(
    ["--port", "1"],
    [
      { method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { method: "tools/list", params: {} },
      { method: "tools/call", params: { name: "folio_health", arguments: {} } },
    ],
  )
  const { instructions } = replies[0].result as { instructions: string }
  const [socketed] = await exchange(
    ["--socket", path.join(os.tmpdir(), `${"s".repeat(90)}.sock`)],
    [{ method: "initialize", params: { protocolVersion: "2025-06-18" } }],
  )
  const { tools } = replies[1].result as {
    tools: {
      name: string
      title: string
      description: string
      inputSchema: { properties: Record<string, { type: string; description?: string }> }
      annotations: Record<string, unknown>
    }[]
  }

  for (const { length } of [
    instructions,
    (socketed.result as { instructions: string }).instructions,
  ]) {
    assert.ok(length < 4096, `${length} characters`)
  }
  assert.equal(tools.length, 16)

  const routing = instructions.indexOf("Which tool answers what:")
  const before = instructions.slice(0, routing)
  const reader = before.split("\n\n").find((part) => part.startsWith("The reader is")) ?? ""
  const moments = before.indexOf("Call them at these moments:")
  assert.ok(moments >= 0 && moments < before.indexOf("The reader is"))
  assert.match(before, /folio_query over folio\.links/)
  assert.deepEqual(
    before
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => [line.slice(2, line.indexOf(":")), line.match(/folio_\w+/g)]),
    [
      ["Before editing, moving or deleting a file", ["folio_used_by", "folio_query"]],
      ["After editing a document", ["folio_health"]],
      ["Before writing a document of a kind", ["folio_kinds"]],
      ["Before quoting a number from a data file in a document", ["folio_embed"]],
    ],
  )
  assert.match(
    reader,
    /^The reader is the person reading the folder in their browser, usually the user you work for\. Call folio_presence, folio_reads, folio_changes, folio_needs and folio_stale only when the user's request is about what they see - this page, this paragraph - have read or must catch up on, or to fit a report to what they have not read yet; never for anything else\./,
  )
  assert.match(
    reader,
    /while the reader pauses sharing in Folio, they answer only \{paused: true, message\}/,
  )

  for (const { name, title, description, inputSchema, annotations } of tools) {
    assert.ok(instructions.slice(routing).includes(name), `${name} is routed to`)
    assert.ok(title.length > name.length && title !== name, name)
    assert.ok(description.length <= 2048, `${name}: ${description.length} characters`)
    assert.deepEqual(annotations, {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })

    for (const [param, { description: said }] of Object.entries(inputSchema.properties)) {
      assert.ok(said, `${name}.${param} is described`)
    }
  }

  const digest = tools.find(({ name }) => name === "folio_digest")
  assert.deepEqual(
    Object.values(digest?.inputSchema.properties ?? {}).map(({ type }) => type),
    ["string", "string"],
  )

  const unreached = replies[2].result as { content: { text: string }[]; isError: boolean }
  assert.equal(unreached.isError, true)
  assert.equal(
    unreached.content[0].text,
    "No Folio answers at http://localhost:1/ (connect ECONNREFUSED 127.0.0.1:1). These tools read a Folio serving the folder, and the user starts one: ask them to run `folio FOLDER`, or, when a Folio already serves it on another port or a socket, to start folio mcp with --port or --socket to match; then call again. Start no process yourself.",
  )
  assert.match(
    instructions,
    /\nA Folio must already be serving the folder, and the user starts it - as `folio FOLDER`, serving on http:\/\/localhost:8640\/ or the next free port - never you: a running Folio writes into the folder what its FOLIO\.md declares\. This server reads the Folio at http:\/\/localhost:1\/ \(--port or --socket chooses\)\. With none there, every call fails: ask the user to start one\./,
  )
})

test("started by a Claude Code plugin, folio mcp names the plugin's Folio setting where it names --port or --socket; the setting, given as the argument, names a Folio by its address or socket, and empty finds one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-"))
  const socket = path.join(dir, "folio.sock")
  const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-notes-")))
  const onPort = await standIn(notes)
  const onSocket = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ root: "/socketed" }))
  })
  await new Promise<void>((resolve) => onSocket.listen(socket, resolve))
  const plugin = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: "/plugins/folio",
    XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-state-")),
  }
  const initialize = { method: "initialize", params: { protocolVersion: "2025-06-18" } }
  const documents = { method: "tools/call", params: { name: "folio_documents", arguments: {} } }

  try {
    const unreached = await exchange(
      ["localhost:1"],
      [initialize, { method: "tools/call", params: { name: "folio_health", arguments: {} } }],
      plugin,
    )
    const found = await exchange([""], [initialize], plugin)
    const address = await exchange([`localhost:${onPort.port}`], [documents], plugin)
    const url = await exchange([`http://localhost:${onPort.port}/`], [documents], plugin)
    const socketed = await exchange([socket], [documents], plugin)
    const told = (reply: { result?: unknown }) =>
      (reply.result as { instructions: string }).instructions

    assert.match(
      told(unreached[0]),
      /\nA Folio must already be serving the folder, and the user starts it - as `folio FOLDER`, serving on http:\/\/localhost:8640\/ or the next free port - never you: a running Folio writes into the folder what its FOLIO\.md declares\. This server reads the Folio at http:\/\/localhost:1\/ \(the folio plugin's Folio setting chooses\)\. With none there, every call fails: ask the user to start one\./,
    )
    assert.deepEqual(unreached[1].result, {
      content: [
        {
          type: "text",
          text: "No Folio answers at http://localhost:1/ (connect ECONNREFUSED 127.0.0.1:1). These tools read a Folio serving the folder, and the user starts one: ask them to run `folio FOLDER`, or, when a Folio already serves it elsewhere, to set the folio plugin's Folio setting, in /config, to that Folio's address or socket; then call again. Start no process yourself.",
        },
      ],
      isError: true,
    })
    assert.match(
      told(found[0]),
      /This server reads the Folio serving the nearest folder at or above one of your roots, or the folder it started in, else the Folio at http:\/\/localhost:8640\/ \(the folio plugin's Folio setting chooses one instead\)\./,
    )
    assert.ok(told(found[0]).length < 4096, `${told(found[0]).length} characters`)
    assert.deepEqual(
      [answered(address[0]), answered(url[0]), answered(socketed[0])],
      [notes, notes, "/socketed"],
    )
  } finally {
    await onPort.close()
    onSocket.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a period given as ISO times reaches Folio as the digest's from and to", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-"))
  const socket = path.join(dir, "folio.sock")
  const asked: string[] = []
  const stand = http.createServer((request, response) => {
    asked.push(request.url ?? "")
    response.end(JSON.stringify({ root: "/notes" }))
  })
  await new Promise<void>((resolve) => stand.listen(socket, resolve))

  try {
    await exchange(
      ["--socket", socket],
      [
        {
          method: "tools/call",
          params: {
            name: "folio_digest",
            arguments: { from: "2026-11-02", to: "2026-11-02T09:00:00+01:00" },
          },
        },
      ],
    )
    assert.ok(
      asked.includes("/?api=digest&from=2026-11-02&to=2026-11-02T09%3A00%3A00%2B01%3A00"),
      asked.join("\n"),
    )
  } finally {
    stand.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the instructions name the folder the Folio serves; a tool's path outside it is refused naming it, and one under it reaches Folio", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-"))
  const socket = path.join(dir, "folio.sock")
  const asked: string[] = []
  const stand = http.createServer((request, response) => {
    asked.push(request.url ?? "")
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(request.url === "/?api" ? { root: "/notes" } : {}))
  })
  await new Promise<void>((resolve) => stand.listen(socket, resolve))

  try {
    const [initialized, outside, under, source] = await exchange(
      ["--socket", socket],
      [
        { method: "initialize", params: { protocolVersion: "2025-06-18" } },
        {
          method: "tools/call",
          params: { name: "folio_document", arguments: { path: "/etc/hosts" } },
        },
        {
          method: "tools/call",
          params: { name: "folio_document", arguments: { path: "/notes/plans/q3.md" } },
        },
        {
          method: "tools/call",
          params: {
            name: "folio_provenance",
            arguments: { path: "plans/q3.md", block: "3f9a1c2e", source: "/notesy/a.md" },
          },
        },
      ],
    )
    const text = (reply: { result?: unknown }) =>
      (reply.result as { content: { text: string }[] }).content[0].text

    assert.match(
      (initialized.result as { instructions: string }).instructions,
      /\nThe served folder is \/notes\. Paths are relative to it, or absolute under it, with forward slashes/,
    )
    assert.equal(
      text(outside),
      "/etc/hosts is outside the served folder, /notes: a path is relative to it, or absolute under it.",
    )
    assert.equal(
      text(source),
      "/notesy/a.md is outside the served folder, /notes: a path is relative to it, or absolute under it.",
    )
    assert.equal(text(under), "{}")
    assert.ok(asked.includes("/plans/q3.md?api=document"), asked.join("\n"))
    assert.ok(
      !asked.some((url) => url.includes("hosts") || url.includes("notesy")),
      asked.join("\n"),
    )
  } finally {
    stand.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a list too long for one answer is cut to fit, saying how many entries each list left out and how to narrow; a short list, an answer with no list to cut and a query's rows pass whole", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-"))
  const socket = path.join(dir, "folio.sock")
  const many = (count: number) =>
    Array.from({ length: count }, (_, at) => ({ path: `notes/day-${at}.md`, kind: null }))
  const answers: Record<string, unknown> = {
    "/?api": { root: "/notes" },
    "/?api=documents": { ready: true, documents: many(3000) },
    "/small/?api=documents": { ready: true, documents: many(3) },
    "/?api=digest": { from: "a", to: "b", documents: many(2000), values: many(3) },
    "/notes/day-1.md?api=history&version=v1": {
      path: "notes/day-1.md",
      version: "v1",
      text: "words ".repeat(5000),
    },
    "/?api=query&sql=select+1": { columns: [], rows: many(3000), total: 3000, partial: false },
  }
  const stand = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(answers[request.url ?? ""] ?? {}))
  })
  await new Promise<void>((resolve) => stand.listen(socket, resolve))

  try {
    const [whole, small, digest, version, query] = (
      await exchange(
        ["--socket", socket],
        [
          { method: "tools/call", params: { name: "folio_documents", arguments: {} } },
          {
            method: "tools/call",
            params: { name: "folio_documents", arguments: { folder: "small" } },
          },
          { method: "tools/call", params: { name: "folio_digest", arguments: {} } },
          {
            method: "tools/call",
            params: { name: "folio_history", arguments: { path: "notes/day-1.md", version: "v1" } },
          },
          { method: "tools/call", params: { name: "folio_query", arguments: { sql: "select 1" } } },
        ],
      )
    ).map((reply) => (reply.result as { content: { text: string }[] }).content[0].text)
    const cut = JSON.parse(whole)
    const period = JSON.parse(digest)

    assert.ok(whole.length <= 20_000, `${whole.length} characters`)
    assert.equal(cut.documents.length + cut.omitted.documents, 3000)
    assert.ok(cut.documents.length > 100, `${cut.documents.length} kept`)
    assert.deepEqual(cut.documents[0], { path: "notes/day-0.md", kind: null })
    assert.equal(
      cut.narrow,
      "Give folder, such as notes/, for only the documents under it, a deeper one for less.",
    )
    assert.equal(small, JSON.stringify(answers["/small/?api=documents"]))
    assert.ok(digest.length <= 20_000, `${digest.length} characters`)
    assert.equal(period.documents.length + period.omitted.documents, 2000)
    assert.deepEqual([period.values.length, period.omitted.values], [3, undefined])
    assert.equal(version, JSON.stringify(answers["/notes/day-1.md?api=history&version=v1"]))
    assert.equal(period.narrow, "Give a shorter period with from and to.")
    assert.equal(query, JSON.stringify(answers["/?api=query&sql=select+1"]))
  } finally {
    stand.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a tool refuses an argument it does not take, naming those it takes, and two it cannot take together; every cut notice says omitted counts what each list left out", async () => {
  const stand = await standIn("/notes")
  const calls: [string, Record<string, unknown>][] = [
    ["folio_documents", { path: "notes/" }],
    ["folio_health", { folder: "notes/" }],
    ["folio_embed", { path: "report.md", reference: "data.csv", extra: 1 }],
    ["folio_presence", { page: "a.md", tab: 2 }],
    ["folio_history", { path: "report.md", version: "v1", block: "3f9a1c2e" }],
    ["folio_related", { path: "report.md", block: "3f9a1c2e", question: "rain" }],
    ["folio_related", { path: "report.md", question: "rain" }],
    ["folio_related", { block: "3f9a1c2e" }],
    ["folio_history", { path: "report.md", block: "3f9a1c2e", version: "" }],
    ["folio_related", { question: "rain" }],
  ]

  try {
    const [initialized, listed, ...replies] = await exchange(
      ["--port", String(stand.port)],
      [
        { method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { method: "tools/list", params: {} },
        ...calls.map(([name, args]) => ({
          method: "tools/call",
          params: { name, arguments: args },
        })),
      ],
    )
    const answered = replies.map(
      (reply) => reply.result as { content: { text: string }[]; isError?: boolean },
    )
    const notice =
      "adds omitted, how many entries each list left out, and narrow, how to ask for less."
    const passed = JSON.stringify({ root: "/notes", documents: [] })
    const { tools } = listed.result as { tools: { name: string; description: string }[] }

    assert.deepEqual(
      answered.map(({ content, isError }) => [isError ?? false, content[0].text]),
      [
        [true, "folio_documents takes folder, not path."],
        [true, "folio_health takes path, not folder."],
        [true, "folio_embed takes path and reference, not extra."],
        [true, "folio_presence takes no argument, not page or tab."],
        [true, "folio_history takes at most one of version, block and reference."],
        [true, "folio_related takes a question, or path and block, never both."],
        [true, "folio_related takes a question, or path and block, never both."],
        [true, "folio_related takes block only with path, the page holding it."],
        [false, passed],
        [false, passed],
      ],
    )
    assert.deepEqual(stand.asked.filter((url) => url !== "/?api").sort(), [
      "/?api=related&question=rain",
      "/report.md?api=history&block=3f9a1c2e",
    ])
    assert.match(
      (initialized.result as { instructions: string }).instructions,
      /adds omitted, how many entries each list left out, and narrow, how to ask for less\./,
    )
    assert.deepEqual(
      tools
        .filter(({ description }) => description.includes("omitted"))
        .map(({ name, description }) => [name, description.includes(notice)]),
      tools.filter(({ name }) => name !== "folio_query").map(({ name }) => [name, true]),
    )
  } finally {
    await stand.close()
  }
})

async function exchange(
  args: string[],
  requests: { method: string; params: object }[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ id: number; result?: unknown }[]> {
  const server = spawn(
    process.execPath,
    [new URL("../src/cli.ts", import.meta.url).pathname, "mcp", ...args],
    { env },
  )
  let heard = ""
  server.stdout.on("data", (chunk) => {
    heard += chunk
  })

  try {
    requests.forEach(({ method, params }, index) => {
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params })}\n`)
    })

    for (let tries = 0; heard.split("\n").filter(Boolean).length < requests.length; tries++) {
      assert.ok(tries < 200, heard)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    return heard
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.id - b.id)
  } finally {
    server.kill()
  }
}

test("an agent that leaves at once still hears what answers at Folio's address before it leaves", async () => {
  const server = spawn(process.execPath, [
    new URL("../src/cli.ts", import.meta.url).pathname,
    "mcp",
    "--port",
    "1",
  ])
  let said = ""
  server.stderr.on("data", (chunk) => {
    said += chunk
  })
  server.stdin.end()
  await new Promise((resolve) => server.once("exit", resolve))

  assert.deepEqual(
    said
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\d\d:\d\d:\d\d /, "")),
    [
      "folio mcp reading the Folio at http://localhost:1/",
      "nothing answers there yet",
      "the agent left",
    ],
  )
})

test("a program on Folio's address that is no Folio gets the same answer as no program at all, a page or a refusal of its own; a refusal with no type, as Node's parser gives, is Folio's", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-"))
  const socket = path.join(dir, "other.sock")
  let status = 200
  const other = http.createServer((_request, response) => {
    response.statusCode = status

    if (status === 431) {
      response.end()
      return
    }

    response.setHeader("Content-Type", "text/html")
    response.end("<h1>Welcome</h1>")
  })
  await new Promise<void>((resolve) => other.listen(socket, resolve))

  try {
    for (const answered of [200, 404]) {
      status = answered
      const [reply] = await exchange(
        ["--socket", socket],
        [{ method: "tools/call", params: { name: "folio_health", arguments: {} } }],
      )
      const { content, isError } = reply.result as { content: { text: string }[]; isError: boolean }
      assert.equal(isError, true)
      assert.match(
        content[0].text,
        /^No Folio answers on .*other\.sock \(what answers there is no Folio\)\./,
        `${answered}`,
      )
    }

    status = 431
    const [refused] = await exchange(
      ["--socket", socket],
      [{ method: "tools/call", params: { name: "folio_health", arguments: {} } }],
    )
    assert.deepEqual(refused.result, {
      content: [{ type: "text", text: "Folio answered 431." }],
      isError: true,
    })
  } finally {
    other.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("given no port or socket, folio mcp reads the Folio serving the nearest folder at or above one of the agent's roots, says which, and finds it again once it moves", async () => {
  const env = {
    ...process.env,
    XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-state-")),
  }
  const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-notes-")))
  const plans = path.join(notes, "plans")
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-other-")))
  fs.mkdirSync(path.join(plans, "q3"), { recursive: true })
  const stands = [await standIn(notes), await standIn(other)]
  recordServing(modelStore(notes, env), stands[0].port)
  recordServing(modelStore(other, env), stands[1].port)
  const agent = client(["mcp"], { env, cwd: other })

  try {
    await agent.settled(3)
    agent.send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "Root Agent", version: "1" },
      },
    })
    const { instructions } = (await agent.reply(1)).result as { instructions: string }
    agent.send({ method: "notifications/initialized" })
    const asked = await agent.request("roots/list")
    agent.send({
      id: asked.id,
      result: { roots: [{ uri: pathToFileURL(path.join(plans, "q3")).href, name: "q3" }] },
    })
    agent.send({ id: 2, method: "tools/call", params: { name: "folio_documents", arguments: {} } })
    assert.equal(answered(await agent.reply(2)), notes)

    stands.push(await standIn(plans))
    recordServing(modelStore(plans, env), stands[2].port)
    agent.send({ id: 3, method: "tools/call", params: { name: "folio_documents", arguments: {} } })
    assert.equal(answered(await agent.reply(3)), plans)

    await stands[2].close()
    stands.push(await standIn(plans))
    recordServing(modelStore(plans, env), stands[3].port)
    agent.send({ id: 4, method: "tools/call", params: { name: "folio_documents", arguments: {} } })
    assert.equal(answered(await agent.reply(4)), plans)

    await agent.end()
    assert.ok(instructions.length < 4096, `${instructions.length} characters`)
    assert.match(
      instructions,
      /reads the Folio serving the nearest folder at or above one of your roots, or the folder it started in, else the Folio at http:\/\/localhost:8640\//,
    )
    assert.deepEqual(agent.said(), [
      "folio mcp reading the Folio serving the agent's folder",
      `found the Folio at http://localhost:${stands[1].port}/`,
      `that Folio serves ${other}`,
      "Root Agent 1 connected",
      `found the Folio at http://localhost:${stands[0].port}/`,
      `that Folio serves ${notes}`,
      `found the Folio at http://localhost:${stands[2].port}/`,
      `that Folio serves ${plans}`,
      `found the Folio at http://localhost:${stands[3].port}/`,
      `that Folio serves ${plans}`,
      "Root Agent 1 left",
    ])
  } finally {
    await agent.end()
    await Promise.all(stands.map((stand) => stand.close()))
  }
})

test("a client naming no roots: the folder folio mcp started in; a Folio killed without stopping, or no Folio, leaves 8640", async () => {
  const env = {
    ...process.env,
    XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-state-")),
  }
  const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-notes-")))
  const plans = path.join(notes, "plans")
  const gone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-gone-")))
  fs.mkdirSync(plans)
  const stands = [await standIn(notes), await standIn(gone)]
  recordServing(modelStore(notes, env), stands[0].port)
  fs.mkdirSync(modelStore(gone, env), { recursive: true })
  fs.writeFileSync(
    path.join(modelStore(gone, env), "serving.json"),
    JSON.stringify({ port: stands[1].port, pid: deadProcess(), start: "1" }),
  )
  const rooted = client(["mcp"], { env, cwd: plans })
  const unserved = client(["mcp"], { env, cwd: gone })

  try {
    await rooted.settled(3)
    rooted.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    rooted.send({ method: "notifications/initialized" })
    rooted.send({
      id: 2,
      method: "tools/call",
      params: { name: "folio_documents", arguments: {} },
    })
    assert.equal(answered(await rooted.reply(2)), notes)
    assert.equal(rooted.requests(), 0)

    await unserved.settled(2)
    await Promise.all([rooted.end(), unserved.end()])
    assert.deepEqual(rooted.said().slice(1, 3), [
      `found the Folio at http://localhost:${stands[0].port}/`,
      `that Folio serves ${notes}`,
    ])
    assert.equal(
      unserved.said()[1],
      `no Folio serves ${gone} or a folder above it; reading the Folio at http://localhost:8640/`,
    )
    assert.equal(stands[1].asked.length, 0, "the dead Folio's port is never asked")
  } finally {
    await Promise.all([rooted.end(), unserved.end()])
    await Promise.all(stands.map((stand) => stand.close()))
  }
})

async function standIn(root: string) {
  const asked: string[] = []
  const server = http.createServer((request, response) => {
    asked.push(request.url ?? "")
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(request.url === "/?api" ? { root } : { root, documents: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as { port: number }).port,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function answered(reply: { result?: unknown }): string {
  return JSON.parse((reply.result as { content: { text: string }[] }).content[0].text).root
}

function deadProcess(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid as number
}

function client(args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) {
  const server = spawn(
    process.execPath,
    [new URL("../src/cli.ts", import.meta.url).pathname, ...args],
    options,
  )
  const messages: { id?: unknown; method?: string; result?: unknown }[] = []
  let heard = ""
  let said = ""
  server.stdout.on("data", (chunk) => {
    heard += chunk
    const lines = heard.split("\n")
    heard = lines.pop() ?? ""
    messages.push(...lines.filter(Boolean).map((line) => JSON.parse(line)))
  })
  server.stderr.on("data", (chunk) => {
    said += chunk
  })
  const lines = () =>
    said
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\d\d:\d\d:\d\d /, ""))
  const until = async <T>(found: () => T | undefined): Promise<T> => {
    for (let tries = 0; ; tries++) {
      const value = found()

      if (value !== undefined) {
        return value
      }

      assert.ok(tries < 200, `${JSON.stringify(messages)}\n${said}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const exited = new Promise<number | null>((resolve) => server.once("exit", resolve))

  return {
    send: (message: object) =>
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    reply: (id: number) => until(() => messages.find((one) => one.id === id && !one.method)),
    request: (method: string) => until(() => messages.find((one) => one.method === method)),
    requests: () => messages.filter((one) => one.method).length,
    settled: (count: number) => until(() => (lines().length >= count ? true : undefined)),
    said: lines,
    end: () => {
      server.stdin.end()
      return exited
    },
  }
}

test("an agent that declares roots, never lists them and leaves at once still gets its call answered", async () => {
  const env = {
    ...process.env,
    XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-state-")),
  }
  const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-notes-")))
  const stand = await standIn(notes)
  recordServing(modelStore(notes, env), stand.port)
  const agent = client(["mcp"], { env, cwd: notes })

  try {
    agent.send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: { roots: {} } },
    })
    agent.send({ method: "notifications/initialized" })
    agent.send({ id: 2, method: "tools/call", params: { name: "folio_documents", arguments: {} } })
    const exit = await agent.end()

    assert.equal(exit, 0)
    assert.equal(answered(await agent.reply(2)), notes)
    assert.equal(agent.said().at(-1), "the agent left")
  } finally {
    await stand.close()
  }
})
