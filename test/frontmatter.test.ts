import assert from "node:assert/strict"
import { test } from "node:test"
import type { Element, ElementContent } from "hast"
import { frontmatter } from "../src/client/frontmatter.ts"

type Cell = string | { yaml: string }

function rows(table: Element | undefined): [string, Cell][] {
  assert.equal(table?.tagName, "table")
  const body = table.children[0] as Element

  return body.children.map((row) => {
    const [key, value] = (row as Element).children as Element[]
    const pre = value.children[0]

    return [
      text(key),
      pre?.type === "element" && pre.tagName === "pre" ? { yaml: text(pre) } : text(value),
    ]
  })
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

test("lists and maps appear as the YAML written, without the indentation of their key", () => {
  assert.deepEqual(
    rows(
      frontmatter(
        "tags: [a, b]\nowner:\n  name: X\n  roles:\n    - lead\nsteps:\n  - one\n  - two\nnote: |\n  line one\n  line two\n",
      ),
    ),
    [
      ["tags", { yaml: "[a, b]" }],
      ["owner", { yaml: "name: X\nroles:\n  - lead" }],
      ["steps", { yaml: "- one\n- two" }],
      ["note", "line one\nline two\n"],
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
