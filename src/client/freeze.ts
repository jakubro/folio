/** A page frozen into one HTML file: its text, diagrams, charts, data and styles, with tables that still sort. */

import type { Theme } from "./render.ts";
import type { TableViews } from "./tableviews.ts";

export async function freeze(
  article: HTMLElement,
  urlPath: string,
  tables: TableViews | undefined,
  theme: Theme,
  name = urlPath.split("/").pop() || "folder",
): Promise<void> {
  const [style, script] = await Promise.all([asset("page.css"), asset("snapshot.js")]);
  const views = tables?.views(article) ?? {};

  // Copied as written, then given its views again, so the snapshot's tables can go back to that order.
  tables?.restore(article, urlPath, {});
  const copy = article.cloneNode(true) as HTMLElement;
  tables?.restore(article, urlPath, views);

  for (const control of copy.querySelectorAll(".fold-toggle, .mermaid-expand")) {
    control.remove();
  }

  // A link folio marked as pointing at something changed goes back to how its author wrote it.
  for (const link of copy.querySelectorAll<HTMLElement>(".link-changed, .link-gone")) {
    link.classList.remove("link-changed", "link-gone");
    link.title = link.dataset.folioTitle ?? "";
    link.removeAttribute("data-folio-title");

    if (!link.title) {
      link.removeAttribute("title");
    }

    if (!link.classList.length) {
      link.removeAttribute("class");
    }
  }

  for (const fold of copy.querySelectorAll(".fold")) {
    fold.replaceWith(...fold.childNodes);
  }

  // A picture's sources load in place of its own image, which is inlined like any other.
  for (const source of copy.querySelectorAll("picture > source")) {
    source.remove();
  }

  await Promise.all([
    ...[...copy.querySelectorAll("img")].map(inline),
    ...[...copy.querySelectorAll<SVGImageElement>("svg image")].map(inlineSvgImage),
  ]);

  for (const element of copy.querySelectorAll<HTMLElement>("*")) {
    unlinked(element);
  }

  for (const sheet of copy.querySelectorAll("style")) {
    sheet.textContent = offline(sheet.textContent ?? "");
  }

  const html = `<!doctype html>
<html lang="en" data-theme="${theme}" class="frozen">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>${offline(style)}</style>
</head>
<body>
<main>${copy.outerHTML}</main>
<script type="application/json" id="folio-views">${JSON.stringify(views).replaceAll("<", "\\u003c")}</script>
<script>${script.replaceAll("</script", "<\\/script")}</script>
</body>
</html>
`;
  const link = document.createElement("a");

  link.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  link.download = `${name.replace(/\.[^.]+$/, "")}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function asset(name: string): Promise<string> {
  const response = await fetch(`/?asset=${name}`);

  if (!response.ok) {
    throw new Error(`Cannot freeze the page: ${name} did not load.`);
  }

  return response.text();
}

/**
 * Only an image of the folder travels inside the file, and only when its bytes are an image's; any other
 * picture becomes its description, so the snapshot neither carries another file nor makes a request.
 */
async function inline(image: HTMLImageElement): Promise<void> {
  image.removeAttribute("srcset");
  const data = await imageData(image.getAttribute("src") ?? "");

  if (data) {
    image.src = data;
  } else {
    const described = document.createElement("span");
    described.className = "frozen-image";
    described.textContent = image.alt ? `[${image.alt}]` : "[image]";
    image.replaceWith(described);
  }
}

/** A chart's image mark; one that cannot travel is left out of the drawing. */
async function inlineSvgImage(image: SVGImageElement): Promise<void> {
  const data = await imageData(
    image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "",
  );

  image.removeAttribute("xlink:href");

  if (data) {
    image.setAttribute("href", data);
  } else {
    image.remove();
  }
}

async function imageData(source: string): Promise<string | undefined> {
  const address = new URL(source, location.href);

  if (address.protocol === "data:" && /^data:image\//i.test(source)) {
    return source;
  }

  if (address.origin !== location.origin) {
    return undefined;
  }

  try {
    const response = await fetch(address);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.ok ? imageType(bytes) : undefined;

    return type && `data:${type};base64,${base64(bytes)}`;
  } catch {
    return undefined;
  }
}

/** What the bytes are, whatever the response claimed: a text file served as an image is not one. */
function imageType(bytes: Uint8Array): string | undefined {
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF?\s*/, "");

  if (bytes[0] === 0x89 && text(1, 4) === "PNG") {
    return "image/png";
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (text(0, 4) === "GIF8") {
    return "image/gif";
  }

  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
    return "image/webp";
  }

  if (text(4, 8) === "ftyp" && /^avi[fs]$/.test(text(8, 12))) {
    return "image/avif";
  }

  if (text(0, 2) === "BM") {
    return "image/bmp";
  }

  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return "image/x-icon";
  }

  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)
    ? "image/svg+xml"
    : undefined;
}

function base64(bytes: Uint8Array): string {
  let binary = "";

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return btoa(binary);
}

/**
 * An address in an element's own style or in an attribute such as an SVG paint is dropped; a reference
 * to a part of the page, or inline data, stays.
 */
function unlinked(element: Element): void {
  for (const { name, value } of [...element.attributes]) {
    if (name === "style") {
      const style = (element as HTMLElement).style;
      const kept = [...style]
        .filter((property) => !remote(style.getPropertyValue(property)))
        .map((property) => `${property}: ${style.getPropertyValue(property)}`);

      element.setAttribute("style", kept.join("; "));
    } else if (
      remote(value) ||
      (/^(xlink:)?href$/.test(name) && element.localName === "use" && !value.startsWith("#"))
    ) {
      element.removeAttribute(name);
    }
  }
}

function remote(value: string): boolean {
  return /url\(\s*(?!["']?(#|data:))/i.test(value);
}

/**
 * Font sources the bundle emptied, and any address but inline data or a part of the page, would each
 * make a request.
 */
function offline(css: string): string {
  return css
    .replace(/,?\s*url\(\s*(?!["']?(#|data:))[^)]*\)(\s*format\([^)]*\))?/gi, "")
    .replace(/src:\s*;/g, "")
    .replace(/@import[^;]*;/gi, "");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
