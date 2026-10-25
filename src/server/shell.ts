/** The HTML every page and listing starts from; the browser fetches and renders the content itself. */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function shell(title: string, rootName: string, build: string): string {
  return `<!doctype html>
<html lang="en" data-root="${escapeHtml(rootName)}" data-build="${escapeHtml(build)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="/?asset=theme.js"></script>
<link rel="stylesheet" href="/?asset=page.css">
</head>
<body>
<script type="module" src="/?asset=page.js"></script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}
