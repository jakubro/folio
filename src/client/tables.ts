// Tables written loosely still render in full: rows wider than the header widen the table, and
// consecutive lines starting or ending with a pipe form a table, headed when a divider line follows the first.

import type { Nodes, Paragraph, Root, RootContent, Table } from "mdast";
import { defaultHandlers } from "remark-rehype";
import type { Processor, Transformer } from "unified";

const HEADERLESS = new WeakSet<Table>();
const EDGE_PIPE = /^\||(?<!\\)(?:\\\\)*\|$/;
const DIVIDER = /^(?=.*\|)\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
// GFM keeps body cells beyond the header's count, so one header cell fits any row.
const PLACEHOLDER_HEADER = "| |\n|-|\n";

/** Turn runs of pipe lines into headerless tables, and widen every table to its widest row. */
export function tables(this: Processor): Transformer<Root> {
  return (tree, file) => {
    const source = String(file.value);
    const definitions = collect(tree, ["definition", "footnoteDefinition"])
      .map((node) => source.slice(node.position?.start.offset, node.position?.end.offset))
      .join("\n\n");
    const parse = (text: string) =>
      (this.parse(`${text}\n\n${definitions}`) as Root).children.filter(
        (node) => node.type !== "definition" && node.type !== "footnoteDefinition",
      );

    convert(tree, 0, source, parse);

    for (const table of collect(tree, ["table"]) as Table[]) {
      const width = Math.max(...table.children.map((row) => row.children.length));
      const align = table.align ?? [];
      table.align = [...align, ...Array(Math.max(0, width - align.length)).fill(null)];
    }
  };
}

/** Render a table as usual, without its placeholder header row when it was written without one. */
export const table: typeof defaultHandlers.table = (state, node) => {
  const element = defaultHandlers.table(state, node);

  if (HEADERLESS.has(node)) {
    const sections = element.children.filter((child) => child.type === "element");
    element.children = state.wrap(
      sections.filter((section) => section.tagName !== "thead"),
      true,
    );
  }

  return element;
};

function convert(
  parent: Nodes,
  quoteDepth: number,
  source: string,
  parse: (text: string) => RootContent[],
): void {
  if (!("children" in parent)) {
    return;
  }

  const depth = quoteDepth + (parent.type === "blockquote" ? 1 : 0);
  parent.children = (parent.children as RootContent[]).flatMap((child) => {
    if (child.type === "paragraph") {
      return split(child, depth, source, parse);
    }
    convert(child, depth, source, parse);

    return [child];
  }) as typeof parent.children;
}

function split(
  paragraph: Paragraph,
  quoteDepth: number,
  source: string,
  parse: (text: string) => RootContent[],
): RootContent[] {
  let offset = paragraph.position?.start.offset ?? 0;
  const segments: { table: boolean; start: number; lines: string[] }[] = [];
  for (const [index, raw] of source
    .slice(offset, paragraph.position?.end.offset)
    .split("\n")
    .entries()) {
    const line = strip(raw, index === 0 ? 0 : quoteDepth);
    const piped = EDGE_PIPE.test(line.trimEnd()) || DIVIDER.test(line.trimEnd());
    const last = segments.at(-1);

    if (last && last.table === piped) {
      last.lines.push(line);
    } else {
      segments.push({ table: piped, start: offset, lines: [line] });
    }
    offset += raw.length + 1;
  }

  const merged: typeof segments = [];
  for (const segment of segments) {
    const table = segment.table && segment.lines.length > 1;
    const last = merged.at(-1);

    if (last && !last.table && !table) {
      last.lines.push(...segment.lines);
    } else {
      merged.push({ ...segment, table });
    }
  }

  const cuts = merged.slice(1).map((segment) => segment.start);
  const spansCut = paragraph.children.some(
    (child) =>
      child.type !== "text" &&
      cuts.some(
        (cut) =>
          (child.position?.start.offset ?? 0) < cut && cut < (child.position?.end.offset ?? 0),
      ),
  );

  if (!merged.some((segment) => segment.table) || spansCut) {
    return [paragraph];
  }

  const dividers = merged.map((segment) =>
    segment.table && DIVIDER.test(segment.lines[1].trimEnd()) ? segment.lines[1].trim() : undefined,
  );
  const blocks = parse(
    merged
      .map((segment, index) =>
        segment.table
          ? PLACEHOLDER_HEADER + segment.lines.toSpliced(1, dividers[index] ? 1 : 0).join("\n")
          : segment.lines.join("\n"),
      )
      .join("\n\n"),
  );
  const expected = merged.map((segment) => (segment.table ? "table" : "paragraph"));

  // A continuation line lifted out of its paragraph can parse as another block, e.g. `2. x` as a list.
  if (blocks.map((block) => block.type).join() !== expected.join()) {
    return [paragraph];
  }

  for (const [index, block] of blocks.entries()) {
    const divider = dividers[index];

    if (block.type === "table" && divider) {
      block.children.shift();
      block.align = alignments(divider);
    } else if (block.type === "table") {
      HEADERLESS.add(block);
    }
  }

  return blocks;
}

function alignments(divider: string): Table["align"] {
  return divider
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => {
      const [left, right] = [cell.trim().startsWith(":"), cell.trim().endsWith(":")];

      return left && right ? "center" : left ? "left" : right ? "right" : null;
    });
}

function strip(line: string, quoteDepth: number): string {
  let content = line;
  for (let level = 0; level < quoteDepth; level++) {
    content = content.replace(/^\s*>/, "");
  }

  return content.trimStart();
}

function collect(tree: Nodes, types: string[]): Nodes[] {
  const found = types.includes(tree.type) ? [tree] : [];

  return "children" in tree
    ? [...found, ...tree.children.flatMap((child) => collect(child, types))]
    : found;
}
