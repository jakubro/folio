// Renders markdown: frontmatter, GFM, sanitized inline HTML, math, highlighted code and mermaid
// diagrams, with heading anchors for the outline and deep links.

import mermaid from "mermaid";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { frontmatter } from "./frontmatter.ts";
import { table, tables } from "./tables.ts";
import { expandable } from "./zoom.ts";

export type Theme = "light" | "dark";

const EXTRA_TAGS = [
  "details",
  "summary",
  "kbd",
  "mark",
  "sub",
  "sup",
  "abbr",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "section",
  "article",
  "aside",
  "time",
  "wbr",
  "bdi",
  "bdo",
  "caption",
  "colgroup",
  "col",
];
const base = defaultSchema.attributes ?? {};
const SCHEMA = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), ...EXTRA_TAGS])],
  attributes: {
    ...base,
    "*": [...(base["*"] ?? []), "className", "style"],
    a: [...(base.a ?? []), "target", "rel"],
    td: [...(base.td ?? []), "colSpan", "rowSpan", "align"],
    th: [...(base.th ?? []), "colSpan", "rowSpan", "align"],
    details: [...(base.details ?? []), "open"],
    time: [...(base.time ?? []), "dateTime"],
  },
};
// Slugs are added after sanitizing, which would otherwise prefix them, so anchors match GitHub's.
const PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkMath)
  .use(tables)
  .use(remarkRehype, {
    allowDangerousHtml: true,
    handlers: { table, yaml: (_, node: { value: string }) => frontmatter(node.value) },
  })
  .use(rehypeRaw)
  .use(rehypeSanitize, SCHEMA)
  .use(rehypeSlug)
  .use(rehypeKatex)
  .use(rehypeHighlight, { plainText: ["mermaid"] })
  .use(rehypeStringify);

const DIAGRAM_FONT =
  '"Arimo", "KaTeX_Main", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const DIAGRAM_THEMES = {
  light: {
    theme: "default",
    themeVariables: { fontFamily: DIAGRAM_FONT },
  },
  dark: {
    theme: "dark",
    themeVariables: {
      fontFamily: DIAGRAM_FONT,
      primaryColor: "#2d2d30",
      primaryTextColor: "#cccccc",
      primaryBorderColor: "#3c3c3c",
      lineColor: "#808080",
      secondaryColor: "#212122",
      tertiaryColor: "#1a1a1a",
      background: "#1a1a1a",
      mainBkg: "#2d2d30",
      nodeBorder: "#3c3c3c",
      clusterBkg: "#212122",
      clusterBorder: "#3c3c3c",
      titleColor: "#cccccc",
      edgeLabelBackground: "#212122",
      nodeTextColor: "#cccccc",
    },
  },
} as const;

let diagrams = 0;

/** Render a markdown or mermaid file's text into a detached element, ready to swap into the page. */
export async function render(
  text: string,
  kind: "markdown" | "mermaid",
  theme: Theme,
  owner: Document = document,
): Promise<HTMLElement> {
  const element = owner.createElement("article");
  element.className = "markdown-body";
  element.dataset.theme = theme;

  if (kind === "markdown") {
    element.innerHTML = String(PROCESSOR.processSync(text));
  } else {
    const fence = element
      .appendChild(owner.createElement("pre"))
      .appendChild(owner.createElement("code"));
    fence.className = "language-mermaid";
    fence.textContent = text;
  }

  for (const link of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (new URL(link.getAttribute("href") ?? "", location.href).origin !== location.origin) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }

  for (const heading of element.querySelectorAll(":is(h1, h2, h3, h4, h5, h6)[id]")) {
    const mark = owner.createElement("a");
    mark.className = "heading-link";
    mark.href = `#${encodeURIComponent(heading.id)}`;
    mark.setAttribute("aria-label", `Link to ${heading.textContent}`);
    heading.append(mark);
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    ...DIAGRAM_THEMES[theme],
  });

  for (const fence of element.querySelectorAll("pre > code.language-mermaid")) {
    const figure = owner.createElement("div");
    const source = fence.textContent ?? "";
    figure.className = "mermaid";

    try {
      // Mermaid sizes each box from its measured text, so the face must be loaded before it measures.
      await Promise.all(
        ["16px", "bold 16px"].map((font) => document.fonts.load(`${font} Arimo`, source)),
      );
      ({ svg: figure.innerHTML } = await mermaid.render(`diagram-${++diagrams}`, source));
      fence.parentElement?.replaceWith(figure);
      expandable(figure);
    } catch (error) {
      fence.parentElement?.classList.add("diagram-failed");
      fence.parentElement?.setAttribute("title", (error as Error).message);
    }
  }

  return element;
}
