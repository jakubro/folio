/**
 * What the language server knows of a document as typed: problems, where a reference leads, what refers
 * to a heading or block, a block's provenance, and the edits a renamed heading or moved file needs.
 */

import fs from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";
import { type Block, placesOf } from "./blocks.ts";
import type { Data } from "./data.ts";
import { confine, isInside, isPruned, linkTarget } from "./files.ts";
import { anchorsIn, anchorsOf, healthOf } from "./health.ts";
import { impactOf } from "./impact.ts";
import type { Indexer } from "./indexer.ts";
import type { Model } from "./model.ts";
import { claimStates, provenance } from "./provenance.ts";
import { pageState } from "./versions.ts";

/** A place in a file: 0-based line, and the columns of a span on it. */
export interface Spot {
  path: string;
  line: number;
  start: number;
  end: number;
}

export interface Finding extends Omit<Spot, "path"> {
  severity: "error" | "warning";
  what: string;
}

export interface Edit extends Spot {
  text: string;
}

export interface Editor {
  root: string;
  model: Model;
  data: Data;
  indexer: Indexer;
  /** The text of a file as the editor holds it, unsaved edits included; the file's own text otherwise. */
  textOf(urlPath: string): string | undefined;
}

interface Written extends Spot {
  written: string;
  /** As the page reads it: a link's with its escapes and character references decoded. */
  address: string;
  target?: { path: string; fragment: string };
  /** A link's address is percent-encoded; an include's, an embed's and a figure's is written as it is. */
  link: boolean;
  /** A link's address written between angle brackets, which keep a space as it is. */
  bracketed: boolean;
  /** A figure's value written without quotes, which an address holding a space needs. */
  bare: boolean;
}

type Placed = Omit<Written, "path" | "target" | "link" | "bare">;

const INCLUDE = /(?<!\\)\{include:\s*([^}\n"'[\]{},]*[^}\s"'[\]{},])\s*\}/g;
const FIGURE = /<data\b[^>]*?\bvalue=(?:"([^"]+)"|'([^']+)'|([^"'\s>]+))[^>]*>[^<]*<\/data>/g;
const EMBED = /\{(?:table|value):\s*([^}\n|]*[^}\s|])/g;
const QUERY = /^\s*(?:`{3,}|~{3,})\s*sql\s+query\s+(\S+)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

export async function findings(editor: Editor, urlPath: string): Promise<Finding[]> {
  const text = editor.textOf(urlPath) ?? "";
  const lines = text.split("\n");
  const blocks = await editor.indexer.split(text, "markdown");
  const found: Finding[] = [];

  for (const { line, start, end, address } of linksOf(
    text,
    blocks.flatMap(({ addresses = [] }) => addresses),
  )) {
    const why = brokenLink(editor, urlPath, address, blocks);

    if (why) {
      found.push({ line, start, end, severity: "warning", what: why });
    }
  }

  for (const [line, content] of lines.entries()) {
    for (const match of content.matchAll(INCLUDE)) {
      const why = brokenInclude(editor, urlPath, match[1], blocks);

      if (why) {
        found.push({ ...spanOf(match, match[1], line), severity: "error", what: why });
      }
    }
  }

  found.sort((a, b) => a.line - b.line);

  const file = path.join(editor.root, urlPath);

  for (const block of blocks) {
    const states = await claimStates(editor.data, file, block.claims ?? []);

    for (const claim of states.filter(({ state }) => state === "contradicted")) {
      const at = locate(lines, block, claim.figure);
      found.push({
        ...at,
        severity: "warning",
        what: `${claim.figure} is contradicted: the data says ${claim.live} (${claim.reference})`,
      });
    }
  }

  // Health checks the file as saved, so its other findings hold only while the text is the saved one.
  if (readText(file) === text) {
    const { problems } = await healthOf(editor.model, editor.data).state();

    for (const problem of problems) {
      if (problem.path === urlPath && !["link", "include", "figure"].includes(problem.kind)) {
        found.push({
          line: problem.line - 1,
          start: 0,
          end: lines[problem.line - 1]?.length ?? 0,
          severity: problem.severity === "error" ? "error" : "warning",
          what: problem.what,
        });
      }
    }
  }

  return found;
}

export function definition(
  editor: Editor,
  urlPath: string,
  line: number,
  column: number,
): Spot | undefined {
  const text = editor.textOf(urlPath) ?? "";
  const link = placesAt(editor, urlPath, text).links.find(
    (found) => found.line === line && found.start <= column && column <= found.end,
  );

  if (link) {
    return target(editor, urlPath, link.address);
  }

  for (const pattern of [INCLUDE, FIGURE, EMBED]) {
    for (const match of (text.split("\n")[line] ?? "").matchAll(pattern)) {
      const start = match.index ?? 0;

      if (column < start || column > start + match[0].length) {
        continue;
      }

      const reference = addressOf(match);
      return pattern === INCLUDE
        ? target(editor, urlPath, reference)
        : dataSpot(editor, urlPath, reference);
    }
  }

  return undefined;
}

export async function references(editor: Editor, urlPath: string, line: number): Promise<Spot[]> {
  const blocks = await editor.indexer.split(editor.textOf(urlPath) ?? "", "markdown");
  const block = blocks.find(({ lines }) => lines[0] - 1 <= line && line <= lines[1] - 1);

  if (!block) {
    return [];
  }

  const fragment = block.slug ?? `^${block.id}`;
  return (await writtenTo(editor, urlPath))
    .filter(({ target: to }) => to?.fragment === fragment)
    .map(spotOf);
}

export async function hover(
  editor: Editor,
  urlPath: string,
  line: number,
): Promise<string | undefined> {
  const file = path.join(editor.root, urlPath);
  const block = editor.model
    .held(urlPath)
    ?.find(({ lines }) => lines[0] - 1 <= line && line <= lines[1] - 1);

  if (!block) {
    return undefined;
  }

  if (readText(file) !== editor.textOf(urlPath)) {
    return "Unsaved: provenance follows the file as saved.";
  }

  const found = await provenance(
    editor.root,
    editor.model,
    editor.data,
    pageState(editor.root, file, editor.model),
    urlPath,
    urlPath,
    block.id,
  );

  if (!found) {
    return undefined;
  }

  const said = [
    `**${found.kind}**, lines ${found.lines[0]}-${found.lines[1]} of \`${found.source}\`${found.changed ? `, changed ${found.changed}` : ""}`,
  ];

  for (const { reference, files, query, error } of found.data) {
    said.push(
      `- \`${reference}\` reads ${files.map(({ path: at, changed }) => `\`${at}\` (changed ${changed})`).join(", ") || "nothing"}${error ? ` - ${error}` : ""}${query ? `\n\n  \`\`\`sql\n  ${query.replaceAll("\n", "\n  ")}\n  \`\`\`` : ""}`,
    );
  }

  for (const { figure, state, live, reason } of found.claims) {
    said.push(
      `- ${figure}: ${state}${live ? `, the data says ${live}` : ""}${reason ? ` - ${reason}` : ""}`,
    );
  }

  if (found.conventions.kind) {
    said.push(`- Kind \`${found.conventions.kind}\`, from \`${found.conventions.declaredIn}\``);
  }

  return said.join("\n");
}

export function headingAt(editor: Editor, urlPath: string, line: number): Spot | undefined {
  const content = (editor.textOf(urlPath) ?? "").split("\n")[line] ?? "";
  const heading = HEADING.exec(content);

  if (!heading) {
    return undefined;
  }

  const start = content.indexOf(heading[2], heading[1].length);
  return { path: urlPath, line, start, end: start + heading[2].length };
}

/** Anchors are numbered over the whole page, so a renamed heading can move another heading's anchor too. */
export async function renameHeading(
  editor: Editor,
  urlPath: string,
  line: number,
  name: string,
): Promise<Edit[] | undefined> {
  const spot = headingAt(editor, urlPath, line);
  const blocks = await editor.indexer.split(editor.textOf(urlPath) ?? "", "markdown");

  if (!spot || !blocks.some(({ lines, slug }) => lines[0] - 1 === line && slug)) {
    return undefined;
  }

  const anchors = (renamed?: string) => {
    const slugger = new GithubSlugger();
    return blocks.flatMap(({ headings = [] }) =>
      headings.map(
        ({ text, id, line: at }) =>
          id ?? slugger.slug(renamed !== undefined && at - 1 === line ? renamed : text),
      ),
    );
  };
  const before = anchors();
  const after = anchors(name);
  const moved = new Map(
    before.flatMap((anchor, index) => (anchor === after[index] ? [] : [[anchor, after[index]]])),
  );
  const edits: Edit[] = [{ ...spot, text: name }];

  for (const written of await writtenTo(editor, urlPath)) {
    const anchor = moved.get(written.target?.fragment ?? "");

    if (anchor !== undefined) {
      edits.push({ ...spotOf(written), text: written.written.replace(/#[^#]*$/, `#${anchor}`) });
    }
  }

  return edits;
}

/** A file's move, or a folder's as the move of everything under it, dot-folders and node_modules too. */
export function movesOf(root: string, from: string, to: string): Map<string, string> {
  const moves = new Map<string, string>();
  const walk = (at: string) => {
    const placed = `${to}${at.slice(from.length)}`;
    moves.set(at, placed);
    moves.set(`${at}/`, `${placed}/`);

    for (const dirent of entries(path.join(root, at))) {
      const inside = `${at}/${dirent.name}`;

      if (dirent.isDirectory()) {
        walk(inside);
      } else {
        moves.set(inside, `${to}${inside.slice(from.length)}`);
      }

      if (dirent.isSymbolicLink() && isFolder(path.join(root, inside))) {
        moves.set(`${inside}/`, `${to}${inside.slice(from.length)}/`);
      }
    }
  };

  if (isFolder(path.join(root, from))) {
    walk(from);
  } else {
    moves.set(from, to);
  }

  return moves;
}

/** The moves of renames made in turn, each naming its paths as the renames before it left them. */
export function movesInTurn(root: string, renames: [string, string][]): Map<string, string> {
  const moves = new Map<string, string>();

  for (const [from, to] of renames) {
    // What an earlier rename put at the path is not on disk there yet, so it moves on from its record.
    const placed = [...moves.values()].includes(from);

    for (const [was, now] of moves) {
      if (now === from || now.startsWith(`${from}/`)) {
        moves.set(was, `${to}${now.slice(from.length)}`);
      }
    }

    for (const [was, now] of placed ? [] : movesOf(root, from, to)) {
      if (!moves.has(was)) {
        moves.set(was, now);
      }
    }
  }

  return moves;
}

/**
 * Every address naming a moved file, and every address a moved document writes, is written again only
 * where it no longer leads where it led, keeping its form: relative, or from the served folder.
 */
export async function moveFiles(editor: Editor, moves: Map<string, string>): Promise<Edit[]> {
  // A path under a moved folder moves with it though the walk did not reach it, as under a symlinked folder.
  const moved = (at: string) => {
    let placed = moves.get(at);

    for (let end = at.lastIndexOf("/", at.length - 2); placed === undefined && end > 0; ) {
      placed = moves.get(at.slice(0, end + 1));
      placed &&= `${placed}${at.slice(end + 1)}`;
      end = at.lastIndexOf("/", end - 1);
    }

    return placed ?? at;
  };
  const reaching = new Map<string, Set<string>>();

  for (const from of moves.keys()) {
    for (const source of [...(await linking(editor, from)), from]) {
      reaching.set(source, (reaching.get(source) ?? new Set()).add(from));
    }
  }

  const edits: Edit[] = [];

  for (const written of [...reaching.keys()]
    .filter(rewritable)
    .flatMap((at) => writtenIn(editor, at))) {
    const { target, address } = written;
    const source = moved(written.path);

    // A document that stays is edited only where the folder model has it reach a moved path.
    if (
      !target ||
      address.startsWith("#") ||
      (source === written.path && !reaching.get(source)?.has(target.path))
    ) {
      continue;
    }

    const to = moved(target.path);
    const leads = written.link ? linkTarget(source, address) : referenceTarget(source, address);

    if (leads?.path !== to) {
      edits.push({ ...spotOf(written), text: readdressed(written, source, to) });
    }
  }

  return edits;
}

/**
 * Every address written in a file as the folder model reads it: links and pictures outside code, HTML, math and
 * frontmatter, embeds and figures outside code, includes anywhere.
 */
function writtenIn(editor: Editor, source: string): Written[] {
  const text = editor.textOf(source) ?? "";
  const { literal, links } = placesAt(editor, source, text);
  const found: Written[] = links.map((link) => ({
    path: source,
    ...link,
    target: linkTarget(source, link.address),
    link: true,
    bare: false,
  }));

  for (const [line, content] of text.split("\n").entries()) {
    for (const pattern of [INCLUDE, FIGURE, EMBED]) {
      for (const match of content.matchAll(pattern)) {
        const written = addressOf(match);
        const inside =
          pattern === INCLUDE ? undefined : literal(line, spanOf(match, written, line).start);

        if (inside === "inlineCode" || inside === "code") {
          continue;
        }

        found.push({
          path: source,
          ...spanOf(match, written, line),
          written,
          address: written,
          target: referenceTarget(source, written),
          link: false,
          bracketed: false,
          bare: pattern === FIGURE && match[3] !== undefined,
        });
      }
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

async function writtenTo(editor: Editor, urlPath: string): Promise<Written[]> {
  return [...new Set([urlPath, ...(await linking(editor, urlPath))])]
    .filter((source) => /\.(md|markdown)$/i.test(source))
    .flatMap((source) => writtenIn(editor, source))
    .filter(({ target }) => target?.path === urlPath);
}

async function linking(editor: Editor, urlPath: string): Promise<string[]> {
  const dependents = await impactOf(editor.model, editor.data).dependents(urlPath);
  return [...editor.model.linkedFrom(urlPath), ...dependents.map(({ source }) => source)];
}

function rewritable(urlPath: string): boolean {
  return /\.(md|markdown)$/i.test(urlPath) && !urlPath.split("/").some(isPruned);
}

function referenceTarget(source: string, written: string): Written["target"] {
  const hash = written.lastIndexOf("#");
  const address = hash < 0 ? written : written.slice(0, hash);

  if (!address) {
    return { path: source, fragment: written.slice(hash + 1) };
  }

  return {
    path: address.startsWith("/")
      ? path.posix.normalize(address.slice(1))
      : path.posix.join(path.posix.dirname(source), address),
    fragment: hash < 0 ? "" : written.slice(hash + 1),
  };
}

function spotOf({ path: at, line, start, end }: Written): Spot {
  return { path: at, line, start, end };
}

function readdressed(
  { written, link, bracketed, bare }: Written,
  source: string,
  target: string,
): string {
  const hash = written.indexOf("#");
  const fragment = hash < 0 ? "" : written.slice(hash);
  const query = link ? (/^[^?#]*(\?[^#]*)/.exec(written)?.[1] ?? "") : "";
  const address = written.startsWith("/")
    ? `/${target}`
    : path.posix.relative(path.posix.dirname(source), target) || ".";
  // A folder's address keeps its closing slash, which a relative path drops.
  const folder = target.endsWith("/") && !address.endsWith("/") ? "/" : "";
  const text = link
    ? linked(address + folder, `${query}${fragment}`, bracketed)
    : `${address}${folder}${fragment}`;

  return bare && /\s/.test(text) ? `"${text}"` : text;
}

/**
 * A path's own # and ? would read as a fragment and a query, a character reference as its character, and an
 * unbalanced parenthesis ends an address - one in the query or fragment kept as written included.
 */
function linked(address: string, kept: string, bracketed: boolean): string {
  const text = encodeURI(address)
    .replace(/[#?]/g, encodeURIComponent)
    .replace(/&(?=#?\w+;)/g, "%26");

  if (bracketed) {
    return `${text.replaceAll("%20", " ")}${kept}`;
  }

  const path = balanced(text) ? text : text.replaceAll("(", "%28").replaceAll(")", "%29");

  return balanced(path + kept)
    ? path + kept
    : path + kept.replace(/\\.|[()]/g, (found) => (found.length > 1 ? found : `\\${found}`));
}

function balanced(text: string): boolean {
  let depth = 0;

  for (let at = 0; at < text.length && depth >= 0; at++) {
    if (text[at] === "\\") {
      at++;
    } else {
      depth += text[at] === "(" ? 1 : text[at] === ")" ? -1 : 0;
    }
  }

  return depth === 0;
}

/** The model serves the markdown text it indexed; any other, such as an unsaved buffer, is parsed here. */
function placesAt(
  editor: Editor,
  urlPath: string,
  text: string,
): { literal: (line: number, column: number) => string | undefined; links: Placed[] } {
  const held = /\.(md|markdown)$/i.test(urlPath) ? editor.model.heldFor(urlPath, text) : undefined;
  const { literals, addresses } = held
    ? {
        literals: held.flatMap(({ literals: found = [] }) => found),
        addresses: held.flatMap(({ addresses: found = [] }) => found),
      }
    : placesOf(text);
  const starts = lineStarts(text);

  return {
    literal: (line, column) =>
      literals.find(
        ({ start, end }) => start <= starts[line] + column && starts[line] + column < end,
      )?.type,
    links: linksOf(text, addresses),
  };
}

function linksOf(text: string, addresses: NonNullable<Block["addresses"]>): Placed[] {
  const starts = lineStarts(text);

  return addresses
    .map(({ start, end, url }) => {
      const bracketed = text[start] === "<";
      const [from, to] = bracketed ? [start + 1, end - 1] : [start, end];
      let [line, high] = [0, starts.length];

      while (line + 1 < high) {
        const middle = (line + high) >> 1;
        [line, high] = starts[middle] <= from ? [middle, high] : [line, middle];
      }

      return {
        line,
        start: from - starts[line],
        end: to - starts[line],
        written: text.slice(from, to),
        address: url,
        bracketed,
      };
    })
    .sort((a, b) => a.line - b.line || a.start - b.start);
}

function lineStarts(text: string): number[] {
  return [0, ...[...text.matchAll(/\n/g)].map((found) => found.index + 1)];
}

function addressOf(match: RegExpMatchArray): string {
  return match.slice(1).find((group) => group !== undefined) as string;
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFolder(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function brokenLink(
  editor: Editor,
  urlPath: string,
  url: string,
  own: Block[],
): string | undefined {
  const target = linkTarget(urlPath, url);

  if (!target || target.path === ".." || target.path.startsWith("../")) {
    return undefined;
  }

  const there =
    target.path === urlPath ||
    editor.model.hashOf(target.path) !== undefined ||
    (fs.existsSync(path.join(editor.root, target.path)) &&
      confine(editor.root, target.path) !== undefined);

  if (!there) {
    return `Links to ${target.path}, which is not there`;
  }

  const { fragment } = target;

  if (!fragment || !/\.(md|markdown)$/i.test(target.path)) {
    return undefined;
  }

  const blocks = target.path === urlPath ? own : (editor.model.held(target.path) ?? []);

  if (fragment.startsWith("^")) {
    return blocks.some(({ id }) => id === fragment.slice(1))
      ? undefined
      : `Links to a block no longer in ${target.path}: #${fragment}`;
  }

  const anchors = target.path === urlPath ? anchorsIn(own) : anchorsOf(editor.model, target.path);
  return anchors.has(fragment) || anchors.has(fragment.replace(/^user-content-/, ""))
    ? undefined
    : `Links to a heading not in ${target.path}: #${fragment}`;
}

function brokenInclude(
  editor: Editor,
  urlPath: string,
  written: string,
  own: Block[],
): string | undefined {
  const hash = written.indexOf("#");
  const address = hash < 0 ? written : written.slice(0, hash);
  const relative = address.startsWith("/")
    ? address.slice(1)
    : path.posix.join(path.posix.dirname(urlPath), address);
  const file = path.join(editor.root, relative);

  if (!isInside(editor.root, file) || !confine(editor.root, relative)) {
    return `Includes ${written}, which is not there`;
  }

  if (hash < 0) {
    return undefined;
  }

  const fragment = written.slice(hash + 1);
  const blocks = relative === urlPath ? own : (editor.model.held(relative) ?? []);
  const found = fragment.startsWith("^")
    ? blocks.some(({ id }) => id === fragment.slice(1))
    : blocks.some(({ slug }) => slug === fragment.replace(/^user-content-/, ""));

  return found ? undefined : `Includes ${written}, which is not there`;
}

function target(editor: Editor, urlPath: string, reference: string): Spot | undefined {
  const include = linkTarget(urlPath, reference);

  if (!include || include.path.startsWith("../")) {
    return undefined;
  }

  const blocks = editor.model.held(include.path) ?? [];
  const block = include.fragment.startsWith("^")
    ? blocks.find(({ id }) => id === include.fragment.slice(1))
    : blocks.find(({ slug }) => slug && slug === include.fragment.replace(/^user-content-/, ""));

  return fs.existsSync(path.join(editor.root, include.path))
    ? { path: include.path, line: block ? block.lines[0] - 1 : 0, start: 0, end: 0 }
    : undefined;
}

function dataSpot(editor: Editor, urlPath: string, reference: string): Spot | undefined {
  if (reference.startsWith("#")) {
    const name = reference.slice(1).split("#")[0];
    const lines = (editor.textOf(urlPath) ?? "").split("\n");
    const line = lines.findIndex((content) => QUERY.exec(content)?.[1] === name);
    return line < 0 ? undefined : { path: urlPath, line, start: 0, end: 0 };
  }

  const address = reference.split("#")[0];
  const relative = address.startsWith("/")
    ? address.slice(1)
    : path.posix.join(path.posix.dirname(urlPath), address);

  return confine(editor.root, relative) ? { path: relative, line: 0, start: 0, end: 0 } : undefined;
}

function spanOf(match: RegExpMatchArray, inner: string, line: number): Omit<Spot, "path"> {
  const start = (match.index ?? 0) + match[0].indexOf(inner);
  return { line, start, end: start + inner.length };
}

function locate(lines: string[], block: Block, figure: string): Omit<Spot, "path"> {
  for (let line = block.lines[0] - 1; line < block.lines[1]; line++) {
    const start = lines[line]?.indexOf(figure) ?? -1;

    if (start >= 0) {
      return { line, start, end: start + figure.length };
    }
  }

  return { line: block.lines[0] - 1, start: 0, end: lines[block.lines[0] - 1]?.length ?? 0 };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
