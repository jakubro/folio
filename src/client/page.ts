// The page: lays out toolbar, tree, content and outline, then renders the file or folder this address names.

import { foldable, reveal } from "./folds.ts";
import { button, ICONS } from "./icons.ts";
import { type Change, Live, type Subscription } from "./live.ts";
import { Outline } from "./outline.ts";
import { fetchPage, type Kind, kindOf, Prerender } from "./pages.ts";
import {
  fullWidth,
  handOffOnLinks,
  type Panel,
  panelShown,
  setFullWidth,
  setPanelShown,
  setTheme,
  theme,
} from "./prefs.ts";
import { render } from "./render.ts";
import { type Entry, fetchListing, href, iconFor, Tree } from "./tree.ts";
import { closeExpanded } from "./zoom.ts";

type Step = "previous" | "next";

interface Destination {
  pathname: string;
  kind: Kind;
  text: string;
  version: string | null;
  entries: Entry[];
  article?: HTMLElement;
}

let urlPath = decodeURIComponent(location.pathname).slice(1);
let kind = kindOf(urlPath) ?? "markdown";
let folderPath = urlPath.replace(/\/$/, "");
const rootName = document.documentElement.dataset.root ?? "";
const SAVE_SCROLL_MS = 200;
const SCROLL_KEYS = new Set([" ", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
const STEP_KEYS: Record<string, Step> = { ArrowLeft: "previous", ArrowRight: "next" };
const PANEL_KEYS: Record<string, Panel> = { ArrowLeft: "tree", ArrowRight: "outline" };

const bar = document.createElement("header");
const layout = document.createElement("div");
const main = document.createElement("main");
const tree = new Tree(urlPath);
const outline = new Outline();
let article = document.createElement("article");
let text = "";
let version: string | null = null;
let entries: Entry[] = [];
let images = new Map<string, string | null>();
const live = new Live(subscription, (change) => changed(change).catch(() => live.retry()));
const prerender = new Prerender(theme);
let saving: ReturnType<typeof setTimeout> | undefined;
// A position the page was too short to reach when restored; reapplied as each image loads.
let restoring: number | undefined;
let navigation = 0;
let stepping = Promise.resolve();
// The browser scrolls the block a click last landed in with the arrow keys, so they stay its own.
let scroller: Element | undefined;

// The browser restores a position before the content has rendered, so folio keeps its own.
history.scrollRestoration = "manual";

bar.className = "bar";
layout.className = "layout";
article.className = "markdown-body";
main.append(article);
layout.append(tree.element, main, outline.element);
document.body.prepend(bar, layout);

const toggles = {
  tree: button(ICONS.tree, "Show or hide the file tree"),
  outline: button(ICONS.outline, "Show or hide the outline"),
  width: button(ICONS.width, "Full width"),
  theme: button(ICONS.sun, "Switch theme"),
  live: button(ICONS.live, "Suspend live updates in this tab"),
};
const steps: Record<Step, HTMLButtonElement> = {
  previous: button(ICONS.left, "Previous page (←)"),
  next: button(ICONS.right, "Next page (→)"),
};
const spacer = document.createElement("div");
spacer.className = "spacer";
let crumbs = breadcrumbs();
bar.append(
  toggles.tree,
  steps.previous,
  steps.next,
  crumbs,
  spacer,
  toggles.live,
  toggles.outline,
  toggles.width,
  toggles.theme,
);

for (const panel of ["tree", "outline"] as Panel[]) {
  toggles[panel].addEventListener("click", () => togglePanel(panel));
}

toggles.width.addEventListener("click", () => {
  setFullWidth(!fullWidth());
  showPrefs();
});

toggles.theme.addEventListener("click", () => {
  setTheme(theme() === "dark" ? "light" : "dark");
  showPrefs();
  void draw();
});

toggles.live.addEventListener("click", () => {
  if (live.suspended) {
    live.start();
  } else {
    live.stop();
  }

  showLive();
});

for (const direction of ["previous", "next"] as Step[]) {
  steps[direction].disabled = true;
  steps[direction].addEventListener("click", () => queueStep(direction));
}

handOffOnLinks();
showPrefs();
showTitle();
tree.onChange = () => void live.resubscribe();
void tree.load();
await load();
await draw();
land();
void showSteps();
addEventListener("scroll", rememberScroll, { passive: true });
addEventListener("pagehide", saveScroll);

for (const type of ["load", "error"]) {
  document.addEventListener(type, () => restoring !== undefined && restore(), true);
}

for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) {
  addEventListener(
    type,
    (event) => {
      if (type !== "keydown" || SCROLL_KEYS.has((event as KeyboardEvent).key)) {
        restoring = undefined;
      }
    },
    { passive: true },
  );
}
addEventListener("pointerdown", (event) => {
  scroller = sidewaysScroller(event.target as Element);
});
addEventListener("keydown", (event) => {
  const direction = STEP_KEYS[event.key];
  const panel = PANEL_KEYS[event.key];
  const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  const altOnly = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

  // Alt+arrows are the browser's back and forward, taken over so they never leave the page.
  if (panel && altOnly && !event.defaultPrevented) {
    event.preventDefault();

    if (!event.repeat) {
      togglePanel(panel);
    }
  } else if (direction && !modified && !event.defaultPrevented && !scroller?.isConnected) {
    event.preventDefault();
    queueStep(direction);
  }
});
addEventListener("popstate", returned);
document.addEventListener("click", follow);
live.start();
showLive();

function togglePanel(panel: Panel): void {
  setPanelShown(panel, !panelShown(panel));
  showPrefs();
}

function showPrefs(): void {
  toggles.theme.innerHTML = theme() === "dark" ? ICONS.sun : ICONS.moon;
  toggles.tree.setAttribute("aria-pressed", String(panelShown("tree")));
  toggles.outline.setAttribute("aria-pressed", String(panelShown("outline")));
  toggles.width.setAttribute("aria-pressed", String(fullWidth()));
}

function showLive(): void {
  toggles.live.innerHTML = live.suspended ? ICONS.pause : ICONS.live;
  toggles.live.title = live.suspended
    ? "Resume live updates in this tab"
    : "Suspend live updates in this tab";
  toggles.live.setAttribute("aria-pressed", String(live.suspended));
  document.documentElement.classList.toggle("suspended", live.suspended);
}

// False when the tab moved to another page while loading, so what arrived belongs to no page shown.
async function load(): Promise<boolean> {
  const shown = urlPath;

  if (kind === "folder") {
    const listing = await fetchListing(folderPath);

    if (shown !== urlPath) {
      return false;
    }

    entries = listing?.entries ?? [];
    version = listing?.version ?? null;
    return true;
  }

  const response = await fetch(`${href(urlPath)}?raw`);
  const body = await response.text();

  if (shown !== urlPath) {
    return false;
  }

  const missing = response.status === 404;
  document.documentElement.classList.toggle("missing", missing);
  text = missing ? text : body;
  version = response.headers.get("X-Folio-Version");
  return true;
}

// Renders off-page, then swaps in place: the scroll position, tree and outline state all survive.
async function draw(): Promise<void> {
  const shown = urlPath;
  const next = kind === "folder" ? listingArticle() : await render(text, kind, theme());
  const y = scrollY;

  if (shown === urlPath) {
    await swap(next, () => scrollTo(0, y));
  }
}

async function swap(next: HTMLElement, position: () => void): Promise<void> {
  article.replaceWith(next);
  article = next;
  foldable(article, urlPath);
  position();
  outline.build(article);
  const versions = await imageVersions(article, images);

  if (article === next) {
    images = versions;
    showImages();
    void live.resubscribe();
  }
}

// Plain clicks to another page or folder, or on a heading's own mark, are folio's; the rest stay the browser's.
function follow(event: MouseEvent): void {
  const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  const url = link && new URL(link.href);
  const plain =
    event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;

  if (
    !url ||
    !plain ||
    event.defaultPrevented ||
    link.target ||
    link.hasAttribute("download") ||
    url.origin !== location.origin ||
    url.search
  ) {
    return;
  }

  if (link.classList.contains("heading-link")) {
    event.preventDefault();
    history.replaceState(history.state, "", url.hash);
    link.parentElement?.scrollIntoView();
    return;
  }

  if (url.pathname === location.pathname && url.hash) {
    clearTimeout(saving);
    saveScroll();
    return;
  }

  event.preventDefault();
  void go(url, url.href === location.href ? "replace" : "push");
}

function returned(): void {
  clearTimeout(saving);

  if (decodeURIComponent(location.pathname).slice(1) === urlPath) {
    navigation++;
    land();
  } else {
    void go(new URL(location.href), "pop");
  }
}

// The old content stays until the new is ready; what folio cannot show in place loads as a new page.
async function go(url: URL, mode: "push" | "replace" | "pop"): Promise<void> {
  const token = ++navigation;
  const next = await destination(url).catch(() => undefined);

  if (token !== navigation) {
    return;
  }

  if (!next) {
    location[mode === "push" ? "assign" : "replace"](url.href);
    return;
  }

  clearTimeout(saving);

  if (mode !== "pop") {
    saveScroll();
    history[mode === "push" ? "pushState" : "replaceState"](null, "", next.pathname + url.hash);
  }

  urlPath = decodeURIComponent(next.pathname).slice(1);
  kind = next.kind;
  folderPath = urlPath.replace(/\/$/, "");
  text = next.text;
  version = next.version;
  entries = next.entries;
  document.documentElement.classList.remove("missing");
  prerender.clear();
  closeExpanded();
  showTitle();
  const trail = breadcrumbs();
  crumbs.replaceWith(trail);
  crumbs = trail;
  void tree.show(urlPath);
  void showSteps();
  await swap(next.article ?? listingArticle(), land);

  if (next.article && next.article.dataset.theme !== theme()) {
    void draw();
  }

  if (live.suspended) {
    live.start();
    showLive();
  }
}

async function destination(url: URL): Promise<Destination | undefined> {
  const target = decodeURIComponent(url.pathname).slice(1);
  const known = kindOf(target);

  if (known === "markdown" || known === "mermaid") {
    const content = await fetchPage(url.pathname);
    return (
      content && {
        pathname: url.pathname,
        kind: known,
        ...content,
        entries: [],
        article: await prerender.take(url.pathname, content, known),
      }
    );
  }

  const folder = target.replace(/\/$/, "");
  const listing = await fetchListing(folder);
  return (
    listing && {
      pathname: href(folder, true),
      kind: "folder",
      text: "",
      version: listing.version,
      entries: listing.entries,
    }
  );
}

async function changed(change: Change): Promise<void> {
  if (change.kind === "folder") {
    void showSteps();
    await tree.refresh(change.path);
  }

  if (change.kind === "image") {
    images.set(change.path, change.version);

    showImages();
  }

  const own =
    kind === "folder"
      ? change.kind === "folder" && change.path === folderPath
      : change.kind === "page" && change.path === urlPath;

  if (own && (await load())) {
    await draw();
  }
}

// Each step starts from the page the one before it reached, so repeated presses keep moving.
function queueStep(direction: Step): void {
  const work = async () => {
    const target = (await neighbours())?.[direction];

    if (target) {
      await go(new URL(href(target), location.href), "push");
    }
  };
  stepping = stepping.then(work, work);
}

async function showSteps(): Promise<void> {
  const shown = urlPath;
  const around = await neighbours().catch(() => undefined);

  if (shown === urlPath) {
    steps.previous.disabled = !around?.previous;
    steps.next.disabled = !around?.next;
  }
}

async function neighbours(): Promise<Record<Step, string | null> | undefined> {
  if (kind === "folder") {
    return undefined;
  }

  const response = await fetch(`${href(urlPath)}?step`);
  return response.ok ? response.json() : undefined;
}

function sidewaysScroller(target: Element): Element | undefined {
  if (!article.contains(target)) {
    return undefined;
  }

  for (
    let element: Element | null = target;
    element && element !== article;
    element = element.parentElement
  ) {
    if (
      /auto|scroll/.test(getComputedStyle(element).overflowX) &&
      element.scrollWidth > element.clientWidth
    ) {
      return element;
    }
  }

  return undefined;
}

function subscription(): Subscription {
  const folders: Record<string, string | null> = tree.folders();

  if (kind === "folder") {
    folders[folderPath] = version;
  }

  return {
    page: kind === "folder" ? {} : { [urlPath]: version },
    images: Object.fromEntries(images),
    folders,
  };
}

// An image's version is its ETag; each local image is asked once, then kept current by changes.
async function imageVersions(
  element: HTMLElement,
  known: Map<string, string | null>,
): Promise<Map<string, string | null>> {
  const paths = [...element.querySelectorAll("img")]
    .map((image) => localPath(image.src))
    .filter((p) => p !== undefined);
  const versions = new Map<string, string | null>();

  for (const imagePath of new Set(paths)) {
    if (known.has(imagePath)) {
      versions.set(imagePath, known.get(imagePath) ?? null);
    } else {
      const response = await fetch(href(imagePath), { method: "HEAD" });
      versions.set(imagePath, response.headers.get("ETag")?.replaceAll('"', "") ?? null);
    }
  }

  return versions;
}

// A version in every local image's address: a re-render then never falls back to an earlier copy.
function showImages(): void {
  for (const image of article.querySelectorAll("img")) {
    const imagePath = localPath(image.src);
    const imageVersion = imagePath === undefined ? null : images.get(imagePath);

    if (imagePath !== undefined && imageVersion) {
      image.src = `${href(imagePath)}?v=${imageVersion}`;
    }
  }
}

function localPath(src: string): string | undefined {
  const url = new URL(src, location.href);
  return url.origin === location.origin ? decodeURIComponent(url.pathname).slice(1) : undefined;
}

function listingArticle(): HTMLElement {
  const element = document.createElement("article");
  const heading = document.createElement("h1");
  const list = document.createElement("ul");

  element.className = "markdown-body listing";
  heading.textContent = folderPath.split("/").pop() || rootName;
  list.append(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const entryPath = folderPath ? `${folderPath}/${entry.name}` : entry.name;
      link.href = href(entryPath, entry.kind === "folder");
      link.innerHTML = iconFor(entry.kind);
      link.append(document.createTextNode(entry.kind === "folder" ? `${entry.name}/` : entry.name));
      item.append(link);
      return item;
    }),
  );
  element.append(
    heading,
    entries.length
      ? list
      : Object.assign(document.createElement("p"), { textContent: "Nothing to show." }),
  );
  return element;
}

function showTitle(): void {
  document.title =
    (kind === "folder" ? folderPath.split("/").pop() || rootName : urlPath.split("/").pop()) ??
    "folio";
}

function breadcrumbs(): HTMLElement {
  const nav = document.createElement("nav");
  const parts = urlPath.split("/").filter(Boolean);

  nav.className = "breadcrumbs";
  nav.setAttribute("aria-label", "Breadcrumbs");

  for (const [index, name] of [rootName, ...parts].entries()) {
    const last = index === parts.length;
    const crumb = document.createElement(last ? "span" : "a");

    if (index > 0) {
      nav.append(
        Object.assign(document.createElement("span"), { className: "separator", textContent: "/" }),
      );
    }

    crumb.textContent = name;

    if (!last) {
      (crumb as HTMLAnchorElement).href = href(parts.slice(0, index).join("/"), true);
    }

    nav.append(crumb);
  }

  return nav;
}

function land(): void {
  const saved = (history.state as { scroll?: number } | null)?.scroll;
  const id = decodeURIComponent(location.hash.slice(1));
  const heading =
    id && (document.getElementById(id) ?? document.getElementById(`user-content-${id}`));

  restoring = saved;

  if (saved !== undefined) {
    restore();
  } else if (heading) {
    reveal(heading);
    heading.scrollIntoView();
  } else {
    scrollTo(0, 0);
  }
}

function restore(): void {
  scrollTo(0, restoring ?? scrollY);
  const loading = [...article.querySelectorAll("img")].some((image) => !image.complete);

  if (restoring !== undefined && (scrollY >= restoring - 1 || !loading)) {
    restoring = undefined;
  }
}

function rememberScroll(): void {
  clearTimeout(saving);
  saving = setTimeout(saveScroll, SAVE_SCROLL_MS);
}

// Held while restoring, and while back or forward has moved the address ahead of the page shown.
function saveScroll(): void {
  if (restoring !== undefined || decodeURIComponent(location.pathname).slice(1) !== urlPath) {
    return;
  }

  history.replaceState({ ...history.state, scroll: scrollY }, "");
}
