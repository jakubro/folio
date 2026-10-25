import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Data } from "../src/server/data.ts";
import { createHandler, listen } from "../src/server/http.ts";
import { Indexer } from "../src/server/indexer.ts";
import { Model } from "../src/server/model.ts";
import { presenceOf } from "../src/server/presence.ts";

const indexer = new Indexer(new URL("../src/server/index-worker.ts", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-")));
const assets = fs.mkdtempSync(path.join(os.tmpdir(), "folio-assets-"));
const lines: string[] = [];
const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-model-"));
const model = new Model(root, store, indexer, () => {});
const data = new Data(root, store);
const server = http.createServer(
  createHandler(root, assets, "build-1", model, data, (line) => lines.push(line)),
);
let base = "";

for (const [name, content] of Object.entries({
  "guide.md": "# Guide\n{include: part.md}",
  "part.md": "included",
  "flow.mmd": "graph LR\n a-->b",
  "img/logo.svg": "<svg/>",
  "img/photo.png": "png-bytes",
  "notes/a.md": "a",
  "secret.env": "TOKEN=1",
  "data/scores.csv": "name,score\nada,3\nbob,12\n",
})) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
}

fs.writeFileSync(path.join(assets, "page.js"), "console.log(1)");

before(async () => {
  base = `http://localhost:${await listen(server, 0)}`;
  await model.start();
});

after(() => {
  void indexer.close();
  model.close();
  server.close();
});

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
    new RegExp(`<html lang="en" data-root="${path.basename(root)}" data-build="build-1">`),
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

test("serves a data file's page shell, its rows as JSON, and lists data files only when asked", async () => {
  const shell = await get("/data/scores.csv");
  const page = JSON.parse((await get("/data/scores.csv?data")).body);

  assert.equal(shell.status, 200);
  assert.match(shell.body, /<script type="module" src="\/\?asset=page\.js">/);
  assert.equal(page.format, "csv");
  assert.deepEqual(page.grid.rows, [
    ["ada", 3],
    ["bob", 12],
  ]);
  assert.equal((await get("/data/scores.csv?page")).status, 404);
  assert.equal((await get("/data/scores.csv?raw")).status, 404);
  assert.equal((await get("/guide.md?data")).status, 404);
  assert.deepEqual(JSON.parse((await get("/data/?tree&data")).body).entries, [
    { name: "scores.csv", kind: "data" },
  ]);
  assert.deepEqual(JSON.parse((await get("/data/?tree")).body).entries, []);
});

test("serves what a document embeds, resolved against its folder or the root, and nothing for a non-document", async () => {
  const embed = async (from: string, reference: string) =>
    JSON.parse((await get(`/${from}?embed=${encodeURIComponent(reference)}`)).body);

  assert.equal((await embed("notes/a.md", "../data/scores.csv#1.score")).value, 12);
  assert.equal((await embed("guide.md", "/data/scores.csv#0.name")).value, "ada");
  assert.equal((await embed("guide.md", "data/scores.csv")).grid.rows.length, 2);
  assert.equal(
    (await embed("guide.md", "data/absent.csv")).error,
    "No data file at data/absent.csv.",
  );
  assert.equal((await embed("guide.md", "secret.env")).error, "No data file at secret.env.");
  assert.equal(
    (await embed("guide.md", "../outside.csv")).error,
    "../outside.csv is outside the served folder.",
  );
  assert.equal(
    (await embed("guide.md", "#absent")).error,
    "No query named absent in this document.",
  );
  assert.equal((await get("/data/scores.csv?embed=x.csv")).status, 404);
});

test("a result too large to send whole is cut short and said so, and the server goes on answering", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-huge-")));
  fs.writeFileSync(
    path.join(folder, "huge.md"),
    "```sql query\nselect repeat('a', 100000) as text from range(10000)\n```\n",
  );
  const own = new Data(folder, fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-huge-data-")));
  const quiet = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-huge-model-")),
    indexer,
    () => {},
  );
  const other = http.createServer(createHandler(folder, assets, "build-1", quiet, own, () => {}));
  const otherBase = `http://localhost:${await listen(other, 0)}`;

  try {
    const response = await fetch(`${otherBase}/huge.md?embed=${encodeURIComponent("#@1")}`);
    const body = await response.text();
    const embedded = JSON.parse(body);

    assert.equal(response.status, 200);
    assert.ok(body.length < 20 * 1024 * 1024, `answered ${body.length} bytes`);
    assert.equal(embedded.grid.partial, true);
    assert.ok(embedded.grid.rows.length > 0);
    assert.equal(embedded.grid.rows[0][0].length, 20_001);
    assert.equal((await fetch(`${otherBase}/huge.md?raw`)).status, 200);
  } finally {
    other.close();
    quiet.close();
    await own.close();
  }
});

test("a YAML file or chart description that refers to itself is refused in place, never taking the server down", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-cycle-")));
  fs.writeFileSync(path.join(folder, "self.yaml"), "name: &a\n  self: *a\n");
  fs.writeFileSync(
    path.join(folder, "page.md"),
    "{table: self.yaml}\n\n```vega-lite\ndata: &d\n  url: self.yaml\n  again: *d\nmark: bar\n```\n",
  );
  const own = new Data(folder, fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-cycle-data-")));
  const quiet = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-cycle-model-")),
    indexer,
    () => {},
  );
  const other = http.createServer(createHandler(folder, assets, "build-1", quiet, own, () => {}));
  const otherBase = `http://localhost:${await listen(other, 0)}`;

  try {
    await quiet.start();
    const embedded = await (await fetch(`${otherBase}/page.md?embed=self.yaml`)).json();
    const page = await (await fetch(`${otherBase}/self.yaml?data`)).json();
    const modelled = await fetch(`${otherBase}/page.md?model`);

    assert.equal(embedded.error, "The file refers to itself at name.self.");
    assert.equal(page.error, "The file refers to itself at name.self.");
    assert.equal(modelled.status, 200);
    assert.deepEqual((await modelled.json()).data, ["self.yaml"]);
  } finally {
    other.close();
    quiet.close();
    await own.close();
  }
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

test("serves a chunk the page script imports by its absolute asset address", async () => {
  assert.equal((await get("/?asset=/page.js")).body, "console.log(1)");
  assert.equal((await get("/?asset=//page.js")).status, 404);
  assert.equal((await get("/?asset=/../package.json")).status, 404);
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

test("shows a document's model as its blocks, its own text with includes unexpanded", async () => {
  const response = await get("/guide.md?model");
  const view = JSON.parse(response.body);

  assert.equal(response.headers["content-type"], "application/json");
  assert.equal(view.path, "guide.md");
  assert.equal(view.kind, "markdown");
  assert.deepEqual(
    view.blocks.map((block: { kind: string; lines: number[]; text: string }) => [
      block.kind,
      block.lines,
      block.text,
    ]),
    [
      ["heading", [1, 1], "# Guide"],
      ["paragraph", [2, 2], "{include: part.md}"],
    ],
  );
  assert.ok(view.blocks.every((block: { id: string }) => /^[0-9a-f]{8}$/.test(block.id)));
  assert.deepEqual(
    view.page.map((block: { kind: string; source: string; lines: number[]; at: number[] }) => [
      block.kind,
      block.source,
      block.lines,
      block.at,
    ]),
    [
      ["heading", "guide.md", [1, 1], [1, 1]],
      ["paragraph", "guide.md", [2, 2], [2, 2]],
      ["paragraph", "part.md", [1, 1], [2, 2]],
    ],
  );
});

test("lists the links into a page with a version, and nothing for an image", async () => {
  const content = JSON.parse((await get("/part.md?links")).body);

  assert.deepEqual(content.links, []);
  assert.match(content.version, /^[0-9a-f]{16}$/);
  assert.equal((await get("/img/photo.png?links")).status, 404);
});

test("serves a page its parser cannot split at once, without block sources, never failing", async () => {
  const failing = {
    split: () => Promise.reject(new Error("parser failed")),
  } as unknown as Indexer;
  const broken = new Model(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-broken-")),
    failing,
    () => {},
  );
  const other = http.createServer(createHandler(root, assets, "build-1", broken, data, () => {}));
  const otherBase = `http://localhost:${await listen(other, 0)}`;

  try {
    const first = await (await fetch(`${otherBase}/guide.md?page`)).json();
    assert.equal(first.text, "# Guide\nincluded");
    assert.match(first.version, /-partial$/);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await fetch(`${otherBase}/guide.md?page`);
    const settled = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(settled.blocks, []);
    assert.doesNotMatch(settled.version, /-partial$/);
  } finally {
    broken.close();
    other.close();
  }
});

test("serves a page as its expanded text, its version and the blocks every file it read places on it", async () => {
  const response = await get("/guide.md?page");
  const content = JSON.parse(response.body);

  assert.equal(response.headers["content-type"], "application/json");
  assert.equal(content.text, "# Guide\nincluded");
  assert.equal(content.version, (await get("/guide.md?raw")).headers["x-folio-version"]);
  assert.deepEqual(
    content.blocks.map((block: { source: string; lines: number[] }) => [block.source, block.lines]),
    [
      ["guide.md", [1, 1]],
      ["guide.md", [2, 2]],
      ["part.md", [1, 1]],
    ],
  );
  assert.equal((await get("/img/photo.png?page")).status, 404);
  assert.equal((await get("/missing.md?page")).status, 404);
});

test("shows how far the model has got for a folder, and nothing for an image or a missing file", async () => {
  assert.deepEqual(
    (({ ready, documents }) => ({ ready, documents }))(JSON.parse((await get("/?model")).body)),
    { ready: true, documents: 4 },
  );
  assert.equal(JSON.parse((await get("/notes/?model")).body).documents, 1);
  assert.equal((await get("/img/logo.svg?model")).status, 404);
  assert.equal((await get("/missing.md?model")).status, 404);
});

test("served from inside a repository, history reads nothing outside the folder", async () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-repo-")));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@a",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@a",
  };
  fs.mkdirSync(path.join(outer, "served"));
  fs.writeFileSync(path.join(outer, "secret.md"), "# Secret words\n");
  fs.writeFileSync(path.join(outer, "served/page.md"), "# Page\n");
  fs.symlinkSync("../secret.md", path.join(outer, "served/link.md"));
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "-q", "-m", "s"],
  ]) {
    execFileSync("git", args, { cwd: outer, env });
  }
  const folder = path.join(outer, "served");
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-repo-model-"));
  const own = new Model(folder, store, indexer, () => {});
  const other = http.createServer(
    createHandler(folder, assets, "build-1", own, new Data(folder, store), () => {}),
  );
  const otherBase = `http://localhost:${await listen(other, 0)}`;
  const secret = createHash("sha1").update("blob 15\0# Secret words\n").digest("hex");

  try {
    const names = [":(top)secret.md", ":/secret.md", "*.md", "link.md"];
    const asked = names.flatMap((name) => [
      `/${encodeURIComponent(name)}?versions`,
      `/${encodeURIComponent(name)}?version=${secret}`,
      `/${encodeURIComponent(name)}?block-history=x`,
    ]);

    for (const address of [...asked, `/page.md?version=${secret}`]) {
      const response = await fetch(`${otherBase}${address}`);
      const body = await response.text();
      assert.doesNotMatch(body, /Secret words/, address);
      assert.ok(response.status === 404 || !/"versions":\[\{/.test(body), `${address}: ${body}`);
    }

    assert.equal((await fetch(`${otherBase}/link.md?history`)).status, 404);
    assert.match(await (await fetch(`${otherBase}/page.md?versions`)).text(), /"versions":\[\{/);
  } finally {
    other.close();
    own.close();
  }
});

test("used-by says it is not ready while the folder is still being read, never an empty list", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-ready-")));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-http-ready-model-"));
  fs.writeFileSync(path.join(folder, "pumps.csv"), "n\n3\n");
  fs.writeFileSync(path.join(folder, "report.md"), "{table: pumps.csv}\n");
  const own = new Model(folder, store, indexer, () => {});
  const other = http.createServer(
    createHandler(folder, assets, "build-1", own, new Data(folder, store), () => {}),
  );
  const otherBase = `http://localhost:${await listen(other, 0)}`;

  try {
    const early = await (await fetch(`${otherBase}/pumps.csv?used-by`)).json();
    await own.start();
    const later = await (await fetch(`${otherBase}/pumps.csv?used-by`)).json();

    assert.deepEqual(early, { ready: false, documents: [] });
    assert.deepEqual(later, { ready: true, documents: [{ source: "report.md", how: "embeds" }] });
  } finally {
    other.close();
    own.close();
  }
});

function getWith(
  urlPath: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${urlPath}`, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
  });
}

test("the API lists its resources and answers each as JSON, refusing what names nothing", async () => {
  const json = async (urlPath: string) => {
    const response = await get(urlPath);
    assert.equal(response.status, 200, `${urlPath}: ${response.body}`);
    assert.match(response.headers["content-type"] ?? "", /^application\/json/);
    return JSON.parse(response.body);
  };
  const index = await json("/?api");

  assert.ok(index.resources.document.address.includes("?api=document"));
  assert.deepEqual(
    (await json("/notes/?api=documents")).documents.map(({ path: at }: { path: string }) => at),
    ["notes/a.md"],
  );

  const guide = await json("/guide.md?api=document");
  assert.equal(guide.path, "guide.md");
  assert.deepEqual(
    [...new Set(guide.page.map(({ source }: { source: string }) => source))],
    ["guide.md", "part.md"],
  );
  assert.deepEqual(
    (await json("/data/?api=query&sql=select name from 'scores.csv' order by score desc")).rows,
    [["bob"], ["ada"]],
  );
  assert.equal((await json("/?api=health")).ready, true);
  assert.deepEqual((await json("/?api=changes")).documents, []);
  assert.deepEqual((await json("/?api=reads")).documents, []);

  assert.equal((await get("/?api=nothing")).status, 404);
  assert.equal((await get("/data/scores.csv?api=document")).status, 404);
  assert.equal((await get("/?api=query")).status, 400);

  const before = fs.readdirSync(root).sort();
  const written = await get("/?api=query&sql=copy (select 1) to 'written.csv'");
  assert.equal(written.status, 400);
  assert.match(written.body, /Only one SELECT/);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test("the API refuses another site's page, a foreign Origin or Host, and anything but reading", async () => {
  assert.equal((await getWith("/?api=health", { origin: "https://evil.example" })).status, 403);
  assert.equal((await getWith("/?api=health", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await get("/?api=health", "evil.example")).status, 403);
  assert.equal((await getWith("/?api=health", { origin: "http://localhost:8640" })).status, 200);

  const posted = await new Promise<number>((resolve, reject) => {
    const request = http.request(`${base}/?api=health`, { method: "POST" }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(posted, 405);
});

test("a query that fails through the API names files by their place in the folder, without the engine's statement", async () => {
  fs.writeFileSync(path.join(root, "data/broken.json"), '{"a": [1, 2,');

  try {
    const malformed = await get(
      `/data/?api=query&sql=${encodeURIComponent("select * from 'broken.json'")}`,
    );
    assert.equal(malformed.status, 400);
    assert.match(malformed.body, /data\/broken\.json/);
    assert.ok(!malformed.body.includes(root), malformed.body);

    const unknown = await get(
      `/data/?api=query&sql=${encodeURIComponent("select nope from 'scores.csv'")}`,
    );
    assert.equal(unknown.status, 400);
    assert.match(unknown.body, /nope/);
    assert.doesNotMatch(unknown.body, /LINE \d+:|folio_view|\^/);
  } finally {
    fs.rmSync(path.join(root, "data/broken.json"));
  }
});

test("while sharing is paused, the views of what the reader read answer only that, except to folio's own pages", async () => {
  const views = [
    "/notes/a.md?read",
    "/notes/a.md?page",
    "/?changed",
    "/?needs-data",
    "/?stale-data",
  ];
  presenceOf(model).pause(true);

  try {
    for (const view of views) {
      assert.equal(JSON.parse((await get(view)).body).paused, true, view);
      const own = await getWith(view, { "sec-fetch-site": "same-origin" });
      assert.equal(own.status, 200, view);
      assert.equal(JSON.parse(own.body).paused, undefined, view);
    }
  } finally {
    presenceOf(model).pause(false);
  }

  for (const view of views) {
    assert.equal(JSON.parse((await get(view)).body).paused, undefined, view);
  }
});
