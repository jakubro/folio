/** Queries a declaration holds, run from its folder and run again only once what they read has changed. */

import path from "node:path";
import type { Data, Grid } from "./data.ts";
import type { Model } from "./model.ts";
import { fileVersion } from "./versions.ts";

export interface DeclaredRun {
  grid?: Grid;
  error?: string;
  watch: string[];
}

const RUNS = new WeakMap<Model, Map<string, { key: string; run: DeclaredRun }>>();

export async function runDeclared(
  model: Model,
  data: Data,
  declaration: { path: string; folder: string },
  name: string,
  query: string,
): Promise<DeclaredRun> {
  const folder = path.join(model.root, declaration.folder);
  const reads = await data.queryReads(path.join(folder, path.basename(declaration.path)), query);
  const files = reads.files.map((file) => path.join(model.root, file));
  const dirs = [...new Set([...files.map((file) => path.dirname(file)), ...(reads.dirs ?? [])])];
  const key = [
    query,
    data.documentsVersion(reads.tables ?? []),
    ...files.map((file) => fileVersion(file) ?? file),
  ].join("\0");
  const runs = RUNS.get(model) ?? new Map<string, { key: string; run: DeclaredRun }>();
  RUNS.set(model, runs);
  const held = runs.get(`${declaration.path}\0${name}`);

  if (held?.key === key) {
    return held.run;
  }

  const { grid, error } = await data.embedQuery(query, folder, "", "");
  const run: DeclaredRun = { ...(grid && { grid }), ...(error && { error }), watch: dirs };
  runs.set(`${declaration.path}\0${name}`, { key, run });
  return run;
}

export function recordsOf(grid: Grid): Record<string, unknown>[] {
  const names = grid.columns.map((column) => column.name);
  return grid.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}
