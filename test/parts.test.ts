import assert from "node:assert/strict"
import { test } from "node:test"
import { blockVersion } from "../src/server/blocks.ts"
import { partlyRead, partsOf } from "../src/server/parts.ts"

const TABLE = [
  "| Pump | Hours | Site |",
  "|---|---|---|",
  "| north | 6 | ridge |",
  "| south | 4 | valley |",
  "| east | 5 | lake |",
  "| west | 2 | pass |",
].join("\n")

test("a table marks the row whose cell changed, and that cell, and nothing else", () => {
  const after = TABLE.replace("| south | 4 | valley |", "| south | 9 | valley |")

  assert.deepEqual(partsOf(TABLE, after, "table"), {
    drawn: 5,
    marked: [
      {
        at: 2,
        count: 1,
        mark: "changed",
        before: "| south | 4 | valley |",
        after: "| south | 9 | valley |",
        changedCells: [1],
      },
    ],
    gone: [],
  })
})

test("a table marks a new row new and a removed row between the rows it sat between", () => {
  const after = TABLE.replace("| east | 5 | lake |\n", "").replace(
    "| north | 6 | ridge |",
    "| north | 6 | ridge |\n| summit | 1 | peak |",
  )
  const parts = partsOf(TABLE, after, "table")

  assert.deepEqual(
    parts?.marked.map(({ at, mark }) => [at, mark]),
    [[2, "new"]],
  )
  assert.deepEqual(
    parts?.gone.map(({ text, after: previous, before: next }) => [text, previous, next]),
    [["| east | 5 | lake |", 3, 4]],
  )

  const between = TABLE.replace(
    "| south | 4 | valley |\n| east | 5 | lake |",
    "| summit | 1 | peak |\n| south | 9 | valley |",
  )
  const mixed = partsOf(TABLE, between, "table")

  assert.deepEqual(
    mixed?.marked.map(({ at, mark }) => [at, mark]),
    [
      [2, "new"],
      [3, "changed"],
    ],
    "a row keeps its pair by the cells it keeps, the one with none in common is new",
  )
  assert.deepEqual(
    mixed?.gone.map(({ text }) => text),
    ["| east | 5 | lake |"],
  )
})

test("a column added marks every row, the header first; padding and moved rows mark nothing", () => {
  const widened = TABLE.split("\n")
    .map((line, index) => `${line}${index === 1 ? "---|" : index === 0 ? " Note |" : " - |"}`)
    .join("\n")

  assert.deepEqual(
    partsOf(TABLE, widened, "table")?.marked.map(({ at, changedCells }) => [at, changedCells]),
    [
      [0, [3]],
      [1, [3]],
      [2, [3]],
      [3, [3]],
      [4, [3]],
    ],
  )
  assert.equal(partsOf(TABLE, TABLE.replaceAll(" | ", "  |  "), "table"), undefined)

  const inserted = TABLE.split("\n")
    .map((line, index) =>
      line.replace(
        /^\| ([^|]+) \|/,
        index === 1 ? "|---|---|" : `| $1 | ${index === 0 ? "Crew" : "two"} |`,
      ),
    )
    .join("\n")
  const shifted = partsOf(TABLE, inserted, "table")
  assert.deepEqual(
    [shifted?.marked.map(({ at, mark }) => [at, mark]), shifted?.gone],
    [
      [
        [0, "changed"],
        [1, "changed"],
        [2, "changed"],
        [3, "changed"],
        [4, "changed"],
      ],
      [],
    ],
    "a column inserted in the middle marks every row changed",
  )

  const swapped = TABLE.replace(
    "| north | 6 | ridge |\n| south | 4 | valley |",
    "| south | 4 | valley |\n| north | 6 | ridge |",
  )
  assert.equal(partsOf(TABLE, swapped, "table"), undefined, "rows only reordered: the block whole")

  const moved = swapped.replace("| west | 2 | pass |", "| west | 3 | pass |")
  assert.deepEqual(
    partsOf(TABLE, moved, "table")?.marked.map(({ at }) => at),
    [4],
    "a moved row is not marked, the changed one is",
  )
})

test("rows left over in equal numbers between matches pair up, however unlike", () => {
  const before = "| Name |\n|---|\n| a |\n| b |\n| c |\n| d |"
  const after = "| Name |\n|---|\n| a |\n| x |\n| y |\n| d |"

  assert.deepEqual(
    partsOf(before, after, "table")?.marked.map(({ at, mark }) => [at, mark]),
    [
      [2, "changed"],
      [3, "changed"],
    ],
  )
})

test("ten changed rows of a long table are ten marks, each at its own row", () => {
  const rows = Array.from({ length: 140 }, (_, i) => `| run-${i + 1} | ${i} |`)
  const before = ["| Run | Value |", "|---|---|", ...rows].join("\n")
  const changed = new Set([3, 17, 18, 40, 41, 42, 77, 99, 120, 139])
  const after = [
    "| Run | Value |",
    "|---|---|",
    ...rows.map((row, i) => (changed.has(i) ? row.replace(/\d+ \|$/, "x |") : row)),
  ].join("\n")

  assert.deepEqual(
    partsOf(before, after, "table")?.marked.map(({ at, mark }) => [at, mark]),
    [...changed].map((i) => [i + 1, "changed"]),
  )
})

test("a list marks the innermost item whose own text changed", () => {
  const before = "- pumps\n  - north runs at night\n  - south runs at dawn\n- valves\n- gauges"
  const after = "- pumps\n  - north runs at night\n  - south runs at noon\n- valves\n- gauges"
  const nested =
    "- pumps and filters\n  - north runs at night\n  - south runs at dawn\n- valves\n- gauges"

  assert.deepEqual(
    partsOf(before, after, "list")?.marked.map(({ at, before: was }) => [at, was]),
    [[2, "  - south runs at dawn"]],
  )
  assert.deepEqual(
    partsOf(before, nested, "list")?.marked.map(({ at }) => at),
    [0],
  )
  assert.equal(partsOf("1. a\n2. b", "3. a\n4. b", "list"), undefined, "a new start number")
  assert.equal(
    partsOf("1. a\n2. b", "3. a\n4. bb", "list"),
    undefined,
    "a new start number with an item reworded: the block whole, the number never absorbed",
  )
  assert.deepEqual(
    partsOf("- a\n\n      x = 1\n- b", "- a\n\n      x  = 1\n- b", "list")?.marked.map(
      ({ at }) => at,
    ),
    [0],
    "code in an item counts every character",
  )
})

test("adjacent changed code lines are one mark showing what they said; a fence change marks the block", () => {
  const before = "```py\ndef run():\n    open()\n    pump()\n    close()\n```"
  const after = "```py\ndef run():\n    open(valve)\n    pump(hours=6)\n    close()\n```"

  assert.deepEqual(partsOf(before, after, "code")?.marked, [
    {
      at: 1,
      count: 2,
      mark: "changed",
      before: "    open()\n    pump()",
      after: "    open(valve)\n    pump(hours=6)",
    },
  ])
  assert.equal(partsOf(before, before.replace("```py", "```python"), "code"), undefined)
  assert.equal(partsOf("a", "b", "paragraph"), undefined)
})

test("a read part takes its text now; the rest stays as read until every part is read", () => {
  const after = TABLE.replace("| north | 6 | ridge |", "| north | 7 | ridge |")
    .replace("| west | 2 | pass |", "| west | 8 | pass |")
    .replace("| east | 5 | lake |\n", "")
  const parts = partsOf(TABLE, after, "table")
  const gone = parts?.gone[0].key as string

  assert.deepEqual(
    parts?.marked.map(({ at }) => at),
    [1, 3],
  )

  const half = partlyRead(TABLE, after, "table", [1], []) as string
  assert.equal(
    half,
    TABLE.replace("| north | 6 | ridge |", "| north | 7 | ridge |"),
    "the row read now, the other change and the removed row as read",
  )
  assert.deepEqual(
    partsOf(half, after, "table")?.marked.map(({ at }) => at),
    [3],
  )

  const all = partlyRead(half, after, "table", [3], [gone]) as string
  assert.equal(blockVersion(all, "table"), blockVersion(after, "table"))
  assert.equal(partsOf(all, after, "table"), undefined)
})
