/** Where each running folio serves, kept in its store so `folio check` and `folio mcp` find it. */

import fs from "node:fs"
import path from "node:path"
import type { Reach } from "./mcp.ts"
import { modelStore } from "./model.ts"
import { alive, startOf } from "./processes.ts"

interface Served {
  port: number
  pid: number
  start: string
}

const RECORD = "serving.json"

/** Record that this process serves the store's folder on `port`, until it exits. */
export function recordServing(store: string, port: number): void {
  const file = path.join(store, RECORD)

  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ port, pid: process.pid, start: startOf("self") }))
  // A folio started on the same folder with --port since then holds the record now.
  process.once("exit", () => {
    if (recorded(file)?.pid === process.pid) {
      fs.rmSync(file, { force: true })
    }
  })
}

/** The folio serving exactly `folder`, a real path; none once the process recording it stops. */
export function servingAt(folder: string, env: NodeJS.ProcessEnv = process.env): Reach | undefined {
  const found = recorded(path.join(modelStore(folder, env), RECORD))
  return found && alive(found.pid, found.start) ? { port: found.port } : undefined
}

/** The nearest folder at or above `folder`, a real path, that a folio serves. */
export function servingAbove(
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
): { root: string; reach: Reach } | undefined {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    const reach = servingAt(dir, env)

    if (reach) {
      return { root: dir, reach }
    }

    if (path.dirname(dir) === dir) {
      return undefined
    }
  }
}

function recorded(file: string): Served | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
