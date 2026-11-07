import assert from "node:assert/strict"
import { test } from "node:test"
import {
  compareCells,
  inQuotes,
  matcherOf,
  numberOf,
  valuesIn,
  wanted,
} from "../src/client/tableviews.ts"

test("cells written as numbers read as numbers, separators, signs, percent and currency included", () => {
  assert.deepEqual(
    ["12", "1,204", "-3.5", "+7", "\u22122", "40%", "$9.99", "1e3", " 8 "].map(numberOf),
    [12, 1204, -3.5, 7, -2, 40, 9.99, 1000, 8],
  )
})

test("cells holding text, dates or several numbers are not numbers", () => {
  assert.deepEqual(["", "A-12", "2026-10-14", "1.2.3", "12 apples", "n/a"].map(numberOf), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
})

test("numbers sort by value, not as text", () => {
  assert.deepEqual(
    ["10", "9", "100", "-1", "2.5"].sort((a, b) => compareCells(a, b)),
    ["-1", "2.5", "9", "10", "100"],
  )
})

test("text sorts with embedded numbers in reading order, ignoring case", () => {
  assert.deepEqual(
    ["item 10", "Item 2", "item 1", "beta"].sort((a, b) => compareCells(a, b)),
    ["beta", "item 1", "Item 2", "item 10"],
  )
})

test("numbers come before text, and blank cells come last in either direction", () => {
  const cells = ["b", "", "3", "a", "1"]

  assert.deepEqual(
    [...cells].sort((a, b) => compareCells(a, b)),
    ["1", "3", "a", "b", ""],
  )
  assert.deepEqual(
    [...cells].sort((a, b) => compareCells(a, b, true)),
    ["b", "a", "3", "1", ""],
  )
})

test("separators count only between groups of three digits, so several numbers in a cell are text", () => {
  assert.deepEqual(["3 4", "1,5", "12,34", "1,23,456"].map(numberOf), [
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  assert.deepEqual(
    ["1 234", "1_000", "1,234,567.5", "-$1,204", "12,345%"].map(numberOf),
    [1234, 1000, 1234567.5, -1204, 12345],
  )
})

test("a sign, a currency mark or a percent sign set apart by a space still leaves a number", () => {
  assert.deepEqual(["$ 100", "100 %", "- 5", "$ 1,204"].map(numberOf), [100, 100, -5, 1204])
})

test("a cell of many spaces or digits before a letter reads as text at once", () => {
  const started = Date.now()

  assert.deepEqual([`1${" ".repeat(40_000)}x`, `${"1".repeat(40_000)}x`].map(numberOf), [
    undefined,
    undefined,
  ])
  assert.ok(Date.now() - started < 200, `read in ${Date.now() - started} ms`)
})

test("a filter's values: quotes ask for a whole cell as written, * and ? for a pattern of it, other text is found within", () => {
  assert.deepEqual(
    [
      '"open"',
      ' " Open " ',
      '""',
      '"op',
      '"',
      "open",
      'open"',
      'a "b" c',
      '"tag":"k3"',
      '"no*"',
      "n*th",
      "op | ",
    ].map(wanted),
    [
      [{ pieces: ["open"], whole: true }],
      [{ pieces: ["Open"], whole: true }],
      [{ pieces: [""], whole: true }],
      [{ pieces: ["op"], whole: false }],
      [],
      [{ pieces: ["open"], whole: false }],
      [{ pieces: ['open"'], whole: false }],
      [{ pieces: ['a "b" c'], whole: false }],
      [{ pieces: ['"tag":"k3"'], whole: false }],
      [{ pieces: ["no*"], whole: true }],
      [{ pieces: ["n", { wild: "*" }, "th"], whole: true }],
      [{ pieces: ["op"], whole: false }],
    ],
  )
})

test("a filter reads escapes, wildcards and values parted by bars", () => {
  const cells = [
    "north",
    "south",
    "east",
    "ninth",
    "month",
    "open",
    "review",
    "closed",
    "reopened",
    '{"id": 3}',
    'say "hi"',
    '"open"',
    "C:\\Users",
    "a\\b",
    "5*3",
    "a|b",
    "no*",
  ]
  const kept = (typed: string) => cells.filter(matcherOf(typed, true))

  assert.deepEqual(
    {
      quoteAtStart: kept('\\"id'),
      equalQuotesInside: kept('"say \\"hi\\""'),
      quotesKept: kept('\\"open\\"'),
      backslash: kept("C:\\Users"),
      literalBackslash: kept("a\\\\b"),
      pattern: kept("n*th"),
      startsWith: kept("no*"),
      endsWith: kept("*th"),
      oneCharacter: kept("s?uth"),
      literalStar: kept("5\\*3"),
      caseOf: kept("NO*"),
      quotedStar: kept('"no*"'),
      severalValues: kept('"open" | "review"'),
      patternsAsValues: kept("op* | rev*"),
      mixed: kept('"open" | clo'),
      literalBar: kept("a\\|b"),
      typing: kept("open |"),
      lone: kept('"').length,
      records: cells.filter(matcherOf('"no*"', false)),
    },
    {
      quoteAtStart: ['{"id": 3}'],
      equalQuotesInside: ['say "hi"'],
      quotesKept: ['"open"'],
      backslash: ["C:\\Users"],
      literalBackslash: ["a\\b"],
      pattern: ["north", "ninth"],
      startsWith: ["north", "no*"],
      endsWith: ["north", "south", "ninth", "month"],
      oneCharacter: ["south"],
      literalStar: ["5*3"],
      caseOf: ["north", "no*"],
      quotedStar: ["no*"],
      severalValues: ["open", "review"],
      patternsAsValues: ["open", "review"],
      mixed: ["open", "closed"],
      literalBar: ["a|b"],
      typing: ["open", "reopened", '"open"'],
      lone: cells.length,
      records: [],
    },
  )
})

test("a value written in quotes escapes what a filter would read otherwise, and keeps only that value", () => {
  const values = ['say "hi"', "5*3", "a|b", "C:\\Users", "a\\*b?", "plain"]

  assert.deepEqual(values.map(inQuotes), [
    '"say \\"hi\\""',
    '"5\\*3"',
    '"a\\|b"',
    '"C:\\\\Users"',
    '"a\\\\\\*b\\?"',
    '"plain"',
  ])
  assert.deepEqual(
    values.map((value) => values.filter(matcherOf(inQuotes(value), true))),
    values.map((value) => [value]),
  )
})

test("cells' values are told apart as quotes match them, shown as most write them, most common first, blanks left out", () => {
  assert.deepEqual(
    valuesIn([
      "open",
      "Open",
      " open ",
      "closed",
      "",
      "  ",
      "waiting",
      "10",
      "9",
      "OPEN",
      "closed",
    ]),
    [
      ["open", 4],
      ["closed", 2],
      ["9", 1],
      ["10", 1],
      ["waiting", 1],
    ],
  )
})
