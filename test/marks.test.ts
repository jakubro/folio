import assert from "node:assert/strict";
import { test } from "node:test";
import { changedShare } from "../src/client/marks.ts";

test("a change's share of a block runs from its first differing line to its last, and is none for the same text", () => {
  const lines = (count: number, changed?: number) =>
    Array.from({ length: count }, (_, at) => (at === changed ? "changed" : `line ${at}`)).join(
      "\n",
    );

  assert.deepEqual(changedShare(lines(10), lines(10, 8)), [0.8, 0.9]);
  assert.equal(changedShare(lines(10), lines(10)), undefined);
  assert.deepEqual(changedShare(lines(10), lines(9)), [0.8888888888888888, 1]);
});
