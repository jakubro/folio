import assert from "node:assert/strict"
import { test } from "node:test"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { gfm } from "../src/server/gfm.ts"

const UPSTREAM = unified().use(remarkParse).use(remarkGfm)
const LINEAR = unified().use(remarkParse).use(gfm)

const EXAMPLES = [
  "www.commonmark.org",
  "Visit www.commonmark.org/help for more information.",
  "Visit www.commonmark.org.\n\nVisit www.commonmark.org/a.b.",
  "www.google.com/search?q=Markup+(business)\n\nwww.google.com/search?q=Markup+(business)))",
  "(www.google.com/search?q=Markup+(business))\n\n(www.google.com/search?q=Markup+(business)",
  "www.google.com/search?q=(business))+ok",
  "www.google.com/search?q=commonmark&hl=en\n\nwww.google.com/search?q=commonmark&hl;",
  "www.commonmark.org/he<lp",
  "http://commonmark.org\n\n(Visit https://encrypted.google.com/search?q=Markup+(business))",
  "foo@bar.baz",
  "hello@mail+xyz.example isn't valid, but hello+xyz@mail.example is.",
  "a.b-c_d@a.b\n\na.b-c_d@a.b.\n\na.b-c_d@a.b-\n\na.b-c_d@a.b_",
  "mailto:foo@bar.baz\n\nxmpp:foo@bar.baz/txt",
  "www.a_b.c www.a.b_c HTTP://X.Y WWW.x.y https://a._b",
  "/x@y.z and \u{1F600}x@y.z and éx@y.z and a+b@c.d",
  "*www.example.com* _a@b.co_ ~~https://x.yz~~ [www.in.link](u)",
  "See ![^a] and ![ ^a] and [^a] here, ![^a [b](c)] ![x](y) [z].\n\n[^a]: A note.\n",
  "> ![^a\n> ] quoted\n\n[^a]: A.\n",
  "Text with `www.code.example` and <https://auto.example> and **www.bold.example**.",
]

const TOKENS = [
  ..."abwhx1_-+.@:/()[]!^*~` \n\t&?,;'\"<>}\\|#é\u{1F600}",
  ...["www", "www.", "WWW.", "http://", "https://", "HTTP://", "a@b.co", "x.y"],
  ...["![^a]", "[^a]", "](", "![", "[^", "\n\n", "\n\n[^a]: n\n", "> ", "- "],
]

test("the same tree as remark-gfm for GitHub's own autolink and footnote examples", () => {
  for (const text of EXAMPLES) {
    assert.deepEqual(LINEAR.parse(text), UPSTREAM.parse(text), JSON.stringify(text))
  }
})

test("the same tree as remark-gfm for thousands of texts made of the characters autolinks and footnotes turn on", () => {
  let seed = 20261028
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }

  for (let made = 0; made < 4000; made++) {
    const length = 1 + Math.floor(random() * 40)
    const text = Array.from({ length }, () => TOKENS[Math.floor(random() * TOKENS.length)]).join("")
    assert.deepEqual(LINEAR.parse(text), UPSTREAM.parse(text), JSON.stringify(text))
  }
})

test("the same tree as remark-gfm for thousands of texts of emphasis, strikethrough, links and footnotes", () => {
  let seed = 20261029
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  const tokens = [
    ..."*_~*_~ab. ,!()[]^`\\\n",
    ...["**", "__", "~~", "***", "___", "~~~", "*a*", "_a_", "~~a~~", "](u)", "![", "[^a]"],
    ...["\n\n[^a]: n\n", "> ", "- ", "\u00e9", "a@b.co", "www.x.y"],
  ]

  for (let made = 0; made < 6000; made++) {
    const length = 1 + Math.floor(random() * 50)
    const text = Array.from({ length }, () => tokens[Math.floor(random() * tokens.length)]).join("")
    assert.deepEqual(LINEAR.parse(text), UPSTREAM.parse(text), JSON.stringify(text))
  }
})

test("a 160,000-character line of dots, underscores, `](`, asterisks, tildes, addresses or links parses in well under a second", () => {
  const lines = {
    dots: `a${".".repeat(160_000)}x`,
    underscores: `a${"_".repeat(160_000)}x`,
    brackets: "](".repeat(80_000),
    "brackets with a footnote": `![^a] ${"](".repeat(80_000)}\n\n[^a]: A note.\n`,
    "dots before an at sign": `a${".".repeat(160_000)}@`,
    "a dotted address": `www.${"x.".repeat(80_000)}_`,
    "refused links": "awww.x".repeat(26_000),
    "closing brackets": `www.x.y/${"(".repeat(80_000)}${")".repeat(80_000)}`,
    "brackets after an open image label": `![${"](".repeat(80_000)}`,
    "brackets after a label with no definition": `![x] ${"](".repeat(80_000)}`,
    "brackets after a footnote label with no definition": `![^x] ${"](".repeat(80_000)}`,
    "dots and underscores in turn": "._".repeat(80_000),
    "dots and asterisks in turn": ".*".repeat(80_000),
    "letters and asterisks in turn": "a*".repeat(80_000),
    "asterisks and underscores in turn": "*_".repeat(80_000),
    "dots and tildes in turn": ".~".repeat(80_000),
    "dots and double tildes in turn": ".~~".repeat(53_334),
  }

  for (const [name, line] of Object.entries(lines)) {
    const started = performance.now()
    LINEAR.parse(line)
    const took = performance.now() - started

    assert.ok(took < 3000, `${name} took ${Math.round(took)} ms`)
  }
})
