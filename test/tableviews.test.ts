import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCells, numberOf } from "../src/client/tableviews.ts";

test("cells written as numbers read as numbers, separators, signs, percent and currency included", () => {
  assert.deepEqual(
    ["12", "1,204", "-3.5", "+7", "\u22122", "40%", "$9.99", "1e3", " 8 "].map(numberOf),
    [12, 1204, -3.5, 7, -2, 40, 9.99, 1000, 8],
  );
});

test("cells holding text, dates or several numbers are not numbers", () => {
  assert.deepEqual(["", "A-12", "2026-10-14", "1.2.3", "12 apples", "n/a"].map(numberOf), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("numbers sort by value, not as text", () => {
  assert.deepEqual(
    ["10", "9", "100", "-1", "2.5"].sort((a, b) => compareCells(a, b)),
    ["-1", "2.5", "9", "10", "100"],
  );
});

test("text sorts with embedded numbers in reading order, ignoring case", () => {
  assert.deepEqual(
    ["item 10", "Item 2", "item 1", "beta"].sort((a, b) => compareCells(a, b)),
    ["beta", "item 1", "Item 2", "item 10"],
  );
});

test("numbers come before text, and blank cells come last in either direction", () => {
  const cells = ["b", "", "3", "a", "1"];

  assert.deepEqual(
    [...cells].sort((a, b) => compareCells(a, b)),
    ["1", "3", "a", "b", ""],
  );
  assert.deepEqual(
    [...cells].sort((a, b) => compareCells(a, b, true)),
    ["b", "a", "3", "1", ""],
  );
});

test("separators count only between groups of three digits, so several numbers in a cell are text", () => {
  assert.deepEqual(["3 4", "1,5", "12,34", "1,23,456"].map(numberOf), [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  assert.deepEqual(
    ["1 234", "1_000", "1,234,567.5", "-$1,204", "12,345%"].map(numberOf),
    [1234, 1000, 1234567.5, -1204, 12345],
  );
});

test("a sign, a currency mark or a percent sign set apart by a space still leaves a number", () => {
  assert.deepEqual(["$ 100", "100 %", "- 5", "$ 1,204"].map(numberOf), [100, 100, -5, 1204]);
});
