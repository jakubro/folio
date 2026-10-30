/** Live updates for one tab: a socket carrying what changed among the things the tab shows. */

import type { Subscription } from "../server/events.ts"

export type { Subscription }

export interface Change {
  kind:
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
    | "stale"
  path: string
  version: string | null
}

/**
 * The server pings every 30 s; two missed pings mean the connection died without closing, as it
 * does when the machine sleeps, and the socket alone would never notice.
 */
const SILENCE_MS = 65_000
const WATCHDOG_MS = 5_000
const RETRY_MS = 2_000

export class Live {
  readonly #subscription: () => Subscription
  readonly #onChange: (change: Change) => void
  readonly #onBuild: (build: string) => void
  #socket: WebSocket | undefined
  #heard = 0
  readonly #outbox: object[] = []
  onSharing: (paused: boolean) => void = () => {}

  constructor(
    subscription: () => Subscription,
    onChange: (change: Change) => void,
    onBuild: (build: string) => void,
  ) {
    this.#subscription = subscription
    this.#onChange = onChange
    this.#onBuild = onBuild
    setInterval(() => this.#watchdog(), WATCHDOG_MS)
    document.addEventListener("visibilitychange", () => this.#watchdog())
    window.addEventListener("online", () => this.#watchdog())
  }

  get suspended(): boolean {
    return !this.#socket
  }

  start(): void {
    const socket = new WebSocket(`ws://${location.host}/?events`)

    this.#socket = socket
    this.#heard = Date.now()
    socket.addEventListener("open", () => {
      this.#drain()
      this.resubscribe()
    })
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data)
      this.#heard = Date.now()

      if (message.type === "change") {
        this.#onChange(message)
      } else if (message.type === "hello") {
        this.#onBuild(message.build)
      } else if (message.type === "sharing") {
        this.onSharing(message.paused)
      }
    })
    socket.addEventListener("close", () => {
      if (this.#socket === socket) {
        setTimeout(() => this.#socket === socket && this.#restart(), RETRY_MS)
      }
    })
  }

  stop(): void {
    const socket = this.#socket
    this.#socket = undefined
    socket?.close()
  }

  /** Send the tab's whole subscription; the server answers anything newer than the versions sent. */
  resubscribe(): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "subscribe", ...this.#subscription() }))
    }
  }

  /** Send now, or once the socket reopens: a suspended tab sends nothing until resumed. */
  send(message: object): void {
    this.#outbox.push(message)
    this.#drain()
  }

  /** Send now if the socket is open, or never: what is stale by the time it reopens is dropped. */
  tell(message: object): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message))
    }
  }

  /** Resubscribe shortly, for a tab that failed to apply a change: the server answers it again. */
  retry(): void {
    setTimeout(() => this.resubscribe(), RETRY_MS)
  }

  #drain(): void {
    while (this.#outbox.length > 0 && this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(this.#outbox.shift()))
    }
  }

  #watchdog(): void {
    if (this.#socket && Date.now() - this.#heard > SILENCE_MS) {
      this.#restart()
    }
  }

  #restart(): void {
    this.stop()
    this.start()
  }
}
