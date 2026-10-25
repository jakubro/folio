/** Data files read as pages: tables, nested documents and databases, through an engine that only reads. */

import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { DocumentTable } from "./documents.ts";
import { type QueryFence, queriesOf, referencesIn } from "./embeds.ts";
import { type Format, formatOf } from "./files.ts";
import { type BlocksOf, expand, expandText } from "./includes.ts";
import { alive, startOf } from "./processes.ts";
import {
  BATCH,
  type Matched,
  plan,
  RAW_JSON,
  type Readers,
  type Reference,
  resolve,
} from "./queries.ts";
import { fileVersion } from "./versions.ts";

export type Cell = string | number | boolean | null;

interface Column {
  name: string;
  type: string;
}

export interface Grid {
  columns: Column[];
  rows: Cell[][];
  /** How many rows the whole holds, when known. */
  total?: number;
  partial: boolean;
}

export interface DataTable {
  name: string;
  columns: Column[];
  total: number;
  first: Grid;
  /** Why this one table could not be read; the database's other tables still show. */
  error?: string;
}

/** What a document embeds: a file's rows, or the value a part of it names. */
export interface Embedded {
  version: string;
  grid?: Grid;
  value?: unknown;
  error?: string;
}

export interface DataPage {
  format: Format;
  size: number;
  version: string;
  error?: string;
  grid?: Grid;
  value?: unknown;
  /** The start of a nested document too large to read whole, or one that does not parse. */
  text?: string;
  /** What the page leaves out of a file that is otherwise read, and why. */
  note?: string;
  tables?: DataTable[];
  table?: string;
}

const ROWS = 5000;
const EMBED_ROWS = 100_000;
const QUERY_ROWS = 10_000;
const SHARED_KEPT = 64;
const FIRST_ROWS = 10;
const QUERY_MS = 10_000;
const NESTING = 5;
const COPY_BATCH = 5000;
/** Below Node's four worker threads, so one is always free to carry a running query's interruption. */
const RUNNING = 3;
const INTERRUPT_AGAIN_MS = 250;
const MISSING = "missing";
const TREE_BYTES = 20 * 1024 * 1024;
const DEPTH = 1000;
const YAML_BYTES = 2 * 1024 * 1024;
const YAML_MS = 10_000;
/** Enough for compose and CI files, which reuse anchors freely; the thread's memory ceiling stops a blow-up. */
const ALIASES = 10_000;
const YAML_MEMORY_MB = 1024;
const YAML_RUNNING = 2;
const YAML_KEPT = 8;
const YAML_PARSED = new Map<string, Promise<{ json?: string; error?: string }>>();
const yamlWaiting: (() => void)[] = [];
const yamlIdle: Worker[] = [];
let yamlRunning = 0;
const YAML_WORKER = new URL(
  import.meta.url.endsWith(".ts") ? "./yaml-worker.ts" : "./yaml-worker.js",
  import.meta.url,
);
const SQLITE_READER = new URL(
  import.meta.url.endsWith(".ts") ? "./sqlite-reader.ts" : "./sqlite-reader.js",
  import.meta.url,
);
const GRID_BYTES = 16 * 1024 * 1024;
const CELL_CHARS = 20_000;
const CELL_MIN_CHARS = 1000;
const ROW_CHARS = 200_000;
/** Shared by every engine job; joins and sorts past it spill to disk, a single value past it fails. */
const MEMORY_LIMIT = "1GB";
const START_BYTES = 64 * 1024;
const SQLITE_MAGIC = "SQLite format 3\0";
const DELIMITERS = [",", ";", "\t", "|"];
const UNEVEN = "null_padding = true, strict_mode = false";
/**
 * A pattern's CSV buffer, one held per file and thread, is sized to its largest file, whose lines cannot
 * outgrow it, and never past the longest line the engine reads by default, 2 MiB.
 */
const SMALL_BUFFER = 64 * 1024;
const LINE_BUFFER = 2 * 1024 * 1024 + 1024;
/**
 * The engine's readers each hold a buffer per thread, a JSON reader 32 MiB whatever its options, so more
 * threads than the memory limit holds fail a pattern of many files: 3,000 JSON files fail at 16, read at 12.
 */
const THREADS = Math.min(os.availableParallelism(), 8);
const DUCKDB_MAGIC = "DUCK";

type Instance = Awaited<ReturnType<typeof import("@duckdb/node-api").DuckDBInstance.create>>;
type Connection = Awaited<ReturnType<Instance["connect"]>>;

/** The folder's documents as tables, and a version that moves whenever any of them may have changed. */
export interface DocumentTables {
  versionOf(tables: readonly string[]): string;
  table(schema: "folio" | "kind", name: string): DocumentTable | undefined;
}

export type SqliteProgress = { names: string[] } | { table: DataTable };

export type SqliteRequest =
  | { kind: "read"; file: string; table?: string; limit: number }
  | { kind: "export"; file: string; table: string; target?: string };

interface Run {
  connection: Connection;
  deadline: number;
  attached: string[];
  files: Set<string>;
  held: string[];
  /** Each view made for a file the query names, by its place in the folder, so no error shows the view. */
  views: Map<string, string>;
}

/** Whether an error says only that a read or a query ran out of time, which a later try may not. */
export function timedOut(error: string): boolean {
  return / ran longer than [\d.]+ s and was stopped\.$| took longer than [\d.]+ s to read\.$/.test(
    error,
  );
}

/** Reads a served folder's data files; the engine starts on first use. */
export class Data {
  readonly #root: string;
  #blocksOf: BlocksOf | undefined;
  #documents: DocumentTables | undefined;
  /** This process's own folder for spill files and copies; another process serving the folder has its own. */
  readonly #own: string;
  readonly #copies = new Map<string, { source: string; holders: number; stale: boolean }>();
  /** The copies made for queries, by the source they copy, read from their folder once. */
  #versions: Map<string, Set<string>> | undefined;
  readonly #converting = new Map<string, Promise<void>>();
  readonly #shapes = new Map<string, { columns: DocumentTable["columns"]; empty: boolean }>();
  /** A document table's copy as read into the engine, and the engine's tables of retired copies. */
  readonly #loaded = new Map<string, { table: string; ready: Promise<void> }>();
  readonly #dropping: string[] = [];
  /** The last run of each query, by folder and text, the most recently asked last. */
  readonly #queries = new Map<
    string,
    { version: string; run: Promise<{ grid: Grid; files: string[] }> }
  >();
  #instance: Promise<Instance> | undefined;
  #attached = 0;
  #views = 0;
  readonly #queryMs: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  /** `scratch` takes the engine's spill files, so it must lie outside the served folder. */
  constructor(root: string, scratch: string, queryMs = QUERY_MS) {
    this.#root = root;
    this.#own = path.join(scratch, "engine", `${process.pid}-${startOf("self")}`);
    this.#queryMs = queryMs;
  }

  async page(file: string, version: string, table?: string): Promise<DataPage> {
    const format = await sniff(file);
    const size = fs.statSync(file).size;
    const base = { format, size, version };

    try {
      switch (format) {
        case "json":
        case "yaml":
          return { ...base, ...(await nested(file, format, size)) };
        case "sqlite":
          return { ...base, ...(await this.#readSqlite(file, table)) };
        case "duckdb":
          return { ...base, ...(await this.#database(file, table)) };
        case "sql": {
          const text = fs.readFileSync(file, "utf8");
          const ran = await this.query(text, path.dirname(file), QUERY_ROWS).catch(
            (error: unknown) => error,
          );
          return ran instanceof Error || !("grid" in (ran as object))
            ? { ...base, text, error: this.#message(ran) }
            : { ...base, text, grid: (ran as { grid: Grid }).grid };
        }
        default:
          return { ...base, ...(await this.#tabular(file, format)) };
      }
    } catch (error) {
      return { ...base, error: this.#message(error) };
    }
  }

  /**
   * Read what a part of a data file names: a database's table, or a path into a file's value - a
   * tabular file being its list of records - whose dotted steps are keys or list positions.
   */
  async embed(file: string, version: string, part: string): Promise<Embedded> {
    try {
      const format = await sniff(file);

      if (format === "sqlite" || format === "duckdb") {
        if (!part) {
          return { version, error: "Name one of the database's tables after a #." };
        }

        const read =
          format === "sqlite"
            ? await this.#readSqlite(file, part, EMBED_ROWS)
            : await this.#database(file, part, EMBED_ROWS);
        return { version, ...(read.error ? { error: read.error } : { grid: read.grid }) };
      }

      if (format === "sql") {
        return this.embedQuery(fs.readFileSync(file, "utf8"), path.dirname(file), version, part);
      }

      if (format === "json" || format === "yaml") {
        const read = await nested(file, format, fs.statSync(file).size);

        if (read.error || read.value === undefined) {
          return { version, error: read.error ?? "The file is too large to embed." };
        }

        return { version, value: walk(read.value, part) };
      }

      const read = await this.#tabular(file, format, EMBED_ROWS);

      if (read.error || !read.grid) {
        return { version, error: read.error ?? "The file holds no rows." };
      }

      return part
        ? { version, value: walk(records(read.grid), part) }
        : { version, grid: read.grid };
    } catch (error) {
      return { version, error: this.#message(error) };
    }
  }

  /** Embed a query's result, or the value a part of it names, as a file's rows are embedded. */
  async embedQuery(sql: string, folder: string, version: string, part: string): Promise<Embedded> {
    try {
      const { grid } = await this.#shared(sql, folder, version);
      return part ? { version, value: walk(records(grid), part) } : { version, grid };
    } catch (error) {
      return { version, error: this.#message(error) };
    }
  }

  /**
   * Run one SELECT whose file references resolve against `folder`, stopping it after 10 s and
   * keeping the first `limit` rows; it reads only the served folder. Names the files it read.
   */
  async query(sql: string, folder: string, limit = ROWS): Promise<{ grid: Grid; files: string[] }> {
    return this.#with(async (connection, deadline) => {
      const run: Run = {
        connection,
        deadline,
        attached: [],
        files: new Set(),
        held: [],
        views: new Map(),
      };

      try {
        const planned = await this.#plan(run, sql, folder, []);
        const grid = await gridOf(connection, planned, limit);
        return { grid, files: [...run.files] };
      } catch (error) {
        let text = message(error);

        // Longest first, so a view numbered 1 never eats into one numbered 10.
        for (const [view, name] of [...run.views].sort(([a], [b]) => b.length - a.length)) {
          text = text.replaceAll(view, name);
        }

        throw new Error(this.#placed(text));
      } finally {
        for (const alias of run.attached) {
          await connection.run(`detach ${alias}`).catch(() => {});
        }

        this.#release(run.held);
      }
    }, "The query");
  }

  /** Lend the folder model's blocks, so a document's part includes expand as its page shows them. */
  useBlocks(blocksOf: BlocksOf): void {
    this.#blocksOf = blocksOf;
  }

  /** Names the state of the document tables given: it moves only when a change reaches one of them. */
  documentsVersion(tables: readonly string[]): string {
    return this.#documents?.versionOf(tables) ?? "";
  }

  /** Lend the folder's documents as tables, so queries read `folio.<name>` and `kind.<name>`. */
  useDocuments(documents: DocumentTables): void {
    this.#documents = documents;
  }

  /** A piece of a document's text as its page shows it, includes expanded. */
  shown(file: string, text: string): string {
    return expandText(this.#root, file, text, this.#blocksOf).text;
  }

  /** A document's queries as its page shows and runs them, includes expanded. */
  documentQueries(file: string): QueryFence[] {
    return queriesOf(expand(this.#root, file, this.#blocksOf));
  }

  /** The data files a document's embeds, charts and queries read, as paths in the folder. */
  async dependencies(file: string): Promise<string[]> {
    const text = fs.readFileSync(file, "utf8");
    return this.dependenciesFrom(
      file,
      referencesIn(text),
      this.documentQueries(file).map(({ sql }) => sql),
    );
  }

  /** The data files a document's embeds and queries read, from what they name, already parsed. */
  async dependenciesFrom(file: string, references: string[], sqls: string[]): Promise<string[]> {
    const folder = path.dirname(file);
    const found = new Set<string>();
    const queries = sqls.map((sql) => ({ sql, folder }));

    for (const reference of references) {
      if (reference.startsWith("#")) {
        continue;
      }

      try {
        const { file: read, format } = resolve(reference, this.#root, folder);
        found.add(this.#relative(read));

        if (format === "sql") {
          queries.push({ sql: fs.readFileSync(read, "utf8"), folder: path.dirname(read) });
        }
      } catch {
        // A reference that resolves to nothing reads nothing; the page shows why.
      }
    }

    for (const { sql, folder: from } of queries) {
      const { files } = await this.#queryFiles(sql, from, []).catch(() => ({ files: [] }));

      for (const read of files) {
        found.add(read);
      }
    }

    return [...found].sort();
  }

  /**
   * Embed what a reference written in the document `from` names - a data file, a `.sql` file, or
   * `#<name>` for one of the document's own queries - versioned by every file it reads.
   */
  async embedReference(from: string, reference: string): Promise<Embedded> {
    const { version } = await this.reads(from, reference);
    const folder = path.dirname(from);

    if (reference.startsWith("#")) {
      const [key, ...part] = reference.slice(1).split("#");
      const fence = this.#fenceOf(from, key);

      return fence
        ? { ...(await this.embedQuery(fence.sql, folder, version, part.join("#"))), version }
        : { version, error: `No query named ${key} in this document.` };
    }

    try {
      const { file, part } = resolve(reference, this.#root, folder);
      return { ...(await this.embed(file, version, part)), version };
    } catch (error) {
      return { version, error: (error as Error).message };
    }
  }

  /**
   * The files a reference in the document `from` reads, through its queries, and a missing one; its
   * version moves with each of them and, for one of the document's own queries, with that query's text.
   */
  async reads(
    from: string,
    reference: string,
  ): Promise<{
    files: string[];
    version: string;
    missing?: string;
    tables?: string[];
    dirs?: string[];
  }> {
    try {
      const { files, sql, documents, dirs } = await this.#readsOf(from, reference);
      const moved = documents.length > 0 ? `${sql}\0${this.#documents?.versionOf(documents)}` : sql;
      return {
        files,
        version: versionOf(files, moved),
        ...(documents.length > 0 && { tables: documents }),
        ...(dirs.length > 0 && { dirs }),
      };
    } catch (error) {
      const { missing, dirs } = error as { missing?: string; dirs?: string[] };
      return { files: [], version: MISSING, ...(missing && { missing }), ...(dirs && { dirs }) };
    }
  }

  async close(): Promise<void> {
    const instance = await this.#instance;
    instance?.closeSync();
  }

  /**
   * Embeds sharing a query share its run at one version of all it reads: asked while it runs or after,
   * until that version moves, the query runs once for all of them. Without a version nothing is shared.
   */
  #shared(sql: string, folder: string, version: string): Promise<{ grid: Grid; files: string[] }> {
    if (!version) {
      return this.query(sql, folder, QUERY_ROWS);
    }

    const key = `${folder}\0${sql}`;
    const held = this.#queries.get(key);

    if (held?.version === version) {
      this.#queries.delete(key);
      this.#queries.set(key, held);
      return held.run;
    }

    const run = this.query(sql, folder, QUERY_ROWS);
    this.#queries.delete(key);
    this.#queries.set(key, { version, run });
    run.catch(() => {
      if (this.#queries.get(key)?.run === run) {
        this.#queries.delete(key);
      }
    });

    for (const oldest of [...this.#queries.keys()].slice(0, -SHARED_KEPT)) {
      this.#queries.delete(oldest);
    }

    return run;
  }

  /**
   * A malformed file is read again leniently, so the page shows what parses beside the whole of what went
   * wrong and how many rows it had to leave out.
   */
  async #tabular(file: string, format: Format, limit = ROWS): Promise<Partial<DataPage>> {
    const complete = format === "jsonl" ? unfinished(file) : undefined;
    const read = complete === undefined ? file : this.#cut(file, complete);
    const note =
      complete === undefined
        ? {}
        : { note: "The last line is not complete yet, so it is left out." };

    try {
      return { grid: await this.#grid(scan(read, format, false), limit), ...note };
    } catch (error) {
      if (format === "parquet") {
        throw error;
      }

      const lenient = await this.#with(async (connection) => {
        const grid = await gridOf(
          connection,
          `select * from ${scan(read, format, true)}`,
          limit,
          true,
        );
        const dropped =
          format === "jsonl"
            ? 0
            : Number(
                (
                  await connection.runAndReadAll("select count(*) from reject_errors")
                ).getRowsJS()[0][0],
              );
        return { grid, dropped };
      }).catch(() => undefined);
      const left = lenient?.dropped
        ? `\n\n${lenient.dropped} ${lenient.dropped === 1 ? "row" : "rows"} could not be read and ${lenient.dropped === 1 ? "is" : "are"} left out.`
        : "";

      return {
        error: `${this.#message(error, true)}${left}`,
        ...(lenient && { grid: lenient.grid }),
        ...note,
      };
    }
  }

  /** A file's complete lines, copied once per version beside the spill files, the older copies removed. */
  #cut(file: string, bytes: number): string {
    const stat = fs.statSync(file);
    const stem = createHash("sha1").update(file).digest("hex").slice(0, 16);
    const folder = path.join(this.#own, "cut");
    const target = path.join(folder, `${stem}-${stat.mtimeMs}-${stat.size}.jsonl`);

    fs.mkdirSync(folder, { recursive: true });

    if (!fs.existsSync(target)) {
      const written = `${target}.${randomUUID()}.tmp`;
      const handle = fs.openSync(file, "r");
      const buffer = Buffer.alloc(bytes);

      try {
        fs.readSync(handle, buffer, 0, bytes, 0);
      } finally {
        fs.closeSync(handle);
      }

      fs.writeFileSync(written, buffer);
      fs.renameSync(written, target);
    }

    for (const old of fs.readdirSync(folder)) {
      const copy = path.join(folder, old);

      if (old.startsWith(`${stem}-`) && copy !== target && !old.endsWith(".tmp")) {
        fs.rmSync(copy, { force: true });
        this.#copies.delete(copy);
      }
    }

    this.#copies.set(target, { source: this.#relative(file), holders: 0, stale: false });
    return target;
  }

  /** The engine names files by their absolute path; the reader knows them by their place in the folder. */
  #message(error: unknown, whole = false): string {
    const text = error instanceof Error ? error.message : String(error);

    if (/^INTERRUPT Error/.test(text)) {
      return this.#stopped("The read");
    }

    return this.#placed(whole ? text.trim() : message(error));
  }

  #placed(text: string): string {
    let shown = text;

    for (const [copy, { source }] of this.#copies) {
      shown = shown.replaceAll(copy, source);
    }

    return shown
      .replaceAll(`${this.#own}${path.sep}`, "")
      .replaceAll(`${this.#root}${path.sep}`, "");
  }

  async #grid(source: string, limit: number): Promise<Grid> {
    return this.#with((connection) => gridOf(connection, `select * from ${source}`, limit));
  }

  async #database(file: string, table?: string, limit = ROWS): Promise<Partial<DataPage>> {
    return this.#with(async (connection) => {
      const alias = `folio_${++this.#attached}`;

      await connection.run(`attach ${literal(file)} as ${alias} (read_only)`);

      try {
        const found = (
          await connection.runAndReadAll(
            `select schema_name, table_name from duckdb_tables() where database_name = ${literal(alias)}
             union select schema_name, view_name from duckdb_views() where database_name = ${literal(alias)} and not internal`,
          )
        )
          .getRowsJS()
          .map(([schema, name]) => ({ schema: String(schema), name: String(name) }));
        // A table outside the main schema is named with its schema, as a query names it.
        const named = new Map(
          found.map(({ schema, name }) => [
            schema === "main" ? name : `${schema}.${name}`,
            { schema, name },
          ]),
        );
        const names = [...named.keys()].sort();
        const read = async (name: string, limit: number): Promise<DataTable> => {
          const { schema, name: bare } = named.get(name) as { schema: string; name: string };
          const qualified = `${alias}.${identifier(schema)}.${identifier(bare)}`;
          const first = await gridOf(connection, `select * from ${qualified}`, limit);
          const counted = await connection.runAndReadAll(`select count(*) from ${qualified}`);
          const total = Number(counted.getRowsJS()[0][0]);

          return { name, columns: first.columns, total, first: { ...first, total } };
        };

        if (table !== undefined) {
          if (!names.includes(table)) {
            return { table, error: `No table named ${table} in this database.` };
          }

          const one = await read(table, limit).catch((error: unknown) => ({
            error: this.#message(error),
          }));
          return "error" in one && one.error
            ? { table, error: one.error }
            : { table, grid: (one as DataTable).first };
        }

        const tables: DataTable[] = [];

        for (const name of names) {
          tables.push(
            await read(name, FIRST_ROWS).catch((error: unknown) =>
              broken(name, this.#message(error)),
            ),
          );
        }

        return { tables };
      } finally {
        await connection.run(`detach ${alias}`);
      }
    });
  }

  async #readsOf(
    from: string,
    reference: string,
  ): Promise<{ files: string[]; sql: string; documents: string[]; dirs: string[] }> {
    const folder = path.dirname(from);
    const absolute = (files: string[]) => files.map((file) => path.join(this.#root, file));

    if (reference.startsWith("#")) {
      const fence = this.#fenceOf(from, reference.slice(1).split("#")[0]);

      if (!fence) {
        return { files: [], sql: "", documents: [], dirs: [] };
      }

      const { files, documents, dirs } = await this.#queryFiles(fence.sql, folder, []);
      return { files: absolute(files), sql: fence.sql, documents, dirs };
    }

    const { file, format } = resolve(reference, this.#root, folder);

    if (format !== "sql") {
      return { files: [file], sql: "", documents: [], dirs: [] };
    }

    const text = fs.readFileSync(file, "utf8");
    const { files, documents, dirs } = await this.#queryFiles(text, path.dirname(file), [file]);
    return { files: [file, ...absolute(files)], sql: "", documents, dirs };
  }

  /** The files a query in the document `file` reads, and the one it names that is not there. */
  async queryReads(
    file: string,
    sql: string,
  ): Promise<{ files: string[]; missing?: string; tables?: string[]; dirs?: string[] }> {
    try {
      const { files, documents, dirs } = await this.#queryFiles(sql, path.dirname(file), []);
      return {
        files,
        ...(documents.length > 0 && { tables: documents }),
        ...(dirs.length > 0 && { dirs }),
      };
    } catch (error) {
      const { missing, dirs } = error as { missing?: string; dirs?: string[] };
      return { files: [], ...(missing && { missing }), ...(dirs && { dirs }) };
    }
  }

  #fenceOf(from: string, key: string): QueryFence | undefined {
    return this.documentQueries(from).find((query) =>
      key.startsWith("@") ? `@${query.line}` === key : query.name === key,
    );
  }

  async #queryFiles(
    sql: string,
    folder: string,
    nesting: string[],
  ): Promise<{ files: string[]; documents: string[]; dirs: string[] }> {
    return this.#with((connection) => this.#filesOf(connection, sql, folder, nesting));
  }

  /** Nested queries are planned on the same connection, so planning never waits on itself for one. */
  async #filesOf(
    connection: Connection,
    sql: string,
    folder: string,
    nesting: string[],
  ): Promise<{ files: string[]; documents: string[]; dirs: string[] }> {
    const nested: { files: string[]; documents: string[]; dirs: string[] } = {
      files: [],
      documents: [],
      dirs: [],
    };
    const planned = await plan(
      connection,
      sql,
      this.#root,
      folder,
      async (reference) => {
        const { file, format } =
          Array.isArray(reference) || "readers" in reference ? { file: "", format: "" } : reference;

        if (format === "sql" && !nesting.includes(file) && nesting.length < NESTING) {
          const text = fs.readFileSync(file, "utf8");
          const inner = await this.#filesOf(connection, text, path.dirname(file), [
            ...nesting,
            file,
          ]);
          nested.files.push(...inner.files);
          nested.documents.push(...inner.documents);
          nested.dirs.push(...inner.dirs);
        }

        return "folio_unread";
      },
      this.#documents && (async () => "folio_unread"),
    );

    return {
      files: [...planned.files, ...nested.files],
      documents: [...planned.documents, ...nested.documents],
      dirs: [...planned.dirs, ...nested.dirs],
    };
  }

  #stopped(what: string): string {
    return `${what} ran longer than ${this.#queryMs / 1000} s and was stopped.`;
  }

  #relative(file: string): string {
    return path.relative(this.#root, file).split(path.sep).join("/");
  }

  async #plan(run: Run, sql: string, folder: string, nesting: string[]): Promise<string> {
    const planned = await plan(
      run.connection,
      sql,
      this.#root,
      folder,
      (reference, written) => this.#source(run, reference, nesting, written),
      this.#documents && ((schema, name) => this.#documentView(run, schema, name)),
    );

    for (const file of planned.files) {
      run.files.add(file);
    }

    return planned.sql;
  }

  /**
   * Written once per version of the table, and read with its columns named so an empty table keeps them;
   * a version already written is read again without building the table.
   */
  async #documentView(run: Run, schema: "folio" | "kind", name: string): Promise<string> {
    const documents = this.#documents as DocumentTables;
    const folder = path.join(this.#own, "documents");
    const stem = `${schema}.${name}@`;
    const target = path.join(folder, `${stem}${documents.versionOf([`${schema}.${name}`])}.jsonl`);
    let shape = this.#shapes.get(target);

    if (!shape || !fs.existsSync(target)) {
      const table = documents.table(schema, name);

      if (!table) {
        throw new Error(
          schema === "kind"
            ? `No kind is named ${name}: a declaration names the kinds a query reads.`
            : `No table is named folio.${name}: folio has documents, headings, links, tasks, frontmatter and tables.`,
        );
      }

      fs.mkdirSync(folder, { recursive: true });
      const written = `${target}.${randomUUID()}.tmp`;
      fs.writeFileSync(written, table.rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
      fs.renameSync(written, target);
      shape = { columns: table.columns, empty: table.rows.length === 0 };
      this.#shapes.set(target, shape);

      for (const old of fs.readdirSync(folder)) {
        const copy = path.join(folder, old);

        if (old.startsWith(stem) && copy !== target && !old.endsWith(".tmp")) {
          this.#shapes.delete(copy);
          this.#retire(copy);
        }
      }
    }

    this.#copies.set(target, {
      source: `${schema}.${name}`,
      holders: (this.#copies.get(target)?.holders ?? 0) + 1,
      stale: false,
    });
    run.held.push(target);

    const columns = shape.columns.map(
      ({ name: column, type }) => `${literal(column)}: ${literal(type)}`,
    );
    const view = `folio_view_${++this.#views}`;
    const body = shape.empty
      ? `select ${shape.columns.map((column) => `null::${column.type} as ${identifier(column.name)}`).join(", ")} where false`
      : `select * from read_json(${literal(target)}, format = 'newline_delimited', columns = {${columns.join(", ")}})`;

    for (const table of this.#dropping.splice(0)) {
      await run.connection.run(`drop table if exists ${table}`);
    }

    // The copy is read into a table of the engine once per version, which every query then reads.
    let loaded = this.#loaded.get(target);

    if (!loaded) {
      const table = `folio_documents_${++this.#views}`;
      const once: { table: string; ready: Promise<void> } = {
        table,
        ready: run.connection.run(`create table ${table} as ${body}`).then(() => {}),
      };
      once.ready.catch(() => {
        if (this.#loaded.get(target) === once) {
          this.#loaded.delete(target);
        }
      });
      this.#loaded.set(target, once);
      loaded = once;
    }

    await loaded.ready;
    await run.connection.run(`create temp view ${view} as select * from ${loaded.table}`);
    run.views.set(view, `${schema}.${name}`);
    run.views.set(loaded.table, `${schema}.${name}`);
    return view;
  }

  /**
   * CSV, TSV and Parquet matches read alike go through one reader over a hundred of them, as a reader per
   * file holds its buffers and soon passes the memory limit; a JSON or YAML file is read on its own, since
   * one reader over several makes every file's rows take the shape of the least regular one.
   */
  async #matched(run: Run, found: Matched[], nesting: string[], written: string): Promise<string> {
    const groups = new Map<string, Matched[]>();
    const bodies: string[] = [];
    // How often each file is already in a group: one a file reaches twice, by a link, goes into another.
    const placed = new Map<string, number>();
    const yaml = found.filter(({ format }) => format === "yaml");
    const copies = new Map(
      (await this.#convertedAll(run, yaml)).map((copy, at) => [yaml[at], copy] as const),
    );

    for (const match of found) {
      const { format, file, path: at, part } = match;

      if (format === "sqlite" || format === "duckdb") {
        if (!part) {
          throw new Error(
            `${written} matches ${at}, a database: name one of its tables after a #, or narrow the pattern.`,
          );
        }

        bodies.push(named(at, await this.#source(run, match, nesting)));
      } else if (format === "json" || format === "yaml") {
        bodies.push(named(at, `read_json(${literal(copies.get(match) ?? file)})`));
      } else if (format === "jsonl") {
        bodies.push(named(at, scan(file, format, false)));
      } else {
        const times = placed.get(file) ?? 0;
        const key = `${format}\0${format === "csv" ? JSON.stringify(layoutOf(file)) : ""}\0${times}`;
        const group = groups.get(key) ?? [];
        group.push(match);
        groups.set(key, group);
        placed.set(file, times + 1);
      }
    }

    for (const matches of groups.values()) {
      for (let at = 0; at < matches.length; at += BATCH) {
        bodies.push(this.#stacked(matches.slice(at, at + BATCH)));
      }
    }

    return this.#stack(run, bodies, written);
  }

  /** One view over every part, in nests of a hundred so no statement grows too deep to parse. */
  async #stack(run: Run, bodies: string[], written: string): Promise<string> {
    let parts = bodies;

    while (parts.length > BATCH) {
      const nests: string[] = [];

      for (let at = 0; at < parts.length; at += BATCH) {
        nests.push(`select * from (${parts.slice(at, at + BATCH).join(" union all by name ")})`);
      }

      parts = nests;
    }

    const view = `folio_view_${++this.#views}`;
    await run.connection.run(
      `create temp view ${view} as ${parts.join(" union all by name ") || "select null::varchar as filename where false"}`,
    );
    run.views.set(view, `'${written}'`);
    return view;
  }

  /**
   * The reader names each row's file in a column of its own, renamed `filename`; a column of that name in
   * the files themselves then becomes `filename_1`, as the engine renames a name taken twice.
   */
  #stacked(matches: Matched[]): string {
    const { format } = matches[0];
    const column = identifier(`folio_file_${++this.#views}`);
    const files = `[${matches.map(({ file }) => literal(file)).join(", ")}]`;
    const stacking = `union_by_name = true, filename = ${literal(column.slice(1, -1))}`;
    let source: string;

    if (format === "csv" || format === "tsv") {
      const { delimiter, skip } =
        format === "csv" ? layoutOf(matches[0].file) : { delimiter: "\t", skip: 0 };
      const largest = Math.max(...matches.map(({ file }) => fs.statSync(file).size));
      const buffer = Math.min(Math.max(largest + 1, SMALL_BUFFER), LINE_BUFFER);
      source = `read_csv(${files}, delim = ${literal(delimiter)}, ${skip > 0 ? `skip = ${skip}, ` : ""}${UNEVEN}, buffer_size = ${buffer}, ${stacking})`;
    } else {
      source = `read_parquet(${files}, ${stacking})`;
    }

    // A match reached through a link is read at its target, which only a lookup ties back to its path.
    const direct = matches.every(({ file, path: at }) => file === path.join(this.#root, at));
    const name = direct
      ? `substr(${column}, length(${literal(this.#root + path.sep)}) + 1)`
      : `map {${matches.map(({ file, path: at }) => `${literal(file)}: ${literal(at)}`).join(", ")}}[${column}]`;

    return `select * from (select ${name} as filename, * exclude (${column}) from ${source})`;
  }

  /**
   * The engine's interruption cannot stop a conversion, so the query stops at its deadline instead, and
   * the conversions go on to be kept for the next run.
   */
  async #convertedAll(run: Run, matches: Matched[]): Promise<string[]> {
    const converted = Promise.all(
      matches.map(({ file, path: at }) =>
        this.#converted(run, file).catch((error: Error) => {
          throw new Error(`${at}: ${error.message}`);
        }),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(this.#stopped("The query"))),
        Math.max(0, run.deadline - Date.now()),
      );
    });

    converted.catch(() => {});

    try {
      return await Promise.race([converted, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every file a query names becomes a view on the query's own connection, gone when it closes. */
  async #source(
    run: Run,
    reference: Reference | Matched[] | Readers,
    nesting: string[],
    written = "",
  ): Promise<string> {
    if (Array.isArray(reference)) {
      return this.#matched(run, reference, nesting, written);
    }

    if ("readers" in reference) {
      return this.#stack(
        run,
        reference.readers.map((reader) => `select * from (${reader})`),
        written,
      );
    }

    const { file, format, part } = reference;
    const { connection } = run;
    const view = `folio_view_${++this.#views}`;
    let body: string;

    if ((format === "sqlite" || format === "duckdb") && !part) {
      throw new Error(`Name one of ${path.basename(file)}'s tables after a #.`);
    }

    if (format === "sqlite") {
      body = await this.#exported(run, file, part);
    } else if (format === "duckdb") {
      const alias = `folio_${++this.#attached}`;
      await connection.run(`attach ${literal(file)} as ${alias} (read_only)`);
      run.attached.push(alias);
      const dot = part.indexOf(".");
      body =
        dot < 0
          ? `select * from ${alias}.${identifier(part)}`
          : `select * from ${alias}.${identifier(part.slice(0, dot))}.${identifier(part.slice(dot + 1))}`;
    } else if (format === "yaml") {
      body = `select * from read_json(${literal(await this.#converted(run, file))})`;
    } else if (format === "json") {
      body = `select * from read_json(${literal(file)})`;
    } else if (format === "sql") {
      if (nesting.includes(file) || nesting.length >= NESTING) {
        throw new Error(`${path.basename(file)} uses itself, or queries nest too deep.`);
      }

      const text = fs.readFileSync(file, "utf8");
      body = await this.#plan(run, text, path.dirname(file), [...nesting, file]);
    } else {
      body = `select * from ${scan(file, format, false)}`;
    }

    await connection.run(`create temp view ${view} as ${body}`);
    run.views.set(view, `'${this.#relative(file)}${part ? `#${part}` : ""}'`);
    return view;
  }

  /**
   * A YAML file is read as the JSON it holds, kept beside the engine's spill files per version.
   * Asked again while it is made - by a query run again after one stopped waiting - it is made once.
   */
  async #converted(run: Run, file: string): Promise<string> {
    const target = this.#copy(run, file, "json");
    let making = this.#converting.get(target);

    if (!making) {
      making = this.#convert(file, target).finally(() => this.#converting.delete(target));
      this.#converting.set(target, making);
    }

    await making;
    return target;
  }

  async #convert(file: string, target: string): Promise<void> {
    if (!fs.existsSync(target)) {
      if (fs.statSync(file).size > YAML_BYTES) {
        throw new Error(`${path.basename(file)} is too large to query.`);
      }

      const { json, error } = await yamlJson(file, fs.readFileSync(file, "utf8"));

      if (json === undefined || error) {
        throw new Error(error ?? "The file holds no value.");
      }

      const written = `${target}.${randomUUID()}.tmp`;
      fs.writeFileSync(written, json.startsWith("[") ? json : `[${json}]`);
      fs.renameSync(written, target);
    }
  }

  /** A SQLite table is copied out as JSON Lines, since only an immutable read writes nothing beside it. */
  async #exported(run: Run, file: string, table: string): Promise<string> {
    const target = this.#copy(run, file, "jsonl", table);
    const written = fs.existsSync(target) ? undefined : `${target}.${randomUUID()}.tmp`;

    try {
      const columns = await sqliteReader<Column[]>(
        { kind: "export", file, table, target: written },
        run.deadline,
        this.#stopped("The query"),
      );

      if (written) {
        fs.renameSync(written, target);
      }

      return fs.statSync(target).size === 0
        ? `select ${columns.map(({ name }) => `null as ${identifier(name)}`).join(", ")} where false`
        : `select * from read_json(${literal(target)}, format = 'newline_delimited')`;
    } finally {
      if (written) {
        fs.rmSync(written, { force: true });
      }
    }
  }

  /** A listing stopped part way keeps the tables it read; the one it was reading, and those after, say why. */
  async #readSqlite(file: string, table?: string, limit = ROWS): Promise<Partial<DataPage>> {
    return this.#with(async (_, deadline) => {
      let names: string[] | undefined;
      const read: DataTable[] = [];

      try {
        return await sqliteReader<Partial<DataPage>>(
          { kind: "read", file, table, limit },
          deadline,
          this.#stopped("The read"),
          (progress) => {
            if ("names" in progress) {
              names = progress.names;
            } else {
              read.push(progress.table);
            }
          },
        );
      } catch (error) {
        if (table !== undefined || names === undefined) {
          throw error;
        }

        return {
          tables: names.map(
            (name, index) =>
              read[index] ??
              broken(
                name,
                index === read.length
                  ? (error as Error).message
                  : `Not read: ${(error as Error).message}`,
              ),
          ),
        };
      }
    });
  }

  /**
   * One copy per source and version, held by the query that reads it: naming a new version removes the
   * copies of older ones, each as soon as no running query holds it.
   */
  #copy(run: Run, file: string, extension: string, table?: string): string {
    const stat = fs.statSync(file);
    const key = table === undefined ? file : `${file}#${table}`;
    const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);
    const stem = hash(key);
    const folder = path.join(this.#own, "read");
    const target = path.join(
      folder,
      `${stem}-${hash(`${stat.mtimeMs}\0${stat.size}`)}.${extension}`,
    );

    fs.mkdirSync(folder, { recursive: true });

    if (!this.#versions) {
      this.#versions = new Map();

      for (const old of fs.readdirSync(folder).filter((name) => !name.endsWith(".tmp"))) {
        const of = old.slice(0, old.indexOf("-"));
        this.#versions.set(
          of,
          new Set([...(this.#versions.get(of) ?? []), path.join(folder, old)]),
        );
      }
    }

    const versions = this.#versions.get(stem) ?? new Set<string>();

    for (const copy of versions) {
      if (copy !== target) {
        versions.delete(copy);
        this.#retire(copy);
      }
    }

    versions.add(target);
    this.#versions.set(stem, versions);
    this.#copies.set(target, {
      source: `${this.#relative(file)}${table === undefined ? "" : `#${table}`}`,
      holders: (this.#copies.get(target)?.holders ?? 0) + 1,
      stale: false,
    });
    run.held.push(target);
    return target;
  }

  #retire(copy: string): void {
    const held = this.#copies.get(copy);

    if (held?.holders) {
      held.stale = true;
    } else {
      this.#copies.delete(copy);
      fs.rmSync(copy, { force: true });

      const loaded = this.#loaded.get(copy);

      if (loaded) {
        this.#loaded.delete(copy);
        this.#dropping.push(loaded.table);
      }
    }
  }

  #release(held: string[]): void {
    for (const copy of held) {
      const entry = this.#copies.get(copy);

      if (entry && --entry.holders === 0 && entry.stale) {
        this.#retire(copy);
      }
    }
  }

  /**
   * Every engine job is stopped at the time limit, counted from when its turn comes, so time queued behind
   * slow jobs is never its own; it is interrupted again until it ends, as an early interruption is lost.
   */
  async #with<T>(
    work: (connection: Connection, deadline: number) => Promise<T>,
    what = "The read",
  ): Promise<T> {
    if (this.#running < RUNNING) {
      this.#running++;
    } else {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }

    try {
      const connection = await (await this.#engine()).connect();
      const deadline = Date.now() + this.#queryMs;
      let timer: NodeJS.Timeout;
      const stop = () => {
        connection.interrupt();
        timer = setTimeout(stop, INTERRUPT_AGAIN_MS);
      };
      timer = setTimeout(stop, this.#queryMs);

      try {
        return await work(connection, deadline);
      } catch (error) {
        throw /interrupt/i.test(message(error)) ? new Error(this.#stopped(what)) : error;
      } finally {
        clearTimeout(timer);
        connection.closeSync();
      }
    } finally {
      const next = this.#waiting.shift();

      if (next) {
        next();
      } else {
        this.#running--;
      }
    }
  }

  /** A start that failed is tried again on the next request; only the start that failed is forgotten. */
  #engine(): Promise<Instance> {
    if (!this.#instance) {
      const starting = this.#start();

      this.#instance = starting;
      starting.catch(() => {
        if (this.#instance === starting) {
          this.#instance = undefined;
        }
      });
    }

    return this.#instance;
  }

  /**
   * Confined before any query runs: only the served folder is readable, nothing is writable through
   * a setting, and the settings are locked so no later statement can widen them.
   */
  async #start(): Promise<Instance> {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const spill = this.#own;
    const engines = path.dirname(spill);

    // Folders of processes that have stopped hold copies of files that may since have changed or gone.
    // A folder names its process by id and start time, as a stopped process's id may be taken again.
    fs.mkdirSync(engines, { recursive: true });

    for (const entry of fs.readdirSync(engines)) {
      const [, pid, start] = /^(\d+)(?:-(\d+))?$/.exec(entry) ?? [];
      const live = pid !== undefined && alive(Number(pid), start);

      if (path.join(engines, entry) !== spill && !live) {
        fs.rmSync(path.join(engines, entry), { recursive: true, force: true });
      }
    }

    fs.mkdirSync(spill, { recursive: true });
    const instance = await DuckDBInstance.create(":memory:", {
      temp_directory: spill,
      memory_limit: MEMORY_LIMIT,
      threads: String(THREADS),
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
    });

    try {
      const connection = await instance.connect();

      try {
        await connection.run(
          `set allowed_directories = [${literal(this.#root + path.sep)}, ${literal(spill + path.sep)}]`,
        );
        await connection.run("set enable_external_access = false");
        await connection.run("set lock_configuration = true");
      } finally {
        connection.closeSync();
      }
    } catch (error) {
      instance.closeSync();
      throw error;
    }

    return instance;
  }
}

/** The bytes of a JSON Lines file's complete lines when its last line is cut short; undefined when whole. */
function unfinished(file: string): number | undefined {
  const { size } = fs.statSync(file);
  const handle = fs.openSync(file, "r");
  const chunks: Buffer[] = [];
  let newline = -1;

  try {
    for (let at = size; at > 0 && newline < 0; ) {
      const length = Math.min(at, START_BYTES);
      const chunk = Buffer.alloc(length);

      at -= length;
      fs.readSync(handle, chunk, 0, length, at);
      const found = chunk.lastIndexOf(10);
      newline = found < 0 ? -1 : at + found;
      chunks.unshift(found < 0 ? chunk : chunk.subarray(found + 1));
    }
  } finally {
    fs.closeSync(handle);
  }

  const last = Buffer.concat(chunks).toString("utf8");

  if (!last.trim() || newline < 0) {
    return undefined;
  }

  try {
    JSON.parse(last);
    return undefined;
  } catch {
    return newline + 1;
  }
}

/** `.db` names SQLite files as often as anything else, so a database is told apart by its first bytes. */
async function sniff(file: string): Promise<Format> {
  const format = formatOf(file) as Format;

  if (format !== "sqlite" && format !== "duckdb") {
    return format;
  }

  const head = Buffer.alloc(16);
  const handle = await fs.promises.open(file, "r");

  try {
    await handle.read(head, 0, 16, 0);
  } finally {
    await handle.close();
  }

  if (head.toString("latin1", 0, 16) === SQLITE_MAGIC) {
    return "sqlite";
  }

  return head.toString("latin1", 8, 12) === DUCKDB_MAGIC ? "duckdb" : format;
}

/** A match's rows beside its path; a column of the file's own named `filename` becomes `filename_1`. */
function named(at: string, source: string): string {
  return `select * from (select ${literal(at)} as filename, * from ${source})`;
}

/**
 * Uneven rows are kept, padded or widened, rather than dropped; only a lenient read drops a row, and it
 * records each in the connection's reject tables.
 */
function scan(file: string, format: Format, lenient: boolean): string {
  const rejected = lenient ? ", ignore_errors = true, store_rejects = true" : "";

  switch (format) {
    case "csv": {
      const { delimiter, skip } = layoutOf(file);
      return `read_csv(${literal(file)}, delim = ${literal(delimiter)}, ${skip > 0 ? `skip = ${skip}, ` : ""}${UNEVEN}${rejected})`;
    }
    case "tsv":
      return `read_csv(${literal(file)}, delim = '\t', ${UNEVEN}${rejected})`;
    case "jsonl":
      return `read_json(${literal(file)}, format = 'newline_delimited'${lenient ? ", ignore_errors = true" : ""})`;
    default:
      return `read_parquet(${literal(file)})`;
  }
}

/**
 * Told from the header line, outside quotes: the engine's own guess turns a file with one ragged row into
 * a single column. Lines before the header are skipped: a spreadsheet's `sep=` line, which names the
 * delimiter, and comment lines starting with `#`.
 */
function layoutOf(file: string): { delimiter: string; skip: number } {
  const head = Buffer.alloc(START_BYTES);
  const handle = fs.openSync(file, "r");
  let read: number;

  try {
    read = fs.readSync(handle, head, 0, START_BYTES, 0);
  } finally {
    fs.closeSync(handle);
  }

  const lines = head.toString("utf8", 0, read).split("\n");
  const named = /^sep=(.)\r?$/i.exec(lines[0] ?? "")?.[1];
  let skip = named === undefined ? 0 : 1;

  while (skip < lines.length - 1 && lines[skip].startsWith("#")) {
    skip++;
  }

  if (named !== undefined) {
    return { delimiter: named, skip };
  }

  const counts = new Map(DELIMITERS.map((candidate) => [candidate, 0]));
  let quoted = false;

  for (const character of lines.slice(skip).join("\n")) {
    if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "\n") {
      break;
    } else if (!quoted && counts.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }

  return {
    delimiter: [...counts].reduce((best, next) => (next[1] > best[1] ? next : best))[0],
    skip,
  };
}

async function nested(file: string, format: Format, size: number): Promise<Partial<DataPage>> {
  if (size > (format === "yaml" ? YAML_BYTES : TREE_BYTES)) {
    const head = Buffer.alloc(START_BYTES);
    const handle = fs.openSync(file, "r");

    try {
      fs.readSync(handle, head, 0, START_BYTES, 0);
    } finally {
      fs.closeSync(handle);
    }

    return { text: head.toString("utf8").replace(/\uFFFD*$/, "") };
  }

  const text = fs.readFileSync(file, "utf8");
  let read: Partial<DataPage>;

  if (format === "json") {
    try {
      read = { value: JSON.parse(text) };
    } catch (error) {
      return { error: message(error), text: text.slice(0, START_BYTES) };
    }
  } else {
    const { json, error } = await yamlJson(file, text);
    read =
      json === undefined || error?.startsWith("The file refers to itself")
        ? { error: error ?? "The file holds no value.", text: text.slice(0, START_BYTES) }
        : { value: JSON.parse(json), ...(error && { error }) };
  }

  // A value nested past the limit could not be answered or drawn: each step down costs a call.
  return deeperThan(read.value, DEPTH)
    ? {
        error: `The file nests deeper than ${DEPTH.toLocaleString("en")} levels, too deep to show.`,
        text: text.slice(0, START_BYTES),
      }
    : read;
}

function deeperThan(value: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[value, 0]];

  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, depth] = next;

    if (node !== null && typeof node === "object") {
      if (depth >= limit) {
        return true;
      }

      for (const child of Object.values(node)) {
        pending.push([child, depth + 1]);
      }
    }
  }

  return false;
}

/** Parsed once per version of a file, however many pages, embeds and queries ask at once. */
function yamlJson(file: string, text: string): Promise<{ json?: string; error?: string }> {
  const stat = fs.statSync(file);
  const key = `${file}\0${stat.mtimeMs}\0${stat.size}`;
  let parsed = YAML_PARSED.get(key);

  if (!parsed) {
    parsed = yamlQueued(text);
    YAML_PARSED.set(key, parsed);

    if (YAML_PARSED.size > YAML_KEPT) {
      YAML_PARSED.delete(YAML_PARSED.keys().next().value as string);
    }
  }

  return parsed;
}

/** A few parses at a time: each takes a thread and up to a gigabyte, and its time limit starts when it does. */
async function yamlQueued(text: string): Promise<{ json?: string; error?: string }> {
  if (yamlRunning < YAML_RUNNING) {
    yamlRunning++;
  } else {
    await new Promise<void>((resolve) => yamlWaiting.push(resolve));
  }

  try {
    return await yaml(text);
  } finally {
    const next = yamlWaiting.shift();

    if (next) {
      next();
    } else {
      yamlRunning--;
    }
  }
}

/**
 * YAML parses many times slower than JSON and can expand aliases without end, so it runs on a thread
 * of its own with a memory ceiling and a time limit; the server meanwhile answers everything else. A
 * thread that answered is kept for the next parse, as starting one takes longer than a small file does.
 */
function yaml(text: string): Promise<{ json?: string; error?: string }> {
  const worker =
    yamlIdle.pop() ??
    new Worker(YAML_WORKER, { resourceLimits: { maxOldGenerationSizeMb: YAML_MEMORY_MB } });

  worker.ref();

  return new Promise((resolve) => {
    const answered = (answer: { json?: string; error?: string }) => {
      clearTimeout(timer);
      worker.off("error", failed);
      worker.unref();
      yamlIdle.push(worker);
      resolve(answer);
    };
    const failed = (error: Error) => {
      clearTimeout(timer);
      worker.off("message", answered);
      void worker.terminate();
      resolve({ error: `The file could not be read: ${message(error)}` });
    };
    const timer = setTimeout(() => {
      worker.off("message", answered);
      worker.off("error", failed);
      void worker.terminate();
      resolve({ error: `The file took longer than ${YAML_MS / 1000} s to read.` });
    }, YAML_MS);

    worker.once("message", answered);
    worker.once("error", failed);
    worker.postMessage({ text, aliases: ALIASES, bytes: TREE_BYTES });
  });
}

/**
 * Read a SQLite file's tables, or one table, as a data page shows them; runs in the SQLite reader's process.
 * A listing reports its names, then each table as it is read.
 */
export function readSqlite(
  file: string,
  table?: string,
  limit = ROWS,
  report: (progress: SqliteProgress) => void = () => {},
): Partial<DataPage> {
  const db = openSqlite(file);

  try {
    const names = db
      .prepare(
        "select name from sqlite_schema where type in ('table', 'view') and name not like 'sqlite_%' order by name",
      )
      .all()
      .map((row) => String(row.name));
    const readTable = (name: string, limit: number): DataTable => {
      const quoted = identifier(name);
      const columns = db
        .prepare(`pragma table_info(${quoted})`)
        .all()
        .map((row) => ({ name: String(row.name), type: String(row.type || "ANY") }));
      const total = Number(db.prepare(`select count(*) as n from ${quoted}`).get()?.n ?? 0);
      const rows: Cell[][] = [];
      let bytes = 0;

      for (const row of db.prepare(`select * from ${quoted} limit ${limit}`).iterate()) {
        const shown = columns.map(({ name: column }) => shortened(row[column]));
        bytes += JSON.stringify(shown).length;

        if (bytes > GRID_BYTES) {
          break;
        }

        rows.push(shown);
      }

      return {
        name,
        columns,
        total,
        first: { columns, rows, total, partial: total > rows.length },
      };
    };

    if (table !== undefined) {
      if (!names.includes(table)) {
        return { table, error: `No table named ${table} in this database.` };
      }

      const found = unreadable(table, () => readTable(table, limit));
      return found.error ? { table, error: found.error } : { table, grid: found.first };
    }

    report({ names });

    return {
      tables: names.map((name) => {
        const read = unreadable(name, () => readTable(name, FIRST_ROWS));
        report({ table: read });
        return read;
      }),
    };
  } finally {
    db.close();
  }
}

/**
 * Name a SQLite table's columns and, given a target, copy its rows there as JSON Lines; runs in the SQLite
 * reader's process.
 */
export function exportSqlite(file: string, table: string, target?: string): Column[] {
  const db = openSqlite(file);

  try {
    const columns = db
      .prepare(`pragma table_info(${identifier(table)})`)
      .all()
      .map((row) => ({ name: String(row.name), type: String(row.type || "VARCHAR") }));

    if (columns.length === 0) {
      throw new Error(`No table named ${table} in this database.`);
    }

    if (target) {
      const out = fs.openSync(target, "w");
      let lines: string[] = [];

      try {
        for (const row of db.prepare(`select * from ${identifier(table)}`).iterate()) {
          lines.push(
            JSON.stringify(
              Object.fromEntries(columns.map(({ name }) => [name, copied(row[name])])),
            ),
          );

          if (lines.length === COPY_BATCH) {
            fs.writeSync(out, `${lines.join("\n")}\n`);
            lines = [];
          }
        }

        fs.writeSync(out, lines.length > 0 ? `${lines.join("\n")}\n` : "");
      } finally {
        fs.closeSync(out);
      }
    }

    return columns;
  } finally {
    db.close();
  }
}

/** A whole number goes into the copy as written, so the engine reads one too large for a double as BIGINT. */
function copied(value: unknown): unknown {
  return typeof value === "bigint" ? RAW_JSON.rawJSON(String(value)) : cell(value);
}

/**
 * Opened immutable: SQLite then writes nothing beside the file, not even the journal a reader of a
 * write-ahead-logged database would otherwise create.
 */
function openSqlite(file: string): import("node:sqlite").DatabaseSync {
  // Loaded on use: importing it warns on every start where it is still experimental.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, {
    readOnly: true,
    readBigInts: true,
  });
}

/**
 * SQLite runs in a process of its own: a slow view holds its reader inside SQLite, where neither an
 * interruption nor ending a thread reaches it, and only ending the process stops it.
 */
function sqliteReader<T>(
  request: SqliteRequest,
  deadline: number,
  stopped: string,
  onProgress: (progress: SqliteProgress) => void = () => {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = fork(SQLITE_READER, [], {
      execArgv: [...process.execArgv, "--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new Error(stopped));
      },
      Math.max(0, deadline - Date.now()),
    );

    child.on("message", (answer: { progress?: SqliteProgress; value?: T; error?: string }) => {
      if (answer.progress) {
        onProgress(answer.progress);
        return;
      }

      clearTimeout(timer);

      if (answer.error === undefined) {
        resolve(answer.value as T);
      } else {
        reject(new Error(answer.error));
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`The SQLite reader stopped (${signal ?? code}).`));
    });
    child.send(request);
  });
}

function unreadable(name: string, read: () => DataTable): DataTable {
  try {
    return read();
  } catch (error) {
    return broken(name, message(error));
  }
}

function broken(name: string, error: string): DataTable {
  return { name, columns: [], total: 0, first: { columns: [], rows: [], partial: false }, error };
}

function versionOf(files: string[], sql: string): string {
  const stamps = [...new Set(files)].sort().map((file) => `${file}\0${fileVersion(file) ?? "-"}`);
  return createHash("sha1")
    .update(`${sql}\0${stamps.join("\n")}`)
    .digest("hex")
    .slice(0, 16);
}

function records({ columns, rows }: Grid): Record<string, Cell>[] {
  return rows.map((row) =>
    Object.fromEntries(columns.map(({ name }, index) => [name, row[index]])),
  );
}

/** A step may itself hold dots, so the longest run of steps naming a key is taken first. */
function walk(value: unknown, part: string): unknown {
  const steps = part ? part.split(".") : [];
  let found = value;

  for (let at = 0; at < steps.length; ) {
    let taken = 0;

    if (Array.isArray(found) && /^\d+$/.test(steps[at]) && Number(steps[at]) < found.length) {
      found = found[Number(steps[at])];
      taken = 1;
    } else if (found !== null && typeof found === "object" && !Array.isArray(found)) {
      for (let end = steps.length; end > at && !taken; end--) {
        const key = steps.slice(at, end).join(".");

        if (Object.hasOwn(found as object, key)) {
          found = (found as Record<string, unknown>)[key];
          taken = end - at;
        }
      }
    }

    if (!taken) {
      throw new Error(`Nothing at ${steps.slice(0, at + 1).join(".")}.`);
    }

    at += taken;
  }

  return found;
}

/**
 * Read streaming and kept while rows fit both the row limit and a size the browser can take. Long values
 * are cut short in the engine, before a chunk of 2,048 rows reaches JavaScript: text and nested values to
 * a length that shrinks as columns multiply, a blob to its size. A date is written out there too: in
 * JavaScript it is a midnight UTC time. Drained, the rest is read without being kept, which counts the
 * whole and lets a lenient read record every row it rejects.
 */
async function gridOf(
  connection: Connection,
  sql: string,
  limit: number,
  drain = false,
): Promise<Grid> {
  const { DuckDBTypeId, JSDuckDBValueConverter } = await import("@duckdb/node-api");
  const prepared = await connection.prepare(sql);
  const columns = Array.from({ length: prepared.columnCount }, (_, index) => ({
    name: prepared.columnName(index),
    type: String(prepared.columnType(index)),
    id: prepared.columnTypeId(index),
  }));
  prepared.destroySync();
  const cap = Math.max(
    CELL_MIN_CHARS,
    Math.min(CELL_CHARS, Math.floor(ROW_CHARS / columns.length)),
  );
  const nested = [
    DuckDBTypeId.LIST,
    DuckDBTypeId.STRUCT,
    DuckDBTypeId.MAP,
    DuckDBTypeId.ARRAY,
    DuckDBTypeId.UNION,
  ];
  const capped = columns.map(({ name, id }, index) => {
    const at = `#${index + 1}`;
    const value =
      id === DuckDBTypeId.VARCHAR || id === DuckDBTypeId.BIT
        ? `left(${at}::varchar, ${cap + 1})`
        : id === DuckDBTypeId.DATE
          ? `${at}::varchar`
          : id === DuckDBTypeId.BLOB
            ? `octet_length(${at}) || ' bytes'`
            : nested.includes(id)
              ? `left(to_json(${at})::varchar, ${cap + 1})`
              : at;
    return `${value} as ${identifier(name)}`;
  });
  const result = await connection.stream(
    `select ${capped.join(", ") || "*"} from (${sql}) folio_capped`,
  );
  const rows: Cell[][] = [];
  let bytes = 0;
  let partial = false;
  let seen = 0;

  reading: for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; ) {
    for (const raw of partial ? [] : chunk.convertRows(JSDuckDBValueConverter)) {
      const row = raw.map((value) => shortened(value, cap));
      bytes += JSON.stringify(row).length;

      if (rows.length === limit || bytes > GRID_BYTES) {
        partial = true;

        if (!drain) {
          break reading;
        }

        break;
      }

      rows.push(row);
    }

    seen += chunk.rowCount;
    chunk = await result.fetchChunk();
  }

  const total = drain ? seen : partial ? undefined : rows.length;

  return {
    columns: columns.map(({ name, type }) => ({ name, type })),
    rows,
    ...(total !== undefined && { total }),
    partial,
  };
}

function shortened(value: unknown, cap = CELL_CHARS): Cell {
  const shown = cell(value);
  return typeof shown === "string" && shown.length > cap ? `${shown.slice(0, cap)}\u2026` : shown;
}

/** Whole numbers too large for a double stay exact as text; nested values show as JSON. */
function cell(value: unknown): Cell {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }

  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return `${value.byteLength} bytes`;
  }

  return JSON.stringify(value, (_, nested) =>
    typeof nested === "bigint" ? String(nested) : nested,
  );
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The engine follows its message with the statement it ran, rewritten, and a caret under the fault;
 * the lines naming the fault are kept, the rewritten statement, which names folio's own views, is not.
 */
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .split("\n")
    .filter((line) => line.trim() && !/^LINE \d+:/.test(line) && !/^\s*\^\s*$/.test(line))
    .join(" ");
}
