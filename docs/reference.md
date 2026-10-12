# Reference

## Command line

```text
folio [FOLDER] [--port N]
```

| Argument | Default | |
|---|---|---|
| `FOLDER` | the current directory | The folder to serve |
| `--port N`, `--port=N`, `-p N` | `8640` | The port, 1 to 65535; folio never falls back to another |

folio prints `folio serving <folder> at http://localhost:<port>/`, then one line per request and per update sent to a tab, timed in UTC.

| Error | Exit status |
|---|---|
| More than one folder, an invalid port, an unknown option, or a folder that does not exist | 2 |
| `Port N is already in use.` | 1 |

## Addresses

Every file's address is its path in the folder, so links between files work as they do on disk.

| Address | Shows |
|---|---|
| `/<path>` to a markdown or mermaid file | The rendered page |
| `/<path>` to an image | The image |
| `/<folder>/` | The folder's listing |
| `/<path>?raw` | The file's text with its includes expanded |

## Keyboard and mouse

| Input | Action |
|---|---|
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next page in the tree's order. After a click into a block wider than the page, they scroll that block instead |
| <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> | Hide or show the tree / the outline |
| <kbd>+</kbd> or <kbd>=</kbd>, <kbd>-</kbd> | Zoom the diagram viewer in, out |
| Arrows, drag | Pan the diagram viewer |
| Wheel | Zoom the diagram viewer about the pointer |
| <kbd>Escape</kbd> | Close the diagram viewer |
| Opening a link in a new tab or window | The new tab starts with this tab's theme, width and panels |

## Files

| Kind | Extensions |
|---|---|
| Page | `.md`, `.markdown` |
| Diagram | `.mermaid`, `.mmd` |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.avif`, `.bmp`, `.ico` |

Other files are neither listed nor served. Dot-files, dot-folders and `node_modules` are never listed, and a folder is listed only when something inside it can be shown.

## Markdown

- **Syntax** - GitHub-flavoured markdown: tables, task lists, strikethrough, footnotes and bare links, plus `$...$` and `$$...$$` math. Fenced code is highlighted for the language named after the fence.
- **Headings** - anchors are named as GitHub names them, and GitHub's `#user-content-` form also works.
- **Links** - a link to another site opens in a new tab.
- **HTML** - `<details>`, `<kbd>`, `<mark>`, `<sub>`, `<sup>`, `<abbr>`, definition lists, figures and tables with merged cells render as elements, and may carry `class` and `style`. Scripts, event handlers and `javascript:` links are removed.
- **Frontmatter** - shows as one table row per key, values exactly as written, lists and maps as highlighted YAML. Frontmatter that is not a valid YAML map shows as a YAML block above the page.
- **Loose tables** - extra cells widen the table under empty header cells, missing cells are left empty, and two or more lines starting or ending with a pipe form a table even without a divider line - headerless when there is none. A single pipe line, and pipes in code, stay as written.
- **Includes** - `{include: path}` resolves against the including file's folder, or the served folder when the path starts with `/`, and expands at any depth. A missing file, a path outside the served folder or a cycle expands to nothing. It is replaced everywhere, code blocks included. A page updates when any file it includes is saved or created.
