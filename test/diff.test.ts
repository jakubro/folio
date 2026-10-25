import assert from "node:assert/strict";
import { test } from "node:test";
import { diffRuns } from "../src/client/diff.ts";

test("words removed and added come out as runs in reading order", () => {
  assert.deepEqual(diffRuns("stops at dawn.", "stops at sunrise today."), [
    { kind: "same", text: "stops at " },
    { kind: "del", text: "dawn" },
    { kind: "ins", text: "sunrise today" },
    { kind: "same", text: "." },
  ]);
});

test("texts too long to compare word by word compare line by line", () => {
  const long = (word: string) => `${`${word} `.repeat(3000)}\nend\n`;

  assert.deepEqual(diffRuns(long("a"), long("b")), [
    { kind: "del", text: `${"a ".repeat(3000)}\n` },
    { kind: "ins", text: `${"b ".repeat(3000)}\n` },
    { kind: "same", text: "end\n" },
  ]);
});
