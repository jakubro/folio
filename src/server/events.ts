// Per-tab update sockets: each tab subscribes to what it shows and hears only when that changes.

import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { confine, isInside, renderable, subfolders } from "./files.ts";
import { isLocal, type Log } from "./http.ts";
import { fileVersion, folderState, pageState } from "./versions.ts";
import { WatchRegistry } from "./watch.ts";

type Kind = "page" | "image" | "folder";

/** What a tab shows, each item keyed by its URL path and mapped to the version the tab holds. */
export interface Subscription {
  page?: Record<string, string | null>;
  images?: Record<string, string | null>;
  folders?: Record<string, string | null>;
}

interface Item {
  kind: Kind;
  urlPath: string;
  version: string | null;
  dirs: string[];
}

interface Tab {
  id: number;
  socket: WebSocket;
  items: Map<string, Item>;
  pending: Set<string>;
  alive: boolean;
  timer?: NodeJS.Timeout;
}

const KINDS: Record<keyof Subscription, Kind> = {
  page: "page",
  images: "image",
  folders: "folder",
};
const DEBOUNCE_MS = 50;
const MAX_MESSAGE = 1 << 20;

// A WebSocket rather than an event stream: browsers allow six HTTP connections per host, so six
// tabs each holding a stream would leave no connection for loading a page.
export class Hub {
  readonly registry: WatchRegistry;
  readonly #root: string;
  readonly #log: Log;
  readonly #tabs = new Set<Tab>();
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  #next = 0;

  constructor(root: string, log: Log, heartbeatMs = 30_000) {
    this.#root = root;
    this.#log = log;
    this.registry = new WatchRegistry((dir) => this.#changed(dir));
    setInterval(() => this.#heartbeat(), heartbeatMs).unref();
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
      alive: true,
    };

    this.#tabs.add(tab);
    socket.on("pong", () => {
      tab.alive = true;
    });
    socket.on("message", (data) => this.#message(tab, String(data)));
    socket.on("close", () => this.#close(tab));
    socket.on("error", () => socket.terminate());
  }

  #close(tab: Tab): void {
    clearTimeout(tab.timer);
    this.#tabs.delete(tab);

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
    }
  }

  // A tab that never answered the last ping died without closing, as it does when a machine sleeps.
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

  // Swaps the tab's whole subscription, then answers every item whose version moved since the tab
  // fetched it - which is how a tab catches up after a suspend or a dropped connection.
  #replace(tab: Tab, subscription: Subscription): void {
    const previous = tab.items;
    tab.items = new Map();

    for (const [field, kind] of Object.entries(KINDS) as [keyof Subscription, Kind][]) {
      for (const [urlPath, version] of Object.entries(subscription[field] ?? {})) {
        const item: Item = { kind, urlPath, version, dirs: [] };
        tab.items.set(`${kind}:${urlPath}`, item);
        this.#refresh(tab, item);
      }
    }

    for (const item of previous.values()) {
      this.#release(item);
    }
  }

  #changed(dir: string): void {
    for (const tab of this.#tabs) {
      for (const [key, item] of tab.items) {
        if (item.dirs.includes(dir)) {
          tab.pending.add(key);
        }
      }

      if (tab.pending.size > 0 && !tab.timer) {
        tab.timer = setTimeout(() => this.#flush(tab), DEBOUNCE_MS);
      }
    }
  }

  // Editors save in bursts - a temporary file, a rename, a chmod - so changes settle before checking.
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
    const { version, dirs } = this.#state(item);
    const previousDirs = item.dirs;

    item.dirs = dirs;

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

  #state(item: Item): { version: string | null; dirs: string[] } {
    const root = this.#root;
    const lexicalDir = path.dirname(path.join(root, item.urlPath));

    // A folder lists a subfolder only while it holds something renderable, so its subfolders are
    // watched too: the first file saved into a new subfolder then shows in the listing.
    if (item.kind === "folder") {
      const dir = confine(root, item.urlPath);
      const dirs = dir
        ? [dir, ...subfolders(dir)]
        : [watchable(root, path.join(root, item.urlPath))];
      return { version: folderState(root, item.urlPath)?.version ?? null, dirs };
    }

    const target = renderable(root, item.urlPath);

    if (!target) {
      return { version: null, dirs: [watchable(root, lexicalDir)] };
    }

    if (item.kind === "image") {
      return { version: fileVersion(target.file) ?? null, dirs: [path.dirname(target.file)] };
    }

    const page = pageState(root, target.file);
    const dirs = new Set([lexicalDir, ...page.files.map((file) => path.dirname(file))]);
    return { version: page.version, dirs: [...dirs].map((dir) => watchable(root, dir)) };
  }

  #release(item: Item): void {
    for (const dir of item.dirs) {
      this.registry.release(dir);
    }

    item.dirs = [];
  }

  #emit(tab: Tab, message: object): void {
    tab.socket.send(JSON.stringify(message));
  }
}

// The nearest existing folder inside root at or above a path. A missing folder is watched through
// its parent, so creating it is heard, and nothing outside root is ever watched.
function watchable(root: string, target: string): string {
  for (let dir = target; isInside(root, dir); dir = path.dirname(dir)) {
    const real = confine(root, path.relative(root, dir));

    if (real) {
      return real;
    }
  }

  return root;
}
