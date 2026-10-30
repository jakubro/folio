import assert from "node:assert/strict"
import { test } from "node:test"
import rehypeStringify from "rehype-stringify"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { alerts } from "../src/client/alerts.ts"

const PROCESSOR = unified().use(remarkParse).use(alerts).use(remarkRehype).use(rehypeStringify)

test("an alert is a callout whatever line endings its file uses", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const html = String(PROCESSOR.processSync(["> [!WARNING]", "> Valve open."].join(ending)))

    assert.match(html, /<blockquote class="markdown-alert markdown-alert-warning">/, ending)
    assert.match(html, /<p class="markdown-alert-title">Warning<\/p>/, ending)
    assert.doesNotMatch(html, /\[!WARNING\]/, ending)
    assert.match(html, /<p>Valve open\.<\/p>/, ending)
  }
})
