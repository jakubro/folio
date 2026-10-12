import assert from "node:assert/strict";
import { test } from "node:test";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { table, tables } from "../src/client/tables.ts";

const PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(tables)
  .use(remarkRehype, { handlers: { table } })
  .use(rehypeStringify);

function html(markdown: string): string {
  return String(PROCESSOR.processSync(markdown)).replaceAll(">\n<", "><");
}

const AB_12 =
  "<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>";

test("a row wider than the header widens the table under empty header cells", () => {
  assert.equal(
    html("|foo|\n|---|\n|baz|bar|"),
    "<table><thead><tr><th>foo</th><th></th></tr></thead>" +
      "<tbody><tr><td>baz</td><td>bar</td></tr></tbody></table>",
  );
});

test("uneven rows take the widest row's width, missing cells blank", () => {
  assert.equal(
    html("|h|\n|-|\n|a|\n|b|c|d|\n|e|f|"),
    "<table><thead><tr><th>h</th><th></th><th></th></tr></thead><tbody>" +
      "<tr><td>a</td><td></td><td></td></tr>" +
      "<tr><td>b</td><td>c</td><td>d</td></tr>" +
      "<tr><td>e</td><td>f</td><td></td></tr></tbody></table>",
  );
});

test("pipe lines with no delimiter line form a table with no header", () => {
  assert.equal(html("|a|b|\n|1|2|"), AB_12);
});

test("a headerless table takes its widest row's width", () => {
  assert.equal(
    html("|a|\n|1|2|"),
    "<table><tbody><tr><td>a</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("a missing leading or trailing pipe is tolerated, with or without a delimiter line", () => {
  assert.equal(html("|a|b\n|1|2"), AB_12);
  assert.equal(html("a|b|\n1|2|"), AB_12);
  assert.equal(
    html("|a|b\n|-|-\n|1|2"),
    "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("prose with a pipe, a lone pipe line and pipes inside code stay prose", () => {
  assert.equal(html("pick x | y"), "<p>pick x | y</p>");
  assert.equal(html("pick x | y\nor a | b"), "<p>pick x | y\nor a | b</p>");
  assert.equal(html("before\n\n|a|b|\n\nafter"), "<p>before</p><p>|a|b|</p><p>after</p>");
  assert.equal(html("`|a|` x\n`|b|` y"), "<p><code>|a|</code> x\n<code>|b|</code> y</p>");
  assert.equal(html("x \\|\ny \\|"), "<p>x |\ny |</p>");
});

test("pipe lines in a fenced code block stay code", () => {
  assert.equal(html("```\n|a|b|\n|1|2|\n```"), "<pre><code>|a|b|\n|1|2|\n</code></pre>");
});

test("a well-formed table renders as GFM renders it", () => {
  assert.equal(
    html("|a|b|\n|:-|-:|\n|1|2|"),
    '<table><thead><tr><th align="left">a</th><th align="right">b</th></tr></thead>' +
      '<tbody><tr><td align="left">1</td><td align="right">2</td></tr></tbody></table>',
  );
});

test("prose above pipe lines stays a paragraph before the table, and ends it below", () => {
  assert.equal(html("Intro\n|a|b|\n|1|2|\nafter"), `<p>Intro</p>${AB_12}<p>after</p>`);
});

test("pipe lines in a quote and in a list item form a table", () => {
  assert.equal(html("> |a|b|\n> |1|2|"), `<blockquote>${AB_12}</blockquote>`);
  assert.equal(html("- |a|b|\n  |1|2|"), `<ul><li>${AB_12}</li></ul>`);
});

test("references in a headerless table resolve against the page's definitions", () => {
  assert.equal(
    html("|[x][r]|b|\n|1|2|\n\n[r]: /u"),
    '<table><tbody><tr><td><a href="/u">x</a></td><td>b</td></tr>' +
      "<tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("a paragraph whose prose would read as another block once split stays as written", () => {
  assert.equal(html("|a|\n|b|\n2. x"), "<p>|a|\n|b|\n2. x</p>");
});

test("pipe lines inside code, math, a link or emphasis spanning lines stay inside it", () => {
  assert.equal(html("x `a\n|b|\n|c|` y"), "<p>x <code>a |b| |c|</code> y</p>");
  assert.equal(
    html("$a\n|b|\n|c|\nd$"),
    '<p><code class="language-math math-inline">a\n|b|\n|c|\nd</code></p>',
  );
  assert.equal(html("[x\n|b|\n|c|](/u)"), '<p><a href="/u">x\n|b|\n|c|</a></p>');
  assert.equal(html("*a\n|b|\n|c|*"), "<p><em>a\n|b|\n|c|</em></p>");
});

test("a hard break in the prose above a table is kept", () => {
  assert.equal(html("foo  \nbar\n|a|b|\n|1|2|"), `<p>foo<br>\nbar</p>${AB_12}`);
});

test("a pipe after an escaped backslash is an edge pipe", () => {
  assert.equal(
    html("x\\\\|\ny\\\\|"),
    "<table><tbody><tr><td>x\\</td></tr><tr><td>y\\</td></tr></tbody></table>",
  );
});

test("a divider line with a different cell count still separates the header", () => {
  const headed =
    "<table><thead><tr><th>a</th><th></th></tr></thead>" +
    "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>";

  assert.equal(html("|a|\n|---|---|\n|1|2|"), headed);
  assert.equal(html("|a|\n|---|---|  \n|1|2|"), headed);
  assert.equal(
    html("|a|b|\n|---|\n|1|2|"),
    "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
  assert.equal(
    html("|a|\n|:-:|--:|\n|1|2|"),
    '<table><thead><tr><th align="center">a</th><th align="right"></th></tr></thead>' +
      '<tbody><tr><td align="center">1</td><td align="right">2</td></tr></tbody></table>',
  );
});
