// Command-line arguments: the folder to serve and the port to serve it on.

import { parseArgs } from "node:util";

const DEFAULT_PORT = 8640;
const USAGE = "Usage: folio [FOLDER] [--port N]";

export interface Options {
  folder: string;
  port: number;
}

export function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: "string", short: "p" } },
  });

  if (positionals.length > 1) {
    throw new Error(`Expected one folder, got ${positionals.length}.\n${USAGE}`);
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${values.port}.\n${USAGE}`);
  }

  return { folder: positionals[0] ?? ".", port };
}
