/** Per-tab update sockets: each tab subscribes to what it shows and hears only when that changes. */

import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { Data } from "./data.ts";
import { confine, isDocument, isInside, renderable, subfolders } from "./files.ts";
import { healthOf } from "./health.ts";
import { isLocal, type Log } from "./http.ts";
import { impactOf } from "./impact.ts";
import type { Model } from "./model.ts";
import { needsOf } from "./needs.ts";
import { presenceOf } from "./presence.ts";
import type { Seen } from "./reads.ts";
import { staleOf } from "./stale.ts";
import { changed, fileVersion, folderState, linksState, pageState, readState } from "./versions.ts";
import { WatchRegistry } from "./watch.ts";

type Kind =
  | "page"
  | "image"
  | "folder"
  | "links"
  | "data"
  | "embed"
  | "reads"
  | "changes"
  | "health"
  | "needs"
  | "stale";

/** What a tab shows, each item keyed by its URL path and mapped to the version the tab holds. */
export interface Subscription {
  page?: Record<string, string | null>;
  images?: Record<string, string | null>;
  folders?: Record<string, string | null>;
  links?: Record<string, string | null>;
  reads?: Record<string, string | null>;
  /** The folder's catch-up list, under the key "". */
  changes?: Record<string, string | null>;
  /** The folder's health, under the key "". */
  health?: Record<string, string | null>;
  /** What needs the reader, under the key "". */
  needs?: Record<string, string | null>;
  /** Documents that have outlived their use, under the key "". */
  stale?: Record<string, string | null>;
  data?: Record<string, string | null>;
  /** Embeds, each keyed by the document holding it and its reference, a line break between. */
  embeds?: Record<string, string | null>;
  withData?: boolean;
}

interface Item {
  kind: Kind;
  urlPath: string;
  version: string | null;
  dirs: string[];
  withData: boolean;
  /** Whether what it shows reads the folder's documents as tables, which any change in the folder can move. */
  documents?: boolean;
  /** Counts refreshes, so one overtaken by a later refresh or a release lands nowhere. */
  refreshes: number;
}

interface Tab {
  id: number;
  socket: WebSocket;
  items: Map<string, Item>;
  pending: Set<string>;
  /** Refreshes land one after another, in the order they were asked for. */
  landing: Promise<void>;
  alive: boolean;
  timer?: NodeJS.Timeout;
}

const KINDS: Record<Exclude<keyof Subscription, "withData">, Kind> = {
  page: "page",
  images: "image",
  folders: "folder",
  links: "links",
  reads: "reads",
  changes: "changes",
  health: "health",
  needs: "needs",
  stale: "stale",
  data: "data",
  embeds: "embed",
};
const DEBOUNCE_MS = 50;
const MAX_MESSAGE = 1 << 20;
const MAX_READ = 10_000;

/**
 * A WebSocket rather than an event stream: browsers allow six HTTP connections per host, so six
 * tabs each holding a stream would leave no connection for loading a page.
 */
export class Hub {
  readonly registry: WatchRegistry;
  readonly #root: string;
  readonly #build: string;
  readonly #log: Log;
  readonly #tabs = new Set<Tab>();
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  #next = 0;
  #model: Model | undefined;
  #data: Data | undefined;
  #unwatched: { dirs: string; watches: number; found: string[] } | undefined;

  constructor(root: string, build: string, log: Log, heartbeatMs = 30_000) {
    this.#root = root;
    this.#build = build;
    this.#log = log;
    this.registry = new WatchRegistry((dir) => this.#changed(dir));
    setInterval(() => this.#heartbeat(), heartbeatMs).unref();
  }

  /** Tell tabs when the links into their page, its block sources or what is new on it change. */
  follow(model: Model): void {
    this.#model = model;
    model.listen(() =>
      this.#refreshKinds(["links", "reads", "changes", "health", "needs", "stale"], true),
    );
    model.reads.listen(() => this.#refreshKinds(["reads", "changes", "needs", "stale"]));
    presenceOf(model).listen((paused) => {
      for (const tab of this.#tabs) {
        this.#emit(tab, { type: "sharing", paused });
      }
    });
  }

  /** Answer embed subscriptions by the files each embed reads, and health by what moves it. */
  read(data: Data): void {
    this.#data = data;

    if (this.#model) {
      healthOf(this.#model, data).listen(() => this.#refreshKinds(["health", "needs"]));
    }
  }

  #refreshKinds(kinds: Kind[], documents = false): void {
    for (const tab of this.#tabs) {
      for (const [key, item] of tab.items) {
        if (
          kinds.includes(item.kind) ||
          item.version?.endsWith("-partial") ||
          (documents && item.documents)
        ) {
          tab.pending.add(key);
        }
      }

      this.#schedule(tab);
    }
  }

  attach(server: http.Server): void {
    server.on("upgrade", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;

      // Any web page can open a WebSocket to localhost; only folio's own pages may open this one.
      if (
        !query.has("events") ||
        !isLocal(request.headers.host) ||
        !isLocal(request.headers.origin)
      ) {
        this.#log(`GET ${request.url} 403`);
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }

      this.#server.handleUpgrade(request, socket, head, (ws) => {
        this.#log(`GET ${request.url} 101`);
        this.#open(ws);
      });
    });
  }

  #open(socket: WebSocket): void {
    const tab: Tab = {
      id: ++this.#next,
      socket,
      items: new Map(),
      pending: new Set(),
      landing: Promise.resolve(),
      alive: true,
    };

    this.#tabs.add(tab);
    socket.on("pong", () => {
      tab.alive = true;
    });
    socket.on("message", (data) => this.#message(tab, String(data)));
    socket.on("close", () => this.#close(tab));
    socket.on("error", () => socket.terminate());
    this.#emit(tab, { type: "hello", build: this.#build });

    if (this.#model) {
      this.#emit(tab, { type: "sharing", paused: presenceOf(this.#model).paused });
    }
  }

  #close(tab: Tab): void {
    clearTimeout(tab.timer);
    this.#tabs.delete(tab);

    if (this.#model) {
      presenceOf(this.#model).look(tab.id, undefined);
    }

    for (const item of tab.items.values()) {
      this.#release(item);
    }
  }

  #message(tab: Tab, data: string): void {
    let message: { type?: string } & Subscription;

    try {
      message = JSON.parse(data);
    } catch {
      tab.socket.close(1003, "Bad subscription");
      return;
    }

    if (message.type === "subscribe") {
      this.#replace(tab, message);
    } else if (message.type === "read") {
      const { blocks, page } = message as { blocks?: unknown; page?: unknown };
      this.#read(blocks, page);
    } else if (message.type === "digested") {
      const { to } = message as { to?: unknown };

      if (typeof to === "number" && Number.isFinite(to)) {
        void this.#model?.history.markDigest(to);
      }
    } else if (message.type === "presence" && this.#model) {
      const { page, source, id } = message as { page?: unknown; source?: unknown; id?: unknown };
      presenceOf(this.#model).look(
        tab.id,
        typeof page === "string"
          ? {
              page,
              ...(typeof source === "string" &&
                typeof id === "string" && { block: { source, id } }),
              at: new Date().toISOString(),
            }
          : undefined,
      );
    } else if (message.type === "share" && this.#model) {
      const { paused } = message as { paused?: unknown };

      if (typeof paused === "boolean") {
        presenceOf(this.#model).pause(paused);
      }
    } else if (message.type === "forget") {
      const { source, ids } = message as { source?: unknown; ids?: unknown };

      if (typeof source === "string" && Array.isArray(ids)) {
        void this.#model?.reads.forget(
          source,
          ids.filter((id) => typeof id === "string"),
        );
      }
    }
  }

  #read(blocks: unknown, page: unknown): void {
    const reads = this.#model?.reads;
    const bySource = new Map<string, Seen[]>();

    if (!reads || !Array.isArray(blocks)) {
      return;
    }

    for (const block of blocks.slice(0, MAX_READ)) {
      const { source, id, version, embeds } = (block ?? {}) as Record<string, unknown>;

      if (typeof source === "string" && typeof id === "string" && typeof version === "string") {
        const seen: Seen = { id, version, ...(isVersions(embeds) && { embeds }) };
        bySource.set(source, [...(bySource.get(source) ?? []), seen]);
      }
    }

    for (const [source, seen] of bySource) {
      const at = Date.now();

      reads
        .read(source, seen, at, typeof page === "string" ? page : undefined)
        .then(async () => {
          if (this.#model && this.#data) {
            const impact = impactOf(this.#model, this.#data);
            await reads.depended(source, at, await impact.hashes(source, at));
          }
        })
        .catch((error: Error) => this.#log(`reads: ${source}: ${error.message}`));
    }
  }

  /** A tab that never answered the last ping died without closing, as it does when a machine sleeps. */
  #heartbeat(): void {
    for (const tab of this.#tabs) {
      if (!tab.alive) {
        tab.socket.terminate();
        continue;
      }

      tab.alive = false;
      tab.socket.ping();
      this.#emit(tab, { type: "ping" });
    }
  }

  /**
   * Swaps the tab's whole subscription, then answers every item whose version moved since the tab
   * fetched it - which is how a tab catches up after a suspend or a dropped connection.
   */
  #replace(tab: Tab, subscription: Subscription): void {
    const previous = tab.items;
    tab.items = new Map();

    // An item named again keeps its watches until its refresh lands, so no save falls in between.
    for (const [field, kind] of Object.entries(KINDS) as [keyof typeof KINDS, Kind][]) {
      for (const [urlPath, version] of Object.entries(subscription[field] ?? {})) {
        const key = `${kind}:${urlPath}`;
        const held = previous.get(key);
        const item: Item = {
          kind,
          urlPath,
          version,
          dirs: held?.dirs ?? [],
          withData: kind === "folder" && subscription.withData === true,
          refreshes: 0,
        };

        if (held) {
          held.dirs = [];
        }

        tab.items.set(key, item);
        this.#refresh(tab, item);
      }
    }

    for (const item of previous.values()) {
      this.#release(item);
    }
  }

  #changed(dir: string): void {
    if (this.#model && this.#data) {
      healthOf(this.#model, this.#data).heard(dir);
    }

    for (const tab of this.#tabs) {
      for (const [key, item] of tab.items) {
        if (item.dirs.includes(dir)) {
          tab.pending.add(key);
        }
      }

      this.#schedule(tab);
    }
  }

  #schedule(tab: Tab): void {
    if (tab.pending.size > 0 && !tab.timer) {
      tab.timer = setTimeout(() => this.#flush(tab), DEBOUNCE_MS);
    }
  }

  /** Editors save in bursts - a temporary file, a rename, a chmod - so changes settle before checking. */
  #flush(tab: Tab): void {
    tab.timer = undefined;

    for (const key of tab.pending) {
      const item = tab.items.get(key);

      if (item) {
        this.#refresh(tab, item);
      }
    }

    tab.pending.clear();
  }

  #refresh(tab: Tab, item: Item): void {
    const refresh = ++item.refreshes;
    const state = this.#state(item);

    tab.landing = tab.landing
      .then(() => state)
      .then((landed) => {
        if (refresh === item.refreshes && this.#tabs.has(tab)) {
          this.#apply(tab, item, landed);
        }
      })
      .catch((error: Error) => this.#log(`update ${item.kind} /${item.urlPath}: ${error.message}`));
  }

  #apply(
    tab: Tab,
    item: Item,
    { version, dirs, documents }: { version: string | null; dirs: string[]; documents?: boolean },
  ): void {
    const previousDirs = item.dirs;

    item.dirs = dirs;
    item.documents = documents;

    for (const dir of dirs) {
      this.registry.acquire(dir);
    }

    for (const dir of previousDirs) {
      this.registry.release(dir);
    }

    if (version !== item.version) {
      item.version = version;
      this.#emit(tab, { type: "change", kind: item.kind, path: item.urlPath, version });
      this.#log(`update ${item.kind} /${item.urlPath} -> tab ${tab.id}`);
    }
  }

  async #state(
    item: Item,
  ): Promise<{ version: string | null; dirs: string[]; documents?: boolean }> {
    const root = this.#root;
    const lexicalDir = path.dirname(path.join(root, item.urlPath));

    if (item.kind === "links") {
      const page = this.#model && renderable(root, item.urlPath);
      const blocks =
        page && isDocument(page.kind) ? pageState(root, page.file, this.#model).blocks : [];
      return {
        version: this.#model ? linksState(this.#model, item.urlPath, blocks).version : null,
        dirs: [],
      };
    }

    // The list changes with the data a read embed shows, so the folders of that data are watched.
    if (item.kind === "changes") {
      const model = this.#model;
      const data = this.#data;

      if (!model) {
        return { version: null, dirs: [] };
      }

      const { version } = await changed(model, data);
      const files = await Promise.all(
        model.reads.embedKeys().map(async (key) => {
          const [from, reference] = key.split("\n");
          const document = renderable(root, from);
          return data && document && isDocument(document.kind) && reference !== undefined
            ? (await data.reads(document.file, reference)).files
            : [];
        }),
      );

      return {
        version,
        dirs: [...new Set(files.flat().map((file) => watchable(root, path.dirname(file))))],
      };
    }

    if (item.kind === "health") {
      if (!this.#model || !this.#data) {
        return { version: null, dirs: [] };
      }

      // The model watches every folder but pruned ones; a tab on health watches those its documents reach.
      const model = this.#model;
      const health = healthOf(model, this.#data);
      const version = await health.checkedVersion();
      const { dirs } = health;

      // Worked out again only when health reaches other folders or the model watches others.
      const reached = dirs.join("\0");

      if (this.#unwatched?.dirs !== reached || this.#unwatched.watches !== model.watchesVersion) {
        const unwatched = dirs.filter((dir) => !model.watches(dir));
        this.#unwatched = {
          dirs: reached,
          watches: model.watchesVersion,
          found: [...new Set(unwatched.map((dir) => watchable(root, dir)))],
        };
      }

      return { version, dirs: this.#unwatched.found };
    }

    if (item.kind === "needs" || item.kind === "stale") {
      if (!this.#model || !this.#data) {
        return { version: null, dirs: [] };
      }

      const { version, watched } = await (item.kind === "needs" ? needsOf : staleOf)(
        this.#model,
        this.#data,
      );
      return { version, dirs: [...new Set(watched.map((dir) => watchable(root, dir)))] };
    }

    if (item.kind === "reads") {
      const page = this.#model && renderable(root, item.urlPath);

      if (!this.#model || !page || !isDocument(page.kind)) {
        return { version: null, dirs: [] };
      }

      const blocks = pageState(root, page.file, this.#model).blocks;
      const state = await readState(this.#model, item.urlPath, blocks, this.#data);
      return { version: state.version, dirs: [] };
    }

    if (item.kind === "embed") {
      return this.#embedState(item.urlPath);
    }

    // A folder lists a subfolder only while it holds something renderable, so its subfolders are watched too.
    // The first file saved into a new subfolder then shows in the listing.
    if (item.kind === "folder") {
      const dir = confine(root, item.urlPath);
      const dirs = dir
        ? [dir, ...subfolders(dir)]
        : [watchable(root, path.join(root, item.urlPath))];
      return { version: folderState(root, item.urlPath, item.withData)?.version ?? null, dirs };
    }

    const target = renderable(root, item.urlPath);
    const fits = item.kind === "page" ? isDocument(target?.kind) : target?.kind === item.kind;

    if (!target || !fits) {
      return { version: null, dirs: [watchable(root, lexicalDir)] };
    }

    if (item.kind === "image" || item.kind === "data") {
      return { version: fileVersion(target.file) ?? null, dirs: [path.dirname(target.file)] };
    }

    const page = pageState(root, target.file, this.#model);
    const dirs = new Set([lexicalDir, ...page.files.map((file) => path.dirname(file))]);
    return { version: page.version, dirs: [...dirs].map((dir) => watchable(root, dir)) };
  }

  /** A reference that names nothing yet is watched where its file would appear. */
  async #embedState(
    key: string,
  ): Promise<{ version: string | null; dirs: string[]; documents?: boolean }> {
    const root = this.#root;
    const [from, reference] = key.split("\n");
    const document = renderable(root, from);

    if (!document || !isDocument(document.kind) || reference === undefined || !this.#data) {
      return { version: null, dirs: [watchable(root, path.dirname(path.join(root, from)))] };
    }

    const {
      files,
      version,
      missing,
      tables,
      dirs: matched = [],
    } = await this.#data.reads(document.file, reference);
    const dirs = new Set([
      ...files.map((file) => watchable(root, path.dirname(file))),
      ...matched.map((dir) => watchable(root, dir)),
      ...(missing && isInside(root, missing) ? [watchable(root, path.dirname(missing))] : []),
      // One of the document's own queries moves with the document's text, as nothing else it reads does.
      ...((files.length === 0 && !missing) || reference.startsWith("#")
        ? [watchable(root, path.dirname(document.file))]
        : []),
    ]);

    return { version, dirs: [...dirs], ...(tables && { documents: true }) };
  }

  #release(item: Item): void {
    item.refreshes++;

    for (const dir of item.dirs) {
      this.registry.release(dir);
    }

    item.dirs = [];
  }

  #emit(tab: Tab, message: object): void {
    tab.socket.send(JSON.stringify(message));
  }
}

function isVersions(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((version) => typeof version === "string")
  );
}

/**
 * The nearest existing folder inside root at or above a path. A missing folder is watched through
 * its parent, so creating it is heard, and nothing outside root is ever watched.
 */
function watchable(root: string, target: string): string {
  for (let dir = target; isInside(root, dir); dir = path.dirname(dir)) {
    const real = confine(root, path.relative(root, dir));

    if (real) {
      return real;
    }
  }

  return root;
}
