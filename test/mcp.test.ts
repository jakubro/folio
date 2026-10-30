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

test("a malformed message gets a JSON-RPC error and the server stays up; a version folio does not speak is not echoed", async () => {
  const server = spawn(process.execPath, [
    new URL("../src/cli.ts", import.meta.url).pathname,
    "mcp",
    "--port",
    "1",
  ])
  const replies: { id: unknown; result?: Record<string, unknown>; error?: { code: number } }[] = []
  const batches: unknown[][] = []
  let heard = ""
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
    assert.equal(byId(6)?.error?.code, -32603)
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

    const reference = fs.readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8")
    assert.match(reference, /It speaks MCP 2025-06-18, and 2025-03-26 or 2024-11-05/)
  } finally {
    server.kill()
  }
})

test("on standard error, folio mcp names the folio it reads, the agent, and every change in what answers there; standard output stays the protocol", async () => {
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
      `folio mcp reading the folio on ${socket}`,
      "nothing answers there yet",
      "Test Agent 3 connected",
      "a folio answers there now, serving /notes/a",
      "that folio now serves /notes/b",
      "that folio stopped answering",
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

test("the introduction routes to every tool within the 2,048 characters older Claude Code keeps; every tool has a title, all four hints and described, typed arguments", async () => {
  const replies = await exchange(
    ["--port", "1"],
    [
      { method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { method: "tools/list", params: {} },
      { method: "tools/call", params: { name: "folio_health", arguments: {} } },
    ],
  )
  const { instructions } = replies[0].result as { instructions: string }
  const { tools } = replies[1].result as {
    tools: {
      name: string
      title: string
      description: string
      inputSchema: { properties: Record<string, { type: string; description?: string }> }
      annotations: Record<string, unknown>
    }[]
  }

  assert.ok(instructions.length <= 2048, `${instructions.length} characters`)
  assert.equal(tools.length, 15)

  for (const { name, title, description, inputSchema, annotations } of tools) {
    assert.ok(instructions.includes(name), `${name} is routed to`)
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
    ["integer", "integer"],
  )

  const unreached = replies[2].result as { content: { text: string }[]; isError: boolean }
  assert.equal(unreached.isError, true)
  assert.match(unreached.content[0].text, /^No folio answers at http:\/\/localhost:1\/ \(/)
  assert.match(unreached.content[0].text, /start one with `folio FOLDER`/)
})

test("a period given as integers reaches folio as the digest's from and to", async () => {
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
          params: { name: "folio_digest", arguments: { from: 1_000, to: 86_401_000 } },
        },
      ],
    )
    assert.ok(asked.includes("/?api=digest&from=1000&to=86401000"), asked.join("\n"))
  } finally {
    stand.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function exchange(
  args: string[],
  requests: { method: string; params: object }[],
): Promise<{ id: number; result?: unknown }[]> {
  const server = spawn(process.execPath, [
    new URL("../src/cli.ts", import.meta.url).pathname,
    "mcp",
    ...args,
  ])
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

test("an agent that leaves at once still hears what answers at folio's address before it leaves", async () => {
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
      "folio mcp reading the folio at http://localhost:1/",
      "nothing answers there yet",
      "the agent left",
    ],
  )
})

test("a program on folio's address that is no folio gets the same answer as no program at all", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-mcp-"))
  const socket = path.join(dir, "other.sock")
  const other = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end("<h1>Welcome</h1>")
  })
  await new Promise<void>((resolve) => other.listen(socket, resolve))

  try {
    const [reply] = await exchange(
      ["--socket", socket],
      [{ method: "tools/call", params: { name: "folio_health", arguments: {} } }],
    )
    const { content, isError } = reply.result as { content: { text: string }[]; isError: boolean }
    assert.equal(isError, true)
    assert.match(
      content[0].text,
      /^No folio answers on .*other\.sock \(what answers there is no folio\)\./,
    )
  } finally {
    other.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("given no port or socket, folio mcp reads the folio serving the nearest folder at or above one of the agent's roots, says which, and finds it again once it moves", async () => {
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
    assert.ok(instructions.length <= 2048, `${instructions.length} characters`)
    assert.match(
      instructions,
      /reads the folio serving the nearest folder at or above one of your roots, or the folder it started in, else the folio at http:\/\/localhost:8640\//,
    )
    assert.deepEqual(agent.said(), [
      "folio mcp reading the folio serving the agent's folder",
      `found the folio at http://localhost:${stands[1].port}/`,
      `that folio serves ${other}`,
      "Root Agent 1 connected",
      `found the folio at http://localhost:${stands[0].port}/`,
      `that folio serves ${notes}`,
      `found the folio at http://localhost:${stands[2].port}/`,
      `that folio serves ${plans}`,
      `found the folio at http://localhost:${stands[3].port}/`,
      `that folio serves ${plans}`,
      "Root Agent 1 left",
    ])
  } finally {
    await agent.end()
    await Promise.all(stands.map((stand) => stand.close()))
  }
})

test("a client naming no roots: the folder folio mcp started in; a folio killed without stopping, or no folio, leaves 8640", async () => {
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
      `found the folio at http://localhost:${stands[0].port}/`,
      `that folio serves ${notes}`,
    ])
    assert.equal(
      unserved.said()[1],
      `no folio serves ${gone} or a folder above it; reading the folio at http://localhost:8640/`,
    )
    assert.equal(stands[1].asked.length, 0, "the dead folio's port is never asked")
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
