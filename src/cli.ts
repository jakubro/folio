#!/usr/bin/env node
/** Entry point of the folio command. */

import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { HELP, parseOptions } from "./server/args.ts"
import { check } from "./server/check.ts"
import { Data } from "./server/data.ts"
import { documentsOf } from "./server/documents.ts"
import { Hub } from "./server/events.ts"
import { healthOf } from "./server/health.ts"
import { createHandler, type Log, listen, listenFree } from "./server/http.ts"
import { impactOf } from "./server/impact.ts"
import { Indexer } from "./server/indexer.ts"
import { lsp } from "./server/lsp.ts"
import { mcp } from "./server/mcp.ts"
import { Model, modelStore } from "./server/model.ts"
import { savedOf } from "./server/saved.ts"
import { recordServing, servingAt } from "./server/serving.ts"
import { listenSocket } from "./server/socket.ts"
import { helpText, painter, reading, terminal } from "./server/terminal.ts"

let options: ReturnType<typeof parseOptions>
let root: string

try {
  options = parseOptions(process.argv.slice(2))
} catch (error) {
  fail((error as Error).message, 2)
}

if (options.command === "help") {
  process.stdout.write(helpText(HELP[options.topic], process.stdout))
  process.exit(0)
}

if (options.command === "version") {
  console.log(`folio ${version()}`)
  process.exit(0)
}

if (options.command === "mcp") {
  const given = options.portGiven || options.socket ? options : undefined
  await mcp(given, version(), terminal(process.stderr, false).log)
  process.exit(0)
}

try {
  root = fs.existsSync(options.folder) ? fs.realpathSync(options.folder) : ""

  if (!root || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a folder: ${options.folder}`)
  }
} catch (error) {
  fail((error as Error).message, 2)
}

/** A model of the folder in this process alone, from the store a folio serving it keeps. */
const standalone = (folder: string, log: Log = () => {}) => {
  const indexer = new Indexer(new URL("./index-worker.js", import.meta.url))
  const store = modelStore(folder)
  const model = new Model(folder, store, indexer, log)
  const data = new Data(folder, store)
  data.useBlocks((file, text) => model.blocksReady(file, text))
  data.useDocuments(documentsOf(model))
  return {
    indexer,
    model,
    data,
    close: async () => {
      model.close()
      await Promise.all([indexer.close(), data.close()])
    },
  }
}

if (options.command === "check") {
  const { progress } = terminal(process.stdout, false)
  const reach = options.portGiven || options.socket ? options : (servingAt(root) ?? options)
  process.exit(await check(root, reach, standalone, (line) => console.log(line), progress))
}

if (options.command === "lsp") {
  const output = terminal(process.stderr, false)
  // The model's one info line is its reading summary, which lsp says as its ready line instead.
  const { indexer, model, data, close } = standalone(root, (line, level) => {
    if (level !== "info") {
      output.log(line, level)
    }
  })
  await lsp(root, model, data, indexer, output)
  await close()
  process.exit(0)
}

const output = terminal(process.stdout, options.command === "serve" && options.verbose === true)
const { log } = output
const build = createHash("sha1")
  .update(fs.readFileSync(path.join(import.meta.dirname, "page.js")))
  .digest("hex")
  .slice(0, 16)
const hub = new Hub(root, build, log)
const indexer = new Indexer(new URL("./index-worker.js", import.meta.url))
const store = modelStore(root)
const model = new Model(root, store, indexer, log)
const data = new Data(root, store)
data.useBlocks((file, text) => model.blocksReady(file, text))
data.useDocuments(documentsOf(model))
hub.follow(model)
hub.read(data)
const sockets = options.command === "serve" ? (options.sockets ?? []) : []
const handler = createHandler(root, import.meta.dirname, build, model, data, log)
/** A view's state lives in the page's address, which the default 16 KB header limit cuts short. */
const server = http.createServer({ maxHeaderSize: 1 << 20 }, handler)
hub.attach(server)

let port: number

try {
  port =
    options.command === "serve" && !options.portGiven
      ? await listenFree(server, options.port, root)
      : await listen(server, options.port)

  for (const socket of sockets) {
    await listenSocket(http.createServer({ maxHeaderSize: 1 << 20 }, handler), socket)
  }
} catch (error) {
  fail((error as Error).message, 1)
}

const paint = painter(process.stdout)
console.log(`${paint("bold", "folio")} serving ${root}`)
console.log(`  at ${paint("cyan", `http://localhost:${port}/`)}${taken(options.port, port)}`)

for (const socket of sockets) {
  console.log(`  and on ${socket}`)
}

try {
  recordServing(store, port)
} catch (error) {
  log(`folio check and folio mcp cannot find this folio: ${(error as Error).message}`, "warning")
}

output.progress(() => reading(model))

model
  .start()
  .finally(() => output.progress(undefined))
  .then(() => {
    savedOf(model, data).start()
    return impactOf(model, data).refresh()
  })
  .catch((error: Error) => log(`model: ${error.message}`))

// A read recorded a moment before folio stops, and health worked out, are written before it exits.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void Promise.all([model.reads.flush(), healthOf(model, data).flush()]).finally(() =>
      process.exit(code),
    )
  })
}

function fail(message: string, code: number): never {
  const [first, ...rest] = message.split("\n")
  console.error([painter(process.stderr)("red", first), ...rest].join("\n"))
  process.exit(code)
}

function taken(asked: number, bound: number): string {
  if (bound === asked) {
    return ""
  }

  return bound === asked + 1
    ? ` - port ${asked} is taken`
    : ` - ports ${asked} to ${bound - 1} are taken`
}

/** Read only when asked: a build run from a copy of `dist/` alone has no package beside it. */
function version(): string {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"))
    .version
}
