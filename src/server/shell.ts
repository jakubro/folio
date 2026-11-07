/** The HTML every page and listing starts from; the browser fetches and renders the content itself. */

import path from "node:path"

export const TAB_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#93c5fd"/><path d="M16 7H9v11M9 12h5" fill="none" stroke="#1e3a8a" stroke-width="2"/></svg>'
const TAB_ICON = `data:image/svg+xml,${encodeURIComponent(TAB_ICON_SVG)}`
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
}

export function shell(title: string, root: string, build: string, missing = false): string {
  return `<!doctype html>
<html lang="en" data-root="${escapeHtml(path.basename(root))}" data-folder="${escapeHtml(root)}" data-build="${escapeHtml(build)}"${missing ? " data-missing" : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="${TAB_ICON}">
<script src="/?asset=theme.js"></script>
<link rel="stylesheet" href="/?asset=page.css">
</head>
<body>
<script type="module" src="/?asset=page.js"></script>
</body>
</html>
`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c])
}
