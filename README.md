# folio

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![Status](https://img.shields.io/badge/status-actively_developed-green.svg)](#)

A markdown server for one folder. folio serves every markdown file, mermaid file and image under a folder to the browser, renders markdown with GitHub-flavoured extensions, math, highlighted code and mermaid diagrams, and updates an open page only when its own file, or a file it includes, changes. A file tree, an outline and the page you are reading share one window, and following a link swaps only the content.

<img src="./docs/images/folio.png" alt="folio showing a page with a formula, highlighted code and a flowchart, between the folder's file tree and the page's outline" />

## Prerequisites

- **Node.js** 22.18 or later

## Installation

```sh
npm install --global @jakubro/folio
```

## Quick start

```sh
folio ~/notes
```

folio prints the address it serves, `http://localhost:8640/` by default; open it in a browser. The page lists the folder; pick a file in the tree to read it. Save a file in your editor and every tab showing it updates in place, keeping its scroll position.

```sh
folio ~/notes --port 9000   # another port
folio                       # the current directory
```

folio listens on localhost only and exits if the port is taken. Stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

## Documentation

Full documentation is published at **[jakubro.github.io/folio](https://jakubro.github.io/folio/)**.

- [Guide](https://jakubro.github.io/folio/guide/) - what folio adds to writing and reading markdown
- [Reference](https://jakubro.github.io/folio/reference/) - every option, key, file type and markdown rule
- [Architecture](https://jakubro.github.io/folio/architecture/) - how folio is put together, for contributors

## Security

folio is a reader: it serves files and never writes one.

- **Localhost only.** The server binds to `127.0.0.1` and refuses any request whose `Host` header is not a localhost name, so a page on another site cannot reach it through a DNS name pointing at your machine. The live-update socket also requires a localhost `Origin`.
- **One folder.** Every path is resolved through symlinks and must land inside the served folder; anything else is not found. Dot-folders and `node_modules` are never listed.
- **No script from content.** Markdown may carry inline HTML, but scripts, event handlers and other executable markup are stripped before a page is drawn, and diagrams render with mermaid's strict security level.

## Contributing

```sh
git clone https://github.com/jakubro/folio.git
cd folio
just install    # dependencies from the lockfile, plus the Chromium build the browser tests drive
just check      # biome, tsc, knip, jscpd, unit tests, build
just e2e        # every documented behaviour in headless Chromium against the built command
just snapshots  # every page, and every picture in the docs, against its recorded image
just --list     # all recipes
```

Development needs [just](https://just.systems/) besides Node.js. `just snapshots` fails naming each image that changed; after a change meant to alter how folio looks, `just update-snapshots` re-records them. The images are taken from the invented folder in `visual/station/`, and folio carries its own fonts, so they do not depend on what a machine has installed. Each recipe tees its output to `/tmp/folio--<recipe>.log`.

## Uninstall

```sh
npm uninstall --global @jakubro/folio
```

## Limitations

- **One folder per process.** Serve another folder by starting folio again on another port.
- **Markdown, mermaid and images.** Other files in the folder are neither listed nor served.
- **Reading, not editing.** Pages are edited in your own editor; folio shows the result.
- **Linux-first.** Developed and tested on Linux.

## Built With

- **Rendering** - [unified](https://unifiedjs.com/) (remark and rehype), [Mermaid](https://mermaid.js.org/), [KaTeX](https://katex.org/), [highlight.js](https://highlightjs.org/), [yaml](https://eemeli.org/yaml/)
- **Server** - [Node.js](https://nodejs.org/), [ws](https://github.com/websockets/ws)
- **Typefaces** - [Arimo](https://github.com/googlefonts/Arimo), [JetBrains Mono](https://www.jetbrains.com/lp/mono/)
- **Toolchain** - [TypeScript](https://www.typescriptlang.org/), [esbuild](https://esbuild.github.io/), [just](https://just.systems/)
- **Testing and quality** - [Playwright](https://playwright.dev/), [Biome](https://biomejs.dev/), [Knip](https://knip.dev/), [jscpd](https://github.com/kucherenko/jscpd)

## License

Copyright (C) 2026 Jakub Roman. Distributed under the [GNU GPL v3](LICENSE).
