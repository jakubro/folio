import assert from "node:assert/strict"
import { test } from "node:test"
import { imageType } from "../src/client/freeze.ts"

const bytes = (text: string) => new TextEncoder().encode(text)

test("an image whose start is comments built to make the check backtrack is told apart at once", () => {
  const started = Date.now()

  assert.equal(imageType(bytes(`<!--${"--><!--".repeat(146)}`)), undefined)
  assert.ok(Date.now() - started < 200, `told apart in ${Date.now() - started} ms`)
})

test("an SVG behind a byte order mark, an XML declaration, comments and a doctype is an SVG", () => {
  assert.equal(
    imageType(
      bytes(
        '\uFEFF <?xml version="1.0"?>\n<!-- drawn -- by hand --->\n<!---->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
    ),
    "image/svg+xml",
  )
  assert.equal(imageType(bytes("<SVG viewBox='0 0 1 1'></SVG>")), "image/svg+xml")
})

test("text that only looks like an SVG's start is no image", () => {
  assert.deepEqual(
    [
      "<!-- never closed <svg>",
      "<html><svg></svg></html>",
      "<?xml version='1.0'?><note/>",
      "<svgx/>",
      "<!-- a --> text <svg/>",
    ].map((text) => imageType(bytes(text))),
    [undefined, undefined, undefined, undefined, undefined],
  )
})
