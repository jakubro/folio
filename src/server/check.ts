/** `folio check`: a folder's health printed, failing when a problem counts as an error. */

import http from "node:http"
import type { Data } from "./data.ts"
import { healthOf, type Problem } from "./health.ts"
import type { Reach } from "./mcp.ts"
import type { Model } from "./model.ts"
import { type Progress, painter, reading } from "./terminal.ts"

export interface Opened {
  model: Model
  data: Data
  close(): Promise<void>
}

const ASK_MS = 1000
const SEVERITIES: Record<string, "red" | "yellow"> = { error: "red", warning: "yellow" }
const paint = painter(process.stdout)
const POLL_MS = 500

/** `root` is a real path: a running folio is asked only when the root it reports is the same. */
export async function check(
  root: string,
  reach: Reach,
  open: (root: string) => Opened,
  print: (line: string) => void,
  progress: (text: Progress | undefined) => void,
): Promise<number> {
  let problems: Problem[]

  try {
    problems =
      (await fromRunning(root, reach, progress)) ?? (await standalone(root, open, progress))
  } catch (error) {
    progress(undefined)
    print(paint("red", `folio check: no health could be worked out: ${(error as Error).message}`))
    return 2
  }

  progress(undefined)

  const errors = problems.filter((problem) => problem.severity === "error")
  const rows = problems.map(({ path, line, severity, kind, what }) => [
    `${path}:${line}`,
    severity ?? "-",
    kind,
    what,
  ])
  const widths = [0, 1, 2].map((column) => Math.max(0, ...rows.map((row) => row[column].length)))

  for (const [place, severity, kind, what] of rows) {
    print(
      [
        place.padEnd(widths[0]),
        paint(SEVERITIES[severity] ?? "dim", severity.padEnd(widths[1])),
        kind.padEnd(widths[2]),
        what,
      ].join("  "),
    )
  }

  print(
    paint(
      errors.length > 0 ? "red" : "green",
      `folio check: ${count(errors.length, "error")}, ${count(problems.length - errors.length, "other problem")}`,
    ),
  )

  return errors.length > 0 ? 1 : 0
}

export function addressOf(reach: Reach): string {
  return reach.socket ? `on ${reach.socket}` : `at http://localhost:${reach.port}/`
}

/** Only finding the folio has a deadline; its health may take as long as checking the folder takes. */
export function ask(reach: Reach, address: string, deadline = ASK_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        ...(reach.socket ? { socketPath: reach.socket } : { host: "127.0.0.1", port: reach.port }),
        path: address,
        headers: { host: "localhost" },
        timeout: deadline,
      },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          body += chunk
        })
        response.on("end", () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.on("timeout", () => request.destroy(new Error("No answer.")))
    request.on("error", reject)
  })
}

async function fromRunning(
  root: string,
  reach: Reach,
  progress: (text: Progress) => void,
): Promise<Problem[] | undefined> {
  const index = (await ask(reach, "/?api").catch(() => undefined)) as { root?: string } | undefined

  if (index?.root !== root) {
    return undefined
  }

  const folio = `the folio ${addressOf(reach)}`

  for (;;) {
    const model = (await ask(reach, "/?model", 0)) as { ready: boolean; documents: number }

    if (model.ready) {
      progress(`waiting for ${folio}, checking health`)
      const health = (await ask(reach, "/?api=health", 0)) as {
        ready: boolean
        problems: Problem[]
      }

      if (health.ready) {
        return health.problems
      }
    } else {
      progress(`waiting for ${folio}, reading the folder: ${model.documents} documents`)
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function standalone(
  root: string,
  open: (root: string) => Opened,
  progress: (text: Progress) => void,
): Promise<Problem[]> {
  const { model, data, close } = open(root)

  try {
    progress(() => reading(model))
    await model.start()
    const health = healthOf(model, data)
    const checking = () => {
      const counted = health.progress
      return counted
        ? `checking health: ${counted.checked} of ${counted.of} documents`
        : "checking health"
    }
    progress(checking)
    const { problems } = await health.state()
    progress(checking)
    await Promise.all([model.flush(), health.flush()])
    return problems
  } finally {
    await close()
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}
