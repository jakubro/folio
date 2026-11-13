/** What Folio's own pages last showed, kept beside the model so they open at once after a restart. */

import fs from "node:fs"
import path from "node:path"
import type { Data } from "./data.ts"
import { type HealthState, healthOf } from "./health.ts"
import type { Model } from "./model.ts"
import {
  attentionNeeds,
  changedNeeds,
  type NeedsPart,
  type NeedsState,
  needsFrom,
  problemNeeds,
  problemNeedsIn,
} from "./needs.ts"
import { type ChangedDocument, changesState } from "./versions.ts"

type Part = "problems" | "attention" | "changed" | "health" | "changes"

interface Answered<T> {
  state: T | undefined
  fresh: boolean
}

interface ChangesState {
  documents: ChangedDocument[]
  version: string
}

const WAIT_MS = 300
const FORMAT = 1
const SHOWNS = new WeakMap<Model, Shown>()
const LATE = Symbol("late")

export async function shownNeeds(model: Model, data: Data): Promise<NeedsState> {
  const problems = shownOf(model).answer<NeedsPart>("problems", problemNeeds(model, data))
  const { checking: _, ...needs } = await neededNow(model, data, problems)
  return needs
}

/** As shownNeeds, saying whether a part is still worked out, a path's problems first; unready while read. */
export async function latestNeeds(
  model: Model,
  data: Data,
  at?: string,
): Promise<NeedsState & { checking: boolean }> {
  if (!model.ready) {
    return { ...needsFrom([undefined]), checking: true }
  }

  const health = healthOf(model, data)
  const problems =
    at === undefined
      ? shownOf(model)
          .answer<NeedsPart>("problems", problemNeeds(model, data))
          .then(async (answered) =>
            answered.fresh || !health.checked
              ? answered
              : { state: await problemNeedsIn(model, health.checked), fresh: false },
          )
      : health
          .checkedAt(at)
          .then((checked) => problemNeedsIn(model, checked))
          .then((state) => ({ state, fresh: state !== undefined }))

  return neededNow(model, data, problems)
}

async function neededNow(
  model: Model,
  data: Data,
  problems: Promise<Answered<NeedsPart>>,
): Promise<NeedsState & { checking: boolean }> {
  const shown = shownOf(model)
  const [parts] = await Promise.all([
    Promise.all([
      problems,
      shown.answer<NeedsPart>("attention", attentionNeeds(model, data)),
      shown.answer<NeedsPart>("changed", changedNeeds(model, data)),
    ]),
    // Health is worked out for the problems anyway; keeping it too lets health open at once.
    shownHealth(model, data),
  ])

  return {
    ...needsFrom(parts.map(({ state }) => state)),
    checking: parts.some(({ fresh }) => !fresh),
  }
}

/** The folder's health as worked out now, or else as last kept; unready only with nothing kept. */
export async function shownHealth(model: Model, data: Data): Promise<HealthState> {
  return (await healthPart(model, data)).state ?? { ready: false, problems: [], version: "" }
}

/** As shownHealth, saying whether a check is still to come; unready while the folder is read. */
export async function latestHealth(
  model: Model,
  data: Data,
): Promise<HealthState & { checking: boolean }> {
  const { state, fresh } = model.ready
    ? await healthPart(model, data)
    : { state: undefined, fresh: false }
  const latest = fresh || !model.ready ? state : (healthOf(model, data).checked ?? state)

  return { ...(latest ?? { ready: false, problems: [], version: "" }), checking: !fresh }
}

/** The catch-up list as worked out now, or else as last kept; empty only with nothing kept. */
export async function shownChanges(model: Model, data: Data): Promise<ChangesState> {
  const work = model.ready ? changesState(model.root, model, data) : Promise.resolve(undefined)
  const { state } = await shownOf(model).answer<ChangesState>("changes", work)

  return state ?? { documents: [], version: "" }
}

function healthPart(model: Model, data: Data): Promise<Answered<HealthState>> {
  const work = model.ready
    ? healthOf(model, data)
        .state()
        .then((state) => (state.ready ? state : undefined))
    : Promise.resolve(undefined)

  return shownOf(model).answer<HealthState>("health", work)
}

/** The one record of a model, so every page and the update hub share what is kept. */
export function shownOf(model: Model): Shown {
  let shown = SHOWNS.get(model)

  if (!shown) {
    shown = new Shown(path.join(model.store, "shown"))
    SHOWNS.set(model, shown)
  }

  return shown
}

class Shown {
  readonly #dir: string
  readonly #kept = new Map<Part, { state: unknown; text: string }>()
  readonly #listeners = new Set<(part: Part) => void>()
  #loaded: Promise<void> | undefined
  #writing = Promise.resolve()

  constructor(dir: string) {
    this.#dir = dir
  }

  listen(listener: (part: Part) => void): void {
    this.#listeners.add(listener)
  }

  flush(): Promise<void> {
    return this.#writing
  }

  /**
   * What the work finds within a moment, or else the part as last kept - undefined with none - while
   * the work goes on. Work finding undefined cannot tell yet, and leaves what is kept alone.
   */
  async answer<T>(part: Part, work: Promise<T | undefined>): Promise<Answered<T>> {
    const done = work.then((state) => {
      if (state !== undefined) {
        this.#keep(part, state)
      }

      return state
    })
    // A failure after the page was answered has no request left to fail.
    done.catch(() => {})
    this.#loaded ??= this.#load()
    await this.#loaded
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<typeof LATE>((resolve) => {
      timer = setTimeout(() => resolve(LATE), WAIT_MS)
    })
    const first = await Promise.race([done, late]).finally(() => clearTimeout(timer))

    return first !== LATE && first !== undefined
      ? { state: first, fresh: true }
      : { state: this.#kept.get(part)?.state as T | undefined, fresh: false }
  }

  #keep(part: Part, state: unknown): void {
    const text = JSON.stringify(state)

    if (this.#kept.get(part)?.text === text) {
      return
    }

    this.#kept.set(part, { state, text })

    for (const listener of this.#listeners) {
      listener(part)
    }

    const file = path.join(this.#dir, `${part}.json`)
    const stored = JSON.stringify({ format: FORMAT, state })
    this.#writing = this.#writing
      .then(async () => {
        await fs.promises.mkdir(this.#dir, { recursive: true })
        await fs.promises.writeFile(`${file}.tmp`, stored)
        await fs.promises.rename(`${file}.tmp`, file)
      })
      .catch(() => {})
  }

  async #load(): Promise<void> {
    const parts: Part[] = ["problems", "attention", "changed", "health", "changes"]

    await Promise.all(
      parts.map(async (part) => {
        const stored = await fs.promises
          .readFile(path.join(this.#dir, `${part}.json`), "utf8")
          .then((text) => JSON.parse(text) as { format: number; state: unknown })
          .catch(() => undefined)

        if (stored?.format === FORMAT && !this.#kept.has(part)) {
          this.#kept.set(part, { state: stored.state, text: JSON.stringify(stored.state) })
        }
      }),
    )
  }
}
