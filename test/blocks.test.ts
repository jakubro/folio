import assert from "node:assert/strict"
import { test } from "node:test"
import { type Block, blocks, placesOf } from "../src/server/blocks.ts"

const DOC = [
  "---",
  "title: Pumps",
  "---",
  "",
  "# Pumps",
  "",
  "The north pump runs at night.",
  "",
  "- intake",
  "- outlet",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```python",
  "print(1)",
  "```",
  "",
  "```mermaid",
  "graph LR",
  "  A --> B",
  "```",
  "",
  "> quoted",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "<div>raw</div>",
  "",
  "---",
  "",
  "| loose | row |",
  "| no | divider |",
].join("\n")

const ids = (list: Block[]) => list.map((block) => block.id)

test("splits a page into its top-level blocks with their kind and lines", () => {
  assert.deepEqual(
    blocks(DOC, "markdown").map(({ kind, lines }) => [kind, lines]),
    [
      ["frontmatter", [1, 3]],
      ["heading", [5, 5]],
      ["paragraph", [7, 7]],
      ["list", [9, 10]],
      ["table", [12, 14]],
      ["code", [16, 18]],
      ["diagram", [20, 23]],
      ["quote", [25, 25]],
      ["math", [27, 29]],
      ["html", [31, 31]],
      ["rule", [33, 33]],
      ["table", [35, 36]],
    ],
  )
})

test("gives each block its own text, a loose table's included", () => {
  const list = blocks("Before.\n\n| a | b |\n| c | d |\nafter", "markdown")

  assert.deepEqual(
    list.map(({ kind, text }) => [kind, text]),
    [
      ["paragraph", "Before."],
      ["table", "| a | b |\n| c | d |"],
      ["paragraph", "after"],
    ],
  )
})

test("a mermaid file is one diagram block, an empty one none", () => {
  assert.deepEqual(
    blocks("graph LR\n  A --> B\n", "mermaid").map(({ kind, lines }) => [kind, lines]),
    [["diagram", [1, 2]]],
  )
  assert.deepEqual(blocks("\n", "mermaid"), [])
})

test("a math fence is a math block, as the page draws it", () => {
  assert.deepEqual(
    blocks("```math\nx^2\n```", "markdown").map((block) => block.kind),
    ["math"],
  )
})

test("a block keeps its identity when moved", () => {
  const first = blocks("# Title\n\nAlpha paragraph.\n\nBeta paragraph.", "markdown")
  const moved = blocks("Beta paragraph.\n\n# Title\n\nAlpha paragraph.", "markdown", first)

  assert.deepEqual(ids(moved), [first[2].id, first[0].id, first[1].id])
})

test("a reworded block keeps its identity; one rewritten beyond recognition gets a new one", () => {
  const first = blocks(
    "The north pump runs at night and stops at dawn.\n\nValves close when the tank is full.",
    "markdown",
  )
  const edited = blocks(
    "The north pump runs at night and halts at sunrise.\n\nInvoices are sent on the first Monday.",
    "markdown",
    first,
  )

  assert.equal(edited[0].id, first[0].id)
  assert.notEqual(edited[1].id, first[1].id)
})

test("a block that changes kind is a new block; a new block leaves the others alone", () => {
  const first = blocks("Setup steps.\n\nRun it.", "markdown")
  const next = blocks("# Setup steps\n\nA new line.\n\nRun it.", "markdown", first)

  assert.notEqual(next[0].id, first[0].id)
  assert.equal(next[2].id, first[1].id)
  assert.equal(new Set(ids(next)).size, 3)
})

test("identical blocks get distinct ids, and each keeps its own when one goes", () => {
  const first = blocks("Same.\n\nMiddle.\n\nSame.", "markdown")
  const next = blocks("Middle.\n\nSame.", "markdown", first)

  assert.equal(new Set(ids(first)).size, 3)
  assert.deepEqual(ids(next), [first[1].id, first[0].id])
})

test("a fresh split gives unedited blocks the same ids every time", () => {
  assert.deepEqual(ids(blocks(DOC, "markdown")), ids(blocks(DOC, "markdown")))
})

test("records each heading's anchor as the page names it, duplicates numbered", () => {
  assert.deepEqual(
    blocks("# Retry `policy`!\n\nText.\n\n## Retry policy", "markdown").map(({ slug }) => slug),
    ["retry-policy", undefined, "retry-policy-1"],
  )
})

test("numbers a heading's anchor after the HTML headings before it, and reads it as the page shows it", () => {
  assert.deepEqual(
    blocks(
      '<h2>Notes</h2>\n\n<h2 id="kept">Notes</h2>\n\n## Notes\n\n## Press <kbd>Ctrl</kbd>',
      "markdown",
    )
      .filter(({ kind }) => kind === "heading")
      .map(({ slug, title }) => [slug, title]),
    [
      ["notes-1", "Notes"],
      ["press-ctrl", "Press Ctrl"],
    ],
  )
})

test("records each markdown link of a block, references resolved, with the text around it", () => {
  const long = "word ".repeat(40).trim()
  const list = blocks(
    `Plain.\n\n${long} [first](a.md) and [second][ref] ${long}\n\n- [inner](b/c.md#part)\n\n[ref]: /d.md`,
    "markdown",
  )

  assert.deepEqual(
    list.map(({ links }) => links?.map(({ url }) => url)),
    [undefined, ["a.md", "/d.md"], ["b/c.md#part"], undefined],
  )
  assert.equal(list[2].links?.[0].context, "inner")
  assert.match(list[1].links?.[0].context ?? "", /^\.\.\.(word ){15}word first and second word/)
  assert.ok((list[1].links?.[0].context.length ?? 0) < long.length + 30)
})

test("a link's context reads as the page shows it: a tied figure as its figure, a value embed as ..., however it is cut", () => {
  const long = "word ".repeat(40).trim()
  const list = blocks(
    [
      'North was the wettest, with <data value="w.sql#0.rain_mm">52.6</data> mm, see [North](north.md).',
      "Rain came to {value: #totals#0.rain_mm} mm, see [totals](totals.md) and `{value: kept}`.",
      `${long} {value: #totals#0.days} days and <data value="queries/wettest.sql#0.rain_mm">52.6</data> mm of rain, most in three storms, see [far](far.md) ${long}`,
      "A plain [link](plain.md) here.",
    ].join("\n\n"),
    "markdown",
  )
  const [figure, value, far, plain] = list.map(({ links }) => links?.[0].context ?? "")

  assert.deepEqual(
    [
      figure,
      value,
      /^\.\.\..* days and 52\.6 mm of rain, most in three storms, see far word/.test(far) &&
        !/[<>{}"]|value[:=]/.test(far),
      plain,
    ],
    [
      "North was the wettest, with 52.6 mm, see North.",
      "Rain came to ... mm, see totals and {value: kept}.",
      true,
      "A plain link here.",
    ],
  )
})

test("a link's context shows an include as ..., found or missing, and an escaped one as the page shows it", () => {
  const list = blocks(
    [
      "The totals are {include: parts/totals.md} as listed, see [north](north.md).",
      "Notes from {include: parts/absent.md} sit beside [south](south.md).",
      "Write \\{include: parts/x.md} to include a file, as [the guide](guide.md) says.",
      "Run `{include: parts/cmd.md}` and `\\{include: kept.md}` as [ops](ops.md) says.",
      "Both {include: a.md} and \\{include: a.md} sit near [here](here.md).",
      "A plain [link](plain.md) here.",
    ].join("\n\n"),
    "markdown",
  )

  assert.deepEqual(
    list.map(({ links }) => links?.[0].context),
    [
      "The totals are ... as listed, see north.",
      "Notes from ... sit beside south.",
      "Write {include: parts/x.md} to include a file, as the guide says.",
      "Run ... and {include: kept.md} as ops says.",
      "Both ... and {include: a.md} sit near here.",
      "A plain link here.",
    ],
  )
})

test("a link's context reads an include as expansion does, whatever markdown would make of its text", () => {
  const list = blocks(
    [
      "Load {include: pkg/__init__.md} as [the loader](loader.md) does.",
      "Write \\{include: my\\_notes.md} to include, as [the guide](guide.md) says.",
      "Write {include\\: a.md} or &#123;include: b.md} as [text](text.md).",
      "Three \\\\\\{include: c.md} near [here](here.md).",
      "Wrapped {include:  \nwide.md} near [there](there.md).",
    ].join("\n\n"),
    "markdown",
  )

  assert.deepEqual(
    list.map(({ links }) => links?.[0].context),
    [
      "Load ... as the loader does.",
      "Write {include: my_notes.md} to include, as the guide says.",
      "Write {include: a.md} or {include: b.md} as text.",
      "Three \\{include: c.md} near here.",
      "Wrapped ... near there.",
    ],
  )
})

test("each link's context is read around that link, though its text matches another's", () => {
  const filler =
    "a station on the ridge whose gauge sits in the lee of the hut and reads a little high in a westerly"
  const [list] = blocks(
    ["North", "South", "West"]
      .map((name) => `- ${filler}, ${name} reads [{value: ${name}.csv#0.rain} mm](${name}.md)`)
      .join("\n"),
    "markdown",
  )

  assert.deepEqual(
    list.links?.map(({ context }) =>
      ["North", "South", "West"].filter((name) => context.includes(`${name} reads ... mm`)),
    ),
    [["North"], ["South"], ["West"]],
  )
})

test("finds code, HTML, math and frontmatter where the file holds them, after a byte order mark too, and records them by block", () => {
  const text =
    "\uFEFF---\nk: v\n---\n\nSee `a` and $b$.\n\n<!-- c -->\n\nIntro\n| `d` | e |\n| f | g |\n\n    h\n"
  const found = [
    ["yaml", "---\nk: v\n---"],
    ["inlineCode", "`a`"],
    ["inlineMath", "$b$"],
    ["html", "<!-- c -->"],
    ["inlineCode", "`d`"],
    ["code", "    h"],
  ]

  assert.deepEqual(
    placesOf(text).literals.map(({ type, start, end }) => [type, text.slice(start, end)]),
    found,
  )
  assert.deepEqual(
    blocks(text, "markdown")
      .flatMap(({ literals = [] }) => literals)
      .map(({ type, start, end }) => [type, text.slice(start, end)]),
    found,
  )
})

test("reads GitHub's backtick math as math, and one broken across lines as a dollar, code and a dollar, as the page does", () => {
  const text =
    "Area $`a^2`$, price $`\\$5`$ and $b$.\n\nBroken $`a\nb`$ here, `c` alone, $d$ after.\n"

  assert.deepEqual(
    placesOf(text).literals.map(({ type, start, end }) => [type, text.slice(start, end)]),
    [
      ["inlineMath", "$`a^2`$"],
      ["inlineMath", "$`\\$5`$"],
      ["inlineMath", "$b$"],
      ["inlineCode", "`a\nb`"],
      ["inlineCode", "`c`"],
      ["inlineMath", "$d$"],
    ],
  )
})

test("finds where each link and definition writes its address and how the page reads it, in quotes and loose tables, after a byte order mark too", () => {
  const text = [
    "\uFEFF[^1]: Note.",
    "",
    "[t.md]: t.md 'T'",
    "",
    "See [x](<a b.md>), [y](a&amp;b.md (T)) and ![p](c(1).png).",
    "",
    "> [d]: d.md",
    "> See [e](",
    "> e.md).",
    "",
    "Intro",
    "| `f [g](g.md) | [h](h.md) |",
    "| i ` | j |",
    "",
  ].join("\n")
  const found = [
    ["t.md", "t.md"],
    ["<a b.md>", "a b.md"],
    ["a&amp;b.md", "a&b.md"],
    ["c(1).png", "c(1).png"],
    ["d.md", "d.md"],
    ["e.md", "e.md"],
    ["g.md", "g.md"],
    ["h.md", "h.md"],
  ]

  assert.deepEqual(
    placesOf(text).addresses.map(({ start, end, url }) => [text.slice(start, end), url]),
    found,
  )
  assert.deepEqual(
    blocks(text, "markdown")
      .flatMap(({ addresses = [] }) => addresses)
      .map(({ start, end, url }) => [text.slice(start, end), url]),
    found,
  )
})
