/** What depends on what: the files a document includes or reads data from, and the documents a file reaches. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Data } from "./data.ts";
import { isDocument, renderable } from "./files.ts";
import type { Model } from "./model.ts";
import type { EmbedVersions, ReadRecord } from "./reads.ts";
import { fileVersion } from "./versions.ts";

export interface Dependency {
  path: string;
  how: "includes" | "embeds";
}

export interface Dependent {
  source: string;
  how: Dependency["how"];
}

export interface Upstream extends Dependency {
  at: string;
}

/**
 * A document's own reach: the files its includes name and the data files its embeds and queries
 * read, with the version of every query file among them, whose edit can change what they read.
 */
interface Edges {
  hash: string;
  includes: string[];
  data: string[];
  queries: Record<string, string>;
}

const INCLUDE = /(?<!\\)\{include:\s*([^}\n]*?)\s*\}/g;
/** Documents are read in slices this size between turns of the event loop. */
const SLICE = 100;
const IMPACTS = new WeakMap<Model, Impact>();

/** The one impact of a model, so every caller shares what it has worked out. */
export function impactOf(model: Model, data: Data): Impact {
  let impact = IMPACTS.get(model);

  if (!impact) {
    impact = new Impact(model.root, model, data);
    IMPACTS.set(model, impact);
  }

  return impact;
}

/**
 * Kept current in the background: every document's own reach is worked out when its text changes,
 * a slice at a time, and what reaches a file is a walk of that index rather than of the folder.
 */
export class Impact {
  readonly #root: string;
  readonly #model: Model;
  readonly #data: Data;
  readonly #edges = new Map<string, Edges>();
  readonly #includedBy = new Map<string, Set<string>>();
  readonly #readBy = new Map<string, Set<string>>();
  readonly #contents = new Map<string, { state: string; hash: Promise<string | undefined> }>();
  #stale = true;
  #refreshing: Promise<void> | undefined;

  constructor(root: string, model: Model, data: Data) {
    this.#root = root;
    this.#model = model;
    this.#data = data;
    model.listen(() => {
      this.#stale = true;
    });
  }

  /** Bring the index up to date; started once folio is serving, so the first ask finds it ready. */
  refresh(): Promise<void> {
    if (!this.#refreshing) {
      this.#refreshing = this.#catchUp().finally(() => {
        this.#refreshing = undefined;
      });
    }

    return this.#refreshing;
  }

  /** The files a document includes, at any depth, and the data and query files its embeds read. */
  async dependencies(urlPath: string): Promise<Dependency[]> {
    await this.refresh();
    const found = new Map<string, Dependency["how"]>();
    const documents = [urlPath];

    for (let next = documents.shift(); next !== undefined; next = documents.shift()) {
      const edges = this.#edges.get(next);

      for (const included of edges?.includes ?? []) {
        if (!found.has(included) && included !== urlPath) {
          found.set(included, "includes");
          documents.push(included);
        }
      }

      for (const read of edges?.data ?? []) {
        if (!found.has(read)) {
          found.set(read, "embeds");
        }
      }
    }

    return [...found]
      .filter(([depended]) => fs.existsSync(path.join(this.#root, depended)))
      .map(([depended, how]) => ({ path: depended, how }));
  }

  /** The documents a file reaches: directly, or through documents including one that does. */
  async dependents(urlPath: string): Promise<Dependent[]> {
    await this.refresh();
    const found = new Map<string, Dependency["how"]>();
    const reached: Dependent[] = [
      ...[...(this.#readBy.get(urlPath) ?? [])].map((source) => ({
        source,
        how: "embeds" as const,
      })),
      ...[...(this.#includedBy.get(urlPath) ?? [])].map((source) => ({
        source,
        how: "includes" as const,
      })),
    ];

    for (let next = reached.shift(); next !== undefined; next = reached.shift()) {
      if (found.has(next.source) || next.source === urlPath) {
        continue;
      }

      found.set(next.source, next.how);

      for (const source of this.#includedBy.get(next.source) ?? []) {
        reached.push({ source, how: next.how });
      }
    }

    return [...found]
      .map(([source, how]) => ({ source, how }))
      .sort((a, b) => a.source.localeCompare(b.source));
  }

  /** A file changed since the read at `at` keeps no hash, so the note goes by its change time. */
  async hashes(urlPath: string, at: number): Promise<Record<string, string>> {
    const found: Record<string, string> = {};

    for (const { path: depended } of await this.dependencies(urlPath)) {
      const hash = await this.#content(depended);
      const changed = fs.statSync(path.join(this.#root, depended), { throwIfNoEntry: false });

      if (hash !== undefined && changed && changed.ctimeMs <= at) {
        found[depended] = hash;
      }
    }

    return found;
  }

  /**
   * Files are dated by their change time, not the modification time a restored file brings along.
   * A read with no record of what the files held - stored before, or still being kept - goes by that time.
   */
  async upstream(urlPath: string, read: Pick<ReadRecord, "at" | "depended">): Promise<Upstream[]> {
    const held = read.depended?.at === read.at ? read.depended.hashes : undefined;
    const found: Upstream[] = [];

    for (const dependency of await this.dependencies(urlPath)) {
      const stat = fs.statSync(path.join(this.#root, dependency.path), { throwIfNoEntry: false });
      const seen = held?.[dependency.path];

      if (
        stat &&
        (seen === undefined
          ? stat.ctimeMs > read.at
          : (await this.#content(dependency.path)) !== seen)
      ) {
        found.push({ ...dependency, at: new Date(stat.ctimeMs).toISOString() });
      }
    }

    return found.sort((a, b) => b.at.localeCompare(a.at));
  }

  async embeds(keys: string[]): Promise<EmbedVersions> {
    const versions: EmbedVersions = new Map();

    for (const key of keys) {
      const [from, reference] = key.split("\n");
      const document = renderable(this.#root, from);

      if (document && isDocument(document.kind) && reference !== undefined) {
        const { files, version } = await this.#data.reads(document.file, reference);
        const at = Math.max(
          0,
          ...files.map((file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0),
        );
        versions.set(key, { version, at });
      }
    }

    return versions;
  }

  /** Any write moves a file's change time, so a file restored with its old modification time is read again. */
  #content(urlPath: string): Promise<string | undefined> {
    const file = path.join(this.#root, urlPath);
    const stat = fs.statSync(file, { throwIfNoEntry: false });

    if (!stat?.isFile()) {
      return Promise.resolve(undefined);
    }

    const state = `${stat.ino}-${stat.size}-${stat.mtimeMs}-${stat.ctimeMs}`;
    const held = this.#contents.get(urlPath);

    if (held?.state === state) {
      return held.hash;
    }

    const hash = new Promise<string | undefined>((resolve) => {
      const digest = createHash("sha1");
      fs.createReadStream(file)
        .on("data", (chunk) => digest.update(chunk))
        .on("end", () => resolve(digest.digest("hex")))
        .on("error", () => resolve(undefined));
    });
    this.#contents.set(urlPath, { state, hash });
    return hash;
  }

  async #catchUp(): Promise<void> {
    while (this.#stale) {
      this.#stale = false;
      await this.#index();
    }
  }

  async #index(): Promise<void> {
    const paths = this.#model.paths();
    const present = new Set(paths);

    for (let start = 0; start < paths.length; start += SLICE) {
      await new Promise((resolve) => setImmediate(resolve));

      for (const urlPath of paths.slice(start, start + SLICE)) {
        const hash = this.#model.hashOf(urlPath);
        const held = this.#edges.get(urlPath);

        if (hash !== undefined && (held?.hash !== hash || !current(this.#root, held.queries))) {
          this.#set(urlPath, await this.#reach(urlPath, hash));
        }
      }
    }

    for (const urlPath of [...this.#edges.keys()]) {
      if (!present.has(urlPath)) {
        this.#set(urlPath, undefined);
      }
    }
  }

  async #reach(urlPath: string, hash: string): Promise<Edges> {
    const blocks = this.#model.held(urlPath) ?? [];
    const texts = blocks.map((block) => block.text);
    const includes = new Set<string>();

    for (const text of texts) {
      for (const [, written] of text.matchAll(INCLUDE)) {
        const target = within(urlPath, written.replace(/#.*$/, ""));

        if (target) {
          includes.add(target);
        }
      }
    }

    const references = blocks.flatMap((block) => block.references ?? []);
    const sqls = blocks.some((block) => block.queries)
      ? this.#data.documentQueries(path.join(this.#root, urlPath)).map(({ sql }) => sql)
      : [];
    const data =
      references.length + sqls.length > 0
        ? await this.#data
            .dependenciesFrom(path.join(this.#root, urlPath), references, sqls)
            .catch(() => [])
        : [];
    const queries = Object.fromEntries(
      data
        .filter((file) => file.endsWith(".sql"))
        .map((file) => [file, fileVersion(path.join(this.#root, file)) ?? ""]),
    );

    return { hash, includes: [...includes], data, queries };
  }

  #set(urlPath: string, edges: Edges | undefined): void {
    const held = this.#edges.get(urlPath);

    for (const target of held?.includes ?? []) {
      this.#includedBy.get(target)?.delete(urlPath);
    }

    for (const target of held?.data ?? []) {
      this.#readBy.get(target)?.delete(urlPath);
    }

    if (!edges) {
      this.#edges.delete(urlPath);
      return;
    }

    this.#edges.set(urlPath, edges);

    for (const target of edges.includes) {
      this.#includedBy.set(target, (this.#includedBy.get(target) ?? new Set()).add(urlPath));
    }

    for (const target of edges.data) {
      this.#readBy.set(target, (this.#readBy.get(target) ?? new Set()).add(urlPath));
    }
  }
}

/** An include's path, relative to the document or, starting with a slash, to the folder. */
function within(from: string, written: string): string | undefined {
  if (!written) {
    return undefined;
  }

  const target = written.startsWith("/")
    ? path.posix.normalize(written.slice(1))
    : path.posix.join(path.posix.dirname(from), written);

  return target.startsWith("../") || target === ".." ? undefined : target;
}

function current(root: string, queries: Record<string, string>): boolean {
  return Object.entries(queries).every(
    ([file, version]) => (fileVersion(path.join(root, file)) ?? "") === version,
  );
}
