/** Headless Chromium run of folio's documented behaviour: opening pages, scroll positions, back and forward. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  base,
  context,
  frameOf,
  keepFrame,
  landed,
  mark,
  marked,
  open,
  root,
  settled,
  waitText,
  write,
} from "./harness.ts";

test("Open and Tree reveal: a page opens at its top, the tree showing its file within its own panel", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  const tree = await page.$eval(".tree", (panel) => {
    const box = panel.getBoundingClientRect();
    const row = (panel.querySelector(".current") as Element).getBoundingClientRect();
    return { scrolled: panel.scrollTop, inside: row.top >= box.top && row.bottom <= box.bottom };
  });

  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.ok(tree.scrolled > 0, "the tree did not scroll to its current file");
  assert.ok(tree.inside, "the current file is outside the tree panel");
  await page.close();
});

test("Heading: an address naming a heading opens with it just below the toolbar", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md#part-3");
  const gap = await page.evaluate(
    () =>
      (document.getElementById("part-3") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );

  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);
  await page.close();
});

test("Address, Link, Same page, Plain anchor: GitHub's user-content form lands on its heading", async () => {
  const parts = Array.from(
    { length: 5 },
    (_, k) =>
      `## Part ${k + 1}\n\n${Array.from({ length: 40 }, (_, n) => `Paragraph ${n + 1}.`).join("\n\n")}`,
  ).join("\n\n");
  write({
    "github/page.md": `# Page\n\n[Same](#user-content-part-3), [Other](other.md#user-content-part-3)\n\n${parts}`,
    "github/other.md": `# Other\n\n${parts}`,
  });
  const landings: [string, boolean][] = [];
  const below = async (page: Page, how: string) => {
    const gap = await page.evaluate(
      () =>
        (document.getElementById("part-3") as Element).getBoundingClientRect().top -
        (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
    );
    landings.push([how, gap >= 0 && gap <= 16]);
  };

  const page = await settled("github/page.md#user-content-part-3");
  await below(page, "address");

  await page.goto(`${base}/github/page.md#part-3`);
  await landed(page);
  await below(page, "plain anchor");

  await page.goto(`${base}/github/page.md`);
  await landed(page);
  await page.click(".markdown-body a:text-is('Same')");
  await page.waitForTimeout(500);
  await below(page, "same page");

  await page.evaluate(() => scrollTo(0, 0));
  await page.click(".markdown-body a:text-is('Other')");
  await page.waitForURL(`${base}/github/other.md#user-content-part-3`);
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Other",
  );
  await page.waitForTimeout(500);
  await below(page, "link");

  assert.deepEqual(landings, [
    ["address", true],
    ["plain anchor", true],
    ["same page", true],
    ["link", true],
  ]);
  await page.close();
});

test("Reload: a scrolled page returns to where it was read, an unscrolled one to its top", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");

  await page.evaluate(() => scrollTo(0, 1500));
  await page.waitForTimeout(400);
  await page.reload();
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 1500);

  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.reload();
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.close();
});

test("Back and forward: each page returns to where it was left, a followed link opens at its top", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");

  await page.evaluate(() => scrollTo(0, 1200));
  await page.waitForTimeout(400);
  // A pointer click would first scroll the link into view, moving the position being tested.
  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForURL(`${base}/shelf/page-58.md`);
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 0, "a followed link did not open at its top");

  await page.evaluate(() => scrollTo(0, 700));
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForURL(`${base}/shelf/page-59.md`);
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 1200, "back");

  await page.goForward();
  await page.waitForURL(`${base}/shelf/page-58.md`);
  await landed(page);
  assert.equal(await page.evaluate(() => scrollY), 700, "forward");
  await page.close();
});

test("Reload and Back and forward: a position below images still loading is reached once they load", async () => {
  write({
    "tall/page.md": `# Tall\n\n![tall](tall.svg)\n\n${"Words after the image. ".repeat(400)}`,
    "tall/tall.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="3000"><rect width="400" height="3000"/></svg>',
  });
  const page = await settled("tall/page.md");
  await page.evaluate(() => scrollTo(0, 2800));
  await page.waitForTimeout(400);
  await page.route("**/tall/tall.svg*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });

  for (const time of ["first", "second"]) {
    await page.reload();
    await landed(page);
    await page.waitForFunction(
      () => (document.querySelector("img[alt=tall]") as HTMLImageElement).complete,
    );
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY), 2800, `${time} reload`);
  }

  await page.unroute("**/tall/tall.svg*");
  await page.close();
});

test("Back and forward: a place the page can no longer reach does not pull it back later", async () => {
  const long = (words: number) =>
    `# X\n\n[y](y.md)\n\n${"Words of a page that changes length. ".repeat(words)}`;
  write({ "short/x.md": long(1200), "short/y.md": "# Y" });
  const page = await settled("short/x.md");

  await page.evaluate(() => scrollTo(0, 2000));
  await page.waitForTimeout(400);
  await page.$eval('.markdown-body a[href="y.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Y",
  );
  write({ "short/x.md": long(300) });
  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "X",
  );
  await page.waitForTimeout(300);
  const landed = await page.evaluate(() => scrollY);

  assert.ok(landed < 2000, `the shorter page still reached ${landed}`);
  write({ "short/x.md": `${long(300)}\n\nappended ${"Words appended at the end. ".repeat(1500)}` });
  await waitText(page, "appended");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), landed);
  await page.close();
});

test("Back and forward: a heading followed right after scrolling returns to where the scroll ended", async () => {
  const page = await settled("notes/long.md");

  await page.evaluate(() => scrollTo(0, 2000));
  await page.$eval('.outline a[href="#part-7"]', (link) => (link as HTMLElement).click());
  await page.waitForURL(`${base}/notes/long.md#part-7`);
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForURL(`${base}/notes/long.md`);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), 2000);
  await page.close();
});

test("Follow a link and Frame follows: content, tree, listing and breadcrumb links swap only the content", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  await keepFrame(page);

  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  assert.deepEqual(await frameOf(page), {
    kept: true,
    url: `${base}/shelf/page-58.md`,
    title: "page-58.md",
    crumbs: [path.basename(root), "shelf", "page-58.md"],
    current: "page-58.md",
    outline: "Page 58",
  });

  await page.click('.tree a[href="/shelf/page-30.md"]');
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 30",
  );
  assert.equal((await frameOf(page)).current, "page-30.md");
  assert.ok((await frameOf(page)).kept, "a tree link reloaded the page");

  await page.click('.breadcrumbs a[href="/shelf/"]');
  await page.waitForSelector(".listing li");
  assert.equal(await page.$eval(".listing h1", (h) => h.textContent), "shelf");
  assert.equal(page.url(), `${base}/shelf/`);
  assert.equal(await page.title(), "shelf");

  await page.click('.listing a[href="/shelf/page-05.md"]');
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 5",
  );
  assert.ok((await frameOf(page)).kept, "a listing link reloaded the page");
  await page.close();
});

test("Folder and Heading on another page: a folder lists in place, a heading link lands on its heading", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  await keepFrame(page);

  await page.$eval('.markdown-body a[href="page-58.md#part-3"]', (link) =>
    (link as HTMLElement).click(),
  );
  await page.waitForURL(`${base}/shelf/page-58.md#part-3`);
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  const gap = await page.evaluate(
    () =>
      (document.getElementById("part-3") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );
  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);

  await page.$eval('.markdown-body a[href="./"]', (link) => (link as HTMLElement).click());
  await page.waitForSelector(".listing li");
  assert.equal(page.url(), `${base}/shelf/`);
  assert.ok((await frameOf(page)).kept, "a folder link reloaded the page");
  await page.close();
});

test("Landing: back and forward between followed links keep the frame and each page's place", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");
  await keepFrame(page);

  await page.evaluate(() => scrollTo(0, 900));
  await page.waitForTimeout(400);
  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.evaluate(() => scrollTo(0, 500));
  await page.waitForTimeout(400);

  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 59",
  );
  assert.equal(await page.evaluate(() => scrollY), 900);
  await page.goForward();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  assert.equal(await page.evaluate(() => scrollY), 500);
  assert.equal((await frameOf(page)).current, "page-58.md");
  assert.ok((await frameOf(page)).kept, "back or forward reloaded the page");
  await page.close();
});

test("External link and Missing page: an outside link opens a new tab, a missing page shows as opened directly", async () => {
  writeShelf();
  await context.route("https://example.com/**", (route) => route.fulfill({ body: "outside" }));
  const page = await open("notes/guide.md");

  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.click('.markdown-body a[href="https://example.com"]'),
  ]);
  assert.equal(page.url(), `${base}/notes/guide.md`);
  await popup.close();
  await context.unroute("https://example.com/**");

  const direct = await (await fetch(`${base}/shelf/absent.md`)).text();
  const shelf = await settled("shelf/page-59.md");
  await shelf.$eval('.markdown-body a[href="absent.md"]', (link) => (link as HTMLElement).click());
  await shelf.waitForURL(`${base}/shelf/absent.md`);
  await shelf.waitForLoadState();
  assert.equal(await shelf.evaluate(() => document.body.innerText.trim()), direct.trim());
  await Promise.all([page.close(), shelf.close()]);
});

test("Live updates: after following a link only the new page's saves update it; a suspended tab resumes", async () => {
  writeShelf();
  const page = await settled("shelf/page-59.md");

  await page.click('button[title="Suspend live updates in this tab"]');
  await page.$eval('.markdown-body a[href="page-58.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 58",
  );
  await page.waitForSelector('button[title="Suspend live updates in this tab"]');
  await page.waitForTimeout(300);
  await mark(page);

  write({ "shelf/page-59.md": "# Page 59\n\nsaved while away" });
  await page.waitForTimeout(600);
  assert.ok(await marked(page), "a save of the previous page re-rendered the new one");

  write({ "shelf/page-58.md": "# Page 58\n\nsaved while shown" });
  await waitText(page, "saved while shown");
  await page.close();
});

test("Prepared ahead: resting the pointer on a page link fetches that page before the click", async () => {
  writeShelf();
  const page = await settled("shelf/page-40.md");
  const fetched = page.waitForRequest(`${base}/shelf/page-39.md?page`, { timeout: 2000 });

  await page.hover('.markdown-body a[href="page-39.md"]');
  await fetched;
  await page.click('.markdown-body a[href="page-39.md"]');
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 39",
  );
  await page.close();
});

test("Prepared ahead: the page rendered while the pointer rested is the one shown, unless its file changed since", async () => {
  const diagram = (name: string) =>
    `# ${name}\n\n[next](b.md)\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n`;
  write({ "ahead/a.md": diagram("A"), "ahead/b.md": diagram("B") });
  const page = await settled("ahead/a.md");
  const id = (selector: string) =>
    page.$eval(selector, (svg) => Number(svg.id.replace("diagram-", "")));
  const shown = await id(".mermaid > svg");
  const fetched = page.waitForRequest(`${base}/ahead/b.md?page`);

  await page.hover('.markdown-body a[href="b.md"]');
  await fetched;
  await page.waitForTimeout(500);
  await page.$eval('.markdown-body a[href="b.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "B",
  );
  assert.equal(await id(".mermaid > svg"), shown + 1, "the click rendered the page again");

  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "A",
  );
  await page.hover('.markdown-body a[href="b.md"]');
  await page.waitForTimeout(500);
  write({ "ahead/b.md": diagram("B, saved after the pointer rested") });
  await page.waitForTimeout(300);
  await page.$eval('.markdown-body a[href="b.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body h1")?.textContent?.startsWith("B"),
  );
  assert.equal(
    await page.$eval(".markdown-body h1", (h) => h.textContent),
    "B, saved after the pointer rested",
  );
  await page.close();
});

test("No blank: the old content stays until the new page is ready", async () => {
  writeShelf();
  const page = await settled("shelf/page-20.md");
  await page.route("**/shelf/page-19.md?page", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  await page.$eval('.markdown-body a[href="page-19.md"]', (link) => (link as HTMLElement).click());
  await page.waitForTimeout(400);
  assert.equal(await page.$eval(".markdown-body h1", (h) => h.textContent), "Page 20");
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 19",
  );
  await page.unroute("**/shelf/page-19.md?page");
  await page.close();
});

test("Live updates: a save of the previous page in flight while following a link never reaches the new page", async () => {
  writeShelf();
  const page = await settled("shelf/page-12.md");
  await page.route("**/shelf/page-12.md?page", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });

  write({ "shelf/page-12.md": "# Page 12, saved\n\n[Previous](page-11.md)" });
  await page.waitForRequest(`${base}/shelf/page-12.md?page`);
  // The wrong content heals within one round trip, so every swap is recorded rather than sampled.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as { seen?: string[] }).seen = seen;
    new MutationObserver(() =>
      seen.push(document.querySelector(".markdown-body h1")?.textContent ?? ""),
    ).observe(document.querySelector("main") as Element, { childList: true });
  });
  await page.$eval('.markdown-body a[href="page-11.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 11",
  );
  await page.waitForTimeout(1500);
  assert.deepEqual(await page.evaluate(() => (window as { seen?: string[] }).seen), ["Page 11"]);
  await page.unroute("**/shelf/page-12.md?page");
  await page.close();
});

test("Live updates: a save of the previous page before the new one is subscribed leaves the new page alone", async () => {
  write({
    "late/a.md": "# A\n\n[b](b.md)",
    "late/b.md": "# B\n\n![pic](pic.svg)",
    "late/pic.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
  });
  const page = await settled("late/a.md");
  await page.route("**/late/pic.svg", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await page.$eval('.markdown-body a[href="b.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "B",
  );
  await mark(page);
  write({ "late/a.md": "# A, saved" });
  await page.waitForTimeout(800);
  assert.ok(await marked(page), "a save of the previous page re-rendered the new one");
  await page.unroute("**/late/pic.svg");
  await page.close();
});

test("Landing: a scroll while back is still loading is not saved as the earlier page's place", async () => {
  writeShelf();
  const page = await settled("shelf/page-30.md");

  await page.evaluate(() => scrollTo(0, 1200));
  await page.waitForTimeout(400);
  await page.$eval('.markdown-body a[href="page-29.md"]', (link) => (link as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 29",
  );
  await page.route("**/shelf/page-30.md?page", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });

  await page.goBack();
  await page.waitForURL(`${base}/shelf/page-30.md`);
  await page.evaluate(() => scrollTo(0, 600));
  await page.waitForFunction(
    () => document.querySelector(".markdown-body h1")?.textContent === "Page 30",
  );
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), 1200);
  await page.unroute("**/shelf/page-30.md?page");
  await page.close();
});

/** Long pages in a folder long enough that its last files sit below the tree panel's fold. */
function writeShelf(): void {
  const parts = (i: number) =>
    Array.from(
      { length: 5 },
      (_, k) =>
        `## Part ${k + 1}\n\n${Array.from({ length: 40 }, (_, n) => `Paragraph ${n + 1} of page ${i}.`).join("\n\n")}`,
    ).join("\n\n");
  const pages: Record<string, string> = {};

  for (let i = 0; i < 60; i++) {
    const name = `shelf/page-${String(i).padStart(2, "0")}.md`;
    const previous = `page-${String(Math.max(i - 1, 0)).padStart(2, "0")}.md`;
    pages[name] = [
      `# Page ${i}`,
      `[Previous](${previous}), [its part 3](${previous}#part-3), [absent](absent.md), [shelf](./)`,
      parts(i),
    ].join("\n\n");
  }

  if (!fs.existsSync(path.join(root, "shelf"))) {
    write(pages);
  }
}
