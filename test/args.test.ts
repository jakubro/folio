import assert from "node:assert/strict"
import { test } from "node:test"
import { parseOptions } from "../src/server/args.ts"

const MCP_USAGE =
  "Usage: folio mcp [FOLIO | --port N | --socket PATH]\n       folio mcp --help for more"

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

test("mcp reads the Folio on a port or a socket, and takes no folder", () => {
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
  assert.throws(() => parseOptions(["mcp", import.meta.dirname]), {
    message: `folio mcp takes no folder: it reads the Folio serving one.\n${MCP_USAGE}`,
  })
  assert.deepEqual(parseOptions(["./mcp"]), { command: "serve", folder: "./mcp", port: 8640 })
})

test("mcp takes the Folio to read as its address on this machine or a socket's path, an empty one as none", () => {
  for (const written of [
    "localhost:9001",
    "http://localhost:9001/",
    "127.0.0.1:9001",
    "http://[::1]:9001/notes/plan.md",
  ]) {
    assert.deepEqual(
      parseOptions(["mcp", written]),
      { command: "mcp", port: 9001, portGiven: true },
      written,
    )
  }
  assert.deepEqual(parseOptions(["mcp", "http://localhost/"]), {
    command: "mcp",
    port: 80,
    portGiven: true,
  })
  assert.deepEqual(parseOptions(["mcp", "/run/folio.sock"]), {
    command: "mcp",
    port: 8640,
    socket: "/run/folio.sock",
  })
  assert.deepEqual(parseOptions(["mcp", "folio.sock"]), {
    command: "mcp",
    port: 8640,
    socket: "folio.sock",
  })
  assert.deepEqual(parseOptions(["mcp", ""]), { command: "mcp", port: 8640 })
  assert.deepEqual(parseOptions(["mcp", "", "--socket", "/s"]), {
    command: "mcp",
    port: 8640,
    socket: "/s",
  })

  for (const written of ["https://localhost:9001/", "example.com:8640", "http://10.0.0.2:8640/"]) {
    assert.throws(() => parseOptions(["mcp", written]), {
      message: `Not a Folio's address: ${written}. Folio answers http on localhost only.\n${MCP_USAGE}`,
    })
  }
  assert.throws(() => parseOptions(["mcp", "localhost:0"]), {
    message: `Invalid port: 0.\n${MCP_USAGE}`,
  })

  for (const twice of [
    ["localhost:9001", "--port", "9002"],
    ["/a.sock", "--socket", "/b.sock"],
  ]) {
    assert.throws(() => parseOptions(["mcp", ...twice]), {
      message: `folio mcp reads one Folio, named once.\n${MCP_USAGE}`,
    })
  }
  assert.throws(() => parseOptions(["mcp", "a.sock", "b.sock"]), {
    message: `Expected one Folio, got 2.\n${MCP_USAGE}`,
  })
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

test("check and mcp read one Folio, on a port or a socket, never both", () => {
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

test("takes components folders to serve, check and edit with, refusing them to mcp", () => {
  assert.deepEqual(parseOptions(["notes", "--components", "a", "--components", "b"]), {
    command: "serve",
    folder: "notes",
    port: 8640,
    components: ["a", "b"],
  })
  assert.deepEqual(parseOptions(["check", "notes", "--components", "a"]), {
    command: "check",
    folder: "notes",
    port: 8640,
    components: ["a"],
  })
  assert.deepEqual(parseOptions(["lsp", "--components", "a"]), {
    command: "lsp",
    folder: ".",
    port: 8640,
    components: ["a"],
  })
  assert.throws(
    () => parseOptions(["--components", ""]),
    /^Error: A components folder needs a path\./,
  )
  assert.throws(() => parseOptions(["mcp", "--components", "a"]), {
    message: `folio mcp takes no --components: the Folio it reads draws with its own.\n${MCP_USAGE}`,
  })
})
