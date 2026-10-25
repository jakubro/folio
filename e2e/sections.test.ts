/** Headless Chromium run of folio's documented behaviour: frontmatter, collapsible blocks, anchors and folds. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import {
  base,
  context,
  frameOf,
  keepFrame,
  landed,
  open,
  sourced,
  visible,
  waitText,
  write,
} from "./harness.ts";

test("Scalar frontmatter, Nested values, Outline: frontmatter shows as a key/value table above the body", async () => {
  write({
    "cards/card.md":
      "---\ntitle: Folio\nstatus: draft\ntags: [a, b]\nowner:\n  name: X\n---\n# Body\n\nText.\n\n## Section\n",
  });
  const page = await open("cards/card.md");
  const facts = await page.evaluate(() => ({
    first: document.querySelector(".markdown-body > :first-child")?.className,
    rows: [...document.querySelectorAll(".markdown-body .frontmatter tr")].map((row) => [
      row.querySelector("th")?.textContent,
      row.querySelector("td pre code.language-yaml.hljs")?.textContent ??
        row.querySelector("td")?.textContent,
    ]),
    rules: document.querySelectorAll(".markdown-body hr").length,
    headings: [...document.querySelectorAll(".markdown-body :is(h1, h2)")].map(
      (h) => h.textContent,
    ),
    outline: [...document.querySelectorAll(".outline a")].map((link) => link.textContent),
  }));

  assert.deepEqual(facts, {
    first: "frontmatter",
    rows: [
      ["title", "Folio"],
      ["status", "draft"],
      ["tags", "[a, b]"],
      ["owner", "name: X"],
    ],
    rules: 0,
    headings: ["Body", "Section"],
    outline: ["Body", "Section"],
  });
  await page.close();
});

test("Malformed YAML: the block shows as highlighted YAML and the body renders", async () => {
  write({ "cards/broken.md": "---\ntitle: [unclosed\n---\n# Body\n\nText.\n" });
  const page = await open("cards/broken.md");
  const facts = await page.evaluate(() => ({
    block: document.querySelector(".markdown-body > pre:first-child > code.language-yaml.hljs")
      ?.textContent,
    tables: document.querySelectorAll(".markdown-body table").length,
    body: document.querySelector(".markdown-body h1")?.textContent,
    outline: [...document.querySelectorAll(".outline a")].map((link) => link.textContent),
  }));

  assert.deepEqual(facts, {
    block: "title: [unclosed",
    tables: 0,
    body: "Body",
    outline: ["Body"],
  });
  await page.close();
});

test("No frontmatter: a rule that does not open the file renders as a rule", async () => {
  write({
    "cards/later.md": "# Later\n\nText.\n\n---\n\nmode: x\n\n---\n",
    "cards/indented.md": "\n---\nmode: x\n---\n",
  });

  for (const [file, rules, heading] of [
    ["cards/later.md", 2, null],
    ["cards/indented.md", 1, "mode: x"],
  ] as const) {
    const page = await open(file);
    const facts = await page.evaluate(() => ({
      tables: document.querySelectorAll(".markdown-body .frontmatter").length,
      rules: document.querySelectorAll(".markdown-body hr").length,
      heading: document.querySelector(".markdown-body h2")?.textContent ?? null,
    }));

    assert.deepEqual(facts, { tables: 0, rules, heading }, file);
    await page.close();
  }
});

test("Live update: a saved frontmatter value updates the table in place", async () => {
  write({ "cards/live.md": "---\ntitle: Folio\nstatus: draft\n---\n# Body\n" });
  const page = await open("cards/live.md");

  await keepFrame(page);
  write({ "cards/live.md": "---\ntitle: Folio\nstatus: final\n---\n# Body\n" });
  await page.waitForFunction(
    () => document.querySelector(".frontmatter tr:nth-child(2) td")?.textContent === "final",
  );
  assert.equal((await frameOf(page)).kept, true);
  await page.close();
});

test("Heading in a block, Open or closed, Highlight, Heading in the block's title, Nested blocks, Live update: a block's content stays out of the outline", async () => {
  const words = "Words fill the section. ".repeat(160);
  const blocks = (extra: string) =>
    [
      "# A",
      words,
      "<details><summary>More</summary>",
      `## B\n\n${extra}${words}`,
      "</details>",
      `## C\n\n${words}`,
      "<details><summary><h2>Notes</h2></summary>",
      "Inside.",
      "<details><summary><h3>Inner</h3></summary>",
      "Deeper.",
      "</details>",
      "</details>",
      words,
    ].join("\n\n");
  const listed = (page: Page) =>
    page.$$eval(".outline a", (links) =>
      links.map((link) => `${link.className.replace(" current", "")} ${link.textContent}`),
    );
  const current = (page: Page, name: string) =>
    page.waitForFunction(
      (want) => document.querySelector(".outline a.current")?.textContent === want,
      name,
    );
  const outline = ["outline-h1 A", "outline-h2 C", "outline-h2 Notes"];
  write({ "outline/blocks.md": blocks("") });
  const page = await open("outline/blocks.md");

  assert.deepEqual(await listed(page), outline);
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) {
      details.open = true;
    }
  });
  assert.deepEqual(await listed(page), outline);

  await page.evaluate(() => document.getElementById("c")?.scrollIntoView());
  await current(page, "C");
  await page.evaluate(() => document.getElementById("b")?.scrollIntoView());
  await current(page, "A");

  write({ "outline/blocks.md": blocks("## Added\n\n") });
  await waitText(page, "Added");
  assert.deepEqual(await listed(page), outline);
  await page.close();
});

test("Mark on hover, Text stays text, Set the anchor, History, Copied address, Every level, Link in a heading, Heading in a block's title: a heading's mark sets its anchor", async () => {
  const words = "Words fill the section. ".repeat(160);
  write({
    "anchors/start.md": "# Start\n\n[Marks](marks.md)",
    "anchors/marks.md": [
      "# Top",
      words,
      "## Second [linked](start.md)",
      words,
      "### Third",
      words,
      "#### Fourth",
      words,
      "##### Fifth",
      "###### Sixth",
      "<details><summary><h2>Titled</h2></summary>",
      "Body.",
      "</details>",
      words,
    ].join("\n\n"),
  });
  const page = await open("anchors/start.md");
  const opacity = (id: string) =>
    page.$eval(`[id="${id}"] .heading-link`, (mark) => getComputedStyle(mark).opacity);

  await page.click("text=Marks");
  await page.waitForSelector("#fourth");
  assert.deepEqual(
    await page.$$eval(":is(h1, h2, h3, h4, h5, h6)[id]", (headings) =>
      headings.map((h) => [h.id, h.querySelectorAll(".heading-link").length, h.textContent]),
    ),
    [
      ["top", 1, "Top"],
      ["second-linked", 1, "Second linked"],
      ["third", 1, "Third"],
      ["fourth", 1, "Fourth"],
      ["fifth", 1, "Fifth"],
      ["sixth", 1, "Sixth"],
      ["titled", 1, "Titled"],
    ],
  );
  assert.equal(await page.$$eval("#third a:not(.heading-link)", (links) => links.length), 0);

  await page.evaluate(() => scrollTo(0, 1500));
  await page.mouse.move(0, 0);
  assert.equal(await opacity("fourth"), "0");
  await page.hover("#fourth");
  assert.equal(await opacity("fourth"), "1");
  const entries = await page.evaluate(() => history.length);
  await page.click("#fourth .heading-link");
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, entries: history.length })), {
    hash: "#fourth",
    entries,
  });

  const copied = await context.newPage();
  await copied.goto(page.url());
  await landed(copied);
  const gap = await copied.evaluate(
    () =>
      (document.getElementById("fourth") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );
  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);
  await copied.close();

  await page.click("#titled .heading-link");
  assert.deepEqual(
    await page.evaluate(() => ({
      hash: location.hash,
      open: (document.querySelector("details") as HTMLDetailsElement).open,
    })),
    { hash: "#titled", open: false },
  );

  await page.goBack();
  await page.waitForFunction(() => location.pathname.endsWith("/anchors/start.md"));
  await page.goForward();
  await page.waitForSelector("#second-linked");
  await page.click("#second-linked >> text=linked");
  await page.waitForFunction(() => location.pathname.endsWith("/anchors/start.md"));
  await page.close();
});

test("Pilcrow on hover, Hidden otherwise, Click unchanged, Outline clean, Copy clean: a heading's mark is a pilcrow", async () => {
  write({ "pilcrow/page.md": "# Alpha\n\nText.\n\n## Beta\n\nText.\n\n###### Gamma" });
  const page = await open("pilcrow/page.md");
  const mark = (id: string) =>
    page.$eval(`[id="${id}"] .heading-link`, (a) => {
      const glyph = getComputedStyle(a, "::before");
      const text = document.createRange();
      text.selectNodeContents(a.parentElement as Element);
      text.setEndBefore(a);
      return {
        glyph: glyph.content,
        weight: glyph.fontWeight,
        scale:
          Math.round(
            (100 * parseFloat(glyph.fontSize)) / parseFloat(getComputedStyle(a).fontSize),
          ) / 100,
        icons: a.childElementCount,
        after: a.getBoundingClientRect().left >= text.getBoundingClientRect().right,
        opacity: getComputedStyle(a).opacity,
      };
    });

  await page.mouse.move(0, 0);
  for (const id of ["alpha", "beta", "gamma"]) {
    assert.deepEqual(await mark(id), {
      glyph: '"\u00b6"',
      weight: "400",
      scale: 0.8,
      icons: 0,
      after: true,
      opacity: "0",
    });
  }
  await page.hover("#beta");
  assert.equal((await mark("beta")).opacity, "1");
  await page.hover("#beta .heading-link");
  assert.equal(
    await page.$eval("#beta .heading-link", (a) => getComputedStyle(a).textDecorationLine),
    "none",
  );

  assert.deepEqual(await page.$$eval(".outline a", (links) => links.map((a) => a.textContent)), [
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  assert.equal(
    await page.$eval("#beta", (heading) => {
      getSelection()?.selectAllChildren(heading);
      return getSelection()?.toString();
    }),
    "Beta",
  );

  const entries = await page.evaluate(() => history.length);
  await page.click("#beta .heading-link");
  assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, entries: history.length })), {
    hash: "#beta",
    entries,
  });
  await page.close();
});

test("Bring to top, Same spot, Address, History, Instant, Near the bottom, Heading in a block's title: a heading's mark brings it just below the toolbar", async () => {
  const words = "Words fill the section. ".repeat(160);
  write({
    "anchors/top-start.md": "# Start\n\n[Tops](tops.md)",
    "anchors/tops.md": [
      "# Top",
      words,
      "## Middle",
      words,
      "<details><summary><h2>Titled</h2></summary>",
      "Body.",
      "</details>",
      words,
      "## Last",
      "Short.",
    ].join("\n\n"),
  });
  const page = await open("anchors/top-start.md");
  const gap = (id: string) =>
    page.evaluate(
      (heading) =>
        (document.getElementById(heading) as Element).getBoundingClientRect().top -
        (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
      id,
    );

  await page.click("text=Tops");
  await page.waitForSelector("#middle");
  const entries = await page.evaluate(() => history.length);
  const middle = await page.$eval("#middle", (h) => h.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => scrollTo(0, y - 400), middle);
  await page.hover("#middle");
  await page.click("#middle .heading-link");
  const at = await page.evaluate(() => scrollY);
  assert.ok((await gap("middle")) >= 0 && (await gap("middle")) <= 16, "heading below the toolbar");
  assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, entries: history.length })), {
    hash: "#middle",
    entries,
  });

  await page.click(".outline >> text=Middle");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), at);

  await page.evaluate(() => scrollTo(0, 0));
  await page.hover("#titled");
  await page.click("#titled .heading-link");
  assert.ok((await gap("titled")) >= 0 && (await gap("titled")) <= 16, "title heading on top");
  assert.equal(await page.$eval("details", (d) => (d as HTMLDetailsElement).open), false);

  await page.evaluate(() => scrollTo(0, 0));
  await page.hover("#last");
  await page.click("#last .heading-link");
  assert.equal(
    await page.evaluate(() => scrollY),
    await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
  );

  await page.goBack();
  await page.waitForFunction(() => location.pathname.endsWith("/anchors/top-start.md"));
  await page.close();
});

test("Control on hover, Fold, Nested sections, Folded is visible, Unfold, Outline, Link mark, Selection: a heading's control folds its section", async () => {
  write({ "folds/sections.md": SECTIONS });
  const page = await open("folds/sections.md");
  const opacity = (id: string) =>
    page.$eval(`[id="${id}"] > .fold-toggle`, (b) => getComputedStyle(b).opacity);
  const textLeft = (id: string) =>
    page.$eval(`[id="${id}"]`, (h) => {
      const range = document.createRange();
      range.selectNodeContents(h.lastChild?.previousSibling ?? h);
      return range.getBoundingClientRect().left;
    });
  const outlined = () => page.$$eval(".outline a", (links) => links.map((a) => a.textContent));

  assert.deepEqual(
    await page.$$eval(":is(h1, h2, h3, h4, h5, h6)[id]", (headings) =>
      headings.map((h) => [h.id, h.querySelectorAll(":scope > .fold-toggle").length]),
    ),
    ["top", "alpha", "alpha-one", "beta", "titled", "inner", "gamma", "sixth"].map((id) => [id, 1]),
  );
  const outline = await outlined();
  await page.mouse.move(0, 0);
  const left = await textLeft("alpha");
  assert.equal(await opacity("alpha"), "0");
  await page.hover("#alpha");
  assert.equal(await opacity("alpha"), "1");
  assert.equal(await textLeft("alpha"), left);
  const toggle = await page.$eval("#alpha > .fold-toggle", (b) => b.getBoundingClientRect());
  const heading = await page.$eval("#alpha", (h) => h.getBoundingClientRect());
  assert.ok(toggle.right <= heading.left + 1, "control sits left of the heading");

  await page.click("#alpha-one > .fold-toggle");
  await page.click("#alpha > .fold-toggle");
  assert.deepEqual(
    [await visible(page, "Alpha text."), await visible(page, "Alpha one text.")],
    [false, false],
  );
  assert.equal(await visible(page, "Beta text."), true);
  assert.equal(await folded(page, "alpha"), "false");
  assert.deepEqual(await outlined(), outline);

  await page.mouse.move(0, 0);
  assert.equal(await opacity("alpha"), "1");
  assert.equal(await opacity("beta"), "0");

  await page.click("#alpha > .fold-toggle");
  assert.deepEqual(
    [await visible(page, "Alpha text."), await visible(page, "Alpha one text.")],
    [true, false],
  );
  assert.equal(await folded(page, "alpha"), "true");
  await page.click("#alpha-one > .fold-toggle");
  assert.equal(await visible(page, "Alpha one text."), true);

  await page.click("#beta > .fold-toggle");
  assert.equal(await visible(page, "Beta text."), false);
  assert.equal(await page.$eval("#titled", (h) => h.checkVisibility()), true);
  await page.click("#beta > .fold-toggle");
  await page.click("#gamma > .fold-toggle");
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  assert.equal(await page.$eval(".outline .current", (a) => a.textContent), "Gamma");
  await page.click("#gamma > .fold-toggle");

  await page.hover("#gamma");
  await page.click("#gamma .heading-link");
  assert.equal(await page.evaluate(() => location.hash), "#gamma");

  await page.evaluate(() => scrollTo(0, 0));
  const box = await page.$eval("#beta", (h) => {
    const range = document.createRange();
    range.selectNodeContents(h.lastChild?.previousSibling ?? h);
    const r = range.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, right: r.right };
  });
  await page.mouse.move(box.x + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.y, { steps: 5 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => String(getSelection())), "Beta");
  assert.equal(await folded(page, "beta"), "true");
  await page.close();
});

test("Live update, Reload, Same tab back, Other tab, Outline into a fold, Deep link, Find: folds last per tab and page, and unfold to show what is asked for", async () => {
  write({ "folds/kept.md": SECTIONS, "folds/away.md": "# Away" });
  const page = await open("folds/kept.md");

  await page.click("#alpha > .fold-toggle");
  write({ "folds/kept.md": `${SECTIONS}\n\nAppended.` });
  await waitText(page, "Appended.");
  assert.equal(await visible(page, "Alpha text."), false);

  await page.reload();
  await landed(page);
  await sourced(page);
  assert.equal(await visible(page, "Alpha text."), false);

  await page.evaluate(() => {
    const link = Object.assign(document.createElement("a"), { href: "away.md", textContent: "Go" });
    document.querySelector(".markdown-body")?.append(link);
  });
  await page.click("text=Go");
  await page.waitForSelector("#away");
  await page.goBack();
  await page.waitForSelector("#alpha");
  assert.equal(await visible(page, "Alpha text."), false);

  const other = await open("folds/kept.md");
  assert.equal(await visible(other, "Alpha text."), true);
  await other.close();

  await page.click(".outline >> text=Alpha one");
  await page.waitForTimeout(300);
  assert.equal(await visible(page, "Alpha one text."), true);
  assert.equal(await folded(page, "alpha"), "true");
  const gap = await page.evaluate(
    () =>
      (document.getElementById("alpha-one") as Element).getBoundingClientRect().top -
      (document.querySelector(".bar") as Element).getBoundingClientRect().bottom,
  );
  assert.ok(gap >= 0 && gap <= 16, `heading sits ${gap} px below the toolbar`);

  await page.click("#alpha > .fold-toggle");
  await page.goto(`${base}/folds/away.md`);
  await page.goto(`${base}/folds/kept.md#alpha-one`);
  await landed(page);
  assert.equal(await visible(page, "Alpha one text."), true);
  assert.equal(await folded(page, "alpha"), "true");

  await page.click("#beta > .fold-toggle");
  assert.equal(await page.$eval("#beta + .fold", (f) => f.getAttribute("hidden")), "until-found");
  await page.$eval("#beta + .fold", (f) => f.dispatchEvent(new Event("beforematch")));
  assert.equal(await folded(page, "beta"), "true");
  await page.reload();
  await landed(page);
  assert.equal(await visible(page, "Beta text."), true);
  await page.close();
});

test("Heading in a block's content, Heading in a block's title: a section inside a collapsible block ends with the block", async () => {
  write({ "folds/blocks.md": SECTIONS });
  const page = await open("folds/blocks.md");
  const open_ = (n: number) =>
    page.$$eval("details", (all, i) => (all[i] as HTMLDetailsElement).open, n);

  await page.click("#titled > .fold-toggle");
  assert.equal(await open_(0), false);
  assert.equal(await folded(page, "titled"), "false");
  await page.click("#titled");
  assert.equal(await open_(0), true);
  assert.equal(await visible(page, "Titled text."), false);

  await page.click('summary >> text="Block"');
  await page.click("#inner > .fold-toggle");
  assert.equal(await visible(page, "Inner text."), false);
  assert.equal(await visible(page, "After the block."), true);
  assert.equal(await page.$eval("#gamma", (h) => h.checkVisibility()), true);
  await page.close();
});

const SECTIONS = [
  "# Top",
  "Top text.",
  "## Alpha",
  "Alpha text.",
  "### Alpha one",
  "Alpha one text.",
  "## Beta",
  "Beta text.",
  "<details><summary><h2>Titled</h2></summary>",
  "Titled text.",
  "</details>",
  "<details><summary>Block</summary>",
  "## Inner",
  "Inner text.",
  "</details>",
  "After the block.",
  "## Gamma",
  `${"Gamma words. ".repeat(400)}`,
  "###### Sixth",
].join("\n\n");

function folded(page: Page, id: string): Promise<string | null> {
  return page.$eval(`[id="${id}"] > .fold-toggle`, (b) => b.getAttribute("aria-expanded"));
}

test("Fold, then leave: the block marks hide once the pointer leaves after folding a section", async () => {
  write({ "folds/leave.md": SECTIONS });
  const page = await open("folds/leave.md");

  for (const away of [
    [0, 400],
    [-20, -20],
  ]) {
    await page.hover("#alpha");
    await page.click("#alpha > .fold-toggle");
    await page.mouse.move(away[0], away[1]);
    await page.waitForTimeout(200);
    assert.equal(await page.isVisible(".block-provenance"), false, `moved to ${away}`);
  }

  await page.close();
});
