/** Folder watches shared by every subscriber, opened by the first and closed by the last. */

import fs from "node:fs"

export type Watch = (dir: string, onChange: () => void) => { close(): void }

interface Held {
  count: number
  watcher?: { close(): void }
}

/**
 * A file is watched through its folder: a save that renames a temporary file over the original
 * detaches any watch held on the original itself.
 */
const watchFolder: Watch = (dir, onChange) => {
  const watcher = fs.watch(dir, { persistent: false }, onChange)
  watcher.on("error", () => watcher.close())
  return watcher
}

export class WatchRegistry {
  readonly #held = new Map<string, Held>()
  readonly #onChange: (dir: string) => void
  readonly #watch: Watch

  constructor(onChange: (dir: string) => void, watch: Watch = watchFolder) {
    this.#onChange = onChange
    this.#watch = watch
  }

  get folders(): string[] {
    return [...this.#held.keys()]
  }

  acquire(dir: string): void {
    const held = this.#held.get(dir) ?? { count: 0 }
    held.count++
    this.#held.set(dir, held)

    if (held.count === 1) {
      try {
        held.watcher = this.#watch(dir, () => this.#onChange(dir))
      } catch {
        // A folder that does not exist yet has nothing to report; its count still balances release().
      }
    }
  }

  release(dir: string): void {
    const held = this.#held.get(dir)

    if (!held) {
      return
    }

    if (--held.count === 0) {
      held.watcher?.close()
      this.#held.delete(dir)
    }
  }
}
