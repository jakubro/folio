/** The parts of Folio an unexpected failure is named by, and the fixed text answering one. */

const PARTS = {
  declarations: "Reading the folder's FOLIO.md declarations",
  history: "Folio's history",
  "data engine": "Folio's data engine",
  "read record": "Folio's read record",
  model: "Folio's model of the folder",
  health: "Folio's health check",
  needs: "Folio's list of what needs you",
  stale: "Folio's list of outlived documents",
  digest: "Folio's digest",
  provenance: "Folio's provenance of a block",
  "used-by": "Folio's list of what a file feeds",
  presence: "Folio's view of what the reader looks at",
  related: "Folio's relating by meaning",
  server: "Folio's server",
} as const
const WHERE = "The reason is in Folio's log, in the terminal running it."
const BLAMED = new WeakMap<object, Part>()

export type Part = keyof typeof PARTS

/** Run `work`, naming `part` on an error it throws or rejects with unless an inner part did. */
export function within<T>(part: Part, work: () => T): T {
  let result: T

  try {
    result = work()
  } catch (error) {
    throw blamed(part, error)
  }

  return result instanceof Promise
    ? (result.catch((error: unknown) => {
        throw blamed(part, error)
      }) as T)
    : result
}

/** Run each method of `target` within `part`, called on `target` so private fields resolve. */
export function guarded<T extends object>(part: Part, target: T): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key)

      return typeof value === "function"
        ? (...args: unknown[]) => within(part, () => value.apply(object, args))
        : value
    },
  })
}

export function failure(error: unknown): string {
  return `${PARTS[partOf(error) ?? "server"]} failed while answering this request. ${WHERE}\n`
}

export function partOf(error: unknown): Part | undefined {
  return isObject(error) ? BLAMED.get(error) : undefined
}

function blamed(part: Part, error: unknown): unknown {
  if (isObject(error) && !BLAMED.has(error)) {
    BLAMED.set(error, part)
  }

  return error
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}
