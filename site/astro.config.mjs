import { fileURLToPath } from "node:url"

import { unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import mermaid from "astro-mermaid"
import starlightThemeRapide from "starlight-theme-rapide"

import { dropLeadingHeading } from "./src/plugins/drop-leading-heading.mjs"
import { rewriteMarkdownLinks } from "./src/plugins/rewrite-markdown-links.mjs"
import { unescapeIncludes } from "./src/plugins/unescape-includes.mjs"

const BASE = "/folio"
const DOCS_ROOT = fileURLToPath(new URL("../docs", import.meta.url))
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Where a link the site does not publish is sent; pinned to the published branch. */
const REPOSITORY = "https://github.com/jakubro/folio"
const REF = "main"

const GUIDE = ["reading", "writing", "data", "keeping-up", "trust", "agents-editors-and-ci"]
const REFERENCE = [
  "command-line",
  "addresses",
  "model-api",
  "editors",
  "keyboard-and-mouse",
  "files",
  "data-files",
  "embedded-data",
  "components",
  "queries",
  "reading",
  "history",
  "digests",
  "conventions",
  "saved-views",
  "markdown",
  "security-and-limits",
]

/**
 * The reading path: get running, see what Folio adds, look something up. The contributor document
 * sits last under an internal label, so it is not read as a promise.
 */
const SIDEBAR = [
  { label: "Start here", slug: "index" },
  { label: "Guide", items: GUIDE.map((page) => ({ slug: `guide/${page}` })) },
  { label: "Reference", items: REFERENCE.map((page) => ({ slug: `reference/${page}` })) },
  {
    label: "Internal",
    collapsed: true,
    items: [{ label: "Architecture", slug: "architecture" }],
  },
]

export default defineConfig({
  site: "https://jakubro.github.io",
  base: BASE,
  trailingSlash: "always",
  markdown: {
    processor: unified({
      smartypants: false,
      remarkPlugins: [
        dropLeadingHeading,
        [
          rewriteMarkdownLinks,
          {
            docsRoot: DOCS_ROOT,
            repoRoot: REPO_ROOT,
            base: BASE,
            repository: REPOSITORY,
            ref: REF,
          },
        ],
        unescapeIncludes,
      ],
    }),
  },
  // Mermaid's layout engine and core are single modules of 1.4 MB and 0.6 MB that no split can cut.
  vite: { build: { chunkSizeWarningLimit: 1500 } },
  integrations: [
    // Claims fenced mermaid blocks before Starlight's renderer sees them, so it must stay first.
    mermaid({ autoTheme: true }),
    starlight({
      title: "Folio",
      plugins: [starlightThemeRapide()],
      components: { ThemeProvider: "./src/components/ThemeProvider.astro" },
      // Inlined rather than emitted, or code blocks lose their styling in the dev server:
      // trailingSlash "always" appends a slash to the hashed /_astro/ec.<hash>.css route, so it never matches.
      expressiveCode: { emitExternalStylesheet: false },
      sidebar: SIDEBAR,
      social: [{ icon: "github", label: "GitHub", href: REPOSITORY }],
    }),
  ],
})
