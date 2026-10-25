/**
 * A folio that writes its saved views, killed the moment it is about to rename a written file into place,
 * or, told `in-place`, halfway through writing a document over in place.
 */

import fs from "node:fs";
import { Data } from "../src/server/data.ts";
import { documentsOf } from "../src/server/documents.ts";
import { Indexer } from "../src/server/indexer.ts";
import { Model } from "../src/server/model.ts";
import { savedOf } from "../src/server/saved.ts";

const [root, store, at] = process.argv.slice(2);
const rename = fs.renameSync;
const writeFile = fs.writeFileSync;

fs.renameSync = (from, to) => {
  if (at !== "in-place" && String(from).endsWith(".folio")) {
    process.kill(process.pid, "SIGKILL");
  }

  rename(from, to);
};

fs.writeFileSync = ((target: fs.PathOrFileDescriptor, bytes: Buffer, ...rest: unknown[]) => {
  if (
    at === "in-place" &&
    typeof target === "number" &&
    fs.readlinkSync(`/proc/self/fd/${target}`).endsWith(".md")
  ) {
    fs.writeSync(target, bytes, 0, Math.floor(bytes.length / 2), 0);
    process.kill(process.pid, "SIGKILL");
  }

  return (writeFile as (...all: unknown[]) => void)(target, bytes, ...rest);
}) as typeof fs.writeFileSync;

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url));
const model = new Model(root, store, indexer, () => {});
const data = new Data(root, store);
data.useBlocks((file, text) => model.blocksReady(file, text));
data.useDocuments(documentsOf(model));
await model.start();
savedOf(model, data).start();
