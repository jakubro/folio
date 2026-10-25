/** An MCP server on standard input and output whose tools read a running folio's model API. */

import http from "node:http";
import readline from "node:readline";
import { RESOURCES } from "./api.ts";

export interface Reach {
  port: number;
  socket?: string;
}

interface Tool {
  resource: keyof typeof RESOURCES;
  at: "path" | "folder" | "root";
  query: Record<string, string>;
  required: string[];
}

/** The MCP versions whose messages for everything folio uses are alike, newest first. */
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PATH = "A path in the served folder, as its address names it";
const FOLDER =
  "A folder of the served folder, as its address names it; the whole folder by default";
const TOOLS: Record<string, Tool> = {
  folio_documents: { resource: "documents", at: "folder", query: {}, required: [] },
  folio_document: { resource: "document", at: "path", query: {}, required: ["path"] },
  folio_provenance: {
    resource: "provenance",
    at: "path",
    query: {
      block: "The block's id",
      source: "The file the block comes from, when an include brought it",
    },
    required: ["path", "block"],
  },
  folio_query: {
    resource: "query",
    at: "folder",
    query: {
      sql: "One SELECT; data files are named in quotes, documents are folio.<table> and kind.<name>",
    },
    required: ["sql"],
  },
  folio_embed: {
    resource: "embed",
    at: "path",
    query: {
      reference:
        "A reference as a document writes it: a data file, a part of it, a .sql file or #query",
    },
    required: ["path", "reference"],
  },
  folio_kinds: { resource: "kinds", at: "path", query: {}, required: [] },
  folio_health: { resource: "health", at: "root", query: {}, required: [] },
  folio_changes: { resource: "changes", at: "root", query: {}, required: [] },
  folio_needs: { resource: "needs", at: "root", query: {}, required: [] },
  folio_presence: { resource: "presence", at: "root", query: {}, required: [] },
  folio_stale: { resource: "stale", at: "root", query: {}, required: [] },
  folio_reads: { resource: "reads", at: "path", query: {}, required: [] },
  folio_history: {
    resource: "history",
    at: "path",
    query: {
      version: "A version's id, for its text",
      block: "A block's id, for each text it has had",
      reference: "An embed's reference, for each result it has shown",
    },
    required: ["path"],
  },
  folio_used_by: { resource: "used-by", at: "path", query: {}, required: ["path"] },
  folio_digest: {
    resource: "digest",
    at: "root",
    query: {
      from: "Start of the period, in milliseconds",
      to: "End of the period, in milliseconds",
    },
    required: [],
  },
};

export async function mcp(reach: Reach, version: string): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const work = answer(line, reach, version)
      .catch((error: Error) => ({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: `Internal error: ${error.message}` },
      }))
      .then((reply) => {
        if (reply) {
          process.stdout.write(`${JSON.stringify(reply)}\n`);
        }
      });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }

  await Promise.all(pending);
}

/** A batch, which MCP 2025-03-26 has a server take, is answered with the replies to its requests. */
async function answer(line: string, reach: Reach, version: string): Promise<unknown> {
  let message: unknown;

  try {
    message = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }

  if (!Array.isArray(message)) {
    return reply(message, reach, version);
  }

  if (message.length === 0) {
    return invalid(null, "a batch holds at least one message");
  }

  const replies = (await Promise.all(message.map((one) => reply(one, reach, version)))).filter(
    (one) => one !== undefined,
  );
  return replies.length > 0 ? replies : undefined;
}

async function reply(message: unknown, reach: Reach, version: string): Promise<object | undefined> {
  if (!isObject(message)) {
    return invalid(null, "a message is a JSON object");
  }

  const { jsonrpc, id = null, method, params = {} } = message;

  // A reply to a request folio never sent needs no answer.
  if (
    typeof method !== "string" &&
    message.id !== undefined &&
    ("result" in message || "error" in message)
  ) {
    return undefined;
  }

  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return invalid(id, 'a request carries jsonrpc "2.0" and a method');
  }

  if (message.id === undefined) {
    return undefined;
  }

  if (!isObject(params) || (params.arguments !== undefined && !isObject(params.arguments))) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Invalid params: params and its arguments are objects." },
    };
  }

  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });

  try {
    switch (method) {
      case "initialize":
        return result({
          protocolVersion:
            PROTOCOLS.find((known) => known === params.protocolVersion) ?? PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "folio", version },
          instructions:
            "folio's model of one folder of markdown and data: documents and their blocks, queries over data and documents, health, what changed, history and what the reader has read. Every tool only reads.",
        });
      case "ping":
        return result({});
      case "tools/list":
        return result({ tools: Object.entries(TOOLS).map(([name, tool]) => describe(name, tool)) });
      case "tools/call":
        return result(
          await call(
            reach,
            String(params.name),
            (params.arguments ?? {}) as Record<string, unknown>,
          ),
        );
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `No method ${method}` } };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Internal error: ${(error as Error).message}` },
    };
  }
}

function invalid(id: unknown, why: string): object {
  return { jsonrpc: "2.0", id, error: { code: -32600, message: `Invalid Request: ${why}.` } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(name: string, tool: Tool): object {
  const properties: Record<string, object> =
    tool.at === "root"
      ? {}
      : { [tool.at]: { type: "string", description: tool.at === "path" ? PATH : FOLDER } };

  for (const [param, description] of Object.entries(tool.query)) {
    properties[param] = { type: "string", description };
  }

  return {
    name,
    description: RESOURCES[tool.resource].answers,
    inputSchema: { type: "object", properties, required: tool.required },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

async function call(reach: Reach, name: string, args: Record<string, unknown>): Promise<object> {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;

  if (!tool) {
    return failed(`No tool is named ${name}.`);
  }

  const missing = tool.required.find((key) => typeof args[key] !== "string" || !args[key]);

  if (missing) {
    return failed(`${name} needs ${missing}.`);
  }

  const at = String((tool.at === "root" ? "" : args[tool.at]) ?? "").replace(/^\/+/, "");
  const query = new URLSearchParams({ api: tool.resource });

  for (const param of Object.keys(tool.query)) {
    if (typeof args[param] === "string" && args[param]) {
      query.set(param, args[param] as string);
    }
  }

  const address = `/${at.split("/").map(encodeURIComponent).join("/")}${tool.at === "folder" && at && !at.endsWith("/") ? "/" : ""}?${query}`;

  try {
    const { status, body } = await get(reach, address);
    return status === 200
      ? { content: [{ type: "text", text: body }] }
      : failed(body.trim() || `folio answered ${status}.`);
  } catch (error) {
    return failed(`folio cannot be reached: ${(error as Error).message}`);
  }
}

function failed(text: string): object {
  return { content: [{ type: "text", text }], isError: true };
}

function get(reach: Reach, address: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        ...(reach.socket ? { socketPath: reach.socket } : { host: "127.0.0.1", port: reach.port }),
        path: address,
        headers: { host: "localhost" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
  });
}
