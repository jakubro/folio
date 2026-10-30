/** A health problem's identity, shared by the server that lists problems and the page that patches them. */

import type { Problem } from "../server/health.ts"

export function problemKey({ kind, severity, path, line, occurrence, what }: Problem): string {
  return `${kind}\0${severity ?? ""}\0${path}\0${line}\0${occurrence ?? 0}\0${what}`
}
