/**
 * Per-tab preferences: theme, full width and side panels. A tab keeps its own; a tab opened from a
 * link takes the opening tab's; any other new tab starts from the last choice made in any tab.
 */

import type { Theme } from "./render.ts";

export type Panel = "tree" | "outline";

interface Prefs {
  theme: Theme;
  fullWidth: boolean;
  tree: boolean;
  outline: boolean;
  data?: boolean;
}

const TAB = "folio.prefs";
const LAST = "folio.lastPrefs";
const HANDOFF = "folio.handoff";
/** Long enough to pick "Open link in new tab" from a context menu. */
const HANDOFF_MS = 10_000;

let prefs = load();

export function theme(): Theme {
  return prefs.theme;
}

export function fullWidth(): boolean {
  return prefs.fullWidth;
}

export function panelShown(panel: Panel): boolean {
  return prefs[panel];
}

export function dataShown(): boolean {
  return prefs.data === true;
}

export function setDataShown(shown: boolean): void {
  save({ ...prefs, data: shown });
}

export function setTheme(value: Theme): void {
  save({ ...prefs, theme: value });
}

export function setFullWidth(value: boolean): void {
  save({ ...prefs, fullWidth: value });
}

export function setPanelShown(panel: Panel, shown: boolean): void {
  save({ ...prefs, [panel]: shown });
}

export function applyPrefs(): void {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.classList.toggle("full-width", prefs.fullWidth);
  root.classList.toggle("no-tree", !prefs.tree);
  root.classList.toggle("no-outline", !prefs.outline);
}

/**
 * Every way of opening a link in another tab starts with one of these events; none relies on the
 * browser copying tab state into the new tab.
 */
export function handOffOnLinks(): void {
  for (const type of ["click", "auxclick", "contextmenu"]) {
    document.addEventListener(type, (event) => {
      const link = (event.target as Element | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      const url = link && new URL(link.href, location.href);
      const sameTab =
        event.type === "click" &&
        !(event as MouseEvent).ctrlKey &&
        !(event as MouseEvent).metaKey &&
        !(event as MouseEvent).shiftKey;

      if (sameTab) {
        return;
      }

      if (url && url.origin === location.origin) {
        const handoff = { path: url.pathname, prefs, time: Date.now() };
        localStorage.setItem(HANDOFF, JSON.stringify(handoff));
      }
    });
  }
}

function save(next: Prefs): void {
  prefs = next;
  sessionStorage.setItem(TAB, JSON.stringify(prefs));
  localStorage.setItem(LAST, JSON.stringify(prefs));
  applyPrefs();
}

function load(): Prefs {
  const own = parse(sessionStorage.getItem(TAB));

  if (own) {
    return own;
  }

  const handoff = parse<{ path: string; prefs: Prefs; time: number }>(
    localStorage.getItem(HANDOFF),
  );
  const handedOff =
    handoff?.path === location.pathname && Date.now() - handoff.time < HANDOFF_MS
      ? handoff.prefs
      : undefined;

  if (handedOff) {
    localStorage.removeItem(HANDOFF);
  }

  const initial = handedOff ??
    parse<Prefs>(localStorage.getItem(LAST)) ?? {
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      fullWidth: false,
      tree: true,
      outline: true,
    };

  sessionStorage.setItem(TAB, JSON.stringify(initial));
  return initial;
}

function parse<T = Prefs>(text: string | null): T | undefined {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
