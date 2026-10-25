import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions } from "../src/server/args.ts";

test("defaults to the current folder and port 8640", () => {
  assert.deepEqual(parseOptions([]), { command: "serve", folder: ".", port: 8640 });
});

test("takes a folder and a port", () => {
  assert.deepEqual(parseOptions(["notes", "--port", "9001"]), {
    command: "serve",
    folder: "notes",
    port: 9001,
  });
});

test("rejects a port that is not a number in range", () => {
  for (const port of ["0", "65536", "80a", "1.5"]) {
    assert.throws(() => parseOptions(["--port", port]), /Invalid port/);
  }
});

test("rejects a second folder", () => {
  assert.throws(() => parseOptions(["a", "b"]), /Expected one folder/);
});

test("takes a socket to serve on, besides the port", () => {
  assert.deepEqual(parseOptions(["notes", "--socket", "/run/a.sock", "--socket", "/run/b.sock"]), {
    command: "serve",
    folder: "notes",
    port: 8640,
    sockets: ["/run/a.sock", "/run/b.sock"],
  });
  assert.throws(() => parseOptions(["mcp", "--socket", "/a", "--socket", "/b"]), /one socket/);
});

test("mcp reads the folio on a port or a socket, and takes no folder", () => {
  assert.deepEqual(parseOptions(["mcp", "--socket", "/run/folio.sock"]), {
    command: "mcp",
    port: 8640,
    socket: "/run/folio.sock",
  });
  assert.deepEqual(parseOptions(["mcp", "-p", "9001"]), { command: "mcp", port: 9001 });
  assert.throws(() => parseOptions(["mcp", "notes"]), /takes no folder/);
  assert.deepEqual(parseOptions(["./mcp"]), { command: "serve", folder: "./mcp", port: 8640 });
});

test("check and lsp take a folder as serving does", () => {
  assert.deepEqual(parseOptions(["check", "notes"]), {
    command: "check",
    folder: "notes",
    port: 8640,
  });
  assert.deepEqual(parseOptions(["lsp"]), { command: "lsp", folder: ".", port: 8640 });
});

test("check and mcp read one folio, on a port or a socket, never both", () => {
  assert.throws(() => parseOptions(["check", "--port", "9001", "--socket", "/s"]), /not both/);
  assert.throws(() => parseOptions(["mcp", "-p", "9001", "--socket", "/s"]), /not both/);
  assert.deepEqual(parseOptions(["check", "--socket", "/s"]), {
    command: "check",
    folder: ".",
    port: 8640,
    socket: "/s",
  });
});
