import { defineCollection } from "astro:content"
import { readFileSync } from "node:fs"
import { i18nLoader } from "@astrojs/starlight/loaders"
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema"
import { glob, type Loader } from "astro/loaders"

const LEADING_HEADING_RE = /^#\s+(.+)$/m
const OUTLINELESS_RE = /^(guide|reference)\//
const NOT_FOUND = "404"

// docsLoader() cannot be repointed off src/content/docs; glob() can. `parseData` synthesizes
// Starlight's required `title` from each file's H1 - a remark plugin runs after it, too late.
// A guide or reference page has no headings, so its outline would list only Starlight's Overview.
function titledDocsLoader(): Loader {
  const inner = glob({
    pattern: "**/*.md",
    base: "../docs",
    generateId: ({ entry }) => entry.replace(/\.md$/, "").toLowerCase(),
  })

  return {
    name: "titled-docs-loader",
    load: (context) =>
      inner.load({
        ...context,
        parseData: async (props) => {
          if (!props.data.title && props.filePath) {
            const heading = readFileSync(props.filePath, "utf-8").match(LEADING_HEADING_RE)

            if (heading) {
              props.data = { ...props.data, title: heading[1].trim() }
            }
          }

          if (OUTLINELESS_RE.test(props.id)) {
            props.data = { ...props.data, tableOfContents: false }
          }

          // Starlight's own 404 route draws this page; as a draft it is not routed a second time.
          if (props.id === NOT_FOUND) {
            props.data = { ...props.data, draft: true }
          }

          return context.parseData(props)
        },
      }),
  }
}

export const collections = {
  docs: defineCollection({ loader: titledDocsLoader(), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
}
