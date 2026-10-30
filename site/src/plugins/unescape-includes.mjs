import { visit } from "unist-util-visit"

/** Kept in step with TOKEN in src/server/includes.ts by hand. */
const ESCAPED_INCLUDE = /\\(\{include:\s*[^}\n[\]{"',]*?\s*\})/g

/**
 * folio drops the backslash that keeps `\{include: path}` from expanding, code included; markdown
 * drops it only outside code, so this drops it inside.
 */
export function unescapeIncludes() {
  return (tree) => {
    visit(tree, ["inlineCode", "code"], (node) => {
      node.value = node.value.replace(ESCAPED_INCLUDE, "$1")
    })
  }
}
