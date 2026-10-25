import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Block, blocks } from "../src/server/blocks.ts";
import { blobId, History } from "../src/server/history.ts";

const DAY = 86_400_000;
const split = async (text: string, kind: "markdown" | "mermaid", previous: Block[] = []) =>
  blocks(text, kind, previous);

test("a save and a commit of the same text are one version; git's history and folio's merge by time", async () => {
  const { root, history, commit } = setup();
  const file = path.join(root, "notes/log.md");

  fs.writeFileSync(file, "# Log\n\nFirst.\n");
  commit("2030-01-01T00:00:00Z");
  fs.writeFileSync(file, "# Log\n\nSecond.\n");
  await history.saved("notes/log.md", "# Log\n\nSecond.\n", Date.parse("2030-01-02T00:00:00Z"));
  commit("2030-01-02T00:05:00Z");
  fs.writeFileSync(file, "# Log\n\nThird.\n");
  await history.saved("notes/log.md", "# Log\n\nThird.\n", Date.parse("2030-01-03T00:00:00Z"));
  fs.utimesSync(file, new Date("2030-01-03T00:00:00Z"), new Date("2030-01-03T00:00:00Z"));
  const versions = await history.versions("notes/log.md");

  assert.deepEqual(
    versions.map(({ id, at, seen, by }) => [id, new Date(at).toISOString(), seen.sort(), by]),
    [
      [blobId("# Log\n\nThird.\n"), "2030-01-03T00:00:00.000Z", ["file", "saved"], undefined],
      [
        blobId("# Log\n\nSecond.\n"),
        "2030-01-02T00:00:00.000Z",
        ["committed", "saved"],
        "Ada Pump",
      ],
      [blobId("# Log\n\nFirst.\n"), "2030-01-01T00:00:00.000Z", ["committed"], "Ada Pump"],
    ],
  );
  assert.equal(await history.text("notes/log.md", versions[2].id), "# Log\n\nFirst.\n");
  assert.equal(await history.text("notes/log.md", versions[1].id), "# Log\n\nSecond.\n");
  assert.equal(await history.text("notes/log.md", blobId("# Elsewhere\n")), undefined);
});

test("a file in a nested repository takes its history from that repository", async () => {
  const { root, history, commit } = setup();
  const inner = path.join(root, "module");

  fs.writeFileSync(path.join(root, "outer.md"), "outer\n");
  commit("2030-01-01T00:00:00Z");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "page.md"), "inner\n");
  commit("2030-02-01T00:00:00Z", inner);
  fs.utimesSync(path.join(inner, "page.md"), new Date("2030-02-02"), new Date("2030-02-02"));
  const versions = await history.versions("module/page.md");

  assert.deepEqual(
    versions.map(({ at, seen, by }) => [new Date(at).toISOString(), seen.sort(), by]),
    [["2030-02-01T00:00:00.000Z", ["committed", "file"], "Ada Pump"]],
  );
});

test("a sweep keeps the last save of each day older than 30 days; a removal is a version", async () => {
  const { history } = setup();
  const now = Date.parse("2030-03-01T12:00:00Z");
  const old = now - 40 * DAY;

  for (const [hour, text] of [
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ] as const) {
    await history.saved("gone.md", text, old + hour * 3_600_000);
  }

  await history.saved("gone.md", "d", now - DAY);
  await history.saved("gone.md", "e", now - DAY + 1000);
  await history.removed("gone.md", now);
  await history.sweep(now);
  const versions = await history.versions("gone.md");

  assert.deepEqual(
    versions.map(({ id, removed }) => (removed ? "removed" : id)),
    ["removed", blobId("e"), blobId("d"), blobId("c")],
  );
  assert.equal(await history.text("gone.md", blobId("a")), undefined);
});

test("versions compare block by block; a block's past follows its identity back from today's ids", async () => {
  const { root, history } = setup();
  const one = "# Pumps\n\nThe north pump runs at night.\n\nValves close.\n";
  const two = "# Pumps\n\nThe north pump runs at night and dawn.\n\nA gauge.\n";

  fs.writeFileSync(path.join(root, "pumps.md"), two);
  await history.saved("pumps.md", one, 1000);
  await history.saved("pumps.md", two, 2000);
  const pairs = await history.compare("pumps.md", blobId(one), blobId(two));

  assert.deepEqual(
    pairs?.map(({ status }) => status),
    ["same", "changed", "removed", "added"],
  );

  const current = blocks(two, "markdown", blocks(one, "markdown"));
  const past = await history.block("pumps.md", current[1].id, current);

  assert.deepEqual(
    past.map(({ text }) => text),
    ["The north pump runs at night and dawn.", "The north pump runs at night."],
  );
});

test("an embed's results are kept when they change", async () => {
  const { history } = setup();

  await history.value("report.md", "total.csv#0.n", { version: "1", value: 3 }, 1);
  await history.value("report.md", "total.csv#0.n", { version: "2", value: 3 }, 2);
  await history.value("report.md", "total.csv#0.n", { version: "3", value: 5 }, 3);
  await history.value("report.md", "rows.csv", {
    version: "1",
    grid: { columns: [{ name: "n", type: "INTEGER" }], rows: [[1], [2]], partial: false },
  });

  assert.deepEqual(
    (await history.values("report.md", "total.csv#0.n")).map(({ at, value }) => [at, value]),
    [
      [1, 3],
      [3, 5],
    ],
  );
  assert.deepEqual((await history.values("report.md", "rows.csv"))[0].table, {
    columns: ["n"],
    rows: [[1], [2]],
    total: 2,
  });
  assert.deepEqual(await history.references("report.md"), ["rows.csv", "total.csv#0.n"]);
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-history-root-")));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-history-"));
  const history = new History(root, store, () => {}, split);
  fs.mkdirSync(path.join(root, "notes"));
  const commit = (date: string, cwd = root) => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada Pump",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada Pump",
      GIT_COMMITTER_EMAIL: "ada@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };

    if (!fs.existsSync(path.join(cwd, ".git"))) {
      execFileSync("git", ["init", "-q"], { cwd, env });
    }

    execFileSync("git", ["add", "."], { cwd, env });
    execFileSync("git", ["commit", "-q", "-m", "snapshot"], { cwd, env });
  };

  return { root, history, commit, store };
}

test("a sweep thins saves no new save touched", async () => {
  const { history } = setup();
  const now = Date.parse("2030-03-01T12:00:00Z");
  const old = now - 40 * DAY;

  await history.saved("old.md", "a", old);
  await history.saved("old.md", "b", old + 60_000);
  await history.sweep(now);

  assert.deepEqual(
    (await history.versions("old.md")).map(({ id }) => id),
    [blobId("b")],
  );
});

test("the text an untracked document had when first known stays, edited at once or not", async () => {
  const { root, history, commit } = setup();

  fs.writeFileSync(path.join(root, "notes/tracked.md"), "# Tracked\n");
  commit("2030-01-01T00:00:00Z");
  fs.writeFileSync(path.join(root, "loose.md"), "# Loose\n\nEdited at once.\n");
  void history.firstSeen("loose.md", "# Loose\n\nFirst known.\n", 1000);
  void history.firstSeen("notes/tracked.md", "# Tracked\n", 1000);
  await history.saved("loose.md", "# Loose\n\nEdited at once.\n", 2000);
  const loose = await history.versions("loose.md");

  assert.equal(await history.text("loose.md", loose[1].id), "# Loose\n\nFirst known.\n");
  assert.deepEqual(
    loose.map(({ seen }) => seen.sort()),
    [["file", "saved"], ["saved"]],
  );
  assert.equal(
    (await history.versions("notes/tracked.md")).some(({ seen }) => seen.includes("saved")),
    false,
  );
});

test("a save and its commit in the same second are one version, after the save before them", async () => {
  const { root, history, commit } = setup();
  const second = Date.parse("2030-01-01T00:00:00Z");

  fs.writeFileSync(path.join(root, "notes/log.md"), "# B\n");
  await history.saved("notes/log.md", "# A\n", second + 300);
  await history.saved("notes/log.md", "# B\n", second + 700);
  commit("2030-01-01T00:00:00Z");
  fs.utimesSync(path.join(root, "notes/log.md"), new Date(second + 700), new Date(second + 700));

  assert.deepEqual(
    (await history.versions("notes/log.md")).map(({ id, seen }) => [id, seen.sort()]),
    [
      [blobId("# B\n"), ["committed", "file", "saved"]],
      [blobId("# A\n"), ["saved"]],
    ],
  );
});

test("a removed document keeps its git history when its folder is gone too", async () => {
  const { root, history, commit } = setup();

  fs.mkdirSync(path.join(root, "gone"));
  fs.writeFileSync(path.join(root, "gone/page.md"), "# Page\n");
  commit("2030-01-01T00:00:00Z");
  fs.rmSync(path.join(root, "gone"), { recursive: true });
  commit("2030-01-02T00:00:00Z");
  const versions = await history.versions("gone/page.md");

  assert.deepEqual(
    versions.map(({ removed }) => Boolean(removed)),
    [true, false],
  );
  assert.equal(await history.text("gone/page.md", versions[1].id), "# Page\n");
});

test("git runs no program a repository's config names", async () => {
  const { root, history, commit } = setup();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-git-marker-")), "ran");
  const script = path.join(path.dirname(marker), "program.sh");

  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "notes/log.md"), "# Log\n");
  commit("2030-01-01T00:00:00Z");
  execFileSync("git", ["config", "core.fsmonitor", script], { cwd: root });
  execFileSync("git", ["config", "gpg.program", script], { cwd: root });
  execFileSync("git", ["config", "log.showSignature", "true"], { cwd: root });
  execFileSync("git", ["config", "diff.external", script], { cwd: root });
  execFileSync("git", ["config", "core.pager", script], { cwd: root });
  fs.writeFileSync(path.join(root, "loose.md"), "# Loose\n");
  const versions = await history.versions("notes/log.md");

  await history.text("notes/log.md", versions[0].id);
  await history.firstSeen("loose.md", "# Loose\n", 1000);

  assert.equal(versions.length, 1);
  assert.equal(fs.existsSync(marker), false, "a program from the repository's config ran");
});

test("history names files literally and never leaves the folder, through patterns or symlinks", async () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-history-outer-")));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@a",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@a",
  };
  fs.mkdirSync(path.join(outer, "served"));
  fs.writeFileSync(path.join(outer, "secret.md"), "# Secret\n");
  fs.writeFileSync(path.join(outer, "served/page.md"), "# Page\n");
  fs.symlinkSync("../secret.md", path.join(outer, "served/link.md"));
  execFileSync("git", ["init", "-q"], { cwd: outer, env });
  execFileSync("git", ["add", "."], { cwd: outer, env });
  execFileSync("git", ["commit", "-q", "-m", "s"], { cwd: outer, env });
  const root = path.join(outer, "served");
  const history = new History(
    root,
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-history-")),
    () => {},
    split,
  );
  const secret = blobId("# Secret\n");

  for (const name of [":(top)secret.md", ":/secret.md", "*.md", "link.md", "../secret.md"]) {
    assert.deepEqual(await history.versions(name), [], name);
    assert.equal(await history.text(name, secret), undefined, name);
  }

  assert.equal((await history.versions("page.md")).length, 1);
});

test("saves append a line each; a document keeps at most 500, twice that between sweeps", async () => {
  const { history, store } = setup();

  await history.saved("busy.md", "# Busy\n", 999_999);
  const log = fs
    .readdirSync(path.join(store, "history/documents"))
    .map((name) => path.join(store, "history/documents", name, "saves.log"))[0];
  const inode = fs.statSync(log).ino;
  await history.saved("busy.md", "# Busy again\n", 999_999);

  assert.equal(fs.statSync(log).ino, inode, "a save appends, never rewrites the log");

  for (let i = 0; i < 1001; i++) {
    await history.saved("busy.md", `# Busy ${i}\n`, 1_000_000 + i);
  }

  assert.ok((await history.versions("busy.md")).length <= 1000, "never past twice the bound");
  await history.sweep(2_000_000);
  const versions = await history.versions("busy.md");

  assert.equal(versions.length, 500);
  assert.equal(await history.text("busy.md", blobId("# Busy 1000\n")), "# Busy 1000\n");
  assert.equal(await history.text("busy.md", blobId("# Busy 0\n")), undefined);
});

test("past the budget a sweep drops the oldest saves of any document but its newest", async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "folio-history-"));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-history-root-")));
  const history = new History(root, store, () => {}, split, 3000);
  const noise = (seed: number) =>
    Array.from({ length: 300 }, (_, i) => ((seed * 7919 + i * 104729) % 9973).toString(36)).join(
      "",
    );

  for (const [i, name] of ["a.md", "b.md", "c.md"].entries()) {
    for (let k = 0; k < 4; k++) {
      await history.saved(name, noise(i * 10 + k), Date.now() - (4 - k) * 60_000 - i);
    }
  }

  await history.sweep();
  const sizes = fs
    .readdirSync(path.join(store, "history/documents"), { recursive: true })
    .filter((name) => String(name).endsWith(".gz"))
    .reduce(
      (sum, name) => sum + fs.statSync(path.join(store, "history/documents", String(name))).size,
      0,
    );

  assert.ok(sizes <= 3000, `kept ${sizes} bytes`);

  for (const [i, name] of ["a.md", "b.md", "c.md"].entries()) {
    const ids = (await history.versions(name)).map(({ id }) => id);
    assert.ok(ids.includes(blobId(noise(i * 10 + 3))), `${name} keeps its newest save`);
  }
});

test("a save made after a commit in the same second is the newer version, as the disk shows", async () => {
  const { root, history, commit } = setup();
  const second = Date.parse("2030-01-01T00:00:00Z");

  fs.writeFileSync(path.join(root, "notes/log.md"), "# A\n");
  commit("2030-01-01T00:00:00Z");
  fs.writeFileSync(path.join(root, "notes/log.md"), "# B\n");
  await history.saved("notes/log.md", "# B\n", second + 300);
  fs.utimesSync(path.join(root, "notes/log.md"), new Date(second + 300), new Date(second + 300));

  assert.deepEqual(
    (await history.versions("notes/log.md")).map(({ id, seen }) => [id, seen.sort()]),
    [
      [blobId("# B\n"), ["file", "saved"]],
      [blobId("# A\n"), ["committed"]],
    ],
  );
});

test("two versions differing only in spacing compare as the same blocks", async () => {
  const { root, history } = setup();
  const one = "# Pumps\n\nThe north pump runs at night.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const two = "# Pumps\n\nThe north  pump runs\nat night.\n\n|a|b|\n|-|-|\n|1|2|\n";

  fs.writeFileSync(path.join(root, "pumps.md"), two);
  await history.saved("pumps.md", one, 1000);
  await history.saved("pumps.md", two, 2000);

  assert.deepEqual(
    (await history.compare("pumps.md", blobId(one), blobId(two)))?.map(({ status }) => status),
    ["same", "same", "same"],
  );
});

test("a .git file pointing at a repository outside the folder lends it no history", async () => {
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "folio-history-elsewhere-")),
  );
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@a",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@a",
  };
  fs.writeFileSync(path.join(outside, "page.md"), "# Secret elsewhere\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "-q", "-m", "s"],
  ]) {
    execFileSync("git", args, { cwd: outside, env });
  }
  const { root, history } = setup();
  fs.mkdirSync(path.join(root, "borrowed"));
  fs.writeFileSync(path.join(root, "borrowed/.git"), `gitdir: ${path.join(outside, ".git")}\n`);
  fs.writeFileSync(path.join(root, "borrowed/page.md"), "# Here\n");
  const secret = blobId("# Secret elsewhere\n");

  assert.deepEqual(
    (await history.versions("borrowed/page.md")).map(({ seen }) => seen),
    [["file"]],
  );
  assert.equal(await history.text("borrowed/page.md", secret), undefined);
});
