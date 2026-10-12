// A page's YAML frontmatter as a key/value table above its body, or as the YAML itself when unreadable.

import type { Element } from "hast";
import { isMap, isScalar, type Node, parseDocument } from "yaml";

/** Turn a frontmatter block into a key/value table, a YAML code block, or nothing when it is empty. */
export function frontmatter(yaml: string): Element | undefined {
  if (!yaml.trim()) {
    return undefined;
  }

  // The failsafe schema keeps every scalar as the text it was written as: 1.10 stays 1.10, ~ stays ~.
  const document = parseDocument(yaml, { schema: "failsafe" });
  const map = document.contents;

  if (document.errors.length > 0 || !isMap(map)) {
    return code(yaml);
  }

  const rows = map.items.map(({ key, value }) =>
    element("tr", [
      element("th", [{ type: "text", value: scalarText(yaml, key) }]),
      isScalar(value) || value === null
        ? element("td", [{ type: "text", value: scalarText(yaml, value) }])
        : element("td", [code(asWritten(yaml, value as Node))]),
    ]),
  );

  return element("table", [element("tbody", rows)], ["frontmatter"]);
}

function scalarText(yaml: string, node: unknown): string {
  if (node === null) {
    return "";
  }

  return isScalar(node) ? String(node.value ?? "") : asWritten(yaml, node as Node);
}

function asWritten(yaml: string, node: Node): string {
  const [start, end] = node.range ?? [0, 0];
  const lineStart = yaml.lastIndexOf("\n", start - 1) + 1;
  const onOwnLine = !yaml.slice(lineStart, start).trim();
  const lines = yaml
    .slice(onOwnLine ? lineStart : start, end)
    .replace(/\s+$/, "")
    .split("\n");
  const indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
  );

  return lines.map((line) => line.slice(indent)).join("\n");
}

function code(text: string): Element {
  return element("pre", [element("code", [{ type: "text", value: text }], ["language-yaml"])]);
}

function element(tagName: string, children: Element["children"], className?: string[]): Element {
  return { type: "element", tagName, properties: className ? { className } : {}, children };
}
