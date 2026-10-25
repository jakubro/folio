/** The folder model: every document as its blocks, kept current by watching the folder, stored outside it. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import GithubSlugger from "github-slugger";
import { type Block, versionOf } from "./blocks.ts";
import {
  isDocument,
  isPruned,
  linkTarget,
  renderable,
  renderableFiles,
  subfolders,
} from "./files.ts";
import { History } from "./history.ts";
import type { Log } from "./http.ts";
import type { Instance } from "./includes.ts";
import { type Indexer, IndexerDown } from "./indexer.ts";
import { Reads } from "./reads.ts";

interface Document {
  path: string;
  kind: "markdown" | "mermaid";
  hash: string;
  blocks: Block[];
  /** When each block that has gone went, by id; the latest few hundred. */
  gone?: Record<string, number>;
}

interface Stored extends Document {
  format?: number;
}

export interface Backlink {
  source: string;
  /** The block holding the link, so following it back lands there. */
  block: string;
  context: string;
  /** What the link points at when it names a heading or a block, as that part reads. */
  part?: string;
}

export interface PageBlock {
  id: string;
  kind: string;
  source: string;
  lines: [number, number];
  /** The lines it spans in the page's expanded text. */
  at: [number, number];
  version: string;
}

const FORMAT = 12;
const DEBOUNCE_MS = 50;
const RETRY_MS = 10_000;
const EXCERPT = 100;
const SWEEP_MS = 86_400_000;
const SWEEP_DELAY_MS = 60_000;
const GONE_KEPT = 500;
const MOVE_MS = 10_000;

/** Name the folder that keeps a served folder's model, under the user's state directory. */
export function modelStore(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  const state = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(state, "folio", hash(root));
}

export class Model {
  readonly reads: Reads;
  readonly history: History;
  readonly root: string;
  readonly store: string;
  readonly log: Log;
  readonly #root: string;
  readonly #store: string;
  readonly #indexer: Indexer;
  readonly #documents = new Map<string, Document>();
  /** The documents held in each folder, by the folder's path on disk. */
  readonly #inFolder = new Map<string, Set<string>>();
  readonly #watches = new Map<string, fs.FSWatcher>();
  #watchesMoved = 0;
  readonly #changed = new Set<string>();
  #work = Promise.resolve();
  #writes = Promise.resolve();
  #marker: Promise<boolean> | undefined;
  readonly #listeners = new Set<(changed?: readonly string[]) => void>();
  readonly #folderListeners = new Set<(dir: string) => void>();
  readonly #prepared = new Map<string, { hash: string; blocks: Block[] }>();
  readonly #preparing = new Set<string>();
  readonly #incoming = new Map<string, Set<string>>();
  readonly #outgoing = new Map<string, Set<string>>();
  /** The version of each document its last parse failed on, so that text is not parsed again. */
  readonly #failed = new Map<string, string>();
  readonly #parsing = new Map<string, Promise<void>>();
  readonly #unindexed = new Map<string, Document["kind"]>();
  readonly #byHash = new Map<string, Set<string>>();
  readonly #removed = new Map<string, { document: Document; at: number }>();
  #kept = new Map<string, Document>();
  readonly #retryMs: number;
  #downUntil = 0;
  #timer: NodeJS.Timeout | undefined;
  #retry: NodeJS.Timeout | undefined;
  #ready = false;
  #sweeping: NodeJS.Timeout | undefined;

  constructor(root: string, store: string, indexer: Indexer, log: Log, retryMs = RETRY_MS) {
    this.#root = root;
    this.#store = store;
    this.#indexer = indexer;
    this.log = log;
    this.#retryMs = retryMs;
    this.root = root;
    this.store = store;
    this.reads = new Reads(
      store,
      (urlPath) => this.#documents.get(urlPath)?.blocks,
      log,
      (urlPath, id) => this.#documents.get(urlPath)?.gone?.[id],
    );
    this.history = new History(root, store, log, (text, kind, previous) =>
      indexer.split(text, kind, previous),
    );
  }

  /** Index the whole folder, reusing what the store holds for files unchanged since, then follow it. */
  start(): Promise<void> {
    return this.#queue(async () => {
      const started = Date.now();
      const stored = await this.#load();
      await this.reads.load();
      this.#kept = new Map([...stored.values()].map((document) => [document.hash, document]));
      await this.#scan(this.#root, stored);
      this.#kept.clear();

      for (const document of stored.values()) {
        await this.#persist(document.path);
      }

      this.#ready = true;
      this.#notify();
      this.#sweep();
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      this.log(`model: ${this.#documents.size} documents indexed in ${seconds} s`);
    });
  }

  close(): void {
    clearTimeout(this.#timer);
    clearTimeout(this.#sweeping);
    clearInterval(this.#sweeping);
    clearTimeout(this.#retry);

    for (const watcher of this.#watches.values()) {
      watcher.close();
    }

    this.#watches.clear();
    this.#watchesMoved++;
  }

  /** Wait for every document already indexed to be kept in the store. */
  flush(): Promise<void> {
    return this.#writes;
  }

  /** A document's blocks, each with its identity, kind, lines and the start of its text. */
  inspect(urlPath: string): object | undefined {
    const document = this.#documents.get(urlPath);

    return (
      document && {
        path: document.path,
        kind: document.kind,
        blocks: document.blocks.map(({ id, kind, lines, text }) => ({
          id,
          kind,
          lines,
          text: excerpt(text),
        })),
      }
    );
  }

  /** The other documents linking to a document. */
  linkedFrom(urlPath: string): string[] {
    return [...(this.#incoming.get(urlPath) ?? [])].filter((source) => source !== urlPath);
  }

  /** Place the blocks of every file an expansion read onto its page; partial while some still parse. */
  page(instances: Instance[]): { blocks: PageBlock[]; partial: boolean } {
    const placed: PageBlock[] = [];
    let partial = false;

    for (const { file, text, first, last, starts, ends } of instances) {
      const source = this.#urlPath(file);
      const kind = renderable(this.#root, source)?.kind;
      const found = kind === "markdown" || kind === "mermaid" ? this.blocksReady(file, text) : [];

      partial ||= !found;

      for (const block of found ?? []) {
        const { id, kind: blockKind, lines } = block;

        if (lines[0] >= first && lines[1] <= last) {
          placed.push({
            id,
            kind: blockKind,
            source,
            lines,
            at: [starts[lines[0] - first], ends[lines[1] - first]],
            version: versionOf(block),
          });
        }
      }
    }

    return { blocks: placed.sort((a, b) => a.at[0] - b.at[0] || b.at[1] - a.at[1]), partial };
  }

  /**
   * Every link from another document of the folder to this one, in path and reading order, each
   * naming the part it points at as it reads on the page given.
   */
  backlinks(urlPath: string, page: PageBlock[]): Backlink[] {
    const found: Backlink[] = [];
    const parts = this.#parts(page);

    for (const source of [...(this.#incoming.get(urlPath) ?? [])].sort()) {
      if (source === urlPath) {
        continue;
      }

      for (const block of this.#documents.get(source)?.blocks ?? []) {
        for (const link of block.links ?? []) {
          const resolved = linkTarget(source, link.url);

          if (resolved?.path === urlPath) {
            const part = resolved.fragment && partOf(parts, resolved.fragment);
            found.push({ source, block: block.id, context: link.context, ...(part && { part }) });
          }
        }
      }
    }

    return found;
  }

  /** Blocks for exactly this text, or undefined while they parse in the background; none if unparseable. */
  blocksReady(file: string, text: string): Block[] | undefined {
    const urlPath = this.#urlPath(file);
    const version = hash(text);
    const held = this.#documents.get(urlPath);
    const prepared = this.#prepared.get(urlPath);

    if (held?.hash === version) {
      return held.blocks;
    }

    if (prepared?.hash === version) {
      return prepared.blocks;
    }

    this.#prepare(urlPath, text, version);
    return undefined;
  }

  held(urlPath: string): Block[] | undefined {
    return this.#documents.get(urlPath)?.blocks;
  }

  /** The blocks held for exactly this text, without asking for any to be parsed. */
  heldFor(urlPath: string, text: string): Block[] | undefined {
    const held = this.#documents.get(urlPath);
    return held?.hash === hash(text) ? held.blocks : undefined;
  }

  paths(): string[] {
    return [...this.#documents.keys()];
  }

  folders(): string[] {
    return [...this.#watches.keys()];
  }

  watches(dir: string): boolean {
    return this.#watches.has(dir);
  }

  /** Moves whenever a folder starts or stops being watched. */
  get watchesVersion(): number {
    return this.#watchesMoved;
  }

  /** Whether the first walk of the folder has ended, so every document is known. */
  get ready(): boolean {
    return this.#ready;
  }

  hashOf(urlPath: string): string | undefined {
    return this.#documents.get(urlPath)?.hash;
  }

  /** Hear each change to the model, with the documents it changed; none named means any may have. */
  listen(listener: (changed?: readonly string[]) => void): void {
    this.#listeners.add(listener);
  }

  /** Hear each watched folder in which any file changed, documents or not, once the model has read it. */
  listenFolders(listener: (dir: string) => void): void {
    this.#folderListeners.add(listener);
  }

  /** How far the model has got, counting the documents under one folder. */
  status(folder: string): object {
    const prefix = folder ? `${folder.replace(/\/$/, "")}/` : "";

    return {
      ready: this.#ready,
      documents: [...this.#documents.keys()].filter((key) => key.startsWith(prefix)).length,
      folders: this.#watches.size,
      store: this.#store,
    };
  }

  #queue(work: () => Promise<void>): Promise<void> {
    this.#work = this.#work.then(work).catch((error: Error) => this.log(`model: ${error.message}`));
    return this.#work;
  }

  async #scan(dir: string, stored = new Map<string, Document>()): Promise<void> {
    await turn();
    this.#watch(dir);

    for (const { name, kind } of renderableFiles(this.#root, dir)) {
      if (isDocument(kind)) {
        const urlPath = this.#urlPath(path.join(dir, name));
        const previous = this.#documents.get(urlPath) ?? stored.get(urlPath);
        stored.delete(urlPath);
        await this.#index(urlPath, kind, previous);
      }
    }

    for (const sub of subfolders(dir)) {
      await this.#scan(sub, stored);
    }
  }

  /** A folder's event says only that something in it changed, so the whole folder is read again. */
  async #rescan(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      return this.#forget(dir);
    }

    const files = new Set<string>();

    for (const { name, kind } of renderableFiles(this.#root, dir)) {
      if (isDocument(kind)) {
        const urlPath = this.#urlPath(path.join(dir, name));
        files.add(urlPath);
        await this.#index(urlPath, kind, this.#documents.get(urlPath));
      }
    }

    for (const urlPath of [...(this.#inFolder.get(dir) ?? [])]) {
      if (!files.has(urlPath)) {
        await this.#remove(urlPath);
      }
    }

    const folders = new Set(subfolders(dir));

    for (const sub of folders) {
      if (!this.#watches.has(sub)) {
        await this.#scan(sub);
      }
    }

    for (const watched of [...this.#watches.keys()]) {
      if (path.dirname(watched) === dir && !folders.has(watched)) {
        await this.#forget(watched);
      }
    }
  }

  async #forget(dir: string): Promise<void> {
    for (const [watched, watcher] of this.#watches) {
      if (watched === dir || watched.startsWith(dir + path.sep)) {
        watcher.close();
        this.#watches.delete(watched);
        this.#watchesMoved++;
      }
    }

    for (const urlPath of [...this.#documents.keys()]) {
      if (path.join(this.#root, urlPath).startsWith(dir + path.sep)) {
        await this.#remove(urlPath);
      }
    }
  }

  /** Read inside the document's turn, so a page's parse of newer text never runs between read and put. */
  #index(urlPath: string, kind: Document["kind"], previous?: Document): Promise<void> {
    return this.#serially(urlPath, async () => {
      let text: string;

      try {
        text = await fs.promises.readFile(path.join(this.#root, urlPath), "utf8");
      } catch {
        return this.#remove(urlPath);
      }

      const version = hash(text);
      const moved = (this.#documents.get(urlPath) ?? previous) ? undefined : this.#movedTo(version);
      const known = this.#documents.get(urlPath) ?? previous ?? moved;

      if (!this.#ready) {
        void this.history.firstSeen(urlPath, text, mtimeOf(path.join(this.#root, urlPath)));
      }

      if (moved) {
        await this.#move(moved, urlPath);
      }

      if (known?.hash === version && known.kind === kind) {
        this.#put({ ...known, path: urlPath });

        if (moved) {
          this.#notify([moved.path, urlPath]);
          await this.#persist(urlPath);
        }

        return;
      }

      this.#saved(urlPath, text, known);

      if (this.#failed.get(urlPath) === version) {
        return;
      }

      let split: Block[];

      try {
        split = await this.#indexer.split(text, kind, known?.blocks);
      } catch (error) {
        this.log(`model: cannot index ${urlPath}: ${(error as Error).message}`);
        return this.#failedIndex(urlPath, kind, version, error as Error);
      }

      this.#put(this.#dated({ path: urlPath, kind, hash: version, blocks: split }, known));
      this.#notify(moved ? [moved.path, urlPath] : [urlPath]);
      await this.#persist(urlPath);
    });
  }

  /**
   * A page asks for the text it was served, which the folder's watch may not have reached yet; a
   * document not indexed yet this run starts from what the store kept, so its ids match the store's.
   */
  #blocksFor(urlPath: string, kind: Document["kind"], text: string): Promise<Block[]> {
    const version = hash(text);

    return this.#serially(urlPath, async () => {
      const held = this.#documents.get(urlPath);
      // A moved document asked for before its new place is indexed keeps its ids; indexing moves the rest.
      const known = held ?? (await this.#stored(urlPath)) ?? this.#movedTo(version);

      if (known?.hash === version && known.kind === kind) {
        return known.blocks;
      }

      if (this.#failed.get(urlPath) === version) {
        return [];
      }

      const split = await this.#indexer.split(text, kind, known?.blocks);

      if (this.#documents.get(urlPath) === held && !urlPath.split("/").some(isPruned)) {
        this.#saved(urlPath, text, known);
        this.#put(this.#dated({ path: urlPath, kind, hash: version, blocks: split }, known));
        this.#notify([urlPath]);
        await this.#persist(urlPath);
      }

      return split;
    });
  }

  /**
   * Parses of one document run one at a time, each from the blocks the last one left, so every
   * version's ids descend from the version before and a page is handed the ids the model keeps.
   */
  #serially<T>(urlPath: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#parsing.get(urlPath) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => {},
      () => {},
    );

    this.#parsing.set(urlPath, settled);
    void settled.then(() => {
      if (this.#parsing.get(urlPath) === settled) {
        this.#parsing.delete(urlPath);
      }
    });

    return run;
  }

  /**
   * A text that failed stays failed until it changes; a downed worker may come back, so that file is
   * indexed again after a pause.
   */
  #failedIndex(urlPath: string, kind: Document["kind"], version: string, error: Error): void {
    if (!(error instanceof IndexerDown)) {
      this.#failed.set(urlPath, version);
      return;
    }

    this.#unindexed.set(urlPath, kind);
    this.#retry ??= setTimeout(() => {
      const unindexed = [...this.#unindexed];
      this.#retry = undefined;
      this.#unindexed.clear();
      void this.#queue(async () => {
        for (const [later, laterKind] of unindexed) {
          await this.#index(later, laterKind, this.#documents.get(later));
        }
      });
    }, this.#retryMs);
    this.#retry.unref();
  }

  #prepare(urlPath: string, text: string, version: string): void {
    const key = `${urlPath}\0${version}`;
    const kind = renderable(this.#root, urlPath)?.kind === "mermaid" ? "mermaid" : "markdown";

    if (this.#preparing.has(key) || Date.now() < this.#downUntil) {
      return;
    }

    this.#preparing.add(key);
    this.#blocksFor(urlPath, kind, text)
      .then(
        (blocks) => {
          if (this.#documents.get(urlPath)?.hash !== version) {
            this.#prepared.set(urlPath, { hash: version, blocks });
          }
        },
        (error: Error) => {
          this.log(`model: cannot index ${urlPath}: ${error.message}`);

          // A worker that went down may come back, so the text is asked for again after a pause.
          if (error instanceof IndexerDown) {
            this.#downUntil = Date.now() + this.#retryMs;
            setTimeout(() => this.#notify(), this.#retryMs).unref();
          } else {
            this.#failed.set(urlPath, version);
            this.#prepared.set(urlPath, { hash: version, blocks: [] });
          }
        },
      )
      .then(() => {
        this.#preparing.delete(key);
        this.#notify([urlPath]);
      });
  }

  async #stored(urlPath: string): Promise<Document | undefined> {
    this.#marker ??= readJson<{ format: number; root: string }>(
      path.join(this.#store, "folder.json"),
    ).then((held) => held?.root === this.#root);

    return (await this.#marker) ? current(await readJson<Stored>(this.#file(urlPath))) : undefined;
  }

  /** A block keeps the time it took its current text; one new or changed takes the file's time. */
  #dated(document: Document, previous: Document | undefined): Document {
    const at = mtimeOf(path.join(this.#root, document.path));
    const before = new Map(previous?.blocks.map((block) => [block.id, block]));
    const kept = new Set(document.blocks.map((block) => block.id));
    const gone = { ...previous?.gone };

    for (const block of document.blocks) {
      const was = before.get(block.id);
      block.seen = was && versionOf(was) === versionOf(block) ? (was.seen ?? at) : at;
      delete gone[block.id];
    }

    for (const id of before.keys()) {
      if (!kept.has(id)) {
        gone[id] = at;
      }
    }

    const latest = Object.entries(gone)
      .sort(([, a], [, b]) => b - a)
      .slice(0, GONE_KEPT);
    return { ...document, gone: Object.fromEntries(latest) };
  }

  #put(document: Document): void {
    this.#drop(document.path);
    this.#prepared.delete(document.path);
    this.#documents.set(document.path, document);
    const folder = path.dirname(path.join(this.#root, document.path));
    this.#inFolder.set(folder, (this.#inFolder.get(folder) ?? new Set()).add(document.path));
    this.#byHash.set(
      document.hash,
      (this.#byHash.get(document.hash) ?? new Set()).add(document.path),
    );
    const targets = new Set(
      document.blocks.flatMap((block) =>
        (block.links ?? []).flatMap((link) => linkTarget(document.path, link.url)?.path ?? []),
      ),
    );
    this.#outgoing.set(document.path, targets);

    for (const target of targets) {
      this.#incoming.set(target, (this.#incoming.get(target) ?? new Set()).add(document.path));
    }
  }

  #drop(urlPath: string): boolean {
    this.#inFolder.get(path.dirname(path.join(this.#root, urlPath)))?.delete(urlPath);

    for (const target of this.#outgoing.get(urlPath) ?? []) {
      this.#incoming.get(target)?.delete(urlPath);
    }

    const version = this.#documents.get(urlPath)?.hash;

    const same = version === undefined ? undefined : this.#byHash.get(version);
    same?.delete(urlPath);

    if (same?.size === 0) {
      this.#byHash.delete(version as string);
    }

    this.#outgoing.delete(urlPath);
    this.#prepared.delete(urlPath);
    return this.#documents.delete(urlPath);
  }

  /**
   * A heading's anchor is counted over the whole page, as the browser counts it, includes and all,
   * and keyed by the element id it gets: the first of several sharing one is where a link lands.
   */
  #parts(page: PageBlock[]): Map<string, string> {
    const slugger = new GithubSlugger();
    const parts = new Map<string, string>();

    for (const { id, source } of page) {
      const held = this.#documents.get(source) ?? this.#prepared.get(source);
      const block = held?.blocks.find((found) => found.id === id);

      if (block) {
        parts.set(`^${id}`, excerpt(block.title ?? block.text));

        for (const { text, id: anchor } of block.headings ?? []) {
          const key = anchor === undefined ? slugger.slug(text) : `user-content-${anchor}`;

          if (!parts.has(key)) {
            parts.set(key, excerpt(text));
          }
        }
      }
    }

    return parts;
  }

  /** The same text whose file has gone, held, just removed or kept by the store from the last run, moved. */
  #movedTo(version: string): Document | undefined {
    const gone = (document: Document | undefined) =>
      document && !fs.existsSync(path.join(this.#root, document.path)) ? document : undefined;
    const removed = this.#removed.get(version);

    for (const held of this.#byHash.get(version) ?? []) {
      const found = gone(this.#documents.get(held));

      if (found) {
        return found;
      }
    }

    return (
      (removed && Date.now() - removed.at < MOVE_MS ? gone(removed.document) : undefined) ??
      gone(this.#kept.get(version))
    );
  }

  /** A moved document's read state and history follow it; its old place leaves the model unremoved. */
  async #move(moved: Document, to: string): Promise<void> {
    this.#removed.delete(moved.hash);
    this.#kept.delete(moved.hash);

    if (this.#drop(moved.path)) {
      await this.#persist(moved.path);
    }

    await this.reads.rename(moved.path, to);
    await this.history.rename(moved.path, to);
  }

  #notify(changed?: readonly string[]): void {
    for (const listener of this.#listeners) {
      listener(changed);
    }
  }

  async #remove(urlPath: string): Promise<void> {
    const held = this.#documents.get(urlPath);
    this.#failed.delete(urlPath);

    if (held) {
      this.#removed.set(held.hash, { document: held, at: Date.now() });
    }

    if (this.#drop(urlPath)) {
      void this.history.removed(urlPath);
      this.#notify([urlPath]);
      await this.#persist(urlPath);
    }
  }

  /**
   * Old saves thin once a day too, not only when their document is saved again; the first sweep
   * waits a minute, so the pages opened as folio starts never compete with it.
   */
  #sweep(): void {
    const sweep = () =>
      this.history.sweep().catch((error: Error) => this.log(`history: ${error.message}`));

    this.#sweeping = setTimeout(() => {
      void sweep();
      this.#sweeping = setInterval(sweep, SWEEP_MS);
      this.#sweeping.unref();
    }, SWEEP_DELAY_MS);
    this.#sweeping.unref();
  }

  /** A save is kept from the moment folio first knew the document; the first walk knows them all. */
  #saved(urlPath: string, text: string, known: Document | undefined): void {
    if (known ? known.hash !== "" : this.#ready) {
      void this.history.saved(urlPath, text, mtimeOf(path.join(this.#root, urlPath)));
    }
  }

  #watch(dir: string): void {
    if (this.#watches.has(dir)) {
      return;
    }

    try {
      const watcher = fs.watch(dir, { persistent: false }, () => this.#heard(dir));
      watcher.on("error", () => {
        watcher.close();
        this.#watches.delete(dir);
        this.#watchesMoved++;
      });
      this.#watches.set(dir, watcher);
      this.#watchesMoved++;
    } catch (error) {
      this.log(`model: cannot watch ${dir}: ${(error as NodeJS.ErrnoException).code}`);
    }
  }

  /** Saves arrive as bursts - a temporary file, a rename - so events gather for a fixed 50 ms, never longer. */
  #heard(dir: string): void {
    this.#changed.add(dir);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      const dirs = [...this.#changed];
      this.#changed.clear();
      void this.#queue(async () => {
        for (const changed of dirs) {
          await turn();
          await this.#rescan(changed);

          for (const listener of this.#folderListeners) {
            listener(changed);
          }
        }
      });
    }, DEBOUNCE_MS);
  }

  #urlPath(file: string): string {
    return path.relative(this.#root, file).split(path.sep).join("/");
  }

  async #load(): Promise<Map<string, Document>> {
    const documents = path.join(this.#store, "documents");
    const marker = path.join(this.#store, "folder.json");
    const found = new Map<string, Document>();
    const held = await readJson<{ format: number; root: string }>(marker);

    if (held?.root !== this.#root) {
      await fs.promises.rm(documents, { recursive: true, force: true });
    }

    // A store of an older format is parsed again, its blocks lending their ids to the new ones.
    for (const name of await fs.promises.readdir(documents).catch(() => [])) {
      const document = current(await readJson<Stored>(path.join(documents, name)));

      if (document) {
        found.set(document.path, held?.format === FORMAT ? document : { ...document, hash: "" });
      }
    }

    if (held?.format !== FORMAT || held.root !== this.#root) {
      await fs.promises.mkdir(this.#store, { recursive: true });
      await fs.promises.writeFile(marker, JSON.stringify({ format: FORMAT, root: this.#root }));
    }

    return found;
  }

  /** Writes run one at a time and store what the model holds when each runs, so the last one wins. */
  #persist(urlPath: string): Promise<void> {
    this.#writes = this.#writes.then(async () => {
      const document = this.#documents.get(urlPath);
      const file = this.#file(urlPath);

      try {
        if (document) {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          await fs.promises.writeFile(
            `${file}.tmp`,
            JSON.stringify({ ...document, format: FORMAT }),
          );
          await fs.promises.rename(`${file}.tmp`, file);
        } else {
          await fs.promises.rm(file, { force: true });
        }
      } catch (error) {
        this.log(`model: cannot store ${urlPath}: ${(error as Error).message}`);
      }
    });
    return this.#writes;
  }

  #file(urlPath: string): string {
    return path.join(this.#store, "documents", `${hash(urlPath)}.json`);
  }
}

/**
 * A document another format stored, one an upgrade cut short left or an older folio wrote since, lends its
 * ids but is parsed again.
 */
function current(stored: Stored | undefined): Document | undefined {
  return stored && (stored.format === FORMAT ? stored : { ...stored, hash: "" });
}

function partOf(parts: Map<string, string>, fragment: string): string {
  return (
    parts.get(fragment) ??
    parts.get(`user-content-${fragment}`) ??
    (fragment.startsWith("^") ? "a block no longer on this page" : `#${fragment}`)
  );
}

/** A folder holding no document never awaits, so a walk would otherwise hold every request until it ends. */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function mtimeOf(file: string): number {
  return fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT)}...` : line;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}
