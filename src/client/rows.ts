/** Embedded data as a list of records, whether it came as a grid or as a list of values. */

import type { Embedded } from "../server/data.ts"

export function rowsOf(embedded: Embedded): Record<string, unknown>[] {
  if (embedded.grid) {
    const { columns, rows } = embedded.grid
    return rows.map((row) => Object.fromEntries(columns.map(({ name }, i) => [name, row[i]])))
  }

  if (Array.isArray(embedded.value)) {
    return embedded.value.map((item) =>
      item !== null && typeof item === "object" ? item : { value: item },
    )
  }

  throw new Error("Not a list of rows.")
}
