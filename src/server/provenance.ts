/**
 * Where a block of a page came from: its file and lines, what it was included or computed from, and
 * whether the figures it ties to data hold.
 */

import fs from "node:fs";
import path from "node:path";
import { singleValue, verdict } from "../client/claims.ts";
import { MARKED, unmarked } from "../client/unresolved.ts";
import { conventionsOf, type Described } from "./conventions.ts";
import type { Data, Embedded } from "./data.ts";
import type { Model } from "./model.ts";
import { resolve } from "./queries.ts";
import type { PageState } from "./versions.ts";

const INCLUDE = /\{include:/;

export interface Provenance {
  source: string;
  kind: string;
  lines: [number, number];
  /** When the block took its current text, as ISO time. */
  changed?: string;
  /** For a block another file brings onto the page: the section it came from, or none for a whole file. */
  included?: { section?: string };
  data: Computed[];
  claims: ClaimState[];
  /** What the folder declares of the block's file: the declarations applying to it, its kind and fields. */
  conventions: Described;
}

interface Computed {
  reference: string;
  files: { path: string; changed: string }[];
  query?: string;
  error?: string;
}

interface ClaimState {
  figure: string;
  reference: string;
  state: "matching" | "contradicted" | "unchecked";
  /** The data's value, written as the figure is. */
  live?: string;
  reason?: string;
  /** Left unchecked by choice - a range, or a figure holding a missing include - not for want of data. */
  deliberate?: boolean;
}

export async function provenance(
  root: string,
  model: Model,
  data: Data,
  shown: Pick<PageState, "blocks" | "layout">,
  page: string,
  source: string,
  id: string,
  occurrence = 0,
): Promise<Provenance | undefined> {
  const block = model.held(source)?.find((found) => found.id === id);

  if (!block) {
    return undefined;
  }

  const file = path.join(root, source);
  // A tied figure's reference is listed with its figure; the same reference read by an embed stays.
  const references = [...(block.references ?? [])];

  for (const { reference } of block.claims ?? []) {
    references.splice(references.indexOf(reference), 1);
  }

  const computed = [
    ...(await Promise.all(
      [...new Set(references)].map((reference) => computedOf(root, data, file, reference)),
    )),
    ...(await Promise.all(
      data
        .documentQueries(file)
        .filter(({ line }) => block.lines[0] <= line && line <= block.lines[1])
        .map(async ({ sql }) => ({
          reference: "",
          query: sql,
          files: dated(root, await data.dependenciesFrom(file, [], [sql]), true),
        })),
    )),
  ];

  return {
    source,
    kind: block.kind,
    lines: block.lines,
    ...(block.seen && { changed: new Date(block.seen).toISOString() }),
    ...includedFrom(model, shown, page, source, id, occurrence),
    data: computed,
    claims: await claimStates(data, file, block.claims ?? []),
    conventions: conventionsOf(model).describe(source),
  };
}

export async function claimStates(
  data: Data,
  file: string,
  claims: { figure: string; reference: string }[],
): Promise<ClaimState[]> {
  return Promise.all(
    claims.map(async ({ figure: typed, reference }): Promise<ClaimState> => {
      const shown = INCLUDE.test(typed) ? data.shown(file, typed) : typed;
      const figure = unmarked(shown).trim();

      const unchecked = (reason: string, deliberate: boolean): ClaimState => ({
        figure,
        reference,
        state: "unchecked",
        reason,
        ...(deliberate && { deliberate }),
      });

      if (shown.includes(MARKED)) {
        return unchecked("An include in this figure resolves to nothing.", true);
      }

      let embedded: Embedded;

      try {
        embedded = await data.embedReference(file, reference);
      } catch (error) {
        return unchecked((error as Error).message, false);
      }

      if (embedded.error) {
        return unchecked(embedded.error, false);
      }

      let value: ReturnType<typeof singleValue>;

      try {
        value = singleValue(embedded);
      } catch (error) {
        return unchecked((error as Error).message, false);
      }

      try {
        return { figure, reference, ...verdict(figure, value) };
      } catch (error) {
        return unchecked((error as Error).message, true);
      }
    }),
  );
}

async function computedOf(
  root: string,
  data: Data,
  file: string,
  reference: string,
): Promise<Computed> {
  const { files, missing } = await data.reads(file, reference);
  const query = queryOf(root, data, file, reference);

  return {
    reference,
    files: dated(root, files, false),
    ...(query && { query }),
    ...(missing && { error: `No data file at ${reference}.` }),
  };
}

function queryOf(root: string, data: Data, file: string, reference: string): string | undefined {
  try {
    if (reference.startsWith("#")) {
      const key = reference.slice(1).split("#")[0];
      return data
        .documentQueries(file)
        .find((query) => (key.startsWith("@") ? `@${query.line}` === key : query.name === key))
        ?.sql;
    }

    const found = resolve(reference, root, path.dirname(file));
    return found.format === "sql" ? fs.readFileSync(found.file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function dated(root: string, files: string[], relative: boolean): Computed["files"] {
  return files.map((found) => {
    const absolute = relative ? path.join(root, found) : found;
    const at = fs.statSync(absolute, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    return {
      path: path.relative(root, absolute).split(path.sep).join("/"),
      changed: new Date(at).toISOString(),
    };
  });
}

/**
 * The innermost include instance placing the block's occurrence; the page's own text is the first.
 * An included part is whole when it runs from the file's first line to its last block.
 */
function includedFrom(
  model: Model,
  { blocks, layout }: Pick<PageState, "blocks" | "layout">,
  page: string,
  source: string,
  id: string,
  occurrence: number,
): Pick<Provenance, "included"> {
  const placed = blocks.filter((found) => found.source === source && found.id === id)[occurrence];
  const index = layout.instances.findLastIndex(
    (found) =>
      found.source === source &&
      placed !== undefined &&
      found.starts[0] <= placed.at[0] &&
      placed.at[0] <= (found.ends.at(-1) ?? 0),
  );

  if (index === 0 || (index < 0 && source === page)) {
    return {};
  }

  const instance = layout.instances[index];
  const held = model.held(source) ?? [];
  const lastLine = Math.max(0, ...held.map((block) => block.lines[1]));

  if (!instance || (instance.first === 1 && instance.last >= lastLine)) {
    return { included: {} };
  }

  const first = held.find((block) => block.lines[0] === instance.first);
  return { included: first ? { section: first.title ?? `^${first.id}` } : {} };
}
