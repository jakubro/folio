/**
 * Pages a link leads to: what kind each address shows, its text, and a rendering prepared while the
 * pointer rests on the link, so following it swaps the content without waiting for the render.
 */

import type { Backlink, PageBlock } from "../server/model.ts";
import type { PageLayout } from "../server/versions.ts";
import type { Marked } from "./marks.ts";
import { render, type Theme } from "./render.ts";

export type Kind = "folder" | "markdown" | "mermaid" | "data";

export interface LinksState {
  links: Backlink[];
  version: string;
}

export interface Content {
  text: string;
  version: string | null;
  blocks: PageBlock[];
  layout: PageLayout;
  links?: LinksState;
  read?: Marked;
}

interface Prepared {
  theme: Theme;
  page: Promise<{ version: string | null; article: HTMLElement } | undefined>;
}

/** Long enough to skip links the pointer only crosses on its way elsewhere. */
const HOVER_MS = 65;
/**
 * Nothing in this document loads: a page rendered before its address takes over fetches its images
 * only once it joins the page, so relative paths resolve against the new address.
 */
const DETACHED = document.implementation.createHTMLDocument("");

/** Tell what an address shows from its form alone, without asking the server. */
export function kindOf(urlPath: string): Kind | undefined {
  if (urlPath === "" || urlPath.endsWith("/")) {
    return "folder";
  }

  if (/\.(mermaid|mmd)$/i.test(urlPath)) {
    return "mermaid";
  }

  if (/\.(csv|tsv|jsonl|ndjson|parquet|json|ya?ml|sqlite3?|db|duckdb|sql)$/i.test(urlPath)) {
    return "data";
  }

  return /\.(md|markdown)$/i.test(urlPath) ? "markdown" : undefined;
}

export async function fetchPage(pathname: string): Promise<Content | undefined> {
  const response = await fetch(`${pathname}?page`);
  return response.ok ? response.json() : undefined;
}

export class Prerender {
  readonly #theme: () => Theme;
  readonly #prepared = new Map<string, Prepared>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(theme: () => Theme) {
    this.#theme = theme;
    document.addEventListener("pointerover", (event) => {
      const link = pageLink(event.target);
      clearTimeout(this.#timer);

      if (link) {
        this.#timer = setTimeout(() => this.#prepare(link), HOVER_MS);
      }
    });
    document.addEventListener("pointerdown", (event) => {
      const link = pageLink(event.target);

      if (link) {
        this.#prepare(link);
      }
    });
  }

  async take(
    pathname: string,
    content: Content,
    kind: "markdown" | "mermaid",
  ): Promise<HTMLElement> {
    const prepared = this.#prepared.get(pathname);
    const ready = prepared?.theme === this.#theme() ? await prepared.page : undefined;
    this.#prepared.delete(pathname);

    return ready?.version === content.version
      ? ready.article
      : render(content.text, content, kind, this.#theme(), DETACHED);
  }

  clear(): void {
    clearTimeout(this.#timer);
    this.#prepared.clear();
  }

  #prepare(link: HTMLAnchorElement): void {
    const { pathname } = new URL(link.href);
    const kind = kindOf(decodeURIComponent(pathname).slice(1));
    const theme = this.#theme();

    if (
      kind === undefined ||
      kind === "folder" ||
      kind === "data" ||
      this.#prepared.get(pathname)?.theme === theme
    ) {
      return;
    }

    const page = fetchPage(pathname)
      .then(async (content) =>
        content
          ? {
              version: content.version,
              article: await render(content.text, content, kind, theme, DETACHED),
            }
          : undefined,
      )
      .catch(() => undefined);
    this.#prepared.set(pathname, { theme, page });
  }
}

function pageLink(target: EventTarget | null): HTMLAnchorElement | undefined {
  const link = (target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;

  const url = link && new URL(link.href);

  return url && !link.target && url.origin === location.origin && url.pathname !== location.pathname
    ? link
    : undefined;
}
