/** Command-line arguments and each command's help: serve a folder, check its health, serve an editor, speak MCP. */

import { parseArgs } from "node:util"

export const DEFAULT_PORT = 8640
const COMMANDS = ["check", "lsp", "mcp"] as const

type Command = "serve" | (typeof COMMANDS)[number]

export type Options =
  | {
      command: "serve"
      folder: string
      port: number
      portGiven?: true
      sockets?: string[]
      verbose?: true
    }
  | { command: "check" | "lsp"; folder: string; port: number; portGiven?: true; socket?: string }
  | { command: "mcp"; port: number; portGiven?: true; socket?: string }
  | { command: "help"; topic: Command }
  | { command: "version" }

export interface Help {
  title: string
  sections: { title: string; rows: [string, string][] | string[] }[]
}

const USAGE: Record<Command, string> = {
  serve: "folio [FOLDER] [--port N] [--socket PATH]... [--verbose]",
  check: "folio check [FOLDER] [--port N | --socket PATH]",
  lsp: "folio lsp [FOLDER]",
  mcp: "folio mcp [--port N | --socket PATH]",
}

const HELP_ROW: [string, string] = ["-h, --help", "Show this help"]

export const HELP: Record<Command, Help> = {
  serve: {
    title: "folio - a live view of a folder of markdown and data",
    sections: [
      { title: "Usage", rows: Object.values(USAGE) },
      {
        title: "Commands",
        rows: [
          ["(none)", "Serve FOLDER in the browser, at http://localhost:PORT/"],
          ["check", "Print the folder's health, and fail when a problem is an error"],
          ["lsp", "Serve an editor the folder's links, includes and health"],
          ["mcp", "Answer an agent from the folio serving a folder"],
        ],
      },
      {
        title: "Arguments",
        rows: [["FOLDER", "The folder to serve (default: the current folder)"]],
      },
      {
        title: "Options",
        rows: [
          [
            "-p, --port N",
            `The port, 1 to 65535 (default: ${DEFAULT_PORT}, or the next free one above it unless FOLDER is served on one taken)`,
          ],
          ["--socket PATH", "Also serve on a unix socket; give it again for several"],
          ["--verbose", "Print every request and update, not only pages opened and problems"],
          ["--version", "Print folio's version"],
          ["-h, --help", "Show this help; folio COMMAND --help shows a command's"],
        ],
      },
      {
        title: "Exit codes",
        rows: [
          [
            "1",
            "The port given or a socket is taken, FOLDER is already served, or no port is free",
          ],
          ["2", "The arguments are wrong, or FOLDER is not a folder"],
        ],
      },
      {
        title: "Examples",
        rows: ["folio ~/notes", "folio ~/notes --port 9000", "folio check ~/notes"],
      },
    ],
  },
  check: {
    title: "folio check - print a folder's health, one problem a line",
    sections: [
      { title: "Usage", rows: [USAGE.check] },
      {
        title: "Arguments",
        rows: [["FOLDER", "The folder to check (default: the current folder)"]],
      },
      {
        title: "Options",
        rows: [
          [
            "-p, --port N",
            `Ask the folio serving FOLDER on this port (default: wherever a folio serving FOLDER serves, else ${DEFAULT_PORT})`,
          ],
          ["--socket PATH", "Ask the folio serving FOLDER on this unix socket"],
          HELP_ROW,
        ],
      },
      {
        title: "Exit codes",
        rows: [
          ["0", "No problem is an error"],
          ["1", "A problem is an error"],
          ["2", "No health could be worked out, or the arguments are wrong"],
        ],
      },
      {
        title: "Examples",
        rows: ["folio check", "folio check ~/notes --socket /run/folio.sock"],
      },
    ],
  },
  lsp: {
    title: "folio lsp - a language server for editors, on standard input and output",
    sections: [
      { title: "Usage", rows: [USAGE.lsp] },
      {
        title: "Arguments",
        rows: [
          ["FOLDER", "The folder whose markdown the editor opens (default: the current folder)"],
        ],
      },
      { title: "Options", rows: [HELP_ROW] },
      {
        title: "Exit codes",
        rows: [
          ["0", "The editor closed the connection"],
          ["2", "The arguments are wrong, or FOLDER is not a folder"],
        ],
      },
      { title: "Examples", rows: ["folio lsp ~/notes"] },
    ],
  },
  mcp: {
    title: "folio mcp - an MCP server on standard input and output, reading a running folio",
    sections: [
      { title: "Usage", rows: [USAGE.mcp] },
      {
        title: "Options",
        rows: [
          [
            "-p, --port N",
            `Read the folio on this port (default: the folio serving the nearest folder at or above one of the agent's roots, or the current folder, else ${DEFAULT_PORT})`,
          ],
          ["--socket PATH", "Read the folio on this unix socket"],
          HELP_ROW,
        ],
      },
      {
        title: "Exit codes",
        rows: [
          ["0", "The agent closed the connection"],
          ["2", "The arguments are wrong"],
        ],
      },
      {
        title: "Examples",
        rows: [
          '{ "mcpServers": { "folio": { "command": "folio", "args": ["mcp"] } } }',
          "folio mcp --socket /run/folio.sock",
        ],
      },
    ],
  },
}

export function parseOptions(argv: string[]): Options {
  const command: Command = COMMANDS.find((name) => name === argv[0]) ?? "serve"
  const { values, positionals } = parsed(command === "serve" ? argv : argv.slice(1), command)

  if (values.help) {
    return { command: "help", topic: command }
  }

  if (values.version) {
    return { command: "version" }
  }

  if (values.verbose && command !== "serve") {
    throw new Error(
      `folio ${command} takes no --verbose: it prints no requests.\n${usage(command)}`,
    )
  }

  const allowed = command === "mcp" ? 0 : 1

  if (positionals.length > allowed) {
    throw new Error(
      command === "mcp"
        ? `folio mcp takes no folder: it reads the folio serving one.\n${usage(command)}`
        : `Expected one folder, got ${positionals.length}.\n${usage(command)}`,
    )
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${values.port}.\n${usage(command)}`)
  }

  const sockets = [values.socket ?? []].flat()

  if (sockets.includes("")) {
    throw new Error(`A socket needs a path.\n${usage(command)}`)
  }

  if (command === "serve") {
    return {
      command,
      folder: positionals[0] ?? ".",
      port,
      ...(values.port !== undefined && { portGiven: true as const }),
      ...(sockets.length > 0 && { sockets }),
      ...(values.verbose && { verbose: true as const }),
    }
  }

  if (sockets.length > 1) {
    throw new Error(`folio ${command} reads one folio, on one socket.\n${usage(command)}`)
  }

  if (command !== "lsp" && sockets.length > 0 && values.port !== undefined) {
    throw new Error(
      `folio ${command} reads one folio, on a port or a socket, not both.\n${usage(command)}`,
    )
  }

  const reach = {
    port,
    ...(values.port !== undefined && { portGiven: true as const }),
    ...(sockets.length > 0 && { socket: sockets[0] }),
  }

  return command === "mcp"
    ? { command, ...reach }
    : { command, folder: positionals[0] ?? ".", ...reach }
}

function parsed(args: string[], command: Command) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        port: { type: "string", short: "p" },
        socket: { type: "string", multiple: true },
        verbose: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    })
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException
    const option = /'([^']+)'/.exec(message)?.[1]
    const name = option
      ?.replace(/ <value>$/, "")
      .split(", ")
      .pop()
    const said =
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? `Unknown option ${option}.`
        : code !== "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
          ? message
          : message.endsWith("does not take an argument")
            ? `${name} takes no value.`
            : `${name} needs a value.`
    throw new Error(`${said}\n${usage(command)}`)
  }
}

function usage(command: Command): string {
  return `Usage: ${USAGE[command]}\n       folio ${command === "serve" ? "" : `${command} `}--help for more`
}
