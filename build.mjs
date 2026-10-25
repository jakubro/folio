/** Builds the published package into dist/: the command, and the page script and styles it serves. */

import fs from "node:fs";
import { build } from "esbuild";

const HERE = import.meta.dirname;
const OUT = `${HERE}/dist`;
const STYLES = `${HERE}/node_modules/highlight.js/styles`;

/**
 * highlight.js ships one stylesheet per theme; nesting each under its theme makes the switch pure CSS.
 * :where() keeps the theme selector weightless, so the page's own code-block rules still win.
 */
const highlightThemes = {
  name: "highlight-themes",
  setup(builder) {
    builder.onResolve({ filter: /^folio:highlight-themes$/ }, (args) => ({
      path: args.path,
      namespace: "highlight-themes",
    }));
    builder.onLoad({ filter: /.*/, namespace: "highlight-themes" }, () => ({
      loader: "css",
      contents: [
        ["light", "github.css"],
        ["dark", "github-dark.css"],
      ]
        .map(
          ([theme, file]) =>
            `:where(:root[data-theme="${theme}"]) {\n${fs.readFileSync(`${STYLES}/${file}`, "utf8")}\n}`,
        )
        .join("\n"),
    }));
  },
};

fs.rmSync(OUT, { recursive: true, force: true });

await build({
  absWorkingDir: HERE,
  entryPoints: {
    cli: "src/cli.ts",
    "index-worker": "src/server/index-worker.ts",
    "yaml-worker": "src/server/yaml-worker.ts",
    "sqlite-reader": "src/server/sqlite-reader.ts",
    "draw-worker": "src/server/draw-worker.ts",
  },
  bundle: true,
  // A native addon: it ships as a runtime dependency and loads from node_modules.
  external: ["@duckdb/node-api"],
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CommonJS dependencies require Node built-ins, which an ES module has no require() for.
  banner: {
    js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
  outdir: OUT,
  logLevel: "warning",
});

const browser = {
  absWorkingDir: HERE,
  bundle: true,
  format: "esm",
  target: "chrome120",
  minify: true,
  outdir: OUT,
  // KaTeX lists woff2 first, which every supported browser takes; the fallbacks would only add weight.
  loader: { ".woff2": "dataurl", ".woff": "empty", ".ttf": "empty" },
  plugins: [highlightThemes],
  legalComments: "linked",
  logLevel: "warning",
};

// Chunks load through the asset query: a relative chunk URL would land in the served folder's address space.
await build({
  ...browser,
  entryPoints: [{ in: "src/client/page.ts", out: "page" }],
  splitting: true,
  chunkNames: "chunk-[hash]",
  publicPath: "/?asset=",
});

// A frozen page has no server to load chunks from, so its script is one file.
await build({
  ...browser,
  entryPoints: [{ in: "src/client/snapshot.ts", out: "snapshot" }],
  format: "iife",
});

// Built apart: theme.js is a classic script, which cannot import a chunk shared with the page.
await build({
  ...browser,
  entryPoints: [
    { in: "src/client/page.css", out: "page" },
    { in: "src/client/theme.ts", out: "theme" },
  ],
});
