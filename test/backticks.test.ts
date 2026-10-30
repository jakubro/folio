import assert from "node:assert/strict"
import { test } from "node:test"
import type { Paragraph, Root } from "mdast"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { backticks } from "../src/client/backticks.ts"

const PROCESSOR = unified().use(remarkParse).use(remarkMath).use(backticks)

function inline(markdown: string): string[] {
  const [paragraph] = (PROCESSOR.parse(markdown) as Root).children as Paragraph[]
  return paragraph.children.map((node) => `${node.type}:${"value" in node ? node.value : ""}`)
}

test("a form broken across lines is a dollar, code read as a code span reads, and a dollar", () => {
  assert.deepEqual(inline("Ticks $`a` b\nc`$ then $e$."), [
    "text:Ticks $",
    "inlineCode:a` b\nc",
    "text:$ then ",
    "inlineMath:e",
    "text:.",
  ])
  assert.deepEqual(inline("Padded $` p\nq `$ end."), [
    "text:Padded $",
    "inlineCode:p\nq",
    "text:$ end.",
  ])
  assert.deepEqual(inline("Spaces $`  \n  `$ only."), [
    "text:Spaces $",
    "inlineCode:  \n  ",
    "text:$ only.",
  ])
})
