// Live updates for one tab: a socket carrying what changed among the things the tab shows.

export interface Subscription {
  page?: Record<string, string | null>;
  images?: Record<string, string | null>;
  folders?: Record<string, string | null>;
}

export interface Change {
  kind: "page" | "image" | "folder";
  path: string;
  version: string | null;
}

// The server pings every 30 s; two missed pings mean the connection died without closing, as it
// does when the machine sleeps, and the socket alone would never notice.
const SILENCE_MS = 65_000;
const WATCHDOG_MS = 5_000;
const RETRY_MS = 2_000;

export class Live {
  readonly #subscription: () => Subscription;
  readonly #onChange: (change: Change) => void;
  #socket: WebSocket | undefined;
  #heard = 0;

  constructor(subscription: () => Subscription, onChange: (change: Change) => void) {
    this.#subscription = subscription;
    this.#onChange = onChange;
    setInterval(() => this.#watchdog(), WATCHDOG_MS);
    document.addEventListener("visibilitychange", () => this.#watchdog());
    window.addEventListener("online", () => this.#watchdog());
  }

  get suspended(): boolean {
    return !this.#socket;
  }

  start(): void {
    const socket = new WebSocket(`ws://${location.host}/?events`);

    this.#socket = socket;
    this.#heard = Date.now();
    socket.addEventListener("open", () => this.resubscribe());
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      this.#heard = Date.now();

      if (message.type === "change") {
        this.#onChange(message);
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket === socket) {
        setTimeout(() => this.#socket === socket && this.#restart(), RETRY_MS);
      }
    });
  }

  stop(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  /** Send the tab's whole subscription; the server answers anything newer than the versions sent. */
  resubscribe(): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "subscribe", ...this.#subscription() }));
    }
  }

  /** Resubscribe shortly, for a tab that failed to apply a change: the server answers it again. */
  retry(): void {
    setTimeout(() => this.resubscribe(), RETRY_MS);
  }

  #watchdog(): void {
    if (this.#socket && Date.now() - this.#heard > SILENCE_MS) {
      this.#restart();
    }
  }

  #restart(): void {
    this.stop();
    this.start();
  }
}
