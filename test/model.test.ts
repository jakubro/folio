import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { versionOf } from "../src/server/blocks.ts";
import { expand, type Instance } from "../src/server/includes.ts";
import { Indexer, IndexerDown } from "../src/server/indexer.ts";
import { Model, modelStore, type PageBlock } from "../src/server/model.ts";
import { pageState } from "../src/server/versions.ts";

interface View {
  blocks: { id: string; kind: string; text: string }[];
}

/** The real parser, which also exits when asked to parse "exit"; one worker serves every test here. */
const indexer = new Indexer(new URL("./exiting-worker.ts", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-")));
const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-store-")), "folder");
const models: Model[] = [];

write({
  "log.md": "# Log\n\nThe north pump runs at night and stops at dawn.\n\nValves close when full.",
  "plans/next.md": "# Next\n\nReplace the gasket.",
  "flow.mmd": "graph LR\n  A --> B",
  ".drafts/hidden.md": "# Hidden",
  "node_modules/pkg/README.md": "# Package",
  "media/pic.png": "png",
});

after(() => {
  void indexer.close();
  for (const model of models) {
    model.close();
  }
});

test("indexes every document under the folder, and nothing pruned", async () => {
  const model = await started();

  assert.deepEqual(
    [
      "log.md",
      "plans/next.md",
      "flow.mmd",
      ".drafts/hidden.md",
      "node_modules/pkg/README.md",
      "media/pic.png",
    ].map((urlPath) => model.inspect(urlPath) !== undefined),
    [true, true, true, false, false, false],
  );
  assert.deepEqual(
    (model.inspect("flow.mmd") as View).blocks.map((block) => block.kind),
    ["diagram"],
  );
  model.close();
});

test("follows an edit to a document no one is looking at, keeping each block's identity", async () => {
  const model = await started();
  const before = view(model, "log.md");

  write({
    "log.md":
      "Valves close when full.\n\n# Log\n\nThe north pump runs at night and halts at sunrise.\n\nInvoices go out on Mondays.",
  });
  const after = await until(model, "log.md", (v) => v.blocks.length === 4);

  assert.deepEqual(
    after.blocks.map((block) => block.id),
    [before.blocks[2].id, before.blocks[0].id, before.blocks[1].id, after.blocks[3].id],
  );
  assert.ok(!before.blocks.some((block) => block.id === after.blocks[3].id));
  model.close();
});

test("follows an edit while another file in the folder is written without pause", async () => {
  const model = await started();
  const noise = setInterval(() => fs.appendFileSync(path.join(root, "build.log"), "line\n"), 10);

  try {
    write({ "plans/next.md": "# Next\n\nReplace the gasket.\n\nOrder a spare." });
    await until(model, "plans/next.md", (v) => v.blocks.length === 3);
  } finally {
    clearInterval(noise);
    fs.rmSync(path.join(root, "build.log"));
  }

  write({ "plans/next.md": "# Next\n\nReplace the gasket." });
  await until(model, "plans/next.md", (v) => v.blocks.length === 2);
  model.close();
});

test("picks up documents and folders added or removed while running", async () => {
  const model = await started();

  write({ "fresh/deep/new.md": "# New" });
  await until(model, "fresh/deep/new.md", () => true);
  fs.rmSync(path.join(root, "plans"), { recursive: true });
  await waitFor(() => model.inspect("plans/next.md") === undefined);
  write({ "plans/next.md": "# Next\n\nReplace the gasket." });
  await until(model, "plans/next.md", () => true);
  model.close();
});

test("catches up on edits made while stopped, and rebuilds from the files alone", async () => {
  const first = await started();
  const log = view(first, "log.md");
  first.close();

  write({
    "log.md": fs.readFileSync(path.join(root, "log.md"), "utf8").replace("Mondays", "Fridays"),
  });
  write({ "later.md": "# Later" });
  fs.rmSync(path.join(root, "fresh"), { recursive: true });

  const second = await started();
  const caughtUp = view(second, "log.md");

  assert.deepEqual(
    caughtUp.blocks.map((block) => block.id),
    log.blocks.map((block) => block.id),
  );
  assert.match(caughtUp.blocks[3].text, /Fridays/);
  assert.notEqual(second.inspect("later.md"), undefined);
  assert.equal(second.inspect("fresh/deep/new.md"), undefined);
  second.close();

  fs.rmSync(store, { recursive: true });
  const rebuilt = await started();

  assert.deepEqual(
    (rebuilt.status("") as { documents: number }).documents,
    (second.status("") as { documents: number }).documents,
  );
  assert.deepEqual(
    view(rebuilt, "plans/next.md").blocks.map((block) => block.id),
    view(second, "plans/next.md").blocks.map((block) => block.id),
  );
  rebuilt.close();
});

test("writes nothing inside the served folder", async () => {
  const before = snapshot(root);
  const model = await started();
  write({ "log.md": "# Log\n\nRewritten." });
  await until(model, "log.md", (v) => v.blocks.length === 2);
  model.close();

  const after = snapshot(root);
  after.delete("log.md");
  before.delete("log.md");
  assert.deepEqual(after, before);
  assert.ok(fs.readdirSync(path.join(store, "documents")).length > 0);
});

test("keeps a folder's model under the user's state directory, one folder per served folder", () => {
  const home = path.join(os.homedir(), ".local", "state", "folio");

  assert.equal(path.dirname(modelStore("/srv/a", {})), home);
  assert.equal(path.dirname(modelStore("/srv/a", { XDG_STATE_HOME: "/state" })), "/state/folio");
  assert.notEqual(modelStore("/srv/a", {}), modelStore("/srv/b", {}));
  assert.equal(path.dirname(modelStore("/srv/a", { XDG_STATE_HOME: "state" })), home);
});

test("a document that cannot be indexed is logged and skipped, and the rest of the folder still is", async () => {
  const lines: string[] = [];
  const failing = {
    split: (text: string, kind: "markdown" | "mermaid", previous?: unknown[]) =>
      text.includes("gasket")
        ? Promise.reject(new Error("parser failed"))
        : indexer.split(text, kind, previous as never),
  } as unknown as Indexer;
  const model = new Model(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-fail-")),
    failing,
    (line) => lines.push(line),
  );
  models.push(model);
  await model.start();

  assert.equal(model.inspect("plans/next.md"), undefined);
  assert.notEqual(model.inspect("log.md"), undefined);
  assert.equal((model.status("") as { ready: boolean }).ready, true);
  assert.ok(lines.some((line) => line === "model: cannot index plans/next.md: parser failed"));
  model.close();
});

test("places a page's blocks from the text it was served, before the folder's watch reaches it", async () => {
  write({
    "page/main.md": "# Main\n\nThe pump runs.\n\n{include: part.md}",
    "page/part.md": "Part text.",
  });
  const model = await started();
  const before = view(model, "page/main.md");

  write({
    "page/main.md": "# Main\n\nThe north pump runs.\n\n{include: part.md}\n\nNew closing line.",
  });
  const instances = expand(root, path.join(root, "page/main.md")).instances;

  assert.equal(model.page(instances).partial, true, "a page served before parsing waits for none");

  const placed = await ready(model, instances);

  assert.deepEqual(
    placed.map(({ id, source, lines, at }) => [id, source, lines, at]),
    [
      [before.blocks[0].id, "page/main.md", [1, 1], [1, 1]],
      [before.blocks[1].id, "page/main.md", [3, 3], [3, 3]],
      [before.blocks[2].id, "page/main.md", [5, 5], [5, 5]],
      [placed[3].id, "page/part.md", [1, 1], [5, 5]],
      [placed[4].id, "page/main.md", [7, 7], [7, 7]],
    ],
  );
  assert.equal(view(model, "page/main.md").blocks.length, 4);
  model.close();
});

test("a page asked for before the first walk reaches it takes the ids the store kept", async () => {
  write({ "kept/doc.md": "# Kept\n\nThe valve leaks at night." });
  const first = await started();
  write({ "kept/doc.md": "# Kept\n\nThe valve leaks at night, slowly." });
  const edited = await until(first, "kept/doc.md", (v) => v.blocks[1].text.includes("slowly"));
  first.close();

  const second = new Model(root, store, indexer, () => {});
  models.push(second);
  const placed = await ready(second, expand(root, path.join(root, "kept/doc.md")).instances);

  assert.deepEqual(
    placed.map((block) => block.id),
    edited.blocks.map((block) => block.id),
  );
  second.close();
});

test("a page served from a pruned folder is placed but never joins the model", async () => {
  const model = await started();
  const placed = await ready(model, expand(root, path.join(root, ".drafts/hidden.md")).instances);

  assert.deepEqual(
    placed.map(({ kind, source }) => [kind, source]),
    [["heading", ".drafts/hidden.md"]],
  );
  assert.equal(model.inspect(".drafts/hidden.md"), undefined);
  model.close();
});

test("lists every link from another document to a page, with the part it points at", async () => {
  write({
    "web/target.md": "# Target\n\n## Retry policy\n\nRetries [here](#retry-policy) back off.",
    "web/a.md":
      "See [it](target.md), [its retries](target.md#retry-policy) and [away](https://example.com/target.md).",
    "web/deep/b.md": "- [From root](/web/target.md#^gone)\n- [Elsewhere](../a.md)",
  });
  const model = await started();
  const ids = view(model, "web/a.md").blocks.map((block) => block.id);

  const page = await ready(model, expand(root, path.join(root, "web/target.md")).instances);

  assert.deepEqual(model.backlinks("web/target.md", page), [
    { source: "web/a.md", block: ids[0], context: "See it, its retries and away." },
    {
      source: "web/a.md",
      block: ids[0],
      context: "See it, its retries and away.",
      part: "Retry policy",
    },
    {
      source: "web/deep/b.md",
      block: view(model, "web/deep/b.md").blocks[0].id,
      context: "From root Elsewhere",
      part: "a block no longer on this page",
    },
  ]);
  model.close();
});

test("a store of an older format is parsed again, keeping every block's id", async () => {
  write({ "older/doc.md": "# Older\n\nThe valve leaks at night." });
  const first = await started();
  write({ "older/doc.md": "# Older\n\nThe valve leaks at night, slowly." });
  const edited = await until(first, "older/doc.md", (v) => v.blocks[1].text.includes("slowly"));
  first.close();
  const marker = path.join(store, "folder.json");
  fs.writeFileSync(
    marker,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(marker, "utf8")), format: 1 }),
  );

  const second = await started();

  assert.deepEqual(
    view(second, "older/doc.md").blocks.map((block) => block.id),
    edited.blocks.map((block) => block.id),
  );
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).format, 12);
  second.close();
});

test("a page whose text cannot be parsed is served without block sources, never failing", async () => {
  write({ "broken/doc.md": "# Broken\n\nThe gasket text." });
  const failing = {
    split: (text: string) =>
      text.includes("gasket") ? Promise.reject(new Error("parser failed")) : Promise.resolve([]),
  } as unknown as Indexer;
  const model = new Model(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-broken-")),
    failing,
    () => {},
  );
  models.push(model);
  const instances = expand(root, path.join(root, "broken/doc.md")).instances;

  assert.deepEqual(model.page(instances), { blocks: [], partial: true });
  assert.deepEqual(await ready(model, instances), []);
  model.close();
});

test("names the part a link points at as the page shows it, includes and all", async () => {
  write({
    "parts2/target.md": "# Target\n\n## Notes\n\n{include: shared.md}",
    "parts2/shared.md": "## Notes\n\nShared paragraph.",
    "parts2/from.md": "[a](target.md#notes-1) and [b](target.md#^ID)",
  });
  const model = await started();
  const page = await ready(model, expand(root, path.join(root, "parts2/target.md")).instances);
  const shared = page.find(
    (block) => block.source === "parts2/shared.md" && block.kind === "paragraph",
  );
  write({ "parts2/from.md": `[a](target.md#notes-1) and [b](target.md#^${shared?.id})` });
  await until(model, "parts2/from.md", (v) => v.blocks[0].text.includes(shared?.id ?? "-"));

  assert.deepEqual(
    model.backlinks("parts2/target.md", page).map((link) => link.part),
    ["Notes", "Shared paragraph."],
  );

  write({ "parts2/from.md": "No links left." });
  await until(model, "parts2/from.md", (v) => v.blocks[0].text === "No links left.");
  assert.deepEqual(model.backlinks("parts2/target.md", page), []);
  model.close();
});

test("tells its listeners once the first walk ends, even when every document came from the store", async () => {
  const first = await started();
  first.close();

  const second = new Model(root, store, indexer, () => {});
  models.push(second);
  let heard = 0;
  second.listen(() => heard++);
  await second.start();

  assert.ok(heard > 0, "nothing told the listeners that the walk ended");
  second.close();
});

test("a section placed on a page brings none of the blocks after it", async () => {
  write({
    "sections/design.md": "# Design\n\n## Retry\n\nBack off.\n\n## Storage\n\nDisk.\n",
    "sections/page.md": "# Page\n\n{include: design.md#retry}\nAfter.\n",
  });
  const model = await started();
  const page = await ready(
    model,
    expand(root, path.join(root, "sections/page.md"), (file, text) => model.blocksReady(file, text))
      .instances,
  );

  assert.deepEqual(
    page.filter((block) => block.source === "sections/design.md").map((block) => block.lines),
    [
      [3, 3],
      [5, 5],
    ],
  );
  model.close();
});

test("counts headings nested in quotes, lists and HTML, and reads parts from files outside the model", async () => {
  write({
    "nested/target.md":
      "# Target\n\n> ## Notes\n\n<h2>Notes</h2>\n\n## Notes\n\n{include: .hidden/shared.md}",
    "nested/.hidden/shared.md": "Hidden paragraph.",
    "nested/from.md": "[a](target.md#notes-2) and [b](target.md#^ID)",
  });
  const model = await started();
  const blocksOf = (file: string, text: string) => model.blocksReady(file, text);
  const page = await ready(
    model,
    expand(root, path.join(root, "nested/target.md"), blocksOf).instances,
  );
  const hidden = page.find((block) => block.source === "nested/.hidden/shared.md");
  write({ "nested/from.md": `[a](target.md#notes-2) and [b](target.md#^${hidden?.id})` });
  await until(model, "nested/from.md", (v) => v.blocks[0].text.includes(hidden?.id ?? "-"));

  assert.deepEqual(
    model.backlinks("nested/target.md", page).map((link) => link.part),
    ["Notes", "Hidden paragraph."],
  );
  model.close();
});

test("a page whose worker went down gets its block sources once a worker answers again", async () => {
  write({ "down/doc.md": "# Down\n\nWaiting for a worker." });
  let calls = 0;
  const flaky = {
    split: (text: string, kind: "markdown" | "mermaid", previous?: unknown[]) =>
      ++calls === 1
        ? Promise.reject(new IndexerDown("indexer exited with code 1"))
        : indexer.split(text, kind, previous as never),
  } as unknown as Indexer;
  const model = new Model(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-down-")),
    flaky,
    () => {},
    50,
  );
  models.push(model);
  const instances = expand(root, path.join(root, "down/doc.md")).instances;

  assert.equal(model.page(instances).partial, true);
  assert.deepEqual(
    (await ready(model, instances)).map((block) => block.kind),
    ["heading", "paragraph"],
  );
  model.close();
});

test("holds where a document has text its page reads no link in, for exactly the text it indexed", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-literals-")));
  const text = "# Doc\n\nIntro\n| `a` | b |\n| c | d |\n\nSee `e` and <!-- f -->.\n";
  fs.writeFileSync(path.join(folder, "doc.md"), text);
  const model = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-literals-store-")),
    indexer,
    () => {},
  );
  models.push(model);
  await model.start();

  assert.deepEqual(
    (model.heldFor("doc.md", text) ?? [])
      .flatMap(({ literals = [] }) => literals)
      .map(({ type, start, end }) => [type, text.slice(start, end)]),
    [
      ["inlineCode", "`a`"],
      ["inlineCode", "`e`"],
      ["html", "<!-- f -->"],
    ],
  );
  assert.equal(model.heldFor("doc.md", `${text}\nMore.\n`), undefined);
  model.close();
});

test("a document an older folio stored is parsed again, though the folder is marked current", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-older-")));
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-older-store-"));
  const text = "# Doc\n\nSee `a` here.\n";
  fs.writeFileSync(path.join(folder, "doc.md"), text);
  const first = new Model(folder, kept, indexer, () => {});
  models.push(first);
  await first.start();
  await first.flush();
  first.close();
  const documents = path.join(kept, "documents");

  for (const name of fs.readdirSync(documents)) {
    const { format: _, ...older } = JSON.parse(fs.readFileSync(path.join(documents, name), "utf8"));
    older.blocks = older.blocks.map(({ literals: __, ...block }: { literals?: unknown }) => block);
    fs.writeFileSync(path.join(documents, name), JSON.stringify(older));
  }

  const second = new Model(folder, kept, indexer, () => {});
  models.push(second);
  await second.start();

  assert.deepEqual(
    (second.heldFor("doc.md", text) ?? [])
      .flatMap(({ literals = [] }) => literals)
      .map(({ start, end }) => text.slice(start, end)),
    ["`a`"],
  );
  second.close();
});

test("a document that crashes the parser shows without ids, is not parsed again, and holds up no other", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-crash-")));
  fs.writeFileSync(path.join(folder, "crash.md"), "exit");
  fs.writeFileSync(path.join(folder, "good.md"), "# Good\n\nFine.");
  let crashes = 0;
  const counting = {
    split: (text: string, kind: "markdown" | "mermaid", previous?: unknown[]) => {
      crashes += text === "exit" ? 1 : 0;
      return indexer.split(text, kind, previous as never);
    },
  } as unknown as Indexer;
  const model = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-crash-store-")),
    counting,
    () => {},
  );
  models.push(model);
  const crash = expand(folder, path.join(folder, "crash.md")).instances;
  const good = expand(folder, path.join(folder, "good.md")).instances;

  model.page(crash);
  model.page(good);

  assert.deepEqual(await ready(model, crash), []);
  assert.deepEqual(
    (await ready(model, good)).map((block) => block.kind),
    ["heading", "paragraph"],
  );
  assert.equal(
    pageState(folder, path.join(folder, "crash.md"), model).version.endsWith("-partial"),
    false,
  );

  await model.start();
  fs.writeFileSync(path.join(folder, "good.md"), "# Good\n\nFine, and edited.");
  await until(model, "good.md", (found) => found.blocks[1]?.text === "Fine, and edited.");
  fs.writeFileSync(path.join(folder, "other.md"), "# Other");
  await until(model, "other.md", (found) => found.blocks.length === 1);
  model.page(crash);

  assert.equal(crashes, 1);
  model.close();
});

test("a page saved twice in quick succession is handed the ids the model keeps", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-saves-")));
  const file = path.join(folder, "doc.md");
  fs.writeFileSync(file, "# Doc\n\nFirst paragraph stays.");
  const model = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-saves-store-")),
    indexer,
    () => {},
  );
  models.push(model);
  await model.start();

  fs.writeFileSync(
    file,
    "# Doc\n\nFirst paragraph stays.\n\nThe pump at the north end runs until dawn.",
  );
  model.page(expand(folder, file).instances);
  fs.writeFileSync(
    file,
    "# Doc\n\nFirst paragraph stays.\n\nThe pump at the north end runs until the dawn.",
  );
  const tab = (await ready(model, expand(folder, file).instances)).map((block) => block.id);
  const held = await until(model, "doc.md", (found) => found.blocks[2]?.text.endsWith("the dawn."));

  assert.deepEqual(
    tab,
    held.blocks.map((block) => block.id),
  );
  model.close();
});

test("an edit no page shows, made while the parser is down, is indexed once it is back", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-unseen-")));
  fs.writeFileSync(path.join(folder, "doc.md"), "# Old");
  let down = false;
  const flaky = {
    split: (text: string, kind: "markdown" | "mermaid", previous?: unknown[]) => {
      if (down) {
        down = false;
        return Promise.reject(new IndexerDown("indexer exited with code 1"));
      }

      return indexer.split(text, kind, previous as never);
    },
  } as unknown as Indexer;
  const model = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-unseen-store-")),
    flaky,
    () => {},
    50,
  );
  models.push(model);
  await model.start();

  down = true;
  fs.writeFileSync(path.join(folder, "doc.md"), "# New");

  await until(model, "doc.md", (found) => found.blocks[0]?.text === "# New");
  model.close();
});

test("names every form of heading as the page shows it, and numbers duplicates as the page does", async () => {
  write({
    "forms/target.md": [
      "<h2>Q&amp;A</h2>",
      "## Q&A",
      "<h2> Spaced  out </h2>",
      '<h2 id="top">Notes</h2>',
      "## Notes",
      "<!-- <h2>Old</h2> -->",
      "## Old",
      "<style>\n<h2>Styled</h2>\n</style>",
      "## Styled",
      "Lead <h2>Inline</h2> tail",
      "## Press <kbd>Ctrl</kbd>",
      "## Logo ![icon](x.png)",
      "## Claim[^1]",
      "[^1]: A note.",
    ].join("\n\n"),
    "forms/from.md": [
      "qa",
      "qa-1",
      "-spaced--out-",
      "top",
      "notes",
      "notes-1",
      "old",
      "old-1",
      "styled",
      "styled-1",
      "inline",
      "press-ctrl",
      "logo-",
      "claim1",
    ]
      .map((anchor) => `[${anchor}](target.md#${anchor})`)
      .join(" "),
  });
  const model = await started();
  const page = await ready(model, expand(root, path.join(root, "forms/target.md")).instances);

  assert.deepEqual(
    model.backlinks("forms/target.md", page).map((link) => link.part),
    [
      "Q&A",
      "Q&A",
      "Spaced out",
      "Notes",
      "Notes",
      "#notes-1",
      "Old",
      "#old-1",
      "Styled",
      "#styled-1",
      "Inline",
      "Press Ctrl",
      "Logo",
      "Claim1",
    ],
  );
  model.close();
});

test("an anchor an author's id shares with another heading names the heading the page lands on", async () => {
  write({
    "clash/target.md": [
      "## Intro",
      '<h2 id="intro">Other</h2>',
      '<h2 id="a">One</h2>',
      '<h2 id="a">Two</h2>',
      '<h2 id="">Empty</h2>',
      "## Empty!",
    ].join("\n\n"),
    "clash/from.md": ["intro", "user-content-intro", "a", "empty"]
      .map((anchor) => `[${anchor}](target.md#${anchor})`)
      .join(" "),
  });
  const model = await started();
  const page = await ready(model, expand(root, path.join(root, "clash/target.md")).instances);

  assert.deepEqual(
    model.backlinks("clash/target.md", page).map((link) => link.part),
    ["Intro", "Other", "One", "Empty!"],
  );
  model.close();
});

test("an edit read just before a page's newer text is parsed never leaves the model behind the tab", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-late-")));
  const file = path.join(folder, "doc.md");
  fs.writeFileSync(file, "# Doc\n\nThe pump at the north end runs every night.\n\nValves close.");
  const model = new Model(
    folder,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-model-late-store-")),
    indexer,
    () => {},
  );
  models.push(model);
  await model.start();
  const read = fs.promises.readFile;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = false;
  fs.promises.readFile = (async (...args: Parameters<typeof read>) => {
    const text = await read(...args);

    if (args[0] === file && !gated) {
      gated = true;
      await held;
    }

    return text;
  }) as typeof read;

  try {
    fs.writeFileSync(file, "# Doc\n\nValves close.");
    await waitFor(() => gated);
    fs.writeFileSync(
      file,
      "# Doc\n\nThe pump at the north end runs every night, mostly.\n\nValves close.",
    );
    const instances = expand(folder, file).instances;
    model.page(instances);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const tab = (await ready(model, instances)).map((block) => block.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const kept = view(model, "doc.md");

    assert.equal(kept.blocks[1].text, "The pump at the north end runs every night, mostly.");
    assert.deepEqual(
      tab,
      kept.blocks.map((block) => block.id),
    );
  } finally {
    fs.promises.readFile = read;
    release();
    model.close();
  }
});

async function ready(model: Model, instances: Instance[]): Promise<PageBlock[]> {
  for (let i = 0; i < 100 && model.page(instances).partial; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const placed = model.page(instances);
  assert.equal(placed.partial, false, "the page's blocks never became ready");
  return placed.blocks;
}

async function started(): Promise<Model> {
  const model = new Model(root, store, indexer, () => {});
  models.push(model);
  await model.start();
  return model;
}

function view(model: Model, urlPath: string): View {
  return model.inspect(urlPath) as View;
}

async function until(model: Model, urlPath: string, test: (view: View) => boolean): Promise<View> {
  await waitFor(() => {
    const found = model.inspect(urlPath) as View | undefined;
    return found !== undefined && test(found);
  });
  return view(model, urlPath);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(condition(), "the model did not follow the change");
}

function write(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}

function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();

  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    files.set(name, stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : "folder");
  }

  return files;
}

test("a moved document keeps its blocks' ids, what was read of it and its history, running or stopped", async () => {
  const model = await started();
  write({ "moves/a.md": "# Moves\n\nThe pump stops." });
  await until(model, "moves/a.md", () => true);
  write({ "moves/a.md": "# Moves\n\nThe pump stops at dawn, slowly." });
  const read = await until(model, "moves/a.md", (v) => v.blocks[1].text.includes("dawn"));
  const [, paragraph] = model.held("moves/a.md") ?? [];
  await model.reads.read("moves/a.md", [{ id: paragraph.id, version: versionOf(paragraph) }]);
  const kept = async (urlPath: string) => {
    assert.deepEqual(
      view(model, urlPath).blocks.map((block) => block.id),
      read.blocks.map((b) => b.id),
    );
    assert.equal(model.reads.get(urlPath)?.blocks[paragraph.id]?.version, versionOf(paragraph));
    assert.ok((await model.history.versions(urlPath)).length >= 2, `${urlPath} keeps its saves`);
  };

  fs.renameSync(path.join(root, "moves/a.md"), path.join(root, "moves/b.md"));
  await until(model, "moves/b.md", () => model.inspect("moves/a.md") === undefined);
  await kept("moves/b.md");

  fs.mkdirSync(path.join(root, "elsewhere"), { recursive: true });
  fs.renameSync(path.join(root, "moves/b.md"), path.join(root, "elsewhere/c.md"));
  await until(model, "elsewhere/c.md", () => model.inspect("moves/b.md") === undefined);
  await kept("elsewhere/c.md");
  await model.reads.flush();
  model.close();

  fs.renameSync(path.join(root, "elsewhere/c.md"), path.join(root, "moves/d.md"));
  const again = await started();
  assert.deepEqual(
    view(again, "moves/d.md").blocks.map((block) => block.id),
    read.blocks.map((b) => b.id),
  );
  assert.equal(again.reads.get("moves/d.md")?.blocks[paragraph.id]?.version, versionOf(paragraph));
  assert.equal(again.reads.get("elsewhere/c.md"), undefined);
  assert.ok((await again.history.versions("moves/d.md")).length >= 2);
  again.close();
});

test("a moved document asked for at its new place before folio indexes it keeps its ids and read record", async () => {
  const model = await started();
  write({ "early/a.md": "# Early\n\nThe valve opens." });
  await until(model, "early/a.md", () => true);
  write({ "early/a.md": "# Early\n\nThe valve opens at noon, briefly." });
  const read = await until(model, "early/a.md", (v) => v.blocks[1].text.includes("noon"));
  const [, paragraph] = model.held("early/a.md") ?? [];
  await model.reads.read("early/a.md", [{ id: paragraph.id, version: versionOf(paragraph) }]);

  const text = fs.readFileSync(path.join(root, "early/a.md"), "utf8");
  fs.renameSync(path.join(root, "early/a.md"), path.join(root, "early/b.md"));
  model.blocksReady(path.join(root, "early/b.md"), text);
  await until(model, "early/b.md", () => model.inspect("early/a.md") === undefined);

  assert.deepEqual(
    view(model, "early/b.md").blocks.map((block) => block.id),
    read.blocks.map((block) => block.id),
  );
  assert.equal(model.reads.get("early/b.md")?.blocks[paragraph.id]?.version, versionOf(paragraph));
  model.close();
});
