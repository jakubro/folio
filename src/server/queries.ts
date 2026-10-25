/**
 * A query's plan: one SELECT whose file references are checked against the served folder and bound to
 * sources folio reads itself, rebuilt as SQL before the engine runs it.
 */

import fs from "node:fs";
import path from "node:path";
import { confine, type Format, formatOf, globOf, isInside, readdir } from "./files.ts";

export interface Reference {
  /** Resolved through symlinks, inside the served folder. */
  file: string;
  format: Format;
  part: string;
}

/** Binds a file, or every file a pattern matched, to a view; matches carry a `filename` column. */
export type Source = (
  reference: Reference | Matched[] | Readers,
  written: string,
) => Promise<string>;

/** A reader handed a pattern's matches, as one statement per batch of them, its rows stacked by name. */
export interface Readers {
  readers: string[];
}

/**
 * A reader over many files holds each file's buffer until its query ends - a JSON reader 32 MiB of address
 * space a file - so a pattern's matches are read a hundred files to a reader.
 */
export const BATCH = 100;

/** A file a pattern matched, with its path in the served folder. */
export interface Matched extends Reference {
  path: string;
}

/** Binds a table of the folder's documents, `folio.<name>` or `kind.<name>`, to a view for the query. */
export type Documents = (schema: "folio" | "kind", name: string) => Promise<string>;

interface Runner {
  runAndReadAll(sql: string, values?: string[]): Promise<{ getRowsJS(): unknown[][] }>;
}

const READERS = new Set([
  "read_csv",
  "read_csv_auto",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
  "read_json_objects",
  "read_parquet",
  "parquet_scan",
]);
const GENERATORS = new Set(["range", "generate_series", "unnest"]);
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const PATTERN = /[*?]/;
/** `JSON.rawJSON`: in every supported Node, though not yet in TypeScript's library. */
export const RAW_JSON = JSON as unknown as { rawJSON(text: string): unknown };

/**
 * Admit one SELECT only; bind each table named like a path to a folder file through `source`, point
 * file readers at folder files, and refuse every other table function. Returns the SQL and its files.
 */
export async function plan(
  runner: Runner,
  sql: string,
  root: string,
  folder: string,
  source: Source,
  documents?: Documents,
): Promise<{ sql: string; files: string[]; documents: string[]; dirs: string[] }> {
  const [[serialized]] = (
    await runner.runAndReadAll("select json_serialize_sql(?::varchar)", [sql])
  ).getRowsJS();
  // Whole numbers past what a double holds - a large literal, an unknown position - are kept as written.
  const tree = JSON.parse(String(serialized), (_, value, context?: { source?: string }) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    /^-?\d+$/.test(context?.source ?? "")
      ? RAW_JSON.rawJSON(context?.source as string)
      : value,
  );

  if (tree.error && !/only select/i.test(tree.error_message)) {
    throw new Error(tree.error_message);
  }

  if (tree.error || tree.statements?.length !== 1) {
    throw new Error(
      "Only one SELECT statement runs in a query; PIVOT and statements that change anything do not.",
    );
  }

  const files = new Set<string>();
  const tables = new Set<string>();
  const dirs = new Set<string>();
  const matched = (name: string) => {
    const found = matches(name, root, folder);

    for (const dir of found.dirs) {
      dirs.add(dir);
    }

    for (const { file } of found.files) {
      files.add(relative(root, file));
    }

    return found.files;
  };
  // Bound once the whole tree is checked, so a refusal never leaves a source half-made and unawaited.
  const bindings: (() => Promise<void>)[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (node === null || typeof node !== "object") {
      return;
    }

    const record = node as Record<string, unknown>;

    if (record.type === "BASE_TABLE" && fileLike(record) && isPattern(String(record.table_name))) {
      const found = matched(String(record.table_name));
      bindings.push(async () => {
        const bound = await source(found, String(record.table_name));
        record.alias ||= record.table_name;
        record.table_name = bound;
      });
    } else if (record.type === "BASE_TABLE" && fileLike(record)) {
      const reference = resolve(String(record.table_name), root, folder);
      files.add(relative(root, reference.file));
      bindings.push(async () => {
        const bound = await source(reference, String(record.table_name));
        record.alias ||= record.table_name;
        record.table_name = bound;
      });
    }

    const schema = record.schema_name;

    if (
      record.type === "BASE_TABLE" &&
      documents &&
      !record.catalog_name &&
      (schema === "folio" || schema === "kind")
    ) {
      const name = String(record.table_name);
      tables.add(`${schema}.${name}`);
      bindings.push(async () => {
        const bound = await documents(schema, name);
        record.alias ||= name;
        record.schema_name = "";
        record.table_name = bound;
      });
    }

    if (record.type === "TABLE_FUNCTION") {
      const call = record.function as { function_name?: string; children?: unknown[] };
      const name = call.function_name ?? "";

      if (READERS.has(name)) {
        const constant = (call.children?.[0] as { value?: { value?: unknown } }) ?? {};

        if (typeof constant.value?.value !== "string") {
          throw new Error(`${name} reads only a file of the folder named in quotes.`);
        }

        if (isPattern(constant.value.value)) {
          const found = matched(constant.value.value);

          if (found.length === 0) {
            throw Object.assign(new Error(`No data file matches ${constant.value.value}.`), {
              dirs: [...dirs],
            });
          }

          const children = call.children as Record<string, unknown>[];
          const files = found.map(({ file }) => file);
          const pattern = constant.value.value;
          const database = found.find(({ format }) => format === "sqlite" || format === "duckdb");
          const stacking = children.find((child) => named(child) === "union_by_name");

          if (database) {
            throw new Error(
              `${name} reads ${pattern}, which matches ${database.path}, a database: narrow the pattern.`,
            );
          }

          if (!stacking) {
            children.push(byName());
          }

          // Batches stack by name and number their rows apart.
          // A reader told to read by position, or to number its rows, is handed every match at once instead.
          const batched =
            files.length > BATCH &&
            record.with_ordinality !== "WITH_ORDINALITY" &&
            (!stacking || isTrue(optionValue(stacking)));
          children[0] = listOf(batched ? files.slice(0, BATCH) : files) as Record<string, unknown>;

          if (batched) {
            bindings.push(async () => {
              const readers: string[] = [];

              for (let at = 0; at < files.length; at += BATCH) {
                children[0] = listOf(files.slice(at, at + BATCH)) as Record<string, unknown>;
                readers.push(
                  await statementOf(runner, {
                    ...record,
                    alias: "",
                    column_name_alias: [],
                    sample: null,
                  }),
                );
              }

              const bound = await source({ readers }, pattern);
              const { alias = "", column_name_alias = [], sample = null } = record;

              for (const key of Object.keys(record)) {
                delete record[key];
              }

              Object.assign(record, baseTable(bound, String(alias)), { column_name_alias, sample });
            });
          }
        } else {
          const reference = resolve(constant.value.value, root, folder);
          files.add(relative(root, reference.file));
          constant.value.value = reference.file;
        }
      } else if (!GENERATORS.has(name)) {
        throw new Error(`A query may not call ${name}.`);
      }
    }

    Object.values(record).forEach(visit);
  };

  visit(tree.statements);
  for (const bind of bindings) {
    await bind();
  }

  const [[rebuilt]] = (
    await runner.runAndReadAll("select json_deserialize_sql(json(?::varchar))", [
      JSON.stringify(tree),
    ])
  ).getRowsJS();

  return { sql: String(rebuilt), files: [...files], documents: [...tables], dirs: [...dirs] };
}

/** Resolve a reference against a folder, or the root after a slash; a whole name beats a split at its last `#`. */
export function resolve(name: string, root: string, folder: string): Reference {
  if (SCHEME.test(name)) {
    throw new Error(`Only the served folder's files can be read, not ${name}.`);
  }

  const hash = name.lastIndexOf("#");
  const whole = locate(name, name, root, folder);

  if (whole) {
    return { ...whole, part: "" };
  }

  const found = hash < 0 ? undefined : locate(name.slice(0, hash), name, root, folder);

  if (!found) {
    const address = hash < 0 ? name : name.slice(0, hash);
    const missing = address.startsWith("/")
      ? path.join(root, address)
      : path.resolve(folder, address);
    throw Object.assign(new Error(`No data file at ${name}.`), { missing });
  }

  return { ...found, part: name.slice(hash + 1) };
}

/** Symlinked folders are not followed, so a walk can neither loop nor leave the served folder. */
function matches(name: string, root: string, folder: string): { files: Matched[]; dirs: string[] } {
  if (SCHEME.test(name)) {
    throw new Error(`Only the served folder's files can be read, not ${name}.`);
  }

  const hash = name.lastIndexOf("#");
  const address = hash < 0 || isPattern(name.slice(hash)) ? name : name.slice(0, hash);
  const part = address === name ? "" : name.slice(hash + 1);
  const pattern = path.posix.normalize(
    address.startsWith("/") ? address.slice(1) : path.posix.join(relative(root, folder), address),
  );

  if (pattern === ".." || pattern.startsWith("../")) {
    throw new Error(`${name} is outside the served folder.`);
  }

  const segments = pattern.split("/");
  const fixed = segments.findIndex((segment) => isPattern(segment));
  const start = confine(root, segments.slice(0, fixed).join("/"));
  const depth = pattern.includes("**") ? Number.POSITIVE_INFINITY : segments.length - fixed;
  const regex = globOf(pattern);
  const files: Matched[] = [];
  const dirs: string[] = [];
  const walk = (dir: string, at: string, left: number) => {
    dirs.push(dir);

    for (const dirent of readdir(dir)) {
      const within = at ? `${at}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        if (left > 1) {
          walk(path.join(dir, dirent.name), within, left - 1);
        }

        continue;
      }

      const real = regex.test(within) ? confine(root, within) : undefined;
      const format = real && formatOf(real);

      if (real && format && format !== "sql" && fs.statSync(real).isFile()) {
        files.push({ file: real, format, part, path: within });
      }
    }
  };

  if (start && fs.statSync(start).isDirectory()) {
    walk(start, segments.slice(0, fixed).join("/"), depth);
  } else {
    // A pattern whose fixed folder is not there yet is heard through the nearest folder that is.
    for (let at = fixed - 1; at >= 0; at--) {
      const there = confine(root, segments.slice(0, at).join("/"));

      if (there) {
        dirs.push(there);
        break;
      }
    }
  }

  return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), dirs };
}

/** A CTE or a view is named plainly; a dot, a slash or a `#` marks a file. */
function fileLike(table: Record<string, unknown>): boolean {
  return !table.schema_name && !table.catalog_name && /[./#]/.test(String(table.table_name));
}

function locate(
  address: string,
  name: string,
  root: string,
  folder: string,
): { file: string; format: Format } | undefined {
  const target = address.startsWith("/") ? path.join(root, address) : path.resolve(folder, address);
  const real = isInside(root, target) ? confine(root, path.relative(root, target)) : undefined;

  // Not inside, or not once resolved: the path or a symlink on it leads out of the folder.
  if (!real && (!isInside(root, target) || fs.existsSync(target))) {
    throw new Error(`${name} is outside the served folder.`);
  }

  const format = real && formatOf(real);
  return real && format && fs.statSync(real).isFile() ? { file: real, format } : undefined;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isPattern(name: string): boolean {
  return PATTERN.test(name);
}

/** An option written `name = value` is a comparison; written `name := value`, the value under that alias. */
function named(child: Record<string, unknown>): string | undefined {
  const left = child.left as { column_names?: string[] } | undefined;
  return child.type === "COMPARE_EQUAL"
    ? left?.column_names?.[0]
    : String(child.alias || "") || undefined;
}

function optionValue(option: Record<string, unknown>): unknown {
  return option.type === "COMPARE_EQUAL" ? option.right : option;
}

/** A table function as a statement of its own, `SELECT * FROM` it, as the engine writes it out. */
async function statementOf(runner: Runner, table: Record<string, unknown>): Promise<string> {
  const [[serialized]] = (
    await runner.runAndReadAll("select json_serialize_sql('select * from range(1)')")
  ).getRowsJS();
  const tree = JSON.parse(String(serialized));
  tree.statements[0].node.from_table = table;
  const [[rebuilt]] = (
    await runner.runAndReadAll("select json_deserialize_sql(json(?::varchar))", [
      JSON.stringify(tree),
    ])
  ).getRowsJS();

  return String(rebuilt);
}

/** The engine writes a boolean option as a constant, or as text cast to a boolean. */
function isTrue(node: unknown): boolean {
  const {
    class: kind,
    value,
    child,
  } = (node ?? {}) as {
    class?: string;
    value?: { value?: unknown };
    child?: { value?: { value?: unknown } };
  };
  const written = kind === "CAST" ? child?.value?.value : value?.value;

  return written === true || /^(t|true|1)$/i.test(String(written));
}

function baseTable(name: string, alias: string): Record<string, unknown> {
  return {
    type: "BASE_TABLE",
    alias,
    sample: null,
    schema_name: "",
    table_name: name,
    column_name_alias: [],
    catalog_name: "",
    at_clause: null,
  };
}

/** `union_by_name = true`, so the matches stack by column name as a pattern in a table name does. */
function byName(): Record<string, unknown> {
  return {
    class: "COMPARISON",
    type: "COMPARE_EQUAL",
    alias: "",
    left: { class: "COLUMN_REF", type: "COLUMN_REF", alias: "", column_names: ["union_by_name"] },
    right: {
      class: "CONSTANT",
      type: "VALUE_CONSTANT",
      alias: "",
      value: { type: { id: "BOOLEAN", type_info: null }, is_null: false, value: true },
    },
  };
}

/** A list of constant paths, as DuckDB serializes `['a', 'b']`, for a reader handed every match. */
function listOf(paths: string[]): unknown {
  return {
    class: "FUNCTION",
    type: "FUNCTION",
    alias: "",
    function_name: "list_value",
    schema: "main",
    children: paths.map((value) => ({
      class: "CONSTANT",
      type: "VALUE_CONSTANT",
      alias: "",
      value: { type: { id: "VARCHAR", type_info: null }, is_null: false, value },
    })),
    filter: null,
    order_bys: { type: "ORDER_MODIFIER", orders: [] },
    distinct: false,
    is_operator: false,
    export_state: false,
    catalog: "",
  };
}
