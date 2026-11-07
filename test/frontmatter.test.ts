import assert from "node:assert/strict"
import { test } from "node:test"
import type { Element, ElementContent } from "hast"
import { frontmatter, linksOf } from "../src/client/frontmatter.ts"

type Cell =
  | string
  | { list: Cell[] }
  | { map: [string, Cell][] }
  | { entries: { keys: string[]; rows: Cell[][] } }

function rows(table: Element | undefined): [string, Cell][] {
  assert.equal(table?.tagName, "table")
  assert.deepEqual(table.properties.className, ["frontmatter"])
  const body = table.children[0] as Element

  return body.children.map((row) => {
    const [key, value] = (row as Element).children as Element[]

    return [text(key), cell(value)]
  })
}

function cell(value: Element): Cell {
  const [only] = value.children

  return only?.type === "element" && only.tagName === "ul"
    ? { list: only.children.map((item) => cell(item as Element)) }
    : only?.type === "element" && only.tagName === "table"
      ? (only.children[0] as Element).tagName === "thead"
        ? { entries: entries(only) }
        : { map: rows(only) }
      : text(value)
}

function entries(table: Element): { keys: string[]; rows: Cell[][] } {
  assert.deepEqual(table.properties.className, ["frontmatter"])
  const [head, body] = table.children as Element[]
  const keys = ((head.children[0] as Element).children as Element[]).map(text)

  return {
    keys,
    rows: (body.children as Element[]).map((row) => (row.children as Element[]).map(cell)),
  }
}

function text(node: ElementContent): string {
  return node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(text).join("")
      : ""
}

function codeBlock(node: Element | undefined): string {
  assert.equal(node?.tagName, "pre")
  const code = node.children[0] as Element
  assert.deepEqual(code.properties.className, ["language-yaml"])

  return text(code)
}

test("one row per key in file order, each scalar as written", () => {
  assert.deepEqual(
    rows(frontmatter('title: Folio\nstatus: draft\nversion: 1.10\nquoted: "a b"\nempty:\nnone: ~')),
    [
      ["title", "Folio"],
      ["status", "draft"],
      ["version", "1.10"],
      ["quoted", "a b"],
      ["empty", ""],
      ["none", "~"],
    ],
  )
})

test("a list shows as a list and a map as rows of its own, each value as YAML reads it", () => {
  assert.deepEqual(
    rows(
      frontmatter(
        "tags: [a, b]\nowner:\n  name: X\n  roles:\n    - lead\nsteps:\n  - one\n  - two\ngrid: [[1, 2], [3]]\nnone: []\nquoted: ['it''s', \"say \\\"hi\\\"\"]\nnote: |\n  line one\n  line two\n",
      ),
    ),
    [
      ["tags", { list: ["a", "b"] }],
      [
        "owner",
        {
          map: [
            ["name", "X"],
            ["roles", { list: ["lead"] }],
          ],
        },
      ],
      ["steps", { list: ["one", "two"] }],
      ["grid", { list: [{ list: ["1", "2"] }, { list: ["3"] }] }],
      ["none", { list: [] }],
      ["quoted", { list: ["it's", 'say "hi"'] }],
      ["note", "line one\nline two\n"],
    ],
  )
})

test("a list of maps shows as one table: an entry a row, a column per key in first-appearance order", () => {
  assert.deepEqual(
    rows(
      frontmatter(
        'links:\n  - kind: owns\n    repo: web\n    card: "[#42](https://example.com/42)"\n    title: Pick a time\n  - kind: relates\n    card: "[#7](https://example.com/7)"\n    extra: [a, b]\nonly:\n  - id: "[pump-1](parts/pump-1.md)"\nmixed:\n  - name: x\n  - plain\n',
      ),
    ),
    [
      [
        "links",
        {
          entries: {
            keys: ["kind", "repo", "card", "title", "extra"],
            rows: [
              ["owns", "web", "#42", "Pick a time", ""],
              ["relates", "", "#7", "", { list: ["a", "b"] }],
            ],
          },
        },
      ],
      ["only", { entries: { keys: ["id"], rows: [["pump-1"]] } }],
      ["mixed", { list: [{ map: [["name", "x"]] }, "plain"] }],
    ],
  )
})

test("YAML that does not parse, or is not key/value, shows as the block itself", () => {
  for (const yaml of ["title: [unclosed", "a: 1\na: 2", "- a\n- b", "just text"]) {
    assert.equal(codeBlock(frontmatter(yaml)), yaml)
  }
})

test("an empty block shows nothing", () => {
  assert.equal(frontmatter(""), undefined)
  assert.equal(frontmatter("  \n"), undefined)
})

function links(node: ElementContent): [string, string][] {
  return node.type !== "element"
    ? []
    : node.tagName === "a"
      ? [[String(node.properties.href), text(node)]]
      : node.children.flatMap(links)
}

test("a link in a value is a link shown by its text, the words around it kept, and an empty text shows the address", () => {
  const table = frontmatter(
    'parent: "[P-3](./p-3.md)"\nnote: see [the spec](spec.md) first\nbare: "[](x.md)"\nplain: no link',
  )

  assert.deepEqual(rows(table), [
    ["parent", "P-3"],
    ["note", "see the spec first"],
    ["bare", "x.md"],
    ["plain", "no link"],
  ])
  assert.deepEqual(links(table as Element), [
    ["./p-3.md", "P-3"],
    ["spec.md", "the spec"],
    ["x.md", "x.md"],
  ])
})

test("a link inside a list or a map is a link shown by its text, its quotes gone", () => {
  const table = frontmatter(
    'dependencies: ["[A-1](../archive/a-1.md)", "[A-2](./a-2.md)"]\nrefs:\n  - kind: source\n    item: "[#12](https://example.com/item/12)"',
  ) as Element

  assert.deepEqual(rows(table), [
    ["dependencies", { list: ["A-1", "A-2"] }],
    ["refs", { entries: { keys: ["kind", "item"], rows: [["source", "#12"]] } }],
  ])
  assert.deepEqual(links(table), [
    ["../archive/a-1.md", "A-1"],
    ["./a-2.md", "A-2"],
    ["https://example.com/item/12", "#12"],
  ])
})

test("an unquoted link in a list or a map, and one YAML reads across lines, is a link like any", () => {
  const yaml =
    "refs:\n  - see [A-1](a-1.md) now\n  - spec: see [A-2](a-2.md#x), then [A-3](a-3.md)\n  - see [A-4 and\n    more](a-4.md)"

  assert.deepEqual(links(frontmatter(yaml) as Element), [
    ["a-1.md", "A-1"],
    ["a-2.md#x", "A-2"],
    ["a-3.md", "A-3"],
    ["a-4.md", "A-4 and more"],
  ])
  assert.deepEqual(
    linksOf(yaml).map(({ url }) => url),
    ["a-1.md", "a-2.md#x", "a-3.md", "a-4.md"],
  )
})

test("a list or a map shows the links its values hold, and none in code across lines, keys or comments", () => {
  const yaml =
    'refs:\n  - |\n    see `x\n    [A-1](a-1.md)` y\n  - "[A-2](a-2.md)": key\n  - plain # [A-3](a-3.md)\nflow: ["a ` b", "[A-4](a-4.md)", "c ` d"]'

  assert.deepEqual(links(frontmatter(yaml) as Element), [["a-4.md", "A-4"]])
  assert.deepEqual(
    linksOf(yaml).map(({ url }) => url),
    ["a-4.md"],
  )
})

test("a link reworded by escapes is a link all the same, and moves no other from where it is written", () => {
  const yaml =
    "l:\n  - \"\\x5bA-7](a-7.md) then [A-8](a-8.md) and [A-7](a-7.md)\"\n  - '[A-9''s](a-9.md)'\nm:\n  ? - \"[A-5](a-5.md)\"\n  : v"

  assert.deepEqual(links(frontmatter(yaml) as Element), [
    ["a-7.md", "A-7"],
    ["a-8.md", "A-8"],
    ["a-7.md", "A-7"],
    ["a-9.md", "A-9's"],
  ])
  assert.deepEqual(
    linksOf(yaml).map(({ url, offset }) => [url, yaml.slice(offset, offset + 6)]),
    [
      ["a-7.md", '"\\x5bA'],
      ["a-8.md", "[A-8]("],
      ["a-7.md", "[A-7]("],
      ["a-9.md", "[A-9''"],
    ],
  )
})

test("a comment on a block value's header line holds no link and moves none", () => {
  const yaml = "refs:\n  - | # was [A-6](a-6.md)\n    now [A-6](a-6.md)"

  assert.deepEqual(links(frontmatter(yaml) as Element), [["a-6.md", "A-6"]])
  assert.deepEqual(
    linksOf(yaml).map(({ offset }) => yaml.slice(offset, offset + 6)),
    ["[A-6]("],
  )
  assert.equal(yaml.slice(0, linksOf(yaml)[0].offset).split("\n").length, 3)
})

test("between twins a link is placed at the one written nearest its place, and escaped code stays code", () => {
  const yaml =
    'refs:\n  - "\\x5bA-10](a-10.md) is the old name;\n    see [A-10](a-10.md)"\ncode: ["\\x60[A-11](a-11.md)\\x60 then [A-11](a-11.md)"]'

  assert.deepEqual(links(frontmatter(yaml) as Element), [
    ["a-10.md", "A-10"],
    ["a-10.md", "A-10"],
    ["a-11.md", "A-11"],
  ])
  assert.deepEqual(
    linksOf(yaml).map(({ url, offset }) => [url, yaml.slice(0, offset).split("\n").length]),
    [
      ["a-10.md", 2],
      ["a-10.md", 3],
      ["a-11.md", 4],
    ],
  )
})

test("an address sanitizing would strip stays text, in a value and in a list", () => {
  const table = frontmatter(
    'run: "[go](javascript:alert)"\nlist: ["[go](vbscript:x)", "[mail](mailto:a@example.com)"]',
  ) as Element

  assert.deepEqual(rows(table), [
    ["run", "[go](javascript:alert)"],
    ["list", { list: ["[go](vbscript:x)", "mail"] }],
  ])
  assert.deepEqual(links(table), [["mailto:a@example.com", "mail"]])
})

test("each link the values hold, with the key above it, its value as read, and where it is written", () => {
  const yaml =
    'title: Plan\ndependencies: ["[A-1](./a-1.md)", "[A-2](../archive/a-2.md)"]\nrefs:\n  - kind: source\n    item: "[#12](https://example.com/item/12) (first)"'

  const found = linksOf(yaml)

  assert.deepEqual(
    found.map(({ url, context, offset }) => [url, context, yaml.slice(offset, offset + 6)]),
    [
      ["./a-1.md", "dependencies: A-1", "[A-1]("],
      ["../archive/a-2.md", "dependencies: A-2", "[A-2]("],
      ["https://example.com/item/12", "refs: #12 (first)", "[#12]("],
    ],
  )
  assert.deepEqual(
    found.map(({ context, span }) => context.slice(...span)),
    ["A-1", "A-2", "#12"],
  )
  assert.deepEqual(linksOf("title: [unclosed"), [])
})

test("a link written inside backticks in a value is code, as on the page, and one beside it a link", () => {
  const yaml = "note: see `[a](a.md)` and ``[b `x`](b.md)`` then [c](c.md)"

  assert.deepEqual(
    linksOf(yaml).map(({ url, context }) => [url, context]),
    [["c.md", "note: see `[a](a.md)` and ``[b `x`](b.md)`` then c"]],
  )
  assert.deepEqual(links(frontmatter(yaml) as Element), [["c.md", "c"]])
})
