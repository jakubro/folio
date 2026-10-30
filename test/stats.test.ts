import assert from "node:assert/strict"
import { test } from "node:test"
import { profilesIn } from "../src/client/stats.ts"

test("a page's own count of a column mostly of zeros bins a long tail on a log scale, as the server does", () => {
  const waits = Array.from({ length: 1000 }, (_, i) =>
    i < 700 ? 0 : Math.round(1.03 ** (i - 700)),
  )
  const wait = profilesIn(
    ["wait"],
    waits.map((value) => ({ wait: value })),
  ).get("wait")
  const bins = wait?.bins ?? []

  assert.equal(wait?.low, "0")
  assert.equal(wait?.high, "6.89K")
  assert.equal(bins.length, 20)
  assert.equal(bins[0].from, 0)
  assert.equal(bins.at(-1)?.to, 6892)
  assert.ok(bins[0].to < 30, `the first bar spans 0 to ${bins[0].to}`)
  assert.equal(
    bins.reduce((sum, { count }) => sum + count, 0),
    1000,
  )
})

test("a page's own count of an evenly spread column keeps even bars", () => {
  const sizes = profilesIn(
    ["size"],
    Array.from({ length: 200 }, (_, i) => ({ size: i * 1.5 })),
  ).get("size")

  assert.equal(sizes?.bins?.[0].to, 14.925)
})
