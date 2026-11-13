/** Whether another program holds a file open for writing, told on a worker thread so no request waits on it. */

import { createHash } from "node:crypto"
import fs from "node:fs"
import { Worker } from "node:worker_threads"

interface Waiting {
  resolve: (held: boolean) => void
}

const IDLE_MS = 10_000
const POLL_MS = 25
/** Past this, a file a program keeps open and empty is taken as it reads. */
const SETTLE_MS = 2000
const READS = 5
const TIMES_KEPT = 1000
const TIMES = new Map<string, number>()
const WORKER = new URL(
  import.meta.url.endsWith(".ts") ? "./writers-worker.ts" : "./writers-worker.js",
  import.meta.url,
)

export interface Settled {
  text: string
  /** The file's time once the text was read, so a later write never dates it. */
  at: number
}

export class Writers {
  readonly #script: URL
  readonly #waiting = new Map<number, Waiting>()
  #worker: Worker | undefined
  #idle: NodeJS.Timeout | undefined
  #next = 0

  constructor(script: URL = WORKER) {
    this.#script = script
  }

  /** A check that cannot run answers held, so nothing is written over a writer it could not see. */
  held(file: string, { dev, ino }: fs.Stats): Promise<boolean> {
    const id = ++this.#next
    this.#worker ??= this.#start()
    clearTimeout(this.#idle)

    return new Promise((resolve) => {
      this.#waiting.set(id, { resolve })
      this.#worker?.postMessage({ id, file, dev, ino })
    })
  }

  /**
   * A file's text once a program rewriting it in place is done: an empty read is taken only once nothing
   * holds the file open for writing, and the text is the one the file held from before to after its read.
   */
  async settled(file: string): Promise<Settled | undefined> {
    const until = Date.now() + SETTLE_MS

    for (;;) {
      const read = await steadyReadOff(file)

      if (read?.text !== "" || Date.now() >= until) {
        return read && { text: read.text, at: read.at }
      }

      if (!(await this.held(file, read.stat))) {
        const again = await steadyReadOff(file)
        return again && { text: again.text, at: again.at }
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  #start(): Worker {
    const worker = new Worker(this.#script)
    worker.unref()
    worker.on("message", ({ id, held }: { id: number; held: boolean }) => {
      this.#waiting.get(id)?.resolve(held)
      this.#waiting.delete(id)

      if (this.#waiting.size === 0) {
        this.#idle = setTimeout(() => {
          if (this.#worker === worker && this.#waiting.size === 0) {
            this.#worker = undefined
            void worker.terminate()
          }
        }, IDLE_MS)
        this.#idle.unref()
      }
    })
    worker.on("error", () => this.#died(worker))
    worker.on("exit", () => this.#died(worker))
    return worker
  }

  #died(worker: Worker): void {
    if (this.#worker !== worker) {
      return
    }

    this.#worker = undefined

    for (const waiting of this.#waiting.values()) {
      waiting.resolve(true)
    }

    this.#waiting.clear()
  }
}

export const writers = new Writers()

/**
 * Linux names every file a process holds open; elsewhere only the file's stillness tells. A descriptor's /proc
 * link is lstat'd and readlink'd without touching its target, so only those open for writing on a file reach
 * fdinfo, the costly read. Only one on the document's own filesystem is looked at, so a hung mount elsewhere
 * cannot stall the check; its device and inode decide, as btrfs subvolumes share a mount device while
 * repeating inode numbers. Another hard link counts too. Without a mount, its path decides.
 */
export function heldForWriting(file: string, { dev, ino }: { dev: number; ino: number }): boolean {
  let pids: string[]

  try {
    pids = fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid) && Number(pid) !== process.pid)
  } catch {
    return false
  }

  const mounts = new Map<string, string>()
  const device = ownDevice(file, mounts)

  for (const pid of pids) {
    let descriptors: string[]

    try {
      descriptors = fs.readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }

    for (const descriptor of descriptors) {
      try {
        const at = `/proc/${pid}/fd/${descriptor}`

        if ((fs.lstatSync(at).mode & 0o200) === 0 || !onFile(fs.readlinkSync(at))) {
          continue
        }

        const info = fs.readFileSync(`/proc/${pid}/fdinfo/${descriptor}`, "utf8")
        const flags = Number.parseInt(/^flags:\s*(\d+)/m.exec(info)?.[1] ?? "0", 8)
        const held = /^ino:\s*(\d+)/m.exec(info)?.[1]

        // The access mode's two bits: write only or read and write.
        if ((flags & 3) === 0 || (held !== undefined && Number(held) !== ino)) {
          continue
        }

        if (device === undefined) {
          if (fs.readlinkSync(at) === file) {
            return true
          }
        } else if (deviceOf(pid, info, mounts) === device) {
          const target = fs.statSync(at)

          if (target.dev === dev && target.ino === ino) {
            return true
          }
        }
      } catch {
        // The process or its descriptor went meanwhile.
      }
    }
  }

  return false
}

/** A file's text as it held from before to after the read, with the file's time then. */
export function steadyRead(file: string): { text: string; at: number; stat: fs.Stats } | undefined {
  for (let tries = 1; ; tries++) {
    try {
      const before = fs.statSync(file)
      const text = fs.readFileSync(file, "utf8")
      const stat = fs.statSync(file)

      if (unmoved(before, stat)) {
        return noted(file, text, stat)
      }

      if (tries >= READS) {
        return { text, at: stat.mtimeMs, stat }
      }
    } catch {
      return undefined
    }
  }
}

/** The file's time when a steady read last found this text in it: the time of the text itself. */
export function readTime(file: string, text: string): number | undefined {
  return TIMES.get(`${file}\0${hashOf(text)}`)
}

async function steadyReadOff(
  file: string,
): Promise<{ text: string; at: number; stat: fs.Stats } | undefined> {
  for (let tries = 1; ; tries++) {
    try {
      const before = await fs.promises.stat(file)
      const text = await fs.promises.readFile(file, "utf8")
      const stat = await fs.promises.stat(file)

      if (unmoved(before, stat)) {
        return noted(file, text, stat)
      }

      if (tries >= READS) {
        return { text, at: stat.mtimeMs, stat }
      }
    } catch {
      return undefined
    }
  }
}

function noted(
  file: string,
  text: string,
  stat: fs.Stats,
): { text: string; at: number; stat: fs.Stats } {
  const key = `${file}\0${hashOf(text)}`
  TIMES.delete(key)
  TIMES.set(key, stat.mtimeMs)

  for (const oldest of [...TIMES.keys()].slice(0, -TIMES_KEPT)) {
    TIMES.delete(oldest)
  }

  return { text, at: stat.mtimeMs, stat }
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

function unmoved(before: fs.Stats, after: fs.Stats): boolean {
  return before.mtimeMs === after.mtimeMs && before.size === after.size && before.ino === after.ino
}

/** Sockets, pipes and anonymous inodes link to `kind:[...]`, and a memory file to `/memfd:`. */
function onFile(target: string): boolean {
  return target.startsWith("/") && !target.startsWith("/memfd:")
}

/** Read from the mount table as another program's descriptor is, not from stat, whose device can differ. */
function ownDevice(file: string, mounts: Map<string, string>): string | undefined {
  let handle: number | undefined

  try {
    handle = fs.openSync(file, "r")
    return deviceOf("self", fs.readFileSync(`/proc/self/fdinfo/${handle}`, "utf8"), mounts)
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle)
    }
  }
}

function deviceOf(pid: string, info: string, mounts: Map<string, string>): string | undefined {
  const mount = /^mnt_id:\s*(\d+)/m.exec(info)?.[1]

  if (!mounts.has(pid)) {
    mounts.set(pid, fs.readFileSync(`/proc/${pid}/mountinfo`, "utf8"))
  }

  return (mounts.get(pid) as string)
    .split("\n")
    .find((line) => line.startsWith(`${mount} `))
    ?.split(" ")[2]
}
