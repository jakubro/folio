/** The built command's clients other than the browser: the model API on a socket, and the MCP server. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CLI, ENV, freePort, until, writeIn } from "./harness.ts";

test("Read over HTTP, Read over MCP, Read only: an agent reads the model through folio's MCP server, on its socket", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-clients-")));
  const socket = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-socket-")),
    "folio.sock",
  );
  writeIn(folder, {
    "notes/watch.md": "# Watch\n\nThe pump runs at noon. See [the log](log.md).\n",
    "notes/log.md": "# Log\n\nRan at noon.\n",
    "rates.csv": "arm,pct\nA,0.8\nB,0.6\n",
  });
  const port = await freePort();
  let said = "";
  const server = spawn(
    process.execPath,
    [CLI, folder, "--port", String(port), "--socket", socket, "--socket", `${socket}.2`],
    {
      env: ENV,
    },
  );
  server.stdout?.on("data", (chunk) => {
    said += chunk;
  });
  const client = spawn(process.execPath, [CLI, "mcp", "--socket", socket], { env: ENV });
  const replies = new Map<number, Record<string, unknown>>();
  let heard = "";
  client.stdout?.on("data", (chunk) => {
    heard += chunk;
    const lines = heard.split("\n");
    heard = lines.pop() ?? "";

    for (const line of lines.filter(Boolean)) {
      const reply = JSON.parse(line);
      replies.set(reply.id, reply);
    }
  });
  let next = 0;
  const ask = async (method: string, params: object = {}) => {
    const id = ++next;
    client.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await until(() => replies.has(id));
    return replies.get(id) as { result?: Record<string, unknown>; error?: unknown };
  };
  const tool = async (name: string, args: object) => {
    const { result } = await ask("tools/call", { name, arguments: args });
    const { content, isError } = result as { content: { text: string }[]; isError?: boolean };
    return { text: content[0].text, isError: isError === true };
  };

  try {
    await until(() => said.includes("model:"));
    assert.equal((fs.statSync(socket).mode & 0o777).toString(8), "600");

    const hello = await ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal((hello.result as { serverInfo: { name: string } }).serverInfo.name, "folio");

    const { tools } = (await ask("tools/list")).result as {
      tools: { name: string; annotations: { readOnlyHint: boolean } }[];
    };
    assert.ok(tools.every(({ annotations }) => annotations.readOnlyHint));

    const reference = fs.readFileSync(
      path.join(import.meta.dirname, "../docs/reference.md"),
      "utf8",
    );
    const index = await new Promise<{ resources: Record<string, unknown> }>((resolve, reject) => {
      http
        .get({ socketPath: socket, path: "/?api", headers: { host: "localhost" } }, (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(JSON.parse(body)));
        })
        .on("error", reject);
    });
    assert.deepEqual(
      tools.map(({ name }) => name).filter((name) => !reference.includes(`\`${name}\``)),
      [],
    );
    assert.deepEqual(
      Object.keys(index.resources).filter((name) => !reference.includes(`?api=${name}`)),
      [],
    );

    const document = JSON.parse((await tool("folio_document", { path: "notes/watch.md" })).text);
    assert.deepEqual(
      document.blocks.map(({ kind }: { kind: string }) => kind),
      ["heading", "paragraph"],
    );
    const result = JSON.parse(
      (await tool("folio_query", { sql: "select arm from 'rates.csv' where pct > 0.7" })).text,
    );
    assert.deepEqual(result.rows, [["A"]]);
    const linked = JSON.parse(
      (await tool("folio_query", { sql: "select path, target from folio.links" })).text,
    );
    assert.deepEqual(linked.rows, [["notes/watch.md", "notes/log.md"]]);
    assert.equal(JSON.parse((await tool("folio_health", {})).text).ready, true);

    const refused = await tool("folio_query", { sql: "copy (select 1) to 'out.csv'" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Only one SELECT/);
    assert.equal(fs.existsSync(path.join(folder, "out.csv")), false);
    assert.equal((await tool("folio_document", {})).isError, true);

    const overSocket = await new Promise<number>((resolve, reject) => {
      http
        .get({ socketPath: socket, path: "/?api", headers: { host: "localhost" } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
        .on("error", reject);
    });
    assert.equal(overSocket, 200);
    const overSecond = await new Promise<number>((resolve, reject) => {
      http
        .get(
          { socketPath: `${socket}.2`, path: "/?api", headers: { host: "localhost" } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        )
        .on("error", reject);
    });
    assert.equal(overSecond, 200);
  } finally {
    client.kill();
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }

  assert.equal(fs.existsSync(socket), false, "the socket goes with the server");
});

test("Pass, Fail, Built-in as error, Nothing by default, Running folio, Standalone: folio check prints health and fails on errors", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-check-")));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-check-state-"));
  const env = { ...ENV, XDG_STATE_HOME: state };
  const fence = (body: string) => `\`\`\`yaml folio\n${body}\n\`\`\``;
  const run = (...args: string[]) =>
    new Promise<{ status: number; out: string; ms: number }>((resolve) => {
      const started = Date.now();
      let out = "";
      const child = spawn(process.execPath, [CLI, "check", folder, ...args], { env });
      child.stdout?.on("data", (chunk) => {
        out += chunk;
      });
      child.once("exit", (status) =>
        resolve({ status: status ?? -1, out, ms: Date.now() - started }),
      );
    });
  writeIn(folder, { "notes/a.md": "# A\n\nSee [gone](gone.md).\n", "notes/b.md": "# B\n" });

  try {
    const passing = await run("--port", String(await freePort()));
    assert.equal(passing.status, 0, passing.out);
    assert.match(passing.out, /notes\/a\.md:3 - link Links to notes\/gone\.md, which is not there/);
    assert.match(passing.out, /0 errors, 1 other problem/);

    writeIn(folder, {
      "FOLIO.md": `# Rules\n\n${fence("rules:\n  no-b:\n    message: '{path} is not allowed'\n    query: select path from folio.documents where path = 'notes/b.md'")}\n`,
    });
    const failing = await run();
    assert.equal(failing.status, 1, failing.out);
    assert.match(failing.out, /notes\/b\.md:1 error rule notes\/b\.md is not allowed/);

    writeIn(folder, {
      "FOLIO.md": `# Rules\n\n${fence("health:\n  - where: '**'\n    error: [include]")}\n`,
      "notes/b.md": "# B\n\n{include: missing.md}\n",
    });
    const included = await run();
    assert.equal(included.status, 1, included.out);
    assert.match(
      included.out,
      /notes\/b\.md:3 error include Includes missing\.md, which is not there/,
    );
    assert.match(included.out, /notes\/a\.md:3 - link/);

    const warm = await run();
    assert.equal(warm.out, included.out);

    const port = await freePort();
    let said = "";
    const server = spawn(process.execPath, [CLI, folder, "--port", String(port)], { env });
    server.stdout?.on("data", (chunk) => {
      said += chunk;
    });

    try {
      await until(() => said.includes("model:"));
      const running = await run("--port", String(port));
      assert.equal(running.out, included.out);
      assert.equal(running.status, 1);
      assert.ok(said.includes("GET /?api=health"), "the running folio answered");
    } finally {
      server.kill();
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("Diagnostics, Go to, References, Hover, Rename: folio lsp answers an editor over the protocol", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-lsp-")));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-lsp-state-"));
  writeIn(folder, {
    "a.md": "# Alpha\n\n## Pump section\n\nThe pump runs at noon.\n",
    "b.md": "# B\n\nSee [pump](a.md#pump-section).\n",
    "index.md": "# Index\n\nSee [c](notes/c.md).\n",
    "notes/c.md": "# C\n",
  });
  const server = spawn(process.execPath, [CLI, "lsp", folder], {
    env: { ...ENV, XDG_STATE_HOME: state },
  });
  const replies = new Map<number, { result?: unknown }>();
  const notes: { method: string; params: { uri: string; diagnostics: { message: string }[] } }[] =
    [];
  let buffer = Buffer.alloc(0);
  server.stdout?.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      const head = buffer.indexOf("\r\n\r\n");
      const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, head).toString())?.[1]);

      if (head < 0 || buffer.length < head + 4 + length) {
        return;
      }

      const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString());
      buffer = buffer.subarray(head + 4 + length);

      if (message.id !== undefined && message.method === undefined) {
        replies.set(message.id, message);
      } else if (message.method) {
        notes.push(message);
      }
    }
  });
  const send = (message: object) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    server.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  let next = 0;
  const ask = async (method: string, params: object) => {
    const id = ++next;
    send({ id, method, params });
    await until(() => replies.has(id));
    return replies.get(id)?.result as unknown;
  };
  const uri = (name: string) => pathToFileURL(path.join(folder, name)).href;

  try {
    await ask("initialize", {
      processId: null,
      rootUri: pathToFileURL(folder).href,
      capabilities: {},
    });
    send({ method: "initialized", params: {} });
    send({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: uri("b.md"),
          languageId: "markdown",
          version: 1,
          text: "# B\n\nSee [pump](a.md#pumps).\n",
        },
      },
    });
    await until(() => notes.some(({ params }) => params?.diagnostics?.length > 0));
    assert.deepEqual(
      notes
        .find(({ params }) => params?.diagnostics?.length > 0)
        ?.params.diagnostics.map(({ message }) => message),
      ["Links to a heading not in a.md: #pumps"],
    );

    send({
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: uri("b.md"), version: 2 },
        contentChanges: [{ text: "# B\n\nSee [pump](a.md#pump-section).\n" }],
      },
    });
    const definition = (await ask("textDocument/definition", {
      textDocument: { uri: uri("b.md") },
      position: { line: 2, character: 14 },
    })) as { uri: string; range: { start: { line: number } } };
    assert.equal(definition.uri, uri("a.md"));
    assert.equal(definition.range.start.line, 2);

    send({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: uri("a.md"),
          languageId: "markdown",
          version: 1,
          text: "# Alpha\n\n## Pump section\n\nThe pump runs at noon.\n",
        },
      },
    });
    const found = (await ask("textDocument/references", {
      textDocument: { uri: uri("a.md") },
      position: { line: 2, character: 4 },
      context: { includeDeclaration: false },
    })) as { uri: string }[];
    assert.deepEqual(
      found.map(({ uri: at }) => at),
      [uri("b.md")],
    );
    const shown = (await ask("textDocument/hover", {
      textDocument: { uri: uri("a.md") },
      position: { line: 4, character: 2 },
    })) as { contents: { value: string } };
    assert.match(shown.contents.value, /paragraph\*\*, lines 5-5 of `a\.md`/);

    const renamed = (await ask("textDocument/rename", {
      textDocument: { uri: uri("a.md") },
      position: { line: 2, character: 4 },
      newName: "Pump room",
    })) as { changes: Record<string, { newText: string }[]> };
    assert.deepEqual(
      renamed.changes[uri("b.md")].map(({ newText }) => newText),
      ["a.md#pump-room"],
    );
    assert.deepEqual(
      renamed.changes[uri("a.md")].map(({ newText }) => newText),
      ["Pump room"],
    );

    const moved = (await ask("workspace/willRenameFiles", {
      files: [{ oldUri: uri("a.md"), newUri: uri("old/a.md") }],
    })) as { changes: Record<string, { newText: string }[]> };
    assert.deepEqual(
      moved.changes[uri("b.md")].map(({ newText }) => newText),
      ["old/a.md#pump-section"],
    );
    assert.equal(
      fs.readFileSync(path.join(folder, "b.md"), "utf8"),
      "# B\n\nSee [pump](a.md#pump-section).\n",
    );

    const both = (await ask("workspace/willRenameFiles", {
      files: [
        { oldUri: uri("notes/c.md"), newUri: uri("notes/z.md") },
        { oldUri: uri("notes"), newUri: uri("archive/notes") },
      ],
    })) as { changes: Record<string, { newText: string }[]> };
    assert.deepEqual(
      both.changes[uri("index.md")].map(({ newText }) => newText),
      ["archive/notes/z.md"],
    );
  } finally {
    server.kill();
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
