import assert from "node:assert/strict"
import { test } from "node:test"
import { parseOptions } from "../src/server/args.ts"

test("defaults to the current folder and port 8640", () => {
  assert.deepEqual(parseOptions([]), { command: "serve", folder: ".", port: 8640 })
})

test("takes a folder and a port, marking the port as given", () => {
  assert.deepEqual(parseOptions(["notes", "--port", "9001"]), {
    command: "serve",
    folder: "notes",
    port: 9001,
    portGiven: true,
  })
  assert.deepEqual(parseOptions(["notes", "-p", "8640"]), {
    command: "serve",
    folder: "notes",
    port: 8640,
    portGiven: true,
  })
})

test("rejects a port that is not a number in range", () => {
  for (const port of ["0", "65536", "80a", "1.5"]) {
    assert.throws(() => parseOptions(["--port", port]), /Invalid port/)
  }
})

test("rejects a second folder", () => {
  assert.throws(() => parseOptions(["a", "b"]), /Expected one folder/)
})

test("takes a socket to serve on, besides the port", () => {
  assert.deepEqual(parseOptions(["notes", "--socket", "/run/a.sock", "--socket", "/run/b.sock"]), {
    command: "serve",
    folder: "notes",
    port: 8640,
    sockets: ["/run/a.sock", "/run/b.sock"],
  })
  assert.throws(() => parseOptions(["mcp", "--socket", "/a", "--socket", "/b"]), /one socket/)
})

test("mcp reads the folio on a port or a socket, and takes no folder", () => {
  assert.deepEqual(parseOptions(["mcp", "--socket", "/run/folio.sock"]), {
    command: "mcp",
    port: 8640,
    socket: "/run/folio.sock",
  })
  assert.deepEqual(parseOptions(["mcp", "-p", "9001"]), {
    command: "mcp",
    port: 9001,
    portGiven: true,
  })
  assert.deepEqual(parseOptions(["mcp"]), { command: "mcp", port: 8640 })
  assert.throws(() => parseOptions(["mcp", "notes"]), /takes no folder/)
  assert.deepEqual(parseOptions(["./mcp"]), { command: "serve", folder: "./mcp", port: 8640 })
})

test("check and lsp take a folder as serving does", () => {
  assert.deepEqual(parseOptions(["check", "notes"]), {
    command: "check",
    folder: "notes",
    port: 8640,
  })
  assert.deepEqual(parseOptions(["lsp"]), { command: "lsp", folder: ".", port: 8640 })
  assert.deepEqual(parseOptions(["check", "notes", "--port", "9001"]), {
    command: "check",
    folder: "notes",
    port: 9001,
    portGiven: true,
  })
})

test("check and mcp read one folio, on a port or a socket, never both", () => {
  assert.throws(() => parseOptions(["check", "--port", "9001", "--socket", "/s"]), /not both/)
  assert.throws(() => parseOptions(["mcp", "-p", "9001", "--socket", "/s"]), /not both/)
  assert.deepEqual(parseOptions(["check", "--socket", "/s"]), {
    command: "check",
    folder: ".",
    port: 8640,
    socket: "/s",
  })
})

test("asks for help, a command's help or the version, and takes --verbose when serving only", () => {
  assert.deepEqual(parseOptions(["--help"]), { command: "help", topic: "serve" })
  assert.deepEqual(parseOptions(["-h"]), { command: "help", topic: "serve" })
  assert.deepEqual(parseOptions(["check", "--help"]), { command: "help", topic: "check" })
  assert.deepEqual(parseOptions(["lsp", "-h"]), { command: "help", topic: "lsp" })
  assert.deepEqual(parseOptions(["mcp", "--help"]), { command: "help", topic: "mcp" })
  assert.deepEqual(parseOptions(["--version"]), { command: "version" })
  assert.deepEqual(parseOptions(["notes", "--verbose"]), {
    command: "serve",
    folder: "notes",
    port: 8640,
    verbose: true,
  })
  assert.throws(() => parseOptions(["check", "--verbose"]), /takes no --verbose/)
})

test("names an unknown option or a missing value in one line, then the usage", () => {
  assert.throws(
    () => parseOptions(["--prot", "9000"]),
    (error: Error) => {
      const [first, usage] = error.message.split("\n")
      assert.equal(first, "Unknown option --prot.")
      assert.match(usage, /^Usage: folio \[FOLDER\]/)
      return true
    },
  )
  assert.throws(() => parseOptions(["check", "--port"]), {
    message: /^--port needs a value\.\nUsage: folio check/,
  })
  assert.throws(() => parseOptions(["--verbose=1"]), {
    message: /^--verbose takes no value\.\nUsage: folio \[FOLDER\]/,
  })
  assert.throws(() => parseOptions(["check", "--help=x"]), {
    message: /^--help takes no value\.\nUsage: folio check/,
  })
})
