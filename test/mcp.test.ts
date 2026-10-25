import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";

test("a malformed message gets a JSON-RPC error and the server stays up; a version folio does not speak is not echoed", async () => {
  const server = spawn(process.execPath, [
    new URL("../src/cli.ts", import.meta.url).pathname,
    "mcp",
    "--port",
    "1",
  ]);
  const replies: { id: unknown; result?: Record<string, unknown>; error?: { code: number } }[] = [];
  const batches: unknown[][] = [];
  let heard = "";
  server.stdout.on("data", (chunk) => {
    heard += chunk;
    const lines = heard.split("\n");
    heard = lines.pop() ?? "";

    for (const line of lines.filter(Boolean)) {
      const parsed = JSON.parse(line);

      if (Array.isArray(parsed)) {
        batches.push(parsed);
      }

      replies.push(...[parsed].flat());
    }
  });
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
  ];

  try {
    for (const message of sent) {
      server.stdin.write(
        `${
          typeof message === "string"
            ? message
            : JSON.stringify(Array.isArray(message) ? message : { jsonrpc: "2.0", ...message })
        }\n`,
      );
    }

    for (let tries = 0; replies.length < 13; tries++) {
      assert.ok(tries < 200, `only ${replies.length} replies`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const byId = (id: unknown) => replies.find((reply) => reply.id === id);
    assert.deepEqual(
      replies.filter(({ id }) => id === null).map(({ error }) => error?.code),
      [-32600, -32600, -32600, -32600],
    );
    assert.equal(byId(1)?.error?.code, -32602);
    assert.equal(byId(2)?.error?.code, -32602);
    assert.equal(byId(3)?.result?.protocolVersion, "2025-06-18");
    assert.equal(byId(4)?.result?.protocolVersion, "2025-03-26");
    assert.equal(byId(6)?.error?.code, -32603);
    assert.equal((byId(9)?.result as { isError?: boolean } | undefined)?.isError, true);
    assert.deepEqual(
      batches.map((batch) => (batch as { id: unknown }[]).map(({ id }) => id)),
      [
        [null, null],
        [7, 8],
      ],
    );
    assert.deepEqual(byId(5)?.result, {});
    assert.equal(server.exitCode, null, "the server is still up");

    const reference = fs.readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8");
    assert.match(reference, /It speaks MCP 2025-06-18, and 2025-03-26 or 2024-11-05/);
  } finally {
    server.kill();
  }
});
