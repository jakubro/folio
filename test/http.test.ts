import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createHandler, listen } from "../src/server/http.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-")));
const assets = fs.mkdtempSync(path.join(os.tmpdir(), "folio-assets-"));
const lines: string[] = [];
const server = http.createServer(createHandler(root, assets, (line) => lines.push(line)));
let base = "";

for (const [name, content] of Object.entries({
  "guide.md": "# Guide\n{include: part.md}",
  "part.md": "included",
  "flow.mmd": "graph LR\n a-->b",
  "img/logo.svg": "<svg/>",
  "img/photo.png": "png-bytes",
  "notes/a.md": "a",
  "secret.env": "TOKEN=1",
})) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
}

fs.writeFileSync(path.join(assets, "page.js"), "console.log(1)");

before(async () => {
  base = `http://localhost:${await listen(server, 0)}`;
});

after(() => server.close());

function get(
  urlPath: string,
  host?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${urlPath}`, host ? { headers: { host } } : {}, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
    });
    request.on("error", reject);
  });
}

test("serves the page shell for markdown, mermaid and folders", async () => {
  for (const urlPath of ["/guide.md", "/flow.mmd", "/", "/notes/"]) {
    const response = await get(urlPath);
    assert.equal(response.status, 200, urlPath);
    assert.match(response.headers["content-type"] ?? "", /^text\/html/);
    assert.match(response.body, /<script type="module" src="\/\?asset=page\.js">/);
  }

  assert.match((await get("/guide.md")).body, /<title>guide\.md<\/title>/);
  assert.match(
    (await get("/notes/")).body,
    new RegExp(`<html lang="en" data-root="${path.basename(root)}">`),
  );
});

test("serves raw text with includes expanded and a version", async () => {
  const response = await get("/guide.md?raw");

  assert.equal(response.body, "# Guide\nincluded");
  assert.match(String(response.headers["x-folio-version"]), /^[0-9a-f]{16}$/);
  assert.equal((await get("/img/photo.png?raw")).status, 404);
});

test("serves a page's neighbours as JSON, and nothing for a folder", async () => {
  const response = await get("/guide.md?step");

  assert.match(response.headers["content-type"] ?? "", /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), { previous: "flow.mmd", next: "part.md" });
  assert.equal((await get("/notes/?step")).status, 404);
});

test("serves one tree level as JSON", async () => {
  const response = await get("/?tree");

  assert.deepEqual(JSON.parse(response.body).entries, [
    { name: "img", kind: "folder" },
    { name: "notes", kind: "folder" },
    { name: "flow.mmd", kind: "mermaid" },
    { name: "guide.md", kind: "markdown" },
    { name: "part.md", kind: "markdown" },
  ]);
  assert.equal((await get("/guide.md?tree")).status, 404);
});

test("serves images with their type, sandboxing SVG", async () => {
  const png = await get("/img/photo.png");
  const svg = await get("/img/logo.svg");

  assert.equal(png.body, "png-bytes");
  assert.equal(png.headers["content-type"], "image/png");
  assert.equal(svg.headers["content-type"], "image/svg+xml");
  assert.equal(svg.headers["content-security-policy"], "sandbox");
});

test("answers an unchanged image with 304", async () => {
  const { headers } = await get("/img/photo.png");
  const response = await new Promise<number>((resolve) => {
    http.get(`${base}/img/photo.png`, { headers: { "if-none-match": headers.etag } }, (r) => {
      r.resume();
      resolve(r.statusCode ?? 0);
    });
  });

  assert.equal(response, 304);
});

test("redirects a folder without its trailing slash", async () => {
  const response = await get("/notes");

  assert.equal(response.status, 301);
  assert.equal(response.headers.location, "/notes/");
});

test("refuses what is not renderable or not inside the folder", async () => {
  for (const urlPath of [
    "/secret.env",
    "/missing.md",
    "/%2e%2e/etc/passwd",
    "/notes/%2e%2e%2f%2e%2e%2fx.md",
    "/%E0%A4%A",
  ]) {
    assert.ok([400, 404].includes((await get(urlPath)).status), urlPath);
  }
});

test("serves bundled assets by name only", async () => {
  assert.equal((await get("/?asset=page.js")).body, "console.log(1)");
  assert.equal((await get("/notes/?asset=page.js")).status, 200);
  assert.equal((await get("/?asset=../package.json")).status, 404);
  assert.equal((await get("/?asset=missing.js")).status, 404);
});

test("refuses a request whose Host is not a localhost name", async () => {
  assert.equal((await get("/guide.md", "attacker.example:80")).status, 403);
  assert.equal((await get("/guide.md", "127.0.0.1:1")).status, 200);
});

test("logs one line per request", async () => {
  lines.length = 0;
  await get("/guide.md");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(lines, ["GET /guide.md 200"]);
});

test("rejects a taken port with an error naming it", async () => {
  const port = (server.address() as { port: number }).port;

  await assert.rejects(listen(http.createServer(), port), {
    message: `Port ${port} is already in use.`,
  });
});
