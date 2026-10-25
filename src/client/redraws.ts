/** The redraw event of folio's output contract: after every redraw, which blocks appeared, changed and went. */

export interface Redraw {
  page: string;
  cause: "load" | "update";
  added: Element[];
  changed: Element[];
  removed: Element[];
}

export function blocksIn(article: Element): Element[] {
  return [...article.querySelectorAll("[data-folio-id]")];
}

/** Announce a redraw on the document; on an update, a block redrawn under the same identity is changed. */
export function announce(
  page: string,
  cause: Redraw["cause"],
  before: Element[],
  after: Element[],
  renamed: Element[] = [],
): void {
  const staying = new Set(after);
  const gone = before.filter((block) => !staying.has(block));
  const kept = new Set(before);
  const added: Element[] = [];
  const changed: Element[] = [];

  for (const block of after.filter((block) => !kept.has(block))) {
    const old = cause === "update" ? gone.findIndex((other) => sameBlock(other, block)) : -1;

    if (old >= 0) {
      gone.splice(old, 1);
      changed.push(block);
    } else {
      added.push(block);
    }
  }

  // A block kept in place whose identity changed is reported under its new identity.
  for (const block of renamed) {
    if (kept.has(block) && staying.has(block) && !changed.includes(block)) {
      changed.push(block);
    }
  }

  if (cause === "update" && added.length + changed.length + gone.length === 0) {
    return;
  }

  const detail: Redraw = { page, cause, added, changed, removed: gone };
  document.dispatchEvent(new CustomEvent("folio:redraw", { detail }));
}

/** Tell whether two block elements stand for the same block: the same id in the same file. */
export function sameBlock(a: Node, b: Node): boolean {
  return (
    a instanceof Element &&
    b instanceof Element &&
    a.getAttribute("data-folio-id") === b.getAttribute("data-folio-id") &&
    a.getAttribute("data-folio-source") === b.getAttribute("data-folio-source")
  );
}
