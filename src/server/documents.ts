/**
 * The folder's documents as tables a query reads: each declared kind with a row per document and a column
 * per field, and every document's structure - headings, links, tasks, frontmatter and tables - undeclared.
 */

import path from "node:path";
import GithubSlugger from "github-slugger";
import { parse as parseYaml } from "yaml";
import type { Block } from "./blocks.ts";
import { type Conventions, conventionsOf, DECLARATION, type Document } from "./conventions.ts";
import { linkTarget } from "./files.ts";
import type { Model } from "./model.ts";

export interface DocumentTable {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
}

const STRUCTURE: Record<string, { name: string; type: string }[]> = {
  documents: columns("path VARCHAR", "title VARCHAR", "kind VARCHAR"),
  headings: columns(
    "path VARCHAR",
    "line INTEGER",
    "level INTEGER",
    "text VARCHAR",
    "anchor VARCHAR",
  ),
  links: columns(
    "path VARCHAR",
    "line INTEGER",
    "url VARCHAR",
    "target VARCHAR",
    "fragment VARCHAR",
    "context VARCHAR",
  ),
  tasks: columns("path VARCHAR", "line INTEGER", "done BOOLEAN", "text VARCHAR"),
  frontmatter: columns("path VARCHAR", "key VARCHAR", "value VARCHAR"),
  tables: columns(
    "path VARCHAR",
    "line INTEGER",
    "row INTEGER",
    "header VARCHAR[]",
    "cells VARCHAR[]",
  ),
};
const SCALARS: Record<string, string> = { text: "VARCHAR", number: "DOUBLE", link: "VARCHAR" };
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const DOCUMENTS = new WeakMap<Model, Documents>();

/** The one set of document tables of a model, so every query shares it. */
export function documentsOf(model: Model): Documents {
  let documents = DOCUMENTS.get(model);

  if (!documents) {
    documents = new Documents(model, conventionsOf(model));
    DOCUMENTS.set(model, documents);
  }

  return documents;
}

export class Documents {
  readonly #model: Model;
  readonly #conventions: Conventions;
  /** Each table's revision moves only when a change reaches its rows; `#all` moves them all at once. */
  readonly #revisions = new Map<string, number>();
  readonly #rowsOf = new Map<
    string,
    { hash: string; rows: Record<string, Record<string, unknown>[]> }
  >();
  readonly #kindOf = new Map<string, string | undefined>();
  readonly #built = new Map<string, { stamp: string; table: DocumentTable }>();
  readonly #kindRows = new Map<
    string,
    { found: unknown; shape: string; row: Record<string, unknown> }
  >();
  readonly #kindValues = new Map<string, string | undefined>();
  readonly #generations = new Map<string, number>();
  #kindsKnown = false;
  #all = 0;

  constructor(model: Model, conventions: Conventions) {
    this.#model = model;
    this.#conventions = conventions;
    model.listen((changed) => this.#changed(changed));
  }

  /** Names the state of the tables read: it moves only when a change reaches one of them. */
  versionOf(tables: readonly string[]): string {
    const read = [...new Set(tables)]
      .sort()
      .map((table) => `${table}:${this.#revisions.get(table) ?? 0}`);
    return `documents-${this.#all}-${read.join(",")}`;
  }

  /** A table by its schema and name: `folio.<structure>` or `kind.<name>`; undefined when there is none. */
  table(schema: string, name: string): DocumentTable | undefined {
    const key = `${schema}.${name}`;
    const stamp = this.versionOf([key]);
    const built = this.#built.get(key);

    if (built?.stamp === stamp) {
      return built.table;
    }

    const table =
      schema === "folio" && Object.hasOwn(STRUCTURE, name)
        ? {
            columns: STRUCTURE[name],
            rows: this.#paths().flatMap((urlPath) => this.#held(urlPath)[name]),
          }
        : schema === "kind"
          ? this.#kind(name)
          : undefined;

    if (table) {
      this.#built.set(key, { stamp, table });
    }

    return table;
  }

  /**
   * A changed document moves the structure tables its rows changed in, the kinds it leaves and joins, and
   * every kind naming one of those by id; a changed declaration moves everything.
   */
  #changed(changed: readonly string[] | undefined): void {
    if (
      changed === undefined ||
      changed.some((urlPath) => path.posix.basename(urlPath) === DECLARATION)
    ) {
      this.#all++;
      this.#rowsOf.clear();
      this.#kindOf.clear();
      this.#kindRows.clear();
      this.#kindValues.clear();
      this.#kindsKnown = false;
      return;
    }

    const kinds = new Set<string>();

    for (const urlPath of changed) {
      const before = this.#rowsOf.get(urlPath)?.rows;
      this.#rowsOf.delete(urlPath);
      const after = this.#model.hashOf(urlPath) === undefined ? undefined : this.#held(urlPath);

      for (const structure of Object.keys(STRUCTURE)) {
        if (
          JSON.stringify(before?.[structure] ?? []) !== JSON.stringify(after?.[structure] ?? [])
        ) {
          this.#bump(`folio.${structure}`);
        }
      }

      // A document's kind row moves only when its kind or a field's value does, not with every edit.
      const was = this.#kindOf.get(urlPath);
      const now = after === undefined ? undefined : this.#conventions.kindOf(urlPath);
      const values = now === undefined ? undefined : valuesOf(this.#conventions.document(urlPath));
      const moved = was !== now || values !== this.#kindValues.get(urlPath);

      if (after === undefined) {
        this.#kindOf.delete(urlPath);
        this.#kindRows.delete(urlPath);
        this.#kindValues.delete(urlPath);
      } else {
        this.#kindOf.set(urlPath, now);
        this.#kindValues.set(urlPath, values);
      }

      for (const kind of moved ? [was, now] : []) {
        if (kind !== undefined) {
          kinds.add(kind);
        }
      }
    }

    for (const kind of kinds) {
      this.#bump(`kind.${kind}`);
    }

    // A kind whose ids moved moves every kind naming its documents by id.
    const named = new Set<string>();

    for (const kind of this.#conventions.kinds()) {
      const generation = this.#conventions.generation(kind);

      const seen = this.#generations.get(kind);
      this.#generations.set(kind, generation);

      if (seen !== undefined && seen !== generation) {
        named.add(kind);
      }
    }

    for (const kind of this.#conventions.naming(named)) {
      this.#bump(`kind.${kind}`);
    }
  }

  #bump(table: string): void {
    this.#revisions.set(table, (this.#revisions.get(table) ?? 0) + 1);
  }

  #held(urlPath: string): Record<string, Record<string, unknown>[]> {
    const hash = this.#model.hashOf(urlPath) ?? "";
    const held = this.#rowsOf.get(urlPath);

    if (held?.hash === hash) {
      return held.rows;
    }

    const rows = Object.fromEntries(
      Object.keys(STRUCTURE).map((structure) => [structure, this.#rows(structure, urlPath)]),
    );
    this.#rowsOf.set(urlPath, { hash, rows });
    this.#kindOf.set(urlPath, this.#conventions.kindOf(urlPath));
    return rows;
  }

  #paths(): string[] {
    return this.#model.paths().sort();
  }

  #rows(table: string, urlPath: string): Record<string, unknown>[] {
    const blocks = this.#model.held(urlPath) ?? [];

    switch (table) {
      case "documents": {
        const title = blocks.find((block) => block.kind === "heading")?.title ?? null;
        return [{ path: urlPath, title, kind: this.#conventions.kindOf(urlPath) ?? null }];
      }
      case "headings":
        return headingsOf(urlPath, blocks);
      case "links":
        return blocks.flatMap((block) =>
          (block.links ?? []).map(({ url, context }) => {
            const target = linkTarget(urlPath, url);
            return {
              path: urlPath,
              line: block.lines[0],
              url,
              target: target?.path ?? null,
              fragment: target?.fragment || null,
              context,
            };
          }),
        );
      case "tasks":
        return blocks.flatMap((block) =>
          block.kind === "list" || block.kind === "quote" ? tasksOf(urlPath, block) : [],
        );
      case "frontmatter":
        return frontmatterOf(urlPath, blocks);
      default:
        return blocks.flatMap((block) =>
          block.kind === "table"
            ? tableRows(urlPath, block.text, block.lines[0])
            : block.kind === "quote"
              ? quotedTables(urlPath, block)
              : [],
        );
    }
  }

  /**
   * A kind's columns are its fields as every declaration naming it declares them; a field typed apart by
   * two declarations is text, each document's value read as its own declaration types it.
   */
  #kind(name: string): DocumentTable | undefined {
    const fields = new Map<string, Set<string>>();

    for (const declaration of this.#conventions.all()) {
      for (const [field, definition] of Object.entries(declaration.kinds[name]?.fields ?? {})) {
        const types = fields.get(field) ?? new Set<string>();
        types.add(definition.type === "list" ? `list:${definition.of}` : definition.type);
        fields.set(field, types);
      }
    }

    if (!this.#conventions.all().some((declaration) => declaration.kinds[name])) {
      return undefined;
    }

    for (const kind of this.#conventions.kinds()) {
      this.#generations.set(kind, this.#conventions.generation(kind));
    }

    // Once every document's kind is known, only the documents of this kind are visited.
    if (!this.#kindsKnown) {
      for (const urlPath of this.#model.paths()) {
        this.#kindOf.set(urlPath, this.#conventions.kindOf(urlPath));
      }

      this.#kindsKnown = true;
    }

    const placed = [...this.#kindOf]
      .flatMap(([urlPath, kind]) => (kind === name ? [urlPath] : []))
      .sort()
      .flatMap((urlPath) => {
        const found = this.#conventions.document(urlPath);
        this.#kindValues.set(urlPath, valuesOf(found));
        return found ? [{ urlPath, found }] : [];
      });
    const columns = [...fields].map(([field, types]) => {
      const [type] = types;
      const scalar = (of: string) => (of === "date" ? "date" : (SCALARS[of] ?? "VARCHAR"));

      return types.size > 1
        ? {
            field,
            type: [...types].every((each) => each.startsWith("list:")) ? "VARCHAR[]" : "VARCHAR",
          }
        : { field, type: type.startsWith("list:") ? `${scalar(type.slice(5))}[]` : scalar(type) };
    });
    const shape = JSON.stringify(columns);
    const rows: Record<string, unknown>[] = placed.map(({ urlPath, found }) => {
      const held = this.#kindRows.get(urlPath);

      if (held?.found === found && held.shape === shape) {
        return held.row;
      }

      const row = {
        path: urlPath,
        ...Object.fromEntries(
          columns.map(({ field, type }) => [
            field,
            cellOf(found.fields[field]?.value ?? null, type),
          ]),
        ),
      };
      this.#kindRows.set(urlPath, { found, shape, row });
      return row;
    });
    const dated = (field: string) =>
      rows.some((row) =>
        [row[field]].flat().some((value) => typeof value === "string" && value.length > 10),
      )
        ? "TIMESTAMP"
        : "DATE";

    return {
      columns: [
        { name: "path", type: "VARCHAR" },
        ...columns.map(({ field, type }) => ({
          name: field,
          type: type.replace(/^date/, () => dated(field)),
        })),
      ],
      rows,
    };
  }
}

function valuesOf(found: Document | undefined): string | undefined {
  return (
    found && JSON.stringify(Object.entries(found.fields).map(([name, { value }]) => [name, value]))
  );
}

/**
 * A value as its column holds it: a time with an offset moved to UTC and every time given its seconds,
 * and in a column of text whatever the document's own declaration made of it.
 */
function cellOf(value: unknown, type: string): unknown {
  if (type.startsWith("date")) {
    return Array.isArray(value) ? value.map(timeOf) : timeOf(value);
  }

  if (type === "VARCHAR[]") {
    return Array.isArray(value)
      ? value.map((item) => (item === null ? null : String(item)))
      : value;
  }

  return type === "VARCHAR" && value !== null && typeof value !== "string"
    ? Array.isArray(value)
      ? JSON.stringify(value)
      : String(value)
    : value;
}

function timeOf(value: unknown): unknown {
  const time =
    typeof value === "string"
      ? /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value)
      : null;

  if (!time) {
    return value;
  }

  const [, day, minutes, seconds = ":00", offset] = time;
  return offset
    ? new Date(`${day}T${minutes}${seconds}${offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")}`)
        .toISOString()
        .replace("T", " ")
        .replace("Z", "")
    : `${day} ${minutes}${seconds}`;
}

function columns(...written: string[]): { name: string; type: string }[] {
  return written.map((column) => {
    const [name, type] = column.split(" ");
    return { name, type };
  });
}

/**
 * Every heading the page draws - in a quote or raw HTML too - anchored as the page anchors them all: in
 * order, by one slugger, an author's own id kept.
 */
function headingsOf(urlPath: string, blocks: Block[]): Record<string, unknown>[] {
  const slugger = new GithubSlugger();

  return blocks.flatMap((block) =>
    (block.headings ?? []).map(({ text, id, level, line }) => ({
      path: urlPath,
      line,
      level,
      text,
      anchor: id ?? slugger.slug(text),
    })),
  );
}

function tasksOf(urlPath: string, block: Block): Record<string, unknown>[] {
  return unquoted(block.text).flatMap((line, index) => {
    const task = TASK.exec(line);
    return task
      ? [
          {
            path: urlPath,
            line: block.lines[0] + index,
            done: task[1] !== " ",
            text: task[2].trim(),
          },
        ]
      : [];
  });
}

function frontmatterOf(urlPath: string, blocks: Block[]): Record<string, unknown>[] {
  const block = blocks.find((found) => found.kind === "frontmatter");
  let value: unknown;

  try {
    value = block && parseYaml(block.text.replace(/^---\r?\n/, "").replace(/\r?\n---\s*$/, ""));
  } catch {
    return [];
  }

  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([key, held]) => ({
        path: urlPath,
        key,
        value: typeof held === "string" ? held : JSON.stringify(held),
      }))
    : [];
}

function quotedTables(urlPath: string, block: Block): Record<string, unknown>[] {
  const lines = unquoted(block.text);
  const found: Record<string, unknown>[] = [];
  let start = 0;

  for (let index = 0; index <= lines.length; index++) {
    if (index === lines.length || !lines[index].trim()) {
      const run = lines.slice(start, index);

      if (run.length > 1 && run[0].includes("|") && DIVIDER.test(run[1])) {
        found.push(...tableRows(urlPath, run.join("\n"), block.lines[0] + start));
      }

      start = index + 1;
    }
  }

  return found;
}

/** A markdown table's rows by its text: the header, a divider, then one row a line; escaped pipes stay. */
function tableRows(urlPath: string, text: string, line: number): Record<string, unknown>[] {
  const lines = text.split("\n").filter((held) => held.trim());
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/(?<!\\)\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replaceAll("\\|", "|"));
  const header = lines[0] ? cells(lines[0]) : [];
  const body = lines.slice(DIVIDER.test(lines[1] ?? "") ? 2 : 1);

  return body.map((held, row) => ({
    path: urlPath,
    line,
    row,
    header,
    cells: cells(held),
  }));
}

function unquoted(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/^\s*(?:>\s?)+/, ""));
}
