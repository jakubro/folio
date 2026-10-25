/**
 * What is new to the reader on a page: a bar beside each block added or changed since they read it,
 * a tick where a block they read was removed, and the earlier text on demand.
 */

import type { Upstream } from "../server/impact.ts";
import type { LinkMark, Mark, Removed } from "../server/reads.ts";
import { drawDiff } from "./diff.ts";

export interface Marked {
  marks: Mark[];
  removed: Removed[];
  links: LinkMark[];
  upstream: Upstream[];
  version: string;
}

const GUTTER_PX = 34;
const CLEAR_MS = 600;
const LABELS = {
  new: "New since you last read this page",
  changed: "Changed since you read it - show what it said",
  removed: "Removed since you read it - show what it said",
};

export class Marks {
  readonly #layer = document.createElement("div");
  readonly #panel = document.createElement("div");
  readonly #upstream = document.createElement("p");
  #article: HTMLElement | undefined;
  #marked: Marked | undefined;
  #placed: { element: HTMLElement; target: () => DOMRect | undefined }[] = [];
  #open: { source: string; id: string } | undefined;
  #panelUnder: HTMLElement | undefined;
  #scheduled = false;

  /** The note on what changed upstream sits beside the page, so its coming and going moves no text. */
  constructor(main: HTMLElement, beside: HTMLElement) {
    this.#layer.className = "read-marks";
    this.#panel.className = "mark-panel";
    this.#panel.hidden = true;
    this.#upstream.className = "upstream-note";
    this.#upstream.hidden = true;
    beside.append(this.#upstream);
    main.append(this.#layer, this.#panel);
    new ResizeObserver(() => this.#schedule()).observe(document.body);
    addEventListener("resize", () => this.#schedule());
    addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.#panel.hidden) {
        this.#close();
      }
    });
  }

  get version(): string | null {
    return this.#marked?.version ?? null;
  }

  show(article: HTMLElement, marked: Marked | undefined): void {
    this.#article = article;
    this.#marked = marked;

    if (this.#open && !this.#find(this.#open.source, this.#open.id)) {
      this.#close();
    }

    this.#draw();
  }

  removedTicks(): HTMLElement[] {
    return [...this.#layer.querySelectorAll<HTMLElement>(".mark-removed")];
  }

  /** Tell whether a block's earlier text is open, so it is not counted as read meanwhile. */
  holding(block: HTMLElement): boolean {
    return (
      this.#open?.source === block.dataset.folioSource && this.#open?.id === block.dataset.folioId
    );
  }

  /** Where in a changed block, as fractions of its lines, its text differs from the text read. */
  changedSpan(block: HTMLElement): [number, number] | undefined {
    const mark = this.#marked?.marks.find(
      (found) =>
        found.mark === "changed" &&
        found.source === block.dataset.folioSource &&
        found.id === block.dataset.folioId,
    );

    if (mark?.before === undefined || mark.after === undefined) {
      return undefined;
    }

    return changedShare(mark.before, mark.after);
  }

  cleared(read: { source: string; id: string }[]): void {
    if (!this.#marked) {
      return;
    }

    const gone = (item: { source: string; id: string }) =>
      read.some(({ source, id }) => source === item.source && id === item.id);

    this.#marked = {
      ...this.#marked,
      marks: this.#marked.marks.filter((mark) => !gone(mark)),
      removed: this.#marked.removed.filter((removed) => !gone(removed)),
    };

    for (const element of this.#layer.children) {
      const { folioSource: source = "", folioId: id = "" } = (element as HTMLElement).dataset;

      if (gone({ source, id })) {
        element.classList.add("clearing");
        setTimeout(() => element.remove(), CLEAR_MS);
      }
    }
  }

  #draw(): void {
    const article = this.#article;
    const marked = this.#marked;
    this.#layer.replaceChildren();
    this.#placed = [];
    this.#showUpstream(marked?.upstream ?? []);

    for (const link of document.querySelectorAll<HTMLElement>(".link-changed, .link-gone")) {
      link.classList.remove("link-changed", "link-gone");
      link.title = link.dataset.folioTitle ?? "";
      delete link.dataset.folioTitle;
    }

    if (!article || !marked) {
      return;
    }

    for (const { source, id, url, state } of marked.links) {
      for (const block of this.#find(source, id)) {
        for (const link of block.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          if (sameAddress(link.getAttribute("href") ?? "", url)) {
            link.dataset.folioTitle ??= link.title;
            link.classList.add(`link-${state}`);
            link.title =
              state === "gone"
                ? "What this link points at is gone since you read it"
                : "What this link points at changed since you read it";
          }
        }
      }
    }

    for (const { source, id, mark, before, after, data } of marked.marks) {
      for (const block of this.#find(source, id)) {
        const bar = this.#bar(mark, source, id);

        if (mark === "changed") {
          bar.addEventListener("click", () =>
            this.#toggle(source, id, block, "What it said when you read it", () => {
              const shown = document.createDocumentFragment();

              if (before !== undefined) {
                shown.append(drawDiff(before, after ?? ""));
              }

              if (data) {
                shown.append(
                  Object.assign(document.createElement("span"), {
                    className: "mark-data",
                    textContent: `${before === undefined ? "" : "\n\n"}Its data changed since you read it: ${data.join(", ")}`,
                  }),
                );
              }

              return shown;
            }),
          );
        }

        this.#placed.push({ element: bar, target: () => rectOf(block) });
      }
    }

    for (const { source, id, text, after, before } of marked.removed) {
      const next = before ? this.#find(source, before)[0] : undefined;
      const previous = after ? this.#find(source, after).at(-1) : undefined;
      const tick = this.#bar("removed", source, id);
      const target = () => {
        const above = previous && rectOf(previous);
        const below = next && rectOf(next);
        const top = above ? above.bottom + 2 : below ? below.top - 6 : article.offsetTop;
        return new DOMRect(0, top, 0, 4);
      };

      tick.dataset.folioVersion = "removed";
      tick.addEventListener("click", () =>
        this.#toggle(source, id, tick, "Removed since you read it", () =>
          Object.assign(document.createElement("del"), { textContent: text }),
        ),
      );
      this.#placed.push({ element: tick, target });
    }

    this.#layer.append(...this.#placed.map(({ element }) => element));
    this.#place();
  }

  #showUpstream(upstream: Upstream[]): void {
    this.#upstream.hidden = upstream.length === 0;
    this.#upstream.replaceChildren();

    if (upstream.length === 0) {
      return;
    }

    this.#upstream.append("Changed since you last read this page: ");

    for (const [index, { path, how, at }] of upstream.entries()) {
      const link = Object.assign(document.createElement("a"), {
        href: `/${path.split("/").map(encodeURIComponent).join("/")}`,
        textContent: path,
        title: new Date(at).toLocaleString(),
      });
      this.#upstream.append(
        index > 0 ? "; " : "",
        link,
        ` (${how === "includes" ? "included" : "embedded data"}, ${new Date(at).toLocaleString()})`,
      );
    }
  }

  #bar(mark: keyof typeof LABELS, source: string, id: string): HTMLElement {
    const bar = document.createElement(mark === "new" ? "span" : "button");

    bar.className = `read-mark mark-${mark}`;
    bar.title = LABELS[mark];
    bar.setAttribute("aria-label", LABELS[mark]);
    bar.dataset.folioSource = source;
    bar.dataset.folioId = id;

    if (bar instanceof HTMLButtonElement) {
      bar.type = "button";
    }

    return bar;
  }

  #toggle(source: string, id: string, under: HTMLElement, title: string, body: () => Node): void {
    if (this.#open?.source === source && this.#open.id === id) {
      this.#close();
      return;
    }

    const heading = Object.assign(document.createElement("p"), {
      className: "mark-panel-title",
      textContent: title,
    });
    const close = Object.assign(document.createElement("button"), {
      className: "mark-panel-close",
      type: "button",
      textContent: "Close",
    });
    const text = Object.assign(document.createElement("pre"), { className: "mark-panel-text" });

    close.addEventListener("click", () => this.#close());
    text.append(body());
    this.#panel.replaceChildren(heading, close, text);
    this.#panel.hidden = false;
    this.#open = { source, id };
    this.#panelUnder = under;
    this.#place();
  }

  #close(): void {
    this.#open = undefined;
    this.#panelUnder = undefined;
    this.#panel.hidden = true;
  }

  #find(source: string, id: string): HTMLElement[] {
    return [
      ...(this.#article?.querySelectorAll<HTMLElement>(
        `[data-folio-source="${CSS.escape(source)}"][data-folio-id="${CSS.escape(id)}"]`,
      ) ?? []),
    ];
  }

  #schedule(): void {
    if (!this.#scheduled) {
      this.#scheduled = true;
      requestAnimationFrame(() => {
        this.#scheduled = false;
        this.#place();
      });
    }
  }

  /** Placed against the document, as the block link is, so no block element is touched. */
  #place(): void {
    const left = (this.#article?.getBoundingClientRect().left ?? 0) + scrollX - GUTTER_PX;

    for (const { element, target } of this.#placed) {
      const rect = target();
      element.hidden = !rect;

      if (rect) {
        element.style.top = `${rect.top + scrollY}px`;
        element.style.height = `${rect.height}px`;
        element.style.left = `${left}px`;
      }
    }

    const under = this.#panelUnder && rectOf(this.#panelUnder);
    const article = this.#article?.getBoundingClientRect();

    if (under && article && !this.#panel.hidden) {
      this.#panel.style.top = `${under.bottom + scrollY + 4}px`;
      this.#panel.style.left = `${article.left + scrollX}px`;
      this.#panel.style.width = `${article.width}px`;
    }
  }
}

function rectOf(element: Element): DOMRect | undefined {
  return element.getClientRects().length > 0 ? element.getBoundingClientRect() : undefined;
}

/** The page writes an address as the sanitizer leaves it, which may escape what the source wrote. */
function sameAddress(drawn: string, written: string): boolean {
  try {
    return drawn === written || decodeURI(drawn) === decodeURI(written);
  } catch {
    return false;
  }
}

/**
 * Where a text differs from the text it replaced, as fractions of its lines: from the first line that
 * differs to the last; undefined when every line is the same.
 */
export function changedShare(read: string, now: string): [number, number] | undefined {
  const before = read.split("\n");
  const after = now.split("\n");
  let first = 0;
  let last = 0;

  while (first < Math.min(before.length, after.length) && before[first] === after[first]) {
    first++;
  }

  while (
    last < Math.min(before.length, after.length) - first &&
    before.at(-1 - last) === after.at(-1 - last)
  ) {
    last++;
  }

  if (first === after.length && first === before.length) {
    return undefined;
  }

  // Lines removed from the end leave no line of the text now differing: its last line stands for them.
  const start = Math.min(first, after.length - 1);
  return [start / after.length, Math.max(start + 1, after.length - last) / after.length];
}
