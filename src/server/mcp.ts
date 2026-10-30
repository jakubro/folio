/** An MCP server on standard input and output whose tools read a running folio's model API. */

import fs from "node:fs"
import http from "node:http"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import type { RESOURCES } from "./api.ts"
import { DEFAULT_PORT } from "./args.ts"
import { addressOf, ask } from "./check.ts"
import type { Log } from "./http.ts"
import { servingAbove } from "./serving.ts"
import { clientName, painter } from "./terminal.ts"

export interface Reach {
  port: number
  socket?: string
}

interface Located {
  reach: Reach
  unserved?: string[]
}

interface Session {
  version: string
  given: boolean
  located: Located
  connected(client: unknown, capabilities: unknown): void
  notified(method: string): void
  replied(id: unknown, result: unknown): void
  watch(): Promise<void>
}

/** The tool as `tools/list` sends it, but for `resource` and `at`, which are folio's own and never sent. */
interface Tool {
  name: string
  title: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, object>
    required: string[]
    additionalProperties: false
  }
  annotations: {
    readOnlyHint: true
    destructiveHint: false
    idempotentHint: true
    openWorldHint: false
  }
  resource: keyof typeof RESOURCES
  at: "path" | "folder" | "root"
}

/** The MCP versions whose messages for everything folio uses are alike, newest first. */
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
const ROOTS_MS = 1000
const TOOLS: Tool[] = [
  {
    name: "folio_documents",
    title: "List the folder's documents",
    description:
      "List every markdown and diagram document under a folder of the served folder, with the kind a FOLIO.md declaration gives it. Use it to see what exists or which documents are of a kind; for documents matching a condition - a title, a field's value, a link - query folio.documents or kind.<name> with folio_query, and for one document's blocks use folio_document. Answers {ready, documents: [{path, kind}]}: kind is null where no declaration places the document; ready false means folio is still reading the folder and the list is incomplete, so ask again shortly.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description:
            "A folder relative to the served folder, such as notes/; omit for the whole folder",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "documents",
    at: "folder",
  },
  {
    name: "folio_document",
    title: "Read a document's blocks",
    description:
      "Read one document as folio's model holds it: its blocks with their ids, the blocks its page shows once includes are expanded, its declared kind and fields, and the data files it reads. Call it for the block ids that folio_provenance and folio_history take and that a link to a block names - an id is 8 hex characters folio derives, never invented - and to see what a page is made of; read the file itself for its full text. Answers {path, kind: markdown or mermaid, blocks: [{id, kind, lines: [first, last] from 1, text: its first 100 characters}], page: [{id, kind, source: the file the block comes from, lines, at: its lines in the expanded page, version}], conventions: {declarations, kind, declaredIn, fields}, data: [paths]}. A document folio has not read yet is an error: ask again shortly.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "The document's path relative to the served folder, such as notes/plan.md",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "document",
    at: "path",
  },
  {
    name: "folio_provenance",
    title: "Trace where a block came from",
    description:
      "Trace one block of a page to its origin: the file and lines it comes from, when it last changed, the data files and queries behind its embedded tables and values with when each changed, and each figure in it checked against its data. Use it to explain why a number or table reads as it does, or whether a figure still matches its data; take the block's id - and, for a block an include brings, its source - from folio_document's page. For every problem in the folder at once use folio_health. An id not on the page is an error. Answers {source, kind, lines: [first, last], changed: ISO time, included: {section} for an included block, data: [{reference, files: [{path, changed}], query, error}], claims: [{figure, reference, state: matching, contradicted or unchecked, live: the data's value, reason, deliberate: true when left unchecked by choice, as a range is}], conventions}.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "The page's path relative to the served folder, such as notes/plan.md",
        },
        block: {
          type: "string",
          minLength: 1,
          description: "The block's id, 8 hex characters, as folio_document lists it",
        },
        source: {
          type: "string",
          description:
            "The file the block's text comes from when an include brings it onto the page, as folio_document's page names it; omit for the page's own blocks",
        },
      },
      required: ["path", "block"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "provenance",
    at: "path",
  },
  {
    name: "folio_query",
    title: "Run a SQL query over the folder",
    description:
      "Run one read-only DuckDB SELECT over the served folder's data files and its documents as tables, and return the rows. Use it for any question data answers - counts, filters, joins across CSV, JSON, Parquet, SQLite or DuckDB files - and for questions about documents as data: what links to a page (folio.links where target is its path), open tasks, documents of a kind by a field. To read what one reference written in a document shows, use folio_embed. Anything but one SELECT, a path outside the folder and a web address are refused; a query stops after 10 seconds. Answers {columns: [{name, type}], rows, total: the row count, absent when rows were cut, partial: true when rows were cut, files: the data files read}: rows stop at 5,000 or 16 MB, and a long cell is cut at 20,000 characters, fewer when there are more than 10 columns.",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          minLength: 1,
          description:
            "One SELECT. A data file is a table named by its path in single quotes, relative to folder: 'data/daily.csv', 'archive.sqlite#readings', or 'queries/q.sql' for a query file's result; * and ** patterns read many files at once. Documents are folio.documents(path, filename: the name without its folder, title: the one h1, kind), folio.headings(path, line, level, text, anchor), folio.links(path, line, url, target, fragment, context), folio.tasks(path, line, done, text), folio.frontmatter(path, key, value), folio.tables(path, line, row, header, cells), and kind.<name>(path and a column per field the kind declares)",
        },
        folder: {
          type: "string",
          description:
            "The folder the query runs from, relative to the served folder, such as reports/; quoted paths resolve against it. Omit for the served folder",
        },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "query",
    at: "folder",
  },
  {
    name: "folio_embed",
    title: "Resolve a reference a document writes",
    description:
      "Resolve one data reference as a document writes it in {table: ...}, {value: ...}, a figure or a chart, from that document's folder, and return what it shows there. Use it to check a reference before writing it into a document, or to read the value a page shows; for a question of your own over the data use folio_query. Answers {version, grid: {columns, rows, total, partial} for a table, value: for a reference naming one value, error: why the reference resolves to nothing}.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "The document whose folder the reference resolves from, relative to the served folder, such as reports/weekly.md",
        },
        reference: {
          type: "string",
          minLength: 1,
          description:
            "The reference as written: a data file relative to the document (data/daily.csv), a part of it after # (data/daily.csv#0.rain_mm, archive.sqlite#readings), a .sql file, or #name for a query fenced in the document (#totals, #totals#0.rain_mm)",
        },
      },
      required: ["path", "reference"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "embed",
    at: "path",
  },
  {
    name: "folio_kinds",
    title: "Read the declared kinds and rules",
    description:
      "Read what the FOLIO.md declarations applying at a path declare: the kinds of documents with the fields each carries, the rules - queries whose every row is a violation - and the health entries, layered from the served folder down as folio applies them. Use it before writing a document of a kind, to learn its fields and the rules it must keep; for one document's own kind and field values use folio_document, and for the rules broken now folio_health. Answers {declarations: [FOLIO.md paths, outermost first], kinds: [{name, declaredIn, where, fields}], rules: [{name, declaredIn, query, message, severity, line and block: where it is declared}], health: [{declaredIn, where, skip, error}]}, every list empty where nothing is declared.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "A document relative to the served folder, such as notes/plan.md, or a folder ending in /, such as notes/; omit for the served folder itself",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "kinds",
    at: "path",
  },
  {
    name: "folio_health",
    title: "List everything wrong in the folder",
    description:
      "List every problem in the served folder: links to files, headings or blocks not there, includes that find nothing and include loops, figures their data contradicts, diagrams, charts and queries that fail, data that cannot be read, and declarations, fields, rules and saved views a document breaks. Use it after editing documents, to answer which figures disagree with their data, or to find what to fix; for one block's figures in detail use folio_provenance, and for what needs the reader, ranked, folio_needs. It reveals nothing of the reader's reading, and waits while health is being checked. Answers {ready, problems: [{kind: figure, link, include, loop, diagram, chart, query, data, declaration, field, rule or view, path, line, block, severity: error or warning - absent for a problem that is neither, what, anchor: the element to land on, opens: the document showing it when another, occurrence: which of a rule's alike rows}], version: the same while the problems are}; ready false means folio is still reading the folder, so ask again shortly.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "health",
    at: "root",
  },
  {
    name: "folio_changes",
    title: "List what changed since the reader read it",
    description:
      "List the documents the reader has read before whose blocks changed since they last read them, newest change first - what they have to catch up on. Use it for what changed for the reader; for every change in the folder over a period, read or not, use folio_digest, and for the marks on one page folio_reads with its path. It reveals which documents the reader has read. While the reader pauses sharing in folio, it answers only {paused: true, message}. Answers {documents: [{path, blocks: how many changed, at: ISO time of the latest change}], version: the same while the list is}.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "changes",
    at: "root",
  },
  {
    name: "folio_needs",
    title: "List what needs the reader",
    description:
      "List what needs the reader's attention, ranked: every error in the folder, then problems in documents they have read, rows of the folder's declared attention queries, and documents they read that changed since. Use it to triage what to look at first; for every problem whoever reads it use folio_health, and for only the documents changed since read folio_changes. It reveals what the reader has read. While the reader pauses sharing in folio, it answers only {paused: true, message}. Answers {ready, needs: [{source: error, problem, attention or changed, path, line, block, what, name: the attention query's, at}], version: the same while the list is}; ready false, with no needs, while folio still reads the folder.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "needs",
    at: "root",
  },
  {
    name: "folio_presence",
    title: "See what the reader is looking at",
    description:
      "Show what the reader is looking at now: the page open in each browser tab and the block under their pointer with the start of its text, the most recent first. Use it when the reader means what is on their screen - this page, this paragraph; for what they read before use folio_reads. It reveals the reader's screen; a hidden tab shows nothing. While the reader pauses sharing in folio, it answers only {paused: true, message}. Answers {paused: false, looking: [{page, block: {source, id, text}, at: ISO time}]}.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "presence",
    at: "root",
  },
  {
    name: "folio_stale",
    title: "List documents that outlived their use",
    description:
      "List documents that have probably outlived their use - by default unchanged for a year, never read and linked from nowhere, or what the folder's declared stale query names - each with when its file last changed and why. Use it to suggest what to archive; folio only lists them and never moves or deletes anything. For documents the reader should catch up on use folio_changes instead, and for everything wrong in the folder folio_health. It reveals which documents the reader never read. While the reader pauses sharing in folio, it answers only {paused: true, message}. Answers {ready, documents: [{path, changed: ISO time, why}], version: the same while the list is}; ready false, with no documents, while folio still reads the folder.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "stale",
    at: "root",
  },
  {
    name: "folio_reads",
    title: "Read what the reader has read",
    description:
      "Read the reader's read record. For a folder, or with no path, every document read under it and when it was last read; for a document, each block with the version the reader read and when, and the marks its page shows. Use it to tell whether the reader has seen a passage or what is new to them on a page; for the list of documents changed since read use folio_changes. It reveals the reader's reading. While the reader pauses sharing in folio, it answers only {paused: true, message}. Answers {documents: [{path, at: ISO time}]} for a folder, or for a document {blocks: [{id, kind, source, lines, version, read: {version, at: ISO time} or null}], marks: [{source, id, mark: new or changed, before and after: the text as read and as it is, data: embeds whose data changed - a mark from data alone has no before or after, at: milliseconds, parts: the rows, items or lines marked in a table, list or code block}], removed: [{source, id, text, after and before: the ids it stood between, at: milliseconds}], links: [{source, id, url, state: changed or gone}], upstream: [{path, how, at}], version}.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "A document relative to the served folder, such as notes/plan.md, or a folder ending in /; omit for every document read",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "reads",
    at: "path",
  },
  {
    name: "folio_history",
    title: "Read a document's history",
    description:
      "Read a document's versions, newest first, merged from its git commits and every save folio saw - a document since deleted included. With version, that version's full text; with block, each text the block has had; with reference, each result that embed has shown. Use it to answer how a passage or a value changed and when; for everything that changed in the folder over a period use folio_digest. Give at most one of version, block and reference. Answers {path, versions: [{id, at: milliseconds, seen: a list of saved, committed and file, by: the commit's author, removed}]}, {path, version, text: null when unknown}, {path, block, versions: [{version, at, text: absent where the block was not there}]} or {path, reference, results: [{at, value or table, error}]}.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "The document's path relative to the served folder, such as notes/plan.md, also one since deleted",
        },
        version: {
          type: "string",
          description: "A version's id from this tool's versions, for that version's text",
        },
        block: {
          type: "string",
          description: "A block's id as folio_document lists it, for each text the block has had",
        },
        reference: {
          type: "string",
          description:
            "An embed's reference as the document writes it, such as #totals#0.n, for each result it has shown",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "history",
    at: "path",
  },
  {
    name: "folio_used_by",
    title: "List the documents a file feeds",
    description:
      "List the documents that include a file or whose embeds and queries read it - the pages a change to it moves. Use it before editing, moving or deleting a document, data file or query file; it does not list links, so for what links to a document query folio.links with folio_query. Answers {ready, documents: [{source, how: includes or embeds}]}; ready false, with no documents, while folio still reads the folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "The file's path relative to the served folder: a document, data file or .sql file, such as data/daily.csv",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "used-by",
    at: "path",
  },
  {
    name: "folio_digest",
    title: "Summarize what changed in a period",
    description:
      "Summarize what changed in the served folder over a period: every document created, changed or removed, with the versions it started and ended on, and every embedded value that moved, before and after. Use it for what changed this week or since a date across the whole folder, read or not; for what changed of what the reader read use folio_changes, and for one document's versions folio_history. Answers {from, to, documents: [{path, status: created, changed or removed, from, to: version ids folio_history takes}], values: [{document, reference, before, after, at}]}, times in milliseconds.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "integer",
          minimum: 0,
          description:
            "The period's start in milliseconds since 1970-01-01 UTC; default a day before to",
        },
        to: {
          type: "integer",
          minimum: 0,
          description: "The period's end in milliseconds since 1970-01-01 UTC; default now",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resource: "digest",
    at: "root",
  },
]

/** Read the folio at `given`, else the one serving the agent's folder, found anew for each call. */
export async function mcp(given: Reach | undefined, version: string, log: Log): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin })
  const pending = new Set<Promise<void>>()
  const asked = new Map<number, () => void>()
  let asks = 0
  let agent = "the agent"
  let listsRoots = false
  let roots: string[] = []
  let rooting = Promise.resolve()
  let said: string | undefined
  let serving: string | null | undefined
  let watching = Promise.resolve()
  const locate = (): Located => {
    if (given) {
      return { reach: given }
    }

    const folders = roots.length > 0 ? roots : [fs.realpathSync(process.cwd())]

    for (const folder of folders) {
      const found = servingAbove(folder)

      if (found) {
        return { reach: found.reach }
      }
    }

    return { reach: { port: DEFAULT_PORT }, unserved: folders }
  }
  const look = async () => {
    const located = locate()
    session.located = located

    if (!given) {
      const line = located.unserved
        ? `${unserved(located.unserved)}; reading the folio ${addressOf(located.reach)}`
        : `found the folio ${addressOf(located.reach)}`

      if (line !== said) {
        log(line, "info")
        said = line
        serving = undefined
      }
    }

    const index = (await ask(located.reach, "/?api").catch(() => undefined)) as { root?: unknown }
    const now = typeof index?.root === "string" ? index.root : null

    if (now !== serving) {
      log(change(serving, now), "info")
      serving = now
    }
  }
  const askRoots = () => {
    if (given || !listsRoots) {
      return
    }

    const id = ++asks
    rooting = new Promise((resolve) => {
      setTimeout(resolve, ROOTS_MS)
      asked.set(id, resolve)
    })
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "roots/list" })}\n`)
  }
  const session: Session = {
    version,
    given: given !== undefined,
    located: { reach: given ?? { port: DEFAULT_PORT } },
    connected: (client, capabilities) => {
      const named = clientName(client)
      agent = named ?? agent
      listsRoots = isObject(capabilities) && isObject(capabilities.roots)
      log(`${named ?? "an agent"} connected`, "info")
    },
    notified: (method) => {
      if (method === "notifications/initialized" || method === "notifications/roots/list_changed") {
        askRoots()
      }
    },
    replied: (id, result) => {
      const answered = asked.get(id as number)

      if (answered) {
        asked.delete(id as number)
        roots = foldersOf(result)
        answered()
      }
    },
    watch: () => {
      watching = watching.then(() => rooting).then(look)
      return watching
    },
  }

  console.error(
    `${painter(process.stderr)("bold", "folio mcp")} reading the folio ${given ? addressOf(given) : "serving the agent's folder"}`,
  )
  void session.watch()

  for await (const line of lines) {
    if (!line.trim()) {
      continue
    }

    const work = answer(line, session)
      .catch((error: Error) => ({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: `Internal error: ${error.message}` },
      }))
      .then((reply) => {
        if (reply) {
          process.stdout.write(`${JSON.stringify(reply)}\n`)
        }
      })
    pending.add(work)
    void work.finally(() => pending.delete(work))
  }

  await Promise.all(pending)
  await watching
  log(`${agent} left`, "info")
}

/** A batch, which MCP 2025-03-26 has a server take, is answered with the replies to its requests. */
async function answer(line: string, session: Session): Promise<unknown> {
  let message: unknown

  try {
    message = JSON.parse(line)
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
  }

  if (!Array.isArray(message)) {
    return reply(message, session)
  }

  if (message.length === 0) {
    return invalid(null, "a batch holds at least one message")
  }

  const replies = (await Promise.all(message.map((one) => reply(one, session)))).filter(
    (one) => one !== undefined,
  )
  return replies.length > 0 ? replies : undefined
}

async function reply(message: unknown, session: Session): Promise<object | undefined> {
  if (!isObject(message)) {
    return invalid(null, "a message is a JSON object")
  }

  const { jsonrpc, id = null, method, params = {} } = message

  // A reply needs no answer; one to folio's own request names the agent's roots.
  if (
    typeof method !== "string" &&
    message.id !== undefined &&
    ("result" in message || "error" in message)
  ) {
    session.replied(message.id, message.result)
    return undefined
  }

  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return invalid(id, 'a request carries jsonrpc "2.0" and a method')
  }

  if (message.id === undefined) {
    session.notified(method)
    return undefined
  }

  if (!isObject(params) || (params.arguments !== undefined && !isObject(params.arguments))) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Invalid params: params and its arguments are objects." },
    }
  }

  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value })

  try {
    switch (method) {
      case "initialize":
        session.connected(params.clientInfo, params.capabilities)
        return result({
          protocolVersion:
            PROTOCOLS.find((known) => known === params.protocolVersion) ?? PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "folio", version: session.version },
          instructions: instructions(session),
        })
      case "ping":
        return result({})
      case "tools/list":
        return result({ tools: TOOLS.map(describe) })
      case "tools/call":
        await session.watch()
        return result(
          await call(
            session.located,
            String(params.name),
            (params.arguments ?? {}) as Record<string, unknown>,
          ),
        )
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `No method ${method}` } }
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Internal error: ${(error as Error).message}` },
    }
  }
}

function invalid(id: unknown, why: string): object {
  return { jsonrpc: "2.0", id, error: { code: -32600, message: `Invalid Request: ${why}.` } }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function instructions({ given, located }: Session): string {
  const read = given
    ? `the folio ${addressOf(located.reach)} (--port or --socket chooses)`
    : `the folio serving the nearest folder at or above one of your roots, or the folder it started in, else the folio at http://localhost:${DEFAULT_PORT}/ (--port or --socket chooses one instead)`

  return [
    "folio keeps a model of one folder of markdown and data files that it serves to a reader's browser. These tools read that model and change nothing.",
    `A folio must already be serving the folder: started as \`folio FOLDER\`, it serves on http://localhost:${DEFAULT_PORT}/ or the next free port, and this server reads ${read}. With none there, every call fails and says how to start one. While folio still reads the folder, an answer carries ready: false - ask again shortly.`,
    "Paths are relative to the served folder, with forward slashes: notes/plan.md.",
    [
      "Which tool answers what:",
      "- What documents exist, and of which kind: folio_documents.",
      "- What a document is made of, and its block ids, which other tools take: folio_document.",
      "- Where a block, value or figure comes from: folio_provenance.",
      "- Questions over data files, or over documents as tables - what links to a page, open tasks, fields: folio_query. What one reference in a document shows: folio_embed.",
      "- The kinds, fields and rules declared at a path: folio_kinds.",
      "- Everything wrong - broken links, failing queries, figures their data contradicts: folio_health.",
      "- What a change to a file would move: folio_used_by.",
      "- What changed in a period: folio_digest. A document's earlier versions: folio_history.",
      "- The reader: what they look at now (folio_presence), have read (folio_reads), read that changed since (folio_changes), what needs them (folio_needs), what has outlived its use (folio_stale). These five reveal the reader's reading; while the reader pauses sharing in folio, they answer only {paused: true, message}.",
    ].join("\n"),
  ].join("\n\n")
}

function describe({ resource, at, ...tool }: Tool): object {
  return { ...tool, annotations: { title: tool.title, ...tool.annotations } }
}

async function call(
  { reach, unserved: folders }: Located,
  name: string,
  args: Record<string, unknown>,
): Promise<object> {
  const tool = TOOLS.find((one) => one.name === name)

  if (!tool) {
    return failed(`No tool is named ${name}.`)
  }

  const missing = tool.inputSchema.required.find((key) => !given(args[key]))

  if (missing) {
    return failed(`${name} needs ${missing}.`)
  }

  const at = String((tool.at === "root" ? "" : args[tool.at]) ?? "").replace(/^\/+/, "")
  const query = new URLSearchParams({ api: tool.resource })

  for (const [param, value] of Object.entries(args)) {
    if (param !== tool.at && Object.hasOwn(tool.inputSchema.properties, param) && given(value)) {
      query.set(param, String(value))
    }
  }

  const address = `/${at.split("/").map(encodeURIComponent).join("/")}${tool.at === "folder" && at && !at.endsWith("/") ? "/" : ""}?${query}`

  try {
    const { status, type, body } = await get(reach, address)

    if (status === 200 && !type.startsWith("application/json")) {
      throw new Error("what answers there is no folio")
    }

    return status === 200
      ? { content: [{ type: "text", text: body }] }
      : failed(body.trim() || `folio answered ${status}.`)
  } catch (error) {
    const none = folders
      ? `${capitalized(unserved(folders))}, and none answers`
      : "No folio answers"
    return failed(
      `${none} ${addressOf(reach)} (${(error as Error).message}). These tools read a folio serving the folder: start one with \`folio FOLDER\`, then call again. If folio serves on another port or a socket, start folio mcp with --port or --socket to match.`,
    )
  }
}

function given(value: unknown): boolean {
  return (typeof value === "string" && value !== "") || Number.isFinite(value)
}

function failed(text: string): object {
  return { content: [{ type: "text", text }], isError: true }
}

function get(
  reach: Reach,
  address: string,
): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        ...(reach.socket ? { socketPath: reach.socket } : { host: "127.0.0.1", port: reach.port }),
        path: address,
        headers: { host: "localhost" },
      },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          body += chunk
        })
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers["content-type"] ?? "",
            body,
          }),
        )
      },
    )
    request.on("error", reject)
  })
}

/** `null`: nothing answers; `undefined`: not asked yet. */
function change(before: string | null | undefined, now: string | null): string {
  if (now === null) {
    return before === undefined ? "nothing answers there yet" : "that folio stopped answering"
  }

  if (before === undefined) {
    return `that folio serves ${now}`
  }

  return before === null
    ? `a folio answers there now, serving ${now}`
    : `that folio now serves ${now}`
}

function unserved(folders: string[]): string {
  const listed =
    folders.length > 1 ? `${folders.slice(0, -1).join(", ")} or ${folders.at(-1)}` : folders[0]
  return `no folio serves ${listed} or a folder above ${folders.length > 1 ? "them" : "it"}`
}

function capitalized(text: string): string {
  return text[0].toUpperCase() + text.slice(1)
}

function foldersOf(result: unknown): string[] {
  const listed = isObject(result) && Array.isArray(result.roots) ? result.roots : []

  return listed.flatMap((root) => {
    try {
      return [fs.realpathSync(fileURLToPath(root.uri))]
    } catch {
      return []
    }
  })
}
