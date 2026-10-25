/**
 * What needs the reader, ranked: errors, problems in documents they read, what the folder declares needs
 * attention, and changes to what they read.
 */

import { createHash } from "node:crypto";
import { conventionsOf } from "./conventions.ts";
import type { Data } from "./data.ts";
import { recordsOf, runDeclared } from "./declared.ts";
import { healthOf } from "./health.ts";
import type { Model } from "./model.ts";
import { changesState } from "./versions.ts";

export interface Need {
  source: "error" | "problem" | "attention" | "changed";
  path: string;
  line?: number;
  block?: string;
  what: string;
  name?: string;
  at?: string;
}

export interface NeedsState {
  ready: boolean;
  needs: Need[];
  version: string;
  watched: string[];
}

const RANK: Need["source"][] = ["error", "problem", "attention", "changed"];

export async function needsOf(model: Model, data: Data): Promise<NeedsState> {
  const health = await healthOf(model, data).state();

  if (!health.ready) {
    return { ready: false, needs: [], version: "", watched: [] };
  }

  await model.reads.load();
  const read = new Set(model.reads.documents().map(({ path: at }) => at));
  const needs: Need[] = [];
  const dirs = new Set<string>();

  for (const { kind, path: at, line, block, what, severity } of health.problems) {
    const source = severity === "error" ? "error" : read.has(at) ? "problem" : undefined;

    if (source) {
      needs.push({ source, path: at, line, ...(block && { block }), what: `${kind}: ${what}` });
    }
  }

  for (const declaration of conventionsOf(model).all()) {
    for (const [name, definition] of Object.entries(declaration.attention)) {
      needs.push(...(await attention(model, data, declaration, name, definition, dirs)));
    }
  }

  const { documents } = await changesState(model.root, model, data);

  for (const { path: at, blocks, at: when } of documents) {
    needs.push({
      source: "changed",
      path: at,
      what: `${blocks} ${blocks === 1 ? "block" : "blocks"} changed since you read it`,
      at: when,
    });
  }

  needs.sort((a, b) => RANK.indexOf(a.source) - RANK.indexOf(b.source));

  return {
    ready: true,
    needs,
    version: createHash("sha1").update(JSON.stringify(needs)).digest("hex").slice(0, 16),
    watched: [...dirs],
  };
}

async function attention(
  model: Model,
  data: Data,
  declaration: { path: string; folder: string },
  name: string,
  { query, message }: { query: string; message: string },
  dirs: Set<string>,
): Promise<Need[]> {
  const {
    grid,
    error,
    watch: read,
  } = await runDeclared(model, data, declaration, `attention ${name}`, query);

  for (const dir of read) {
    dirs.add(dir);
  }

  return grid?.columns.some((column) => column.name === "path")
    ? recordsOf(grid).map((record) => ({
        source: "attention",
        name,
        path: String(record.path),
        ...(Number(record.line) > 0 && { line: Number(record.line) }),
        what: message.replace(/\{(\w+)\}/g, (all, column: string) =>
          Object.hasOwn(record, column) ? String(record[column] ?? "") : all,
        ),
      }))
    : [
        {
          source: "error",
          path: declaration.path,
          what: `The attention query ${name} cannot run: ${error ?? "it returns no path column."}`,
        },
      ];
}
