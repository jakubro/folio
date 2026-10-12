import assert from "node:assert/strict";
import { test } from "node:test";
import { type Watch, WatchRegistry } from "../src/server/watch.ts";

function recorder() {
  const opened: string[] = [];
  const closed: string[] = [];
  const triggers = new Map<string, () => void>();
  const watch: Watch = (dir, onChange) => {
    opened.push(dir);
    triggers.set(dir, onChange);
    return { close: () => closed.push(dir) };
  };

  return { opened, closed, triggers, watch };
}

test("opens one watch per folder however many subscribers hold it", () => {
  const { opened, closed, watch } = recorder();
  const registry = new WatchRegistry(() => {}, watch);

  registry.acquire("/a");
  registry.acquire("/a");
  registry.acquire("/b");
  assert.deepEqual(opened, ["/a", "/b"]);

  registry.release("/a");
  assert.deepEqual(closed, []);
  assert.deepEqual(registry.folders, ["/a", "/b"]);

  registry.release("/a");
  registry.release("/b");
  assert.deepEqual(closed, ["/a", "/b"]);
  assert.deepEqual(registry.folders, []);
});

test("reopens a folder released to zero and acquired again", () => {
  const { opened, watch } = recorder();
  const registry = new WatchRegistry(() => {}, watch);

  registry.acquire("/a");
  registry.release("/a");
  registry.acquire("/a");

  assert.deepEqual(opened, ["/a", "/a"]);
});

test("ignores a release of a folder never acquired", () => {
  const { closed, watch } = recorder();
  const registry = new WatchRegistry(() => {}, watch);

  registry.release("/a");
  registry.acquire("/a");
  registry.release("/a");

  assert.deepEqual(closed, ["/a"]);
});

test("reports changes with the folder they happened in", () => {
  const { triggers, watch } = recorder();
  const changes: string[] = [];
  const registry = new WatchRegistry((dir) => changes.push(dir), watch);

  registry.acquire("/a");
  triggers.get("/a")?.();

  assert.deepEqual(changes, ["/a"]);
});

test("counts a folder that cannot be watched, so releases still balance", () => {
  const registry = new WatchRegistry(
    () => {},
    () => {
      throw new Error("ENOENT");
    },
  );

  registry.acquire("/missing");
  assert.deepEqual(registry.folders, ["/missing"]);
  registry.release("/missing");
  assert.deepEqual(registry.folders, []);
});
