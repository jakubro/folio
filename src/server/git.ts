/** Git, read only: what the repository a file belongs to knows of it. */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInside } from "./files.ts";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 256 * 1024 * 1024;
/**
 * No command folio runs may write to a repository: optional locks off, no prompts, no pager; every
 * path is literal, so no name folio passes is read as a pattern or a magic pathspec.
 */
const ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_LITERAL_PATHSPECS: "1",
  LC_ALL: "C",
};
/**
 * A repository's own config may name programs to run; each key that can is overridden, as a
 * command-line setting outranks every config file.
 */
const SAFE = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.untrackedCache=false",
  "core.sshCommand=false",
  "core.askPass=false",
  "credential.helper=",
  "log.showSignature=false",
  "gpg.program=false",
  "gpg.ssh.program=false",
  "gpg.x509.program=false",
  "diff.external=",
  "protocol.allow=never",
].flatMap((setting) => ["-c", setting]);

export interface Commit {
  /** The file's blob at the commit; forty zeros where the commit removed it. */
  blob: string;
  /** The start of the second git timed it to. */
  at: number;
  by: string;
}

const COMMITS = 2000;
const LOGGED = 50_000;
const tops = new Map<string, Promise<string | undefined>>();
const logs = new Map<string, { key: string; files: Promise<Map<string, Commit[]>> }>();

/**
 * The commits touching a file, newest first, at most 2,000; none outside a repository folio may
 * read. Each repository's log is read once, whole, and read again only once a commit has moved its
 * HEAD.
 */
export async function commits(file: string, root: string): Promise<Commit[]> {
  const repository = await repositoryOf(placed(file).cwd, root);
  return repository ? ((await logOf(repository)).get(file) ?? []).slice(0, COMMITS) : [];
}

/**
 * The top folder of the repository a folder belongs to, if folio may read it: its git directory
 * lies inside the served folder, or is the `.git` of the served folder or a folder above it. A
 * `.git` file pointing anywhere else - another repository's objects - is refused.
 */
export function repositoryOf(dir: string, root: string): Promise<string | undefined> {
  const key = `${root}\0${dir}`;
  let found = tops.get(key);

  if (found === undefined) {
    found = (async () => {
      const top = await topLevel(dir);
      const named = top && (await git(top, ["rev-parse", "--absolute-git-dir"]))?.trim();
      const real = named && fs.existsSync(named) ? fs.realpathSync(named) : undefined;
      return real && trusted(real, root) ? top : undefined;
    })();
    tops.set(key, found);
  }

  return found;
}

async function topLevel(dir: string): Promise<string | undefined> {
  return (await git(dir, ["rev-parse", "--show-toplevel"]))?.trim() || undefined;
}

function trusted(gitDir: string, root: string): boolean {
  if (isInside(root, gitDir)) {
    return true;
  }

  for (let dir = root; ; dir = path.dirname(dir)) {
    if (isInside(path.join(dir, ".git"), gitDir)) {
      return true;
    }

    if (path.dirname(dir) === dir) {
      return false;
    }
  }
}

/** Every file a repository's commits touched in a period, in milliseconds, as absolute paths. */
export async function touched(top: string, from: number, to: number): Promise<string[]> {
  const output = await git(top, [
    "-c",
    "core.quotePath=false",
    "log",
    `--since=@${Math.floor(from / 1000)}`,
    `--until=@${Math.floor(to / 1000)}`,
    "--no-renames",
    "--no-show-signature",
    "--name-only",
    "--format=",
  ]);

  return [...new Set((output ?? "").split("\n").filter(Boolean))].map((file) =>
    path.join(top, file),
  );
}

export function gitText(file: string, blob: string): Promise<string | undefined> {
  return git(placed(file).cwd, ["cat-file", "blob", blob]);
}

/** Every file a repository tracks, as absolute paths. */
export async function tracked(top: string): Promise<Set<string>> {
  const output = await git(top, ["ls-files", "-z"]);
  return new Set(
    (output ?? "")
      .split("\0")
      .filter(Boolean)
      .map((file) => path.join(top, file)),
  );
}

/**
 * A repository's HEAD moves with every commit, and its reflog with it: their sizes and times are the
 * key, so no process runs to learn the log is still current.
 */
async function logOf(top: string): Promise<Map<string, Commit[]>> {
  const key = await headOf(top);
  const held = logs.get(top);

  if (held?.key === key) {
    return held.files;
  }

  const files = git(top, [
    "-c",
    "core.quotePath=false",
    "log",
    `-n${LOGGED}`,
    "--no-renames",
    "--no-show-signature",
    "--no-ext-diff",
    "--no-textconv",
    "--raw",
    "--no-abbrev",
    "--format=%x01%ct%x00%an",
  ]).then((output) => {
    const found = new Map<string, Commit[]>();

    for (const record of (output ?? "").split("\x01")) {
      const [head, ...rest] = record.split("\n");
      const [time, by] = head.split("\0");

      for (const line of rest) {
        const [fields, name] = line.split("\t");

        if (line.startsWith(":") && name !== undefined) {
          const file = path.join(top, name);
          const blob = fields.split(" ")[3];
          const commit = { blob, at: Number(time) * 1000, by };
          const held = found.get(file);

          if (held) {
            held.push(commit);
          } else {
            found.set(file, [commit]);
          }
        }
      }
    }

    return found;
  });

  logs.set(top, { key, files });
  return files;
}

async function headOf(top: string): Promise<string> {
  const dir = path.join(top, ".git");
  const stamp = ["logs/HEAD", "HEAD", "packed-refs"].map((name) => {
    const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    return stat ? `${stat.mtimeMs}:${stat.size}` : "";
  });

  return stamp[0] ? stamp.join("|") : ((await git(top, ["rev-parse", "HEAD"])) ?? "");
}

/** Run git in a folder; undefined when git is missing, the folder is in no repository, or it fails. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-pager", ...SAFE, ...args],
      { cwd, env: ENV, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

/** A removed file's folder may be gone too: git is asked from the nearest folder still there. */
function placed(file: string): { cwd: string; spec: string } {
  let cwd = path.dirname(file);

  while (!fs.existsSync(cwd) && path.dirname(cwd) !== cwd) {
    cwd = path.dirname(cwd);
  }

  return { cwd, spec: path.relative(cwd, file) };
}
