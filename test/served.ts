/** A fixture folder written to disk, with a started model, a data engine and the document tables. */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Data } from "../src/server/data.ts"
import { documentsOf } from "../src/server/documents.ts"
import type { Indexer } from "../src/server/indexer.ts"
import { Model } from "../src/server/model.ts"

export async function served(
  indexer: Indexer,
  files: Record<string, string>,
  prepare: (root: string) => void = () => {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-served-")))
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-served-store-"))

  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }

  prepare(root)
  const model = new Model(root, store, indexer, () => {})
  const data = new Data(root, store)
  data.useBlocks((file, text) => model.blocksReady(file, text))
  data.useDocuments(documentsOf(model))
  await model.start()
  return { root, store, model, data }
}
