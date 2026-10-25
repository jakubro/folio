/** Command-line arguments: serve a folder, check its health, serve an editor, or speak MCP to a folio. */

import { parseArgs } from "node:util";

const DEFAULT_PORT = 8640;
const USAGE =
  "Usage: folio [FOLDER] [--port N] [--socket PATH]...\n       folio check [FOLDER] [--port N | --socket PATH]\n       folio lsp [FOLDER]\n       folio mcp [--port N | --socket PATH]";

export type Options =
  | { command: "serve"; folder: string; port: number; sockets?: string[] }
  | { command: "check" | "lsp"; folder: string; port: number; socket?: string }
  | { command: "mcp"; port: number; socket?: string };

export function parseOptions(argv: string[]): Options {
  const command = argv[0] === "mcp" || argv[0] === "check" || argv[0] === "lsp" ? argv[0] : "serve";
  const { values, positionals } = parseArgs({
    args: command === "serve" ? argv : argv.slice(1),
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      socket: { type: "string", multiple: true },
    },
  });
  const allowed = command === "mcp" ? 0 : 1;

  if (positionals.length > allowed) {
    throw new Error(
      command === "mcp"
        ? `folio mcp takes no folder: it reads the folio serving one.\n${USAGE}`
        : `Expected one folder, got ${positionals.length}.\n${USAGE}`,
    );
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${values.port}.\n${USAGE}`);
  }

  const sockets = [values.socket ?? []].flat();

  if (sockets.includes("")) {
    throw new Error(`A socket needs a path.\n${USAGE}`);
  }

  if (command === "serve") {
    return {
      command,
      folder: positionals[0] ?? ".",
      port,
      ...(sockets.length > 0 && { sockets }),
    };
  }

  if (sockets.length > 1) {
    throw new Error(`folio ${command} reads one folio, on one socket.\n${USAGE}`);
  }

  if (command !== "lsp" && sockets.length > 0 && values.port !== undefined) {
    throw new Error(`folio ${command} reads one folio, on a port or a socket, not both.\n${USAGE}`);
  }

  const socket = sockets.length === 0 ? {} : { socket: sockets[0] };

  return command === "mcp"
    ? { command, port, ...socket }
    : { command, folder: positionals[0] ?? ".", port, ...socket };
}
