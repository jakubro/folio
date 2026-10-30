/** GitHub alerts: a top-level quote whose first line is nothing but `[!NOTE]` or another kind's marker. */

import type { Blockquote, Root } from "mdast"

export const ALERTS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const

const MARKER = /^\[!(note|tip|important|warning|caution)\]/i
const LINE_END = /^(?:\r\n?|\n)/

export function alerts(): (tree: Root) => void {
  return (tree) => {
    for (const node of tree.children) {
      if (node.type === "blockquote") {
        alert(node)
      }
    }
  }
}

function alert(quote: Blockquote): void {
  const [first] = quote.children
  const text = first?.type === "paragraph" ? first.children[0] : undefined
  const match = text?.type === "text" ? MARKER.exec(text.value) : null

  if (first?.type !== "paragraph" || text?.type !== "text" || !match) {
    return
  }

  const rest = text.value.slice(match[0].length)

  if (!LINE_END.test(rest) && !(rest === "" && first.children.length === 1)) {
    return
  }

  const kind = match[1].toLowerCase() as keyof typeof ALERTS
  text.value = rest.replace(LINE_END, "")

  if (text.value === "" && first.children.length === 1) {
    quote.children.shift()
  }

  quote.data = {
    ...quote.data,
    hProperties: { className: ["markdown-alert", `markdown-alert-${kind}`] },
  }
  quote.children.unshift({
    type: "paragraph",
    data: { hProperties: { className: ["markdown-alert-title"] } },
    children: [{ type: "text", value: ALERTS[kind] }],
  })
}
