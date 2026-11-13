import assert from "node:assert/strict"
import { test } from "node:test"
import { componentName, missingComponent, readComponent } from "../src/client/component.ts"

test("a component fence reads its data entries apart from its options, an empty one as neither", () => {
  assert.deepEqual(
    readComponent(
      "data:\n  rows: data/rows.csv\n  total: '#totals'\ntitle: Rain by station\nstations: [north, east]\n",
    ),
    {
      data: { rows: "data/rows.csv", total: "#totals" },
      options: { title: "Rain by station", stations: ["north", "east"] },
    },
  )
  assert.deepEqual(readComponent(""), { data: {}, options: {} })
  assert.deepEqual(readComponent("data:\n"), { data: {}, options: {} })
})

test("a component fence that is no map of data and options says what it should be", () => {
  assert.throws(() => readComponent("- a\n- b\n"), {
    message: "A component fence holds a YAML map of its data and options.",
  })
  assert.throws(() => readComponent("data: rows.csv\n"), {
    message: "data names each entry and the reference it reads, as name: path.",
  })
  assert.throws(() => readComponent("data:\n  rows: 3\n"), {
    message: "data names each entry and the reference it reads, as name: path.",
  })
  assert.throws(() => readComponent("title: [\n"), /^Error: The fence is not YAML: /)
  assert.throws(() => readComponent("a: &x\n  b: *x\n"), {
    message: "The fence refers to itself at a.b.",
  })
})

test("a component is named by letters, digits, underscores and hyphens after the word component", () => {
  assert.equal(componentName(" levels-2_x "), "levels-2_x")
  assert.throws(() => componentName(""), {
    message: "A component fence names its component after the word component.",
  })
  assert.throws(() => componentName("../levels"), {
    message: "A component's name is letters, digits, _ and -, not ../levels.",
  })
  assert.equal(missingComponent("levels", 2), "No components folder holds levels.js.")
  assert.equal(
    missingComponent("levels", 0),
    "No components folder holds levels.js: none was named with --components.",
  )
})
