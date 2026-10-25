#!/usr/bin/env node
/** Entry point of the folio command. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseOptions } from "./server/args.ts";
import { check } from "./server/check.ts";
import { Data } from "./server/data.ts";
import { documentsOf } from "./server/documents.ts";
import { Hub } from "./server/events.ts";
import { healthOf } from "./server/health.ts";
import { createHandler, listen } from "./server/http.ts";
import { impactOf } from "./server/impact.ts";
import { Indexer } from "./server/indexer.ts";
import { lsp } from "./server/lsp.ts";
import { mcp } from "./server/mcp.ts";
import { Model, modelStore } from "./server/model.ts";
import { savedOf } from "./server/saved.ts";
import { listenSocket } from "./server/socket.ts";

let options: ReturnType<typeof parseOptions>;
let root: string;

try {
  options = parseOptions(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

if (options.command === "mcp") {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
  );
  await mcp(options, version);
  process.exit(0);
}

try {
  root = fs.existsSync(options.folder) ? fs.realpathSync(options.folder) : "";

  if (!root || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a folder: ${options.folder}`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

/** A model of the folder in this process alone, from the store a folio serving it keeps. */
const standalone = (folder: string) => {
  const indexer = new Indexer(new URL("./index-worker.js", import.meta.url));
  const store = modelStore(folder);
  const model = new Model(folder, store, indexer, () => {});
  const data = new Data(folder, store);
  data.useBlocks((file, text) => model.blocksReady(file, text));
  data.useDocuments(documentsOf(model));
  return {
    indexer,
    model,
    data,
    close: async () => {
      model.close();
      await Promise.all([indexer.close(), data.close()]);
    },
  };
};

if (options.command === "check") {
  process.exit(await check(root, options, standalone, (line) => console.log(line)));
}

if (options.command === "lsp") {
  const { indexer, model, data, close } = standalone(root);
  await lsp(root, model, data, indexer);
  await close();
  process.exit(0);
}

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const build = createHash("sha1")
  .update(fs.readFileSync(path.join(import.meta.dirname, "page.js")))
  .digest("hex")
  .slice(0, 16);
const hub = new Hub(root, build, log);
const indexer = new Indexer(new URL("./index-worker.js", import.meta.url));
const store = modelStore(root);
const model = new Model(root, store, indexer, log);
const data = new Data(root, store);
data.useBlocks((file, text) => model.blocksReady(file, text));
data.useDocuments(documentsOf(model));
hub.follow(model);
hub.read(data);
const sockets = options.command === "serve" ? (options.sockets ?? []) : [];
const handler = createHandler(root, import.meta.dirname, build, model, data, log);
/** A view's state lives in the page's address, which the default 16 KB header limit cuts short. */
const server = http.createServer({ maxHeaderSize: 1 << 20 }, handler);
hub.attach(server);

try {
  await listen(server, options.port);

  for (const socket of sockets) {
    await listenSocket(http.createServer({ maxHeaderSize: 1 << 20 }, handler), socket);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(
  `folio serving ${root} at http://localhost:${options.port}/${sockets.length > 0 ? ` and on ${sockets.join(", ")}` : ""}`,
);
model
  .start()
  .then(() => {
    savedOf(model, data).start();
    return impactOf(model, data).refresh();
  })
  .catch((error: Error) => log(`model: ${error.message}`));

// A read recorded a moment before folio stops, and health worked out, are written before it exits.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void Promise.all([model.reads.flush(), healthOf(model, data).flush()]).finally(() =>
      process.exit(code),
    );
  });
}
