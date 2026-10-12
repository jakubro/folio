import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions } from "../src/server/args.ts";

test("defaults to the current folder and port 8640", () => {
  assert.deepEqual(parseOptions([]), { folder: ".", port: 8640 });
});

test("takes a folder and a port", () => {
  assert.deepEqual(parseOptions(["notes", "--port", "9001"]), { folder: "notes", port: 9001 });
});

test("rejects a port that is not a number in range", () => {
  for (const port of ["0", "65536", "80a", "1.5"]) {
    assert.throws(() => parseOptions(["--port", port]), /Invalid port/);
  }
});

test("rejects a second folder", () => {
  assert.throws(() => parseOptions(["a", "b"]), /Expected one folder/);
});
