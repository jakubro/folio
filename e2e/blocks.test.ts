/** Headless Chromium run of folio's documented behaviour: block sources, block links, backlinks and includes. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  base,
  CLI,
  context,
  ENV,
  freePort,
  landed,
  open,
  output,
  until,
  visible,
  waitFor,
  waitText,
  write,
  writeIn,
} from "./harness.ts";

test("Own block, Included block, Nested include, Lines move, Same file twice: every block knows its source file and lines", async () => {
  write({
    "sources/page.md":
      "# Page\n\nOwn paragraph.\n\n{include: parts/part.md}\n\nAfter.\n\n{include: parts/part.md}",
    "sources/parts/part.md": "## Part\n\nPart text.\n\n{include: leaf.md}",
    "sources/parts/leaf.md": "- leaf item",
  });
  const page = await open("sources/page.md");
  const sources = () =>
    page.$$eval(".markdown-body > *", (blocks) =>
      blocks.map((block) => {
        const { folioSource, folioLines } = (block as HTMLElement).dataset;
        return `${block.textContent?.trim()} @ ${folioSource}:${folioLines}`;
      }),
    );

  assert.deepEqual(await sources(), [
    "Page @ sources/page.md:1-1",
    "Own paragraph. @ sources/page.md:3-3",
    "Part @ sources/parts/part.md:1-1",
    "Part text. @ sources/parts/part.md:3-3",
    "leaf item @ sources/parts/leaf.md:1-1",
    "After. @ sources/page.md:7-7",
    "Part @ sources/parts/part.md:1-1",
    "Part text. @ sources/parts/part.md:3-3",
    "leaf item @ sources/parts/leaf.md:1-1",
  ]);

  const kept = await page.$("p[data-folio-source='sources/parts/part.md']");
  write({ "sources/parts/part.md": "Added.\n\n## Part\n\nPart text.\n\n{include: leaf.md}" });
  await waitText(page, "Added.");

  assert.deepEqual((await sources()).slice(2, 6), [
    "Added. @ sources/parts/part.md:1-1",
    "Part @ sources/parts/part.md:3-3",
    "Part text. @ sources/parts/part.md:5-5",
    "leaf item @ sources/parts/leaf.md:1-1",
  ]);
  assert.equal(await kept?.evaluate((block) => block.isConnected), true);
  await page.close();
});

test("Own block, Included block, Nested include: every block reports the file holding its first line", async () => {
  write({
    "firstline/page.md":
      "See {include: word.md} here.\n\n{include: item.md}\n- outer\n\n<details>\n\nInside text.\n\n</details>\n\nNote[^1].\n\n[^1]: The note.\n",
    "firstline/word.md": "folio",
    "firstline/item.md": "- item\n",
    "firstline/flow.mmd": "graph TD\n  A --> B\n",
  });
  const page = await open("firstline/page.md");
  const sources = () =>
    page.$$eval(".markdown-body > *", (blocks) =>
      blocks.map((block) => {
        const { folioId, folioSource, folioLines } = (block as HTMLElement).dataset;
        return [block.tagName, folioSource, folioLines, /^[0-9a-f]{8}$/.test(folioId ?? "")];
      }),
    );
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body > [data-folio-id]").length === 5,
  );

  assert.deepEqual(await sources(), [
    ["P", "firstline/page.md", "1-1", true],
    ["UL", "firstline/item.md", "1-1", true],
    ["DETAILS", "firstline/page.md", "6-10", true],
    ["P", "firstline/page.md", "12-12", true],
    ["SECTION", "firstline/page.md", "14-14", true],
  ]);

  const diagram = await open("firstline/flow.mmd");
  await diagram.waitForSelector(".markdown-body > [data-folio-id]");
  assert.equal(
    await diagram.$eval(".markdown-body > *", (block) => (block as HTMLElement).dataset.folioLines),
    "1-2",
  );
  await diagram.close();
  await page.close();
});

test("Read a block, Hear a redraw, Survive an update, Follow a link: other tools attach through the output contract", async () => {
  write({
    "contract/page.md":
      "# Contract\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n[Next](next.md)",
    "contract/next.md": "# Next",
  });
  const page = await open("contract/page.md");
  await page.evaluate(() => {
    const heard: object[] = [];
    const ids = (blocks: Element[]) => blocks.map((block) => block.textContent?.trim());
    (window as { heard?: object[] }).heard = heard;
    document.addEventListener("folio:redraw", (event) => {
      const { page, cause, added, changed, removed } = (event as CustomEvent).detail;
      heard.push({ page, cause, added: ids(added), changed: ids(changed), removed: ids(removed) });
    });
    const third = [...document.querySelectorAll("[data-folio-id]")].find(
      (block) => block.textContent === "Third paragraph.",
    );
    third?.append(Object.assign(document.createElement("button"), { className: "patched" }));
  });
  const read = await page.$eval("[data-folio-id]:nth-child(2)", (block) => ({
    ...(block as HTMLElement).dataset,
  }));

  assert.match(read.folioId ?? "", /^[0-9a-f]{8}$/);
  assert.deepEqual([read.folioSource, read.folioLines], ["contract/page.md", "3-3"]);

  write({
    "contract/page.md":
      "# Contract\n\nFirst paragraph, edited.\n\nThird paragraph.\n\nA new one.\n\n[Next](next.md)",
  });
  await page.waitForFunction(() => (window as { heard?: object[] }).heard?.length === 1);

  assert.deepEqual(await page.evaluate(() => (window as { heard?: object[] }).heard), [
    {
      page: "contract/page.md",
      cause: "update",
      added: ["A new one."],
      changed: ["First paragraph, edited."],
      removed: ["Second paragraph."],
    },
  ]);
  assert.equal(await page.locator(".markdown-body .patched").count(), 1);

  await page.click('.markdown-body a[href="next.md"]');
  await page.waitForFunction(() => (window as { heard?: object[] }).heard?.length === 2);
  const followed = await page.evaluate(
    () => (window as { heard?: { page: string; cause: string; added: string[] }[] }).heard?.[1],
  );

  assert.deepEqual(
    [followed?.page, followed?.cause, followed?.added],
    ["contract/next.md", "load", ["Next"]],
  );
  await page.close();
});

test("Hear a redraw: an update drawn before its block ids are parsed is announced once they are", async () => {
  write({ "early/page.md": "# Early\n\nFirst paragraph.\n\nSecond paragraph." });
  const page = await open("early/page.md");
  await page.evaluate(() => {
    const heard: object[] = [];
    const texts = (blocks: Element[]) => blocks.map((block) => block.textContent?.trim());
    (window as { heard?: object[] }).heard = heard;
    document.addEventListener("folio:redraw", (event) => {
      const { added, changed, removed } = (event as CustomEvent).detail;
      heard.push({
        cause: (event as CustomEvent).detail.cause,
        added: texts(added),
        changed: texts(changed),
        removed: texts(removed),
      });
    });
  });
  // Until released, every answer is made to look as the server sends a page still parsing.
  let disguising = true;
  await page.route("**/early/page.md?page", async (route) => {
    if (!disguising) {
      return route.continue();
    }

    const response = await route.fetch();
    const content = await response.json();
    await route.fulfill({
      response,
      json: { ...content, blocks: [], version: `${content.version}-partial` },
    });
  });

  write({ "early/page.md": "# Early\n\nFirst paragraph, edited.\n\nA new one." });
  await waitText(page, "A new one.");
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => (window as { heard?: object[] }).heard), []);

  disguising = false;
  await page.waitForFunction(() => (window as { heard?: object[] }).heard?.length);
  await page.waitForTimeout(300);

  assert.deepEqual(await page.evaluate(() => (window as { heard?: object[] }).heard), [
    {
      cause: "update",
      added: ["A new one."],
      changed: ["First paragraph, edited."],
      removed: ["Second paragraph."],
    },
  ]);
  await page.close();
});

test("Hear a redraw: while ids parse, twins stay apart, a load waits, and a block moved to another file is reported", async () => {
  type Heard = { cause: string; added: string[]; changed: string[]; removed: string[] };
  const page = await context.newPage();
  await page.addInitScript(() => {
    const heard: object[] = [];
    const ids = (blocks: HTMLElement[]) =>
      blocks.map((block) => `${block.dataset.folioSource}#${block.dataset.folioId}`);
    (window as { heard?: object[] }).heard = heard;
    document.addEventListener("folio:redraw", (event) => {
      const { cause, added, changed, removed } = (event as CustomEvent).detail;
      heard.push({ cause, added: ids(added), changed: ids(changed), removed: ids(removed) });
    });
  });
  const heard = async () =>
    (await page.evaluate(() => (window as { heard?: object[] }).heard)) as Heard[];
  let disguising = true;
  // Until released, every answer looks as the server sends a page still parsing.
  await page.route("**/held/*.md?page", async (route) => {
    if (!disguising) {
      return route.continue();
    }

    const response = await route.fetch();
    const content = await response.json();
    await route.fulfill({
      response,
      json: { ...content, blocks: [], version: `${content.version}-partial` },
    });
  });
  // Lets real answers through until an event arrives, then disguises again; returns what was heard.
  const settle = async (): Promise<Heard[]> => {
    const seen = (await heard()).length;
    disguising = false;
    await page.waitForFunction(
      (n) => ((window as { heard?: object[] }).heard?.length ?? 0) > n,
      seen,
    );
    await page.waitForTimeout(300);
    disguising = true;
    return (await heard()).slice(seen);
  };
  const idOf = async (file: string): Promise<string> => {
    const served = await (await context.request.get(`${base}/held/${file}?page`)).json();
    const block = served.blocks.find(
      (found: { source: string; kind: string }) =>
        found.source === `held/${file}` && found.kind === "paragraph",
    );
    return served.version.endsWith("-partial") ? idOf(file) : `held/${file}#${block?.id}`;
  };

  write({
    "held/page.md": "# Held\n\nSame words.\n\n{include: part.md}",
    "held/part.md": "Same words.",
  });
  const own = await idOf("page.md");
  await page.goto(`${base}/held/page.md`);
  await page.waitForSelector(".markdown-body > *");
  await page.waitForTimeout(300);
  assert.deepEqual(await heard(), [], "a load drawn while parsing was announced at once");
  await page.evaluate(() =>
    document
      .querySelector(".markdown-body")
      ?.append(Object.assign(document.createElement("p"), { className: "tool-note" })),
  );

  const loaded = await settle();
  assert.deepEqual([loaded[0].cause, loaded[0].added.length], ["load", 3]);
  assert.equal(
    await page.locator(".markdown-body > .tool-note").count(),
    1,
    "ids arriving removed a tool's node",
  );

  write({ "held/page.md": "# Held\n\n{include: part.md}" });
  await page.waitForFunction(() => document.querySelectorAll(".markdown-body > p").length === 1);
  const deleted = await settle();
  assert.deepEqual(deleted, [{ cause: "update", added: [], changed: [], removed: [own] }]);

  write({
    "held/page.md": "# Held\n\nMoved words.\n\n{include: part.md}",
    "held/part.md": "Other.",
  });
  await waitText(page, "Moved words.");
  await settle();
  write({
    "held/part.md": "Moved words.\n\nOther.",
    "held/page.md": "# Held\n\n{include: part.md}",
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".markdown-body > p")].every(
      (p) => p.getAttribute("data-folio-source") === "held/part.md",
    ),
  );
  const moved = (await settle()).flatMap((event) => event.changed);
  assert.ok(
    moved.some((id) => id.startsWith("held/part.md#")),
    `the block moved to another file went unreported: ${JSON.stringify(moved)}`,
  );
  await page.close();
});

test("Hear a redraw: identical blocks from two files are told apart by file and id", async () => {
  write({
    "twins/page.md": "# Twins\n\nSame words.\n\n{include: part.md}",
    "twins/part.md": "Same words.",
  });
  const page = await open("twins/page.md");
  await page.waitForFunction(
    () => document.querySelectorAll(".markdown-body > [data-folio-id]").length === 3,
  );
  const ids = await page.$$eval(".markdown-body > p", (blocks) =>
    blocks.map(
      (block) =>
        `${(block as HTMLElement).dataset.folioSource}#${(block as HTMLElement).dataset.folioId}`,
    ),
  );
  await page.evaluate(() => {
    const heard: string[][] = [];
    (window as { heard?: string[][] }).heard = heard;
    document.addEventListener("folio:redraw", (event) => {
      const { removed } = (event as CustomEvent).detail as { removed: HTMLElement[] };
      heard.push(removed.map((block) => `${block.dataset.folioSource}#${block.dataset.folioId}`));
    });
  });

  write({ "twins/page.md": "# Twins\n\n{include: part.md}" });
  await page.waitForFunction(() => (window as { heard?: string[][] }).heard?.length);

  assert.deepEqual(await page.evaluate(() => (window as { heard?: string[][] }).heard), [[ids[0]]]);
  assert.deepEqual(
    await page.$$eval(".markdown-body > p", (blocks) =>
      blocks.map(
        (block) =>
          `${(block as HTMLElement).dataset.folioSource}#${(block as HTMLElement).dataset.folioId}`,
      ),
    ),
    [ids[1]],
  );
  await page.close();
});

test("Block gone, Get a link: the gone notice clears on any navigation, and a modified click on the mark opens a tab", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler ${i + 1}.`).join("\n\n");
  write({ "vanished/doc.md": `# Doc\n\n${filler}\n\n## Later\n\nKept paragraph.\n\n${filler}` });
  const page = await context.newPage();
  await page.goto(`${base}/vanished/doc.md#^00000000`);
  await page.waitForSelector(".markdown-body > *");
  const notice = () => page.isVisible(".block-gone");

  assert.equal(await notice(), true);
  await page.locator(".markdown-body p", { hasText: "Kept paragraph." }).hover();
  await page.click(".block-link");
  assert.equal(await notice(), false, "a mark click left the notice");

  await page.goto(`${base}/vanished/doc.md#^00000000`);
  await page.waitForSelector(".markdown-body > *");
  await page.hover(".markdown-body h2");
  await page.click(".markdown-body h2 .heading-link");
  assert.equal(await notice(), false, "a heading mark click left the notice");

  await page.locator(".markdown-body p", { hasText: "Kept paragraph." }).hover();
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.click(".block-link", { modifiers: ["ControlOrMeta"] }),
  ]);
  await tab.waitForURL(/#\^[0-9a-f]{8}$/);
  assert.match(page.url(), /#later$/);
  await tab.close();
  await page.close();
});

test("Block gone, Read before: a link to a block read and since removed shows the gone notice", async () => {
  write({ "readgone/doc.md": "# Doc\n\nThe valve closes at noon.\n\nKept paragraph.\n" });
  const page = await open("readgone/doc.md");
  const id = await page
    .locator(".markdown-body p", { hasText: "valve" })
    .getAttribute("data-folio-id");
  await waitFor(async () => {
    const { blocks } = await (await fetch(`${base}/readgone/doc.md?read`)).json();
    return blocks.some((block: { id: string; read: unknown }) => block.id === id && block.read);
  });

  write({ "readgone/doc.md": "# Doc\n\nKept paragraph.\n" });
  const fresh = await context.newPage();
  await fresh.goto(`${base}/readgone/doc.md#^${id}`);
  await fresh.waitForSelector(".read-mark.mark-removed");
  assert.equal(await fresh.isVisible(".block-gone"), true);
  assert.equal(await fresh.locator(".landed").count(), 0);
  await Promise.all([fresh.close(), page.close()]);
});

test("Get a link, Follow it, Block moved, Block reworded, Block gone, Heading links: a link can point at any block and survives edits", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
  const target = "The pump stops when the tank is full.";
  write({
    "anchors/doc.md": `# Doc\n\n${filler}\n\n## Target section\n\n${target}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${filler}`,
  });
  const page = await open("anchors/doc.md");
  const bar = await page.$eval(".bar", (element) => element.getBoundingClientRect().bottom);
  const paragraph = page.locator(".markdown-body p", { hasText: target });

  await paragraph.hover();
  await page.click(".block-link");
  const link = page.url();
  const id = await paragraph.getAttribute("data-folio-id");

  assert.equal(new URL(link).hash, `#^${id}`);
  assert.equal(await page.locator(".markdown-body .landed").count(), 1);
  await page.locator(".markdown-body table").hover();
  assert.equal(
    await page.$eval(".block-link", (mark) => (mark as HTMLAnchorElement).hash),
    `#^${await page.locator(".markdown-body table").getAttribute("data-folio-id")}`,
  );
  assert.equal(
    await page
      .locator(".markdown-body h2")
      .hover()
      .then(() => page.isVisible(".block-link")),
    false,
  );

  const landed = async () => {
    const fresh = await context.newPage();
    await fresh.goto(link);
    await fresh.waitForSelector(".markdown-body > *");
    await fresh.waitForTimeout(200);
    const found = await fresh.evaluate((text) => {
      const block = [...document.querySelectorAll(".markdown-body [data-folio-id]")].find((b) =>
        b.textContent?.includes(text),
      );
      return {
        top: block ? Math.round(block.getBoundingClientRect().top) : null,
        marked: block?.classList.contains("landed") ?? false,
        gone: !(document.querySelector(".block-gone") as HTMLElement).hidden,
        scrolled: scrollY > 0,
      };
    }, "pump");
    await fresh.close();
    return found;
  };
  const below = bar + 12;

  assert.deepEqual(await landed(), { top: below, marked: true, gone: false, scrolled: true });

  write({
    "anchors/doc.md": `# Doc\n\n${filler}\n\n## Target section\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${target}\n\n${filler}`,
  });
  await waitText(page, "Doc");
  assert.deepEqual(
    await landed(),
    { top: below, marked: true, gone: false, scrolled: true },
    "moved",
  );

  write({
    "anchors/doc.md": `# Doc\n\n${filler}\n\nThe pump halts once the tank is full.\n\n${filler}`,
  });
  assert.deepEqual(
    await landed(),
    { top: below, marked: true, gone: false, scrolled: true },
    "reworded",
  );

  write({ "anchors/doc.md": `# Doc\n\n${filler}` });
  assert.deepEqual(
    await landed(),
    { top: null, marked: false, gone: true, scrolled: false },
    "gone",
  );

  const heading = await context.newPage();
  write({ "anchors/doc.md": `# Doc\n\n${filler}\n\n## Target section\n\n${filler}` });
  await heading.goto(`${base}/anchors/doc.md#target-section`);
  await heading.waitForSelector(".markdown-body > *");
  await heading.waitForTimeout(200);
  assert.equal(
    await heading.$eval("#target-section", (h) => Math.round(h.getBoundingClientRect().top)),
    below,
  );
  assert.equal(await heading.isVisible(".block-gone"), false);
  await heading.close();
  await page.close();
});

test("See incoming links, Into a section, Follow back, New link, No links: a page shows what links to it", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler ${i + 1}.`).join("\n\n");
  write({
    "backlinks/target.md": "# Target\n\n## Retry policy\n\nRetries back off.",
    "backlinks/a.md": `# A\n\n${filler}\n\nRead [the target](target.md) before starting.\n\n${filler}`,
    "backlinks/sub/b.md": "- Mind the [retries](../target.md#retry-policy) here.",
    "backlinks/lonely.md": "# Lonely",
  });
  const page = await open("backlinks/target.md");
  const listed = () =>
    page.$$eval(".backlinks li", (items) =>
      items.map((item) => ({
        source: item.querySelector("a")?.textContent,
        part: item.querySelector(".backlink-part")?.textContent ?? null,
        context: item.querySelector(".backlink-context")?.textContent,
      })),
    );
  await page.waitForSelector(".backlinks li");

  assert.deepEqual(await listed(), [
    { source: "backlinks/a.md", part: null, context: "Read the target before starting." },
    { source: "backlinks/sub/b.md", part: " → Retry policy", context: "Mind the retries here." },
  ]);
  assert.deepEqual(
    await page.$$eval(".outline-backlinks a", (links) => links.map((link) => link.textContent)),
    ["a.md", "b.md"],
  );

  write({ "backlinks/c.md": "A [new link](target.md) appears." });
  await page.waitForFunction(() => document.querySelectorAll(".backlinks li").length === 3);
  assert.deepEqual((await listed())[1], {
    source: "backlinks/c.md",
    part: null,
    context: "A new link appears.",
  });

  await page.click('.backlinks a[href^="/backlinks/a.md"]');
  await page.waitForURL(/\/backlinks\/a\.md#\^/);
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body .landed")?.textContent?.startsWith("Read the target"),
  );
  assert.ok((await page.evaluate(() => scrollY)) > 0);
  assert.equal(await page.isVisible(".backlinks"), false);

  const lonely = await open("backlinks/lonely.md");
  await lonely.waitForTimeout(300);
  assert.equal(await lonely.isVisible(".backlinks"), false);
  assert.equal(await lonely.isVisible(".outline-backlinks"), false);
  await lonely.close();
  await page.close();
});

test("Into a section, Follow back: outline entries land on the linking block, and parts from included files read as text", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler ${i + 1}.`).join("\n\n");
  write({
    "backlinks2/target.md": "# Target\n\n{include: shared.md}",
    "backlinks2/shared.md": "## Shared notes\n\nShared paragraph.",
  });
  const served = async (): Promise<{
    version: string;
    blocks: { id: string; kind: string; source: string }[];
  }> => {
    const content = await (await context.request.get(`${base}/backlinks2/target.md?page`)).json();
    return content.version.endsWith("-partial") ? served() : content;
  };
  const shared = (await served()).blocks.find(
    (block) => block.kind === "paragraph" && block.source === "backlinks2/shared.md",
  )?.id;
  write({
    "backlinks2/from.md": `# From\n\n${filler}\n\nSee [the notes](target.md#shared-notes) and [the paragraph](target.md#^${shared}).\n\n${filler}`,
  });
  const page = await open("backlinks2/target.md");
  await page.waitForSelector(".backlinks li");

  assert.deepEqual(
    await page.$$eval(".backlinks .backlink-part", (parts) =>
      parts.map((part) => part.textContent),
    ),
    [" → Shared notes", " → Shared paragraph."],
  );

  await page.click(".outline-backlinks a");
  await page.waitForURL(/\/backlinks2\/from\.md#\^[0-9a-f]{8}$/);
  await page.waitForFunction(() =>
    document.querySelector(".markdown-body .landed")?.textContent?.startsWith("See the notes"),
  );
  await page.close();
});

test("A section, A block, Live, Gone, Whole file: a document can include a section or a block of another", async () => {
  const design = (policy: string) =>
    `# Design\n\nIntro.\n\n## ${policy}\n\nRetries back off.\n\n### Limits\n\nThree tries.\n\n## Storage\n\nKept on disk.`;
  write({ "parts/design.md": design("Retry policy"), "parts/whole.md": "Whole file." });
  const parsed = async (): Promise<{
    version: string;
    blocks: { lines: number[]; id: string }[];
  }> => {
    const served = await (await context.request.get(`${base}/parts/design.md?page`)).json();
    return served.version.endsWith("-partial") ? parsed() : served;
  };
  const storage = (await parsed()).blocks.find((block) => block.lines[0] === 15)?.id;
  write({
    "parts/page.md": `# Page\n\n{include: design.md#retry-policy}\n\nBetween.\n\n{include: design.md#^${storage}}\n\n{include: whole.md}`,
  });
  const page = await open("parts/page.md");
  const shown = () =>
    page.$$eval(".markdown-body > *", (blocks) => blocks.map((block) => block.textContent?.trim()));

  assert.deepEqual(await shown(), [
    "Page",
    "Retry policy",
    "Retries back off.",
    "Limits",
    "Three tries.",
    "Between.",
    "Kept on disk.",
    "Whole file.",
  ]);

  write({
    "parts/design.md": design("Retry policy").replace(
      "Retries back off.",
      "Retries back off, twice.",
    ),
  });
  await waitText(page, "twice");
  assert.equal((await shown())[2], "Retries back off, twice.");

  write({ "parts/design.md": design("Retry rules") });
  await page.waitForSelector(".markdown-body .include-missing");
  assert.equal(
    await page.$eval(".markdown-body .include-missing", (marker) => marker.textContent),
    "{include: design.md#retry-policy}",
  );
  assert.ok(await page.isVisible(".markdown-body .include-missing"));
  assert.deepEqual((await shown()).slice(-2), ["Kept on disk.", "Whole file."]);
  await page.close();
});

test("A section, A block, Gone: parts stay apart from what follows, and a document includes a section of itself", async () => {
  write({
    "parts3/notes.md": "# Notes\n\n## Last\n\nLast words.\n",
    "parts3/page.md":
      "# Page\n\n{include: notes.md#last}\nAfter the include.\n\n{include: page.md#later}\n\n## Later\n\nLater text.\n\n## Loop\n\n{include: page.md#loop}\n",
  });
  const page = await open("parts3/page.md");
  await page.waitForSelector(".markdown-body .include-missing");

  assert.deepEqual(
    await page.$$eval(".markdown-body > *", (blocks) =>
      blocks.map((block) => block.textContent?.trim()),
    ),
    [
      "Page",
      "Last",
      "Last words.",
      "After the include.",
      "Later",
      "Later text.",
      "Later",
      "Later text.",
      "Loop",
      "{include: page.md#loop}",
    ],
  );
  await page.close();
});

test("Headings, Many changes: the outline and folds follow an update; a rewrite shows as a fresh load", async () => {
  const sections = (names: string[]) =>
    names.map((name) => `## ${name}\n\n${name} text.`).join("\n\n");
  write({ "redraw/sections.md": sections(["Alpha", "Beta", "Gamma"]) });
  const page = await open("redraw/sections.md");
  const outlined = () => page.$$eval(".outline a", (links) => links.map((a) => a.textContent));
  await page.$eval("#beta > .fold-toggle", (control) => (control as HTMLElement).click());
  assert.equal(await visible(page, "Beta text."), false);

  write({ "redraw/sections.md": sections(["Alpha renamed", "Beta", "Delta"]) });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".outline a")].some((a) => a.textContent === "Delta"),
  );
  assert.deepEqual(await outlined(), ["Alpha renamed", "Beta", "Delta"]);
  assert.equal(await visible(page, "Beta text."), false);
  assert.equal(await visible(page, "Delta text."), true);
  assert.equal(
    await page.locator(".markdown-body :is(h1, h2, h3, h4, h5, h6) > .fold-toggle").count(),
    3,
  );

  const rewrite = `# Rewritten\n\n${Array.from({ length: 30 }, (_, i) => `Line ${i + 1}.`).join("\n\n")}\n\n## Beta\n\nBeta again.\n\n| a | b |\n|---|---|\n| 1 | 2 |`;
  write({ "redraw/sections.md": rewrite });
  await waitText(page, "Beta again.");
  const fresh = await open("redraw/sections.md");
  const shape = (p: Page) =>
    p.$$eval(".markdown-body > :not(.fold), .markdown-body .fold > *", (blocks) =>
      blocks.map((block) => [block.tagName, block.textContent]),
    );

  assert.deepEqual(await shape(page), await shape(fresh));
  assert.deepEqual(
    await outlined(),
    await fresh.$$eval(".outline a", (a) => a.map((l) => l.textContent)),
  );
  await page.close();
  await fresh.close();
});

test("Start, Unopened change, Blocks, Identity through edits, Pruned folders: folio keeps a model of the whole folder", async () => {
  const doc = (paragraph: string) =>
    `# Pumps\n\n${paragraph}\n\n- intake\n- outlet\n\n| a |\n|---|\n| 1 |\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n\n> quoted`;
  write({
    "model/pumps.md": doc("The north pump runs at night and stops at dawn."),
    "model/.drafts/hidden.md": "# Hidden",
    "model/node_modules/pkg/README.md": "# Package",
  });
  const page = await context.newPage();
  const inspect = async (urlPath: string) => {
    const response = await page.goto(`${base}/${urlPath}?model`);
    return response?.status() === 200 ? JSON.parse(await page.innerText("body")) : undefined;
  };
  const blocksOf = async () =>
    ((await inspect("model/pumps.md"))?.blocks ?? []) as {
      id: string;
      kind: string;
      text: string;
    }[];
  await until(() => output.includes("documents indexed"));
  await waitFor(async () => (await blocksOf()).length > 0);
  const before = await blocksOf();

  assert.equal((await inspect(""))?.ready, true);
  assert.deepEqual(
    before.map((block) => block.kind),
    ["heading", "paragraph", "list", "table", "diagram", "quote"],
  );

  write({
    "model/pumps.md": `> quoted\n\n${doc("The north pump runs at night and halts at sunrise.").replace("\n\n> quoted", "")}`,
  });
  await waitFor(async () => (await blocksOf())[0]?.kind === "quote");
  const after = await blocksOf();

  assert.deepEqual(
    after.map((block) => block.id),
    [before[5].id, ...before.slice(0, 5).map((block) => block.id)],
  );
  assert.match(after[2].text, /halts at sunrise/);
  assert.equal(await inspect("model/.drafts/hidden.md"), undefined);
  assert.equal(await inspect("model/node_modules/pkg/README.md"), undefined);
  await page.close();
});

test("Survive a publish: a tab open while folio restarts on a new build reloads into it and keeps drawing", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-dist-"));
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-e2e-publish-")));
  const publishPort = await freePort();
  const serve = async () => {
    let said = "";
    const child = spawn(
      process.execPath,
      [path.join(dist, "cli.js"), folder, "--port", String(publishPort)],
      {
        env: ENV,
      },
    );
    child.stdout?.on("data", (chunk) => {
      said += chunk;
    });
    await until(() => said.includes("serving"));
    return child;
  };
  fs.cpSync(path.dirname(CLI), dist, { recursive: true });
  writeIn(folder, { "page.md": "# Page\n\nWords.\n\nMore words." });
  let running = await serve();
  const page = await context.newPage();

  try {
    await page.goto(`http://localhost:${publishPort}/page.md`);
    await landed(page);

    running.kill();
    await new Promise((resolve) => running.once("exit", resolve));
    // A new build names its chunks afresh, so every chunk the open tab's script knows is gone.
    for (const name of fs.readdirSync(dist)) {
      const file = path.join(dist, name);

      if (name === "page.js" || /^chunk-.*\.js$/.test(name)) {
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("chunk-", "chunk-next"));
      }

      if (name.startsWith("chunk-")) {
        fs.renameSync(file, path.join(dist, name.replace("chunk-", "chunk-next")));
      }
    }
    running = await serve();

    writeIn(folder, { "page.md": "# Page\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nMore words." });
    await page.waitForSelector(".mermaid svg[aria-roledescription]", { timeout: 20_000 });
  } finally {
    running.kill();
    await page.close();
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("Survive a publish: a tab whose first update socket already reaches a new build reloads into it", async () => {
  const page = await context.newPage();
  let connections = 0;
  let loads = 0;
  page.on("load", () => loads++);
  await page.routeWebSocket(/\?events$/, (socket) => {
    const server = socket.connectToServer();
    const first = ++connections === 1;
    server.onMessage((message) => {
      const hello = typeof message === "string" && JSON.parse(message).type === "hello";
      socket.send(
        first && hello ? JSON.stringify({ type: "hello", build: "a-newer-build" }) : message,
      );
    });
  });
  await page.goto(`${base}/notes/other.md`);
  await waitFor(async () => loads >= 2 && connections >= 2);
  await page.waitForSelector(".markdown-body > *");
  await page.waitForTimeout(500);

  assert.deepEqual({ loads, connections }, { loads: 2, connections: 2 });
  await page.close();
});
