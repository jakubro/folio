/** The allow-list inline HTML is sanitized against before a page draws it. */

import { defaultSchema } from "rehype-sanitize"

const EXTRA_TAGS = [
  "details",
  "summary",
  "kbd",
  "mark",
  "sub",
  "sup",
  "abbr",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "section",
  "article",
  "aside",
  "time",
  "wbr",
  "bdi",
  "bdo",
  "caption",
  "colgroup",
  "col",
  "u",
  "small",
  "cite",
  "dfn",
  "data",
]
const base = defaultSchema.attributes ?? {}
/** The HTML a page may carry: GitHub's set, plus the tags and attributes folio renders beyond it. */
export const SCHEMA = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), ...EXTRA_TAGS])],
  attributes: {
    ...base,
    "*": [...(base["*"] ?? []), "className", "style"],
    a: [...(base.a ?? []), "target", "rel"],
    td: [...(base.td ?? []), "colSpan", "rowSpan", "align"],
    th: [...(base.th ?? []), "colSpan", "rowSpan", "align"],
    details: [...(base.details ?? []), "open"],
    time: [...(base.time ?? []), "dateTime"],
    data: ["value"],
  },
}
