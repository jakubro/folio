/**
 * Parses YAML texts on a thread of its own, one at a time, so a large or hostile file never holds up the
 * server; answers with its JSON, made here, since aliases can make a small file expand without end.
 */

import { parentPort } from "node:worker_threads";
import { parseAllDocuments } from "yaml";
import { cycleIn } from "../client/cycles.ts";

parentPort?.on(
  "message",
  ({ text, aliases, bytes }: { text: string; aliases: number; bytes: number }) =>
    parentPort?.postMessage(parsed(text, aliases, bytes)),
);

function parsed(text: string, aliases: number, bytes: number): { json?: string; error?: string } {
  try {
    const documents = parseAllDocuments(text, { merge: true });
    const all = Array.isArray(documents) ? documents : [documents];
    const errors = all.flatMap((document) => document.errors.map((error) => error.message));
    const values = all.map((document) => document.toJS({ maxAliasCount: aliases }));
    const value = values.length === 1 ? values[0] : values;
    const loop = cycleIn(value);

    return loop !== undefined
      ? { error: `The file refers to itself at ${loop}.` }
      : expanded(value, bytes) > bytes
        ? { error: `The file expands to more than ${bytes / 1024 / 1024} MB.` }
        : { json: JSON.stringify(value, plain), ...(errors.length > 0 && { error: errors[0] }) };
  } catch (error) {
    return { error: (error as Error).message.split("\n")[0] };
  }
}

/**
 * A set is the list of its members and binary data its size, as a data page shows a blob; the holder's
 * own value is looked at, since a buffer has turned itself into an object before the replacer sees it.
 */
function plain(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const own = this[key];
  return own instanceof Set
    ? [...own]
    : own instanceof Uint8Array
      ? `${own.byteLength} bytes`
      : value;
}

/**
 * The length of the value's JSON, near enough, counted once per value an alias shares, and given up on
 * past the limit.
 */
function expanded(value: unknown, limit: number): number {
  const sizes = new Map<object, number>();
  const size = (node: unknown): number => {
    if (node === null || typeof node !== "object") {
      return (JSON.stringify(node) ?? "null").length;
    }

    const known = sizes.get(node);

    if (known !== undefined) {
      return known;
    }

    let total = 2;

    for (const [key, child] of Object.entries(node)) {
      total += (Array.isArray(node) ? 0 : key.length + 3) + size(child) + 1;

      if (total > limit) {
        break;
      }
    }

    sizes.set(node, total);
    return total;
  };

  return size(value);
}
