/** What the reader has read: per document, the version of each block seen, kept beside the model. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Block, versionOf } from "./blocks.ts";
import { linkTarget } from "./files.ts";
import type { Log } from "./http.ts";

interface ReadEntry {
  version: string;
  /** Absent for a block present at the document's first read but not read since. */
  at?: number;
  text?: string;
  /** The version of each embed's data seen in the block, keyed by its file and reference. */
  embeds?: Record<string, string>;
  /** The version of each block the block links to when read, by the link's address. */
  links?: Record<string, string>;
}

export interface ReadRecord {
  path: string;
  at: number;
  /** Block ids in document order, a read block that has since gone kept where it stood. */
  order: string[];
  blocks: Record<string, ReadEntry>;
  /** Blocks of other files read on this page, by file: their changes are this page's too. */
  via?: Record<string, string[]>;
  /** Its dependencies' hashes as of the read at `at`; stale once a later read moves the record's `at`. */
  depended?: { at: number; hashes: Record<string, string> };
}

export interface Mark {
  source: string;
  id: string;
  mark: "new" | "changed";
  /** For a changed block, its text as read and as it stands. */
  before?: string;
  after?: string;
  /** The embeds whose data changed since the block was read. */
  data?: string[];
  /** When the change happened, where known. */
  at?: number;
}

export interface LinkMark {
  source: string;
  id: string;
  url: string;
  state: "changed" | "gone";
}

/** The version of each embed's data now, and when its files last changed, keyed as a read keeps it. */
export type EmbedVersions = Map<string, { version: string; at: number }>;

export interface Removed {
  source: string;
  id: string;
  text: string;
  /** Ids of the nearest blocks still there on either side of where it stood. */
  after?: string;
  before?: string;
  at?: number;
}

export interface Changed {
  path: string;
  blocks: number;
  read: number;
  /** When the latest of its marked changes happened; 0 when none is known. */
  at: number;
}

export interface Seen {
  id: string;
  version: string;
  embeds?: Record<string, string>;
}

const WRITE_MS = 500;
const GONE = "gone";

export class Reads {
  readonly #dir: string;
  readonly #held: (urlPath: string) => Block[] | undefined;
  readonly #goneAt: (urlPath: string, id: string) => number | undefined;
  readonly #log: Log;
  readonly #records = new Map<string, ReadRecord>();
  readonly #dirty = new Set<string>();
  readonly #listeners = new Set<(urlPath: string) => void>();
  #loaded: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #writes = Promise.resolve();

  /** `goneAt` answers when a block left its document, where the model knows. */
  constructor(
    store: string,
    held: (urlPath: string) => Block[] | undefined,
    log: Log,
    goneAt: (urlPath: string, id: string) => number | undefined = () => undefined,
  ) {
    this.#dir = path.join(store, "reads");
    this.#held = held;
    this.#log = log;
    this.#goneAt = goneAt;
  }

  load(): Promise<void> {
    this.#loaded ??= (async () => {
      for (const name of await fs.promises.readdir(this.#dir).catch(() => [])) {
        try {
          const record: ReadRecord = JSON.parse(
            await fs.promises.readFile(path.join(this.#dir, name), "utf8"),
          );
          this.#records.set(record.path, record);
        } catch {
          // A record cut short by a crash is a document read as if for the first time.
        }
      }
    })();
    return this.#loaded;
  }

  get(urlPath: string): ReadRecord | undefined {
    return this.#records.get(urlPath);
  }

  /**
   * What is new to the reader on a page: blocks of documents read before that appeared or changed
   * since, and read blocks that have gone from beside blocks the page shows, or from its own file.
   */
  marks(
    page: { source: string; id: string; version: string }[],
    own: string,
    embeds: EmbedVersions = new Map(),
  ): { marks: Mark[]; removed: Removed[]; links: LinkMark[] } {
    const marks: Mark[] = [];
    const removed: Removed[] = [];
    const links: LinkMark[] = [];
    const shown = new Set(page.map(({ source, id }) => `${source}\0${id}`));

    for (const { source, id, version } of page) {
      const entries = this.#records.get(source)?.blocks;
      const entry = entries?.[id];

      if (!entries) {
        continue;
      }

      const block = this.#held(source)?.find((found) => found.id === id);

      if (!entry) {
        marks.push({ source, id, mark: "new", ...(block?.seen && { at: block.seen }) });
        continue;
      }

      if (entry.at === undefined) {
        continue;
      }

      const moved = Object.entries(entry.embeds ?? {}).filter(
        ([key, seen]) => embeds.has(key) && embeds.get(key)?.version !== seen,
      );
      const data = moved.map(([key]) => key.slice(key.indexOf("\n") + 1));
      const reworded = entry.version !== version;

      if (reworded || data.length > 0) {
        const at = Math.max(
          reworded ? (block?.seen ?? 0) : 0,
          ...moved.map(([key]) => embeds.get(key)?.at ?? 0),
        );
        marks.push({
          source,
          id,
          mark: "changed",
          ...(reworded && { before: entry.text, after: block?.text }),
          ...(data.length > 0 && { data }),
          ...(at > 0 && { at }),
        });
      }

      for (const [url, seen] of Object.entries(entry.links ?? {})) {
        const now = this.#target(source, url);

        if (now !== seen) {
          links.push({ source, id, url, state: now === GONE ? "gone" : "changed" });
        }
      }
    }

    for (const source of new Set(page.map((block) => block.source))) {
      const record = this.#records.get(source);
      const present = new Set(this.#held(source)?.map((block) => block.id));

      for (const [index, id] of (record?.order ?? []).entries()) {
        const entry = record?.blocks[id];

        if (!record || !entry?.text || entry.at === undefined || present.has(id)) {
          continue;
        }

        const after = record.order.slice(0, index).findLast((other) => present.has(other));
        const before = record.order.slice(index + 1).find((other) => present.has(other));
        const near = [after, before].some((other) => shown.has(`${source}\0${other}`));

        if (near || source === own) {
          const at = this.#goneAt(source, id);
          removed.push({ source, id, text: entry.text, after, before, ...(at && { at }) });
        }
      }
    }

    return { marks, removed, links };
  }

  /**
   * Every document read before with blocks changed since, with how many: its own blocks added,
   * changed or removed, and those of other files read on it, their embedded data included.
   */
  changed(embeds: EmbedVersions = new Map()): Changed[] {
    const found: Changed[] = [];

    for (const record of this.#records.values()) {
      const current = this.#held(record.path);

      if (!current) {
        continue;
      }

      const own = this.marks(this.#shown(record.path, current), record.path, embeds);
      const times = [...own.marks, ...own.removed].map((mark) => mark.at ?? 0);
      let blocks = own.marks.length + own.removed.length;

      // An included part is contiguous: it runs from the first to the last block read here.
      // New blocks at either edge widen it and count, as do read blocks gone from it.
      for (const [source, ids] of Object.entries(record.via ?? {})) {
        const held = this.#held(source) ?? [];
        const entries = this.#records.get(source)?.blocks ?? {};
        const at = held.flatMap((block, index) => (ids.includes(block.id) ? [index] : []));
        let first = Math.min(...at);
        let last = Math.max(...at);

        while (at.length > 0 && first > 0 && !entries[held[first - 1].id]) {
          first--;
        }

        while (at.length > 0 && last + 1 < held.length && !entries[held[last + 1].id]) {
          last++;
        }

        const part = at.length > 0 ? held.slice(first, last + 1) : [];
        const gone = ids.filter(
          (id) => entries[id]?.at !== undefined && !held.some((block) => block.id === id),
        );
        const marked = this.marks(this.#shown(source, part), record.path, embeds).marks;

        blocks += marked.length + gone.length;
        times.push(
          ...marked.map((mark) => mark.at ?? 0),
          ...gone.map((id) => this.#goneAt(source, id) ?? 0),
        );
      }

      if (blocks > 0) {
        found.push({ path: record.path, blocks, read: record.at, at: Math.max(...times) });
      }
    }

    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Every document read under a folder, with when it was last read, newest first. */
  documents(folder = ""): { path: string; at: string }[] {
    return [...this.#records.values()]
      .filter((record) => record.path.startsWith(folder))
      .map((record) => ({
        path: record.path,
        at: Math.max(record.at, ...Object.values(record.blocks).map((entry) => entry.at ?? 0)),
      }))
      .sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))
      .map(({ path: at, at: when }) => ({ path: at, at: new Date(when).toISOString() }));
  }

  embedKeys(): string[] {
    return [
      ...new Set(
        [...this.#records.values()].flatMap((record) =>
          Object.values(record.blocks).flatMap((entry) => Object.keys(entry.embeds ?? {})),
        ),
      ),
    ];
  }

  listen(listener: (urlPath: string) => void): void {
    this.#listeners.add(listener);
  }

  /** A block whose version the model no longer holds was read before an edit not yet drawn: skipped. */
  async read(urlPath: string, seen: Seen[], at = Date.now(), page?: string): Promise<void> {
    await this.load();
    const current = this.#held(urlPath);

    if (!current) {
      return;
    }

    const record = this.#records.get(urlPath) ?? baseline(urlPath, current, at);
    const before = this.#records.has(urlPath) ? JSON.stringify(record) : "";
    const read: string[] = [];

    for (const { id, version, embeds } of seen) {
      const block = current.find((found) => found.id === id);

      if (!block || versionOf(block) !== version) {
        continue;
      }

      const links = Object.fromEntries(
        (block.links ?? []).flatMap(({ url }) => {
          const target = this.#target(urlPath, url);
          return target === undefined ? [] : [[url, target]];
        }),
      );
      const entry: ReadEntry = {
        version,
        at,
        text: block.text,
        ...(embeds && Object.keys(embeds).length > 0 && { embeds }),
        ...(Object.keys(links).length > 0 && { links }),
      };
      const held = record.blocks[id];

      read.push(id);

      if (!held?.at || JSON.stringify({ ...held, at }) !== JSON.stringify(entry)) {
        record.blocks[id] = entry;
      }
    }

    record.order = merged(record, current);

    for (const id of Object.keys(record.blocks)) {
      if (record.blocks[id].at === undefined && !current.some((block) => block.id === id)) {
        delete record.blocks[id];
      }
    }

    if (read.length > 0) {
      record.at = at;
    }

    if (JSON.stringify(record) !== before) {
      this.#records.set(urlPath, record);
      this.#changed(urlPath);
    }

    if (page && page !== urlPath && read.length > 0) {
      this.#readVia(page, urlPath, read, at);
    }
  }

  async depended(urlPath: string, at: number, hashes: Record<string, string>): Promise<void> {
    await this.load();
    const record = this.#records.get(urlPath);

    if (record?.at !== at || JSON.stringify(record.depended) === JSON.stringify({ at, hashes })) {
      return;
    }

    record.depended = { at, hashes };
    this.#changed(urlPath);
  }

  #readVia(page: string, source: string, ids: string[], at: number): void {
    const current = this.#held(page);
    const record = this.#records.get(page) ?? (current && baseline(page, current, at));
    const held = record?.via?.[source] ?? [];
    const via = [...new Set([...held, ...ids])];

    if (record && via.length > held.length) {
      record.via = { ...record.via, [source]: via };
      this.#records.set(page, record);
      this.#changed(page);
    }
  }

  /** What a link to a block or a heading points at now: its version, or gone; nothing for any other link. */
  #target(from: string, url: string): string | undefined {
    const target = linkTarget(from, url);

    if (!target?.fragment || !/\.(md|markdown|mermaid|mmd)$/i.test(target.path)) {
      return undefined;
    }

    const block = this.#held(target.path)?.find((found) =>
      target.fragment.startsWith("^")
        ? found.id === target.fragment.slice(1)
        : found.slug === target.fragment,
    );

    return block ? versionOf(block) : GONE;
  }

  #shown(source: string, blocks: Block[]): { source: string; id: string; version: string }[] {
    return blocks.map((block) => ({ source, id: block.id, version: versionOf(block) }));
  }

  /** Carry a document's record to where it moved, and every page's record of reading it there too. */
  async rename(from: string, to: string): Promise<void> {
    await this.load();
    const record = this.#records.get(from);

    if (record && !this.#records.has(to)) {
      this.#records.delete(from);
      this.#records.set(to, { ...record, path: to });
      this.#changed(from);
      this.#changed(to);
    }

    for (const [page, other] of this.#records) {
      if (other.via?.[from]) {
        const { [from]: ids, ...rest } = other.via;
        other.via = { ...rest, [to]: ids };
        this.#changed(page);
      }
    }
  }

  async forget(urlPath: string, ids: string[]): Promise<void> {
    await this.load();
    const record = this.#records.get(urlPath);
    const current = new Set(this.#held(urlPath)?.map((block) => block.id));
    const gone = ids.filter((id) => record?.blocks[id] && !current.has(id));

    if (!record || gone.length === 0) {
      return;
    }

    for (const id of gone) {
      delete record.blocks[id];
    }

    record.order = record.order.filter((id) => !gone.includes(id));
    this.#changed(urlPath);
  }

  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const paths = [...this.#dirty];
    this.#dirty.clear();
    this.#writes = this.#writes.then(async () => {
      for (const urlPath of paths) {
        await this.#write(urlPath);
      }
    });
    return this.#writes;
  }

  #changed(urlPath: string): void {
    this.#dirty.add(urlPath);
    this.#timer ??= setTimeout(() => void this.flush(), WRITE_MS);

    for (const listener of this.#listeners) {
      listener(urlPath);
    }
  }

  async #write(urlPath: string): Promise<void> {
    const record = this.#records.get(urlPath);
    const file = path.join(this.#dir, `${hash(urlPath)}.json`);

    try {
      await fs.promises.mkdir(this.#dir, { recursive: true });

      if (record) {
        await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(record));
        await fs.promises.rename(`${file}.tmp`, file);
      } else {
        await fs.promises.rm(file, { force: true });
      }
    } catch (error) {
      this.#log(`reads: cannot store ${urlPath}: ${(error as Error).message}`);
    }
  }
}

/** The blocks present when a document is first read: a block absent from them appeared since. */
function baseline(urlPath: string, current: Block[], at: number): ReadRecord {
  return {
    path: urlPath,
    at,
    order: current.map((block) => block.id),
    blocks: Object.fromEntries(current.map((block) => [block.id, { version: versionOf(block) }])),
  };
}

function merged(record: ReadRecord, current: Block[]): string[] {
  const order = current.map((block) => block.id);
  const present = new Set(order);

  for (const [index, id] of record.order.entries()) {
    if (!present.has(id) && record.blocks[id]?.at !== undefined) {
      const before = record.order.slice(0, index).findLast((other) => order.includes(other));
      order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
    }
  }

  return order;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}
