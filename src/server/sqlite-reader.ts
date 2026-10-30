/** Answers one SQLite request in a process of its own, which the server ends when the request runs too long. */

import { exportSqlite, readSqlite, type SqliteRequest } from "./data.ts"

process.once("message", (request: SqliteRequest) => {
  let answer: { value?: unknown; error?: string }

  try {
    answer = {
      value:
        request.kind === "read"
          ? readSqlite(
              request.file,
              request.table,
              request.limit,
              (progress) => process.send?.({ progress }),
              request.order,
              request.offset,
            )
          : exportSqlite(request.file, request.table, request.target),
    }
  } catch (error) {
    answer = { error: (error as Error).message.split("\n")[0] }
  }

  process.send?.(answer, () => process.exit(0))
})
