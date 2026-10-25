/** Views folio builds itself, each named by a query on an address rather than by a file. */

import type { Need, NeedsState } from "../server/needs.ts";
import type { StaleState } from "../server/stale.ts";
import type { ChangedDocument } from "../server/versions.ts";
import type { Theme } from "./render.ts";
import { href } from "./tree.ts";

export type ViewName = "catch-up" | "history" | "digest" | "health" | "needs" | "stale";

export interface Changes {
  documents: ChangedDocument[];
  version: string;
}

export interface ViewPage {
  title: string;
  version: string | null;
  article: () => HTMLElement | Promise<HTMLElement>;
}

const NAMES: ViewName[] = ["catch-up", "history", "digest", "health", "stale"];

/** Whether agents are told what the reader reads and looks at, and the switch the page wires up. */
export const sharing = { paused: false, toggle: (_paused: boolean) => {} };
const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** The view an address names; the served folder's own address, with no query, is what needs you. */
export function viewOf(search: string, pathname: string): ViewName | undefined {
  const query = new URLSearchParams(search);
  return (
    NAMES.find((name) => query.has(name)) ?? (pathname === "/" && !search ? "needs" : undefined)
  );
}

export async function fetchChanges(): Promise<Changes | undefined> {
  const response = await fetch("/?changed");
  return response.ok ? response.json() : undefined;
}

export async function loadView(
  name: ViewName,
  urlPath: string,
  search: string,
  theme: Theme,
): Promise<ViewPage | undefined> {
  if (name === "history") {
    const { historyPage } = await import("./history.ts");
    const article = await historyPage(urlPath, new URLSearchParams(search), theme);
    return (
      article && {
        title: article.querySelector("h1")?.textContent ?? urlPath,
        version: null,
        article: () => article,
      }
    );
  }

  if (name === "digest") {
    const { digestPage } = await import("./digest.ts");
    const article = await digestPage(new URLSearchParams(search));
    return { title: "Digest", version: null, article: () => article };
  }

  if (name === "health") {
    const { healthPage } = await import("./health.ts");
    const page = await healthPage();
    return page && { title: "Health", version: page.version, article: () => page.article };
  }

  if (name === "stale") {
    const response = await fetch("/?stale-data");
    const state: StaleState | undefined = response.ok ? await response.json() : undefined;
    return (
      state && {
        title: "Outlived documents",
        version: state.version,
        article: () => staleArticle(state),
      }
    );
  }

  if (name === "needs") {
    const response = await fetch("/?needs-data");
    const state: NeedsState | undefined = response.ok ? await response.json() : undefined;
    return (
      state && {
        title: "What needs you",
        version: state.version,
        article: () => needsArticle(state),
      }
    );
  }

  if (name === "catch-up") {
    const changes = await fetchChanges();
    return (
      changes && {
        title: "Catch up",
        version: changes.version,
        article: () => catchUp(changes),
      }
    );
  }

  return undefined;
}

function ago(at: string, now = Date.now()): string {
  const elapsed = new Date(at).getTime() - now;
  const [unit, size] = UNITS.find(([, ms]) => Math.abs(elapsed) >= ms) ?? ["second", 1000];
  return RELATIVE.format(Math.round(elapsed / size), unit);
}

function catchUp({ documents }: Changes): HTMLElement {
  const element = viewArticle("Catch up");
  const digests = Object.assign(document.createElement("p"), { className: "history-of" });

  digests.append(
    "Digest of ",
    Object.assign(document.createElement("a"), { href: "/?digest", textContent: "today" }),
    ", ",
    Object.assign(document.createElement("a"), {
      href: "/?digest&period=week",
      textContent: "this week",
    }),
    " or any period",
  );
  element.append(digests);
  const list = document.createElement("ul");

  list.className = "catch-up";
  list.append(
    ...documents.map(({ path, blocks, at }) => {
      const item = document.createElement("li");
      const link = Object.assign(document.createElement("a"), {
        href: href(path),
        textContent: path,
      });
      const time = Object.assign(document.createElement("time"), {
        dateTime: at,
        textContent: ago(at),
        title: new Date(at).toLocaleString(),
      });
      const detail = document.createElement("span");

      detail.className = "catch-up-detail";
      detail.append(`${blocks} ${blocks === 1 ? "block" : "blocks"} changed, `, time);

      item.append(link, detail);
      return item;
    }),
  );
  element.append(
    documents.length > 0
      ? list
      : Object.assign(document.createElement("p"), {
          textContent: "Nothing you have read has changed since.",
        }),
  );
  return element;
}

const SOURCES: Record<Need["source"], string> = {
  error: "Errors",
  problem: "Problems in documents you read",
  attention: "Needing attention",
  changed: "Changed since you read it",
};

function needsArticle({ ready, needs }: NeedsState): HTMLElement {
  const element = viewArticle("What needs you");
  const files = Object.assign(document.createElement("p"), { className: "history-of" });

  files.append(
    Object.assign(document.createElement("a"), {
      href: "/?files",
      className: "needs-files",
      textContent: "Every file of the folder",
    }),
    " \u00b7 ",
    Object.assign(document.createElement("a"), {
      href: "/?stale",
      className: "needs-stale",
      textContent: "Documents that may have outlived their use",
    }),
  );
  element.append(files, sharingSwitch());

  if (!ready) {
    element.append(
      Object.assign(document.createElement("p"), {
        textContent: "folio is still reading the folder.",
      }),
    );
    return element;
  }

  for (const source of Object.keys(SOURCES) as Need["source"][]) {
    const found = needs.filter((need) => need.source === source);

    if (found.length === 0) {
      continue;
    }

    const list = document.createElement("ul");
    list.className = `needs needs-${source}`;
    list.append(
      ...found.map(({ path, line, what, at }) => {
        const item = document.createElement("li");
        const link = Object.assign(document.createElement("a"), {
          href: href(path),
          textContent: line ? `${path}:${line}` : path,
        });

        item.append(link, " ", what);

        if (at) {
          item.append(
            " ",
            Object.assign(document.createElement("time"), {
              dateTime: at,
              textContent: ago(at),
              title: new Date(at).toLocaleString(),
            }),
          );
        }

        return item;
      }),
    );
    element.append(
      Object.assign(document.createElement("h2"), { textContent: SOURCES[source] }),
      list,
    );
  }

  if (needs.length === 0) {
    element.append(
      Object.assign(document.createElement("p"), { textContent: "Nothing needs you." }),
    );
  }

  return element;
}

function staleArticle({ ready, documents }: StaleState): HTMLElement {
  const element = viewArticle("Outlived documents");

  element.append(
    Object.assign(document.createElement("p"), {
      className: "history-of",
      textContent: ready
        ? "Documents that have probably outlived their use. folio only lists them: archive or remove them by hand."
        : "folio is still reading the folder.",
    }),
  );

  if (!ready) {
    return element;
  }

  const list = document.createElement("ul");
  list.className = "stale";
  list.append(
    ...documents.map(({ path, changed, why }) => {
      const item = document.createElement("li");
      item.append(
        Object.assign(document.createElement("a"), { href: href(path), textContent: path }),
        ` - ${why}, changed `,
        Object.assign(document.createElement("time"), {
          dateTime: changed,
          textContent: ago(changed),
          title: new Date(changed).toLocaleString(),
        }),
      );
      return item;
    }),
  );
  element.append(
    documents.length > 0
      ? list
      : Object.assign(document.createElement("p"), { textContent: "None." }),
  );
  return element;
}

function sharingSwitch(): HTMLElement {
  const line = Object.assign(document.createElement("p"), { className: "sharing" });
  const toggle = Object.assign(document.createElement("button"), {
    type: "button",
    className: "sharing-toggle",
    textContent: sharing.paused ? "Resume sharing" : "Pause sharing",
  });

  toggle.setAttribute("aria-pressed", String(sharing.paused));
  toggle.addEventListener("click", () => sharing.toggle(!sharing.paused));
  line.append(
    sharing.paused
      ? "Sharing with agents is paused: they are told so, not what you read or look at. "
      : "Agents can read what you read, what is new to you, what needs you and what you look at. ",
    toggle,
  );
  return line;
}

function viewArticle(title: string): HTMLElement {
  const element = document.createElement("article");
  element.className = "markdown-body view";
  element.append(Object.assign(document.createElement("h1"), { textContent: title }));
  return element;
}
