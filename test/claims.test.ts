import assert from "node:assert/strict"
import { test } from "node:test"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import rehypeStringify from "rehype-stringify"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { verdict } from "../src/client/claims.ts"
import { blocks } from "../src/server/blocks.ts"

test("a figure matches its data at the precision it was typed with", () => {
  assert.equal(verdict("81.0%", 0.8104).state, "matching")
  assert.equal(verdict("81%", 0.806).state, "matching")
  assert.deepEqual(verdict("81%", 0.816), { state: "contradicted", live: "82%" })
  assert.equal(verdict("81.0%", 0.8156).state, "contradicted")
})

test("a percentage matches a value already in percent, and units scale the value", () => {
  assert.equal(verdict("81%", 80.6).state, "matching")
  assert.deepEqual(verdict("1%", 0.6), { state: "contradicted", live: "60%" })
  assert.deepEqual(verdict("5%", 0.5), { state: "contradicted", live: "50%" })
  assert.equal(verdict("0.8%", 0.008).state, "matching")
  assert.equal(verdict("$4.2M", 4_213_000).state, "matching")
  assert.deepEqual(verdict("1,234", 1_240), { state: "contradicted", live: "1,240" })
  assert.equal(verdict("-3", -2.6).state, "matching")
})

test("a figure that is no number matches only the same text", () => {
  assert.equal(verdict("yes", "yes").state, "matching")
  assert.deepEqual(verdict("yes", false), { state: "contradicted", live: "false" })
})

test("a block records each tied figure, outside code, and reads its data", () => {
  const [prose, code] = blocks(
    [
      "Uptake was <data value=\"rates.csv#0.pct\">81.0%</data> and **<data value='#q#0.n'>1,204</data>** users.",
      "",
      "```html",
      '<data value="x.csv">9</data>',
      "```",
    ].join("\n"),
    "markdown",
  )

  assert.deepEqual(prose.claims, [
    { reference: "rates.csv#0.pct", figure: "81.0%" },
    { reference: "#q#0.n", figure: "1,204" },
  ])
  assert.deepEqual(prose.references, ["rates.csv#0.pct", "#q#0.n"])
  assert.equal(code.claims, undefined)
})

test("outside folio, under GitHub's sanitizing, a tied figure reads as typed", async () => {
  const html = String(
    await unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize)
      .use(rehypeStringify)
      .process('Uptake was <data value="rates.csv#0.pct">81.0%</data> overall.'),
  )

  assert.equal(html, "<p>Uptake was 81.0% overall.</p>")
})

test("a tie is found whatever other attributes it carries, its value quoted or not, and only with a figure", () => {
  const [prose] = blocks(
    'A <data class="x" value=a.csv#0.n>7</data>, b <data value="b.csv"></data>.',
    "markdown",
  )

  assert.deepEqual(prose.claims, [{ reference: "a.csv#0.n", figure: "7" }])
})

test("a typed date matches the date its data holds, at the parts typed, and is written back as typed", () => {
  assert.equal(verdict("2026-10-15", "2026-10-15T00:00:00.000Z").state, "matching")
  assert.equal(verdict("15 Oct 2026", "2026-10-15T14:30:00.000Z").state, "matching")
  assert.equal(verdict("October 15, 2026", "2026-10-15").state, "matching")
  assert.equal(verdict("Oct 2026", "2026-10-02T00:00:00.000Z").state, "matching")
  assert.deepEqual(verdict("15 Oct 2026", "2026-10-16T00:00:00.000Z"), {
    state: "contradicted",
    live: "16 Oct 2026",
  })
  assert.deepEqual(verdict("2026-10-15 14:30", "2026-10-15T14:45:00.000Z"), {
    state: "contradicted",
    live: "2026-10-15 14:45",
  })
})

test("a time typed against a date with no time reads the date at its midnight, UTC", () => {
  assert.equal(verdict("2026-10-01 00:00", "2026-10-01").state, "matching")
  assert.equal(verdict("2026-10-01T02:00+02:00", "2026-10-01").state, "matching")
  assert.deepEqual(verdict("2026-10-01 14:30", "2026-10-01"), {
    state: "contradicted",
    live: "2026-10-01 00:00",
  })
  assert.deepEqual(verdict("2026-10-01 00:00:30", "2026-10-01"), {
    state: "contradicted",
    live: "2026-10-01 00:00:00",
  })
})

test("a sign may stand before a currency mark, and is written back there", () => {
  assert.equal(verdict("-$5", -5).state, "matching")
  assert.deepEqual(verdict("-$5", -7), { state: "contradicted", live: "-$7" })
  assert.deepEqual(verdict("$-5", -7), { state: "contradicted", live: "$-7" })
})

test("a time typed with an offset is compared in that offset, and a slashed date reads day first", () => {
  assert.equal(verdict("2026-10-15T16:45+02:00", "2026-10-15T14:45:00.000Z").state, "matching")
  assert.deepEqual(verdict("2026-10-15 16:45+02:00", "2026-10-15T15:00:00.000Z"), {
    state: "contradicted",
    live: "2026-10-15 17:00+02:00",
  })
  assert.equal(verdict("15/10/2026", "2026-10-15T00:00:00.000Z").state, "matching")
  assert.equal(verdict("10/15/2026", "2026-10-15").state, "matching")
  assert.deepEqual(verdict("05/10/2026", "2026-10-06"), {
    state: "contradicted",
    live: "06/10/2026",
  })
})

test("a range cannot be checked against one number, and a date is no range", () => {
  assert.throws(() => verdict("29-56%", 0.4), /range/)
  assert.throws(() => verdict("81% to 82%", 0.81), /range/)
  assert.equal(verdict("2026-10-15", 5).state, "contradicted")
  assert.equal(verdict("2026-10", 5).state, "contradicted")
  assert.equal(verdict("-3", -2.6).state, "matching")
})
