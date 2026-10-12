#!/usr/bin/env node
// Entry point of the folio command.

import fs from "node:fs";
import http from "node:http";
import { parseOptions } from "./server/args.ts";
import { Hub } from "./server/events.ts";
import { createHandler, listen } from "./server/http.ts";

let options: ReturnType<typeof parseOptions>;
let root: string;

try {
  options = parseOptions(process.argv.slice(2));
  root = fs.existsSync(options.folder) ? fs.realpathSync(options.folder) : "";

  if (!root || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a folder: ${options.folder}`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const hub = new Hub(root, log);
const server = http.createServer(createHandler(root, import.meta.dirname, log));
hub.attach(server);

try {
  await listen(server, options.port);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`folio serving ${root} at http://localhost:${options.port}/`);
