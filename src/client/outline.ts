/** The outline beside every page: its headings, with the section being read highlighted. */

export class Outline {
  readonly element = document.createElement("aside");
  readonly header = document.createElement("div");
  readonly footer = document.createElement("div");
  #headings: HTMLElement[] = [];
  #links: HTMLAnchorElement[] = [];
  #scheduled = false;

  constructor() {
    this.element.className = "outline";
    this.element.setAttribute("aria-label", "Outline");
    window.addEventListener("scroll", () => this.#schedule(), { passive: true });
    window.addEventListener("resize", () => this.#schedule());
    new ResizeObserver(() => this.#schedule()).observe(document.body);
  }

  build(article: HTMLElement): void {
    this.#headings = [
      ...article.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]"),
    ].filter((heading) => !folded(heading));
    this.#links = this.#headings.map((heading) => {
      const link = document.createElement("a");
      link.href = `#${encodeURIComponent(heading.id)}`;
      link.textContent = ownText(heading);
      link.className = `outline-${heading.tagName.toLowerCase()}`;
      return link;
    });

    if (this.#links.length === 0) {
      const empty = document.createElement("p");
      empty.className = "panel-empty";
      empty.textContent = "No headings";
      this.element.replaceChildren(this.header, empty, this.footer);
    } else {
      this.element.replaceChildren(this.header, ...this.#links, this.footer);
    }

    this.#highlight();
  }

  #schedule(): void {
    if (!this.#scheduled) {
      this.#scheduled = true;
      requestAnimationFrame(() => {
        this.#scheduled = false;
        this.#highlight();
      });
    }
  }

  /**
   * The current section is the last shown heading scrolled past the toolbar; at the very bottom of
   * the page it is the last shown heading, which may never reach the top.
   */
  #highlight(): void {
    const line = (document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0) + 16;
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    const shown = [...this.#headings.entries()].filter(([, heading]) => heading.checkVisibility());
    let current = (atBottom ? shown.at(-1) : shown[0])?.[0] ?? -1;

    if (!atBottom) {
      for (const [index, heading] of shown) {
        if (heading.getBoundingClientRect().top > line) {
          break;
        }

        current = index;
      }
    }

    for (const [index, link] of this.#links.entries()) {
      link.classList.toggle("current", index === current);
    }

    this.#reveal(this.#links[current]);
  }

  /** Scrolls only the outline itself; scrollIntoView would also scroll the page being read. */
  #reveal(link: HTMLAnchorElement | undefined): void {
    if (!link) {
      return;
    }

    const top = link.offsetTop - this.element.offsetTop;
    const bottom = top + link.offsetHeight;

    if (top < this.element.scrollTop) {
      this.element.scrollTop = top;
    } else if (bottom > this.element.scrollTop + this.element.clientHeight) {
      this.element.scrollTop = bottom - this.element.clientHeight;
    }
  }
}

/** A block's title stays in view while it is closed, so only a heading in its content is folded away. */
function folded(heading: Element): boolean {
  for (
    let details = heading.closest("details");
    details;
    details = details.parentElement?.closest("details") ?? null
  ) {
    if (!details.querySelector(":scope > summary")?.contains(heading)) {
      return true;
    }
  }

  return false;
}

/** A tied figure the data contradicts shows the data's value beside it; the heading's text is what was typed. */
function ownText(heading: HTMLElement): string {
  const copy = heading.cloneNode(true) as HTMLElement;

  for (const live of copy.querySelectorAll(".claim-live")) {
    live.remove();
  }

  return copy.textContent ?? "";
}
