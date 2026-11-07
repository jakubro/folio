import assert from "node:assert/strict"
import { test } from "node:test"
import { failure, guarded, within } from "../src/server/failures.ts"

const WHERE =
  "failed while answering this request. The reason is in Folio's log, in the terminal running it.\n"

class Gauge {
  #reading = 7

  read(): number {
    return this.#reading
  }

  break(): never {
    throw new Error(`stuck at ${this.#reading}`)
  }
}

test("a failure is named by the innermost part it escaped, thrown or rejected; a guarded object's methods keep its private fields; a thrown primitive is Folio's server", async () => {
  const caught = (work: () => unknown) => {
    try {
      work()
    } catch (error) {
      return error
    }
  }
  const gauge = guarded("data engine", new Gauge())

  assert.equal(gauge.read(), 7)
  assert.equal(
    failure(caught(() => within("health", () => within("history", () => gauge.break())))),
    `Folio's data engine ${WHERE}`,
  )
  assert.equal(
    failure(
      await within("needs", () =>
        within("read record", () => Promise.reject(new Error("record locked"))),
      ).catch((error: unknown) => error),
    ),
    `Folio's read record ${WHERE}`,
  )
  assert.equal(
    failure(
      caught(() =>
        within("declarations", () => {
          throw "a plain string"
        }),
      ),
    ),
    `Folio's server ${WHERE}`,
  )
})
