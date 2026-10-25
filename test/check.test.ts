import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check } from "../src/server/check.ts";

test("a running folio slow to work out health is waited for, and a failure is said rather than thrown", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-")));
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-socket-")), "s");
  let healthy = true;
  const server = http.createServer((request, response) => {
    if (request.url === "/?api") {
      response.end(JSON.stringify({ root }));
    } else if (healthy) {
      setTimeout(() => {
        response.end(
          JSON.stringify({
            ready: true,
            problems: [
              { kind: "rule", path: "a.md", line: 3, severity: "error", what: "a.md is a draft" },
            ],
          }),
        );
      }, 1500);
    } else {
      response.end("not JSON");
    }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const unused = () => {
    throw new Error("the running folio should have answered");
  };

  try {
    const said: string[] = [];
    assert.equal(await check(root, { port: 1, socket }, unused, (line) => said.push(line)), 1);
    assert.deepEqual(said, [
      "a.md:3 error rule a.md is a draft",
      "folio check: 1 error, 0 other problems",
    ]);

    healthy = false;
    const failed: string[] = [];
    assert.equal(await check(root, { port: 1, socket }, unused, (line) => failed.push(line)), 2);
    assert.match(failed[0], /^folio check: no health could be worked out: /);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rule's warning prints as warning and any other problem that is no error as -, as the reference says", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-")));
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-check-socket-")), "s");
  const server = http.createServer((request, response) => {
    response.end(
      JSON.stringify(
        request.url === "/?api"
          ? { root }
          : {
              ready: true,
              problems: [
                { kind: "rule", path: "a.md", line: 2, severity: "warning", what: "a.md is long" },
                { kind: "link", path: "b.md", line: 4, what: "Links to c.md, which is not there" },
              ],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  try {
    const said: string[] = [];
    await check(
      root,
      { port: 1, socket },
      () => {
        throw new Error("the running folio should have answered");
      },
      (line) => said.push(line),
    );
    assert.deepEqual(said.slice(0, 2), [
      "a.md:2 warning rule a.md is long",
      "b.md:4 - link Links to c.md, which is not there",
    ]);

    const reference = fs.readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8");
    const described = reference.split("\n").find((line) => line.startsWith("`folio check` prints"));
    assert.match(described ?? "", /`error`, `warning` for a rule's warning, or `-`/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
