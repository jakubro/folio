/**
 * A document's history as pages: its timeline, any version read only, two versions side by side,
 * one block's past, and the results an embed has shown.
 */

import type { BlockVersion, Paired, ValueResult, Version } from "../server/history.ts"
import { diffRuns } from "./diff.ts"
import { render, type Theme } from "./render.ts"
import { href } from "./tree.ts"

interface Timeline {
  path: string
  versions: Version[]
  values: string[]
}

const NO_SOURCES = { blocks: [], layout: { instances: [], owners: [] } }
const SEEN = { saved: "saved", committed: "committed", file: "on disk" }

export async function historyPage(
  urlPath: string,
  query: URLSearchParams,
  theme: Theme,
): Promise<HTMLElement | undefined> {
  const at = query.get("at")
  const compare = query.get("compare")
  const block = query.get("block")
  const embed = query.get("embed")

  if (at) {
    return pastVersion(urlPath, at, theme)
  }

  if (compare) {
    return comparison(urlPath, compare)
  }

  if (block) {
    return blockPast(urlPath, block)
  }

  if (embed) {
    return valuePast(urlPath, embed)
  }

  const timeline = await json<Timeline>(urlPath, "versions")
  return timeline && timelineOf(urlPath, timeline)
}

function when(at: number | string): string {
  return new Date(at).toLocaleString()
}

function timelineOf(urlPath: string, { versions, values }: Timeline): HTMLElement {
  const element = page(`History of ${name(urlPath)}`, urlPath)
  const list = document.createElement("ol")
  const compare = Object.assign(document.createElement("button"), {
    type: "button",
    className: "history-compare",
    textContent: "Compare the two picked",
    disabled: true,
  })
  const picked = () =>
    [...list.querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value)

  list.className = "history-timeline"
  list.append(
    ...versions.map((version) => {
      const item = document.createElement("li")
      const time = Object.assign(document.createElement("time"), {
        dateTime: new Date(version.at).toISOString(),
        textContent: when(version.at),
      })
      const detail = Object.assign(document.createElement("span"), {
        className: "history-detail",
        textContent: [
          version.removed ? "removed" : version.seen.map((seen) => SEEN[seen]).join(", "),
          version.by && `by ${version.by}`,
        ]
          .filter(Boolean)
          .join(" "),
      })

      if (version.removed) {
        item.append(time, " ", detail)
        return item
      }

      const box = Object.assign(document.createElement("input"), {
        type: "checkbox",
        value: version.id,
        title: "Pick to compare",
      })
      const open = Object.assign(document.createElement("a"), {
        href: `${href(urlPath)}?history&at=${version.id}`,
        textContent: "Open",
      })

      box.addEventListener("change", () => {
        const chosen = picked()

        if (chosen.length > 2) {
          box.checked = false
        }

        compare.disabled = picked().length !== 2
      })
      item.append(box, " ", time, " ", detail, " ", open)
      return item
    }),
  )
  compare.addEventListener("click", () => {
    // The list runs newest first, so the later pick is the older version.
    const [newer, older] = picked()
    location.assign(`${href(urlPath)}?history&compare=${older},${newer}`)
  })
  element.append(
    versions.length > 0 ? list : paragraph("No history: no git repository and no save seen yet."),
    compare,
  )

  if (values.length > 0) {
    const embeds = document.createElement("ul")

    embeds.append(
      ...values.map((reference) => {
        const item = document.createElement("li")
        item.append(
          Object.assign(document.createElement("a"), {
            href: `${href(urlPath)}?history&embed=${encodeURIComponent(reference)}`,
            textContent: reference,
          }),
        )
        return item
      }),
    )
    element.append(
      Object.assign(document.createElement("h2"), { textContent: "Embedded data" }),
      embeds,
    )
  }

  return element
}

async function pastVersion(urlPath: string, id: string, theme: Theme): Promise<HTMLElement> {
  const [found, timeline] = await Promise.all([
    json<{ text?: string }>(urlPath, `version=${encodeURIComponent(id)}`),
    json<Timeline>(urlPath, "versions"),
  ])
  const version = timeline?.versions.find((other) => other.id === id)

  if (found?.text === undefined) {
    const missing = page(`History of ${name(urlPath)}`, urlPath)
    missing.append(paragraph("This version is not known."))
    return missing
  }

  const kind = /\.(mermaid|mmd)$/i.test(urlPath) ? "mermaid" : "markdown"
  const article = await render(found.text, NO_SOURCES, kind, theme, document, true)
  const banner = document.createElement("p")

  banner.className = "history-banner"
  banner.append(
    `${name(urlPath)} as it was ${version ? when(version.at) : ""} - read only. `,
    Object.assign(document.createElement("a"), {
      href: `${href(urlPath)}?history`,
      textContent: "All versions",
    }),
  )
  article.classList.add("view", "past")
  article.prepend(banner)
  return article
}

async function comparison(urlPath: string, compare: string): Promise<HTMLElement> {
  const [from, to] = compare.split(",")
  const [found, timeline] = await Promise.all([
    json<{ pairs: Paired[] }>(urlPath, `compare=${encodeURIComponent(compare)}`),
    json<Timeline>(urlPath, "versions"),
  ])
  const at = (id: string) => {
    const version = timeline?.versions.find((other) => other.id === id)
    return version ? when(version.at) : "an unknown version"
  }
  const element = page(`${name(urlPath)}: ${at(from)} against ${at(to)}`, urlPath)
  const table = document.createElement("table")

  table.className = "history-compare-table"
  table.innerHTML = "<thead><tr><th></th><th></th></tr></thead><tbody></tbody>"
  const [left, right] = table.querySelectorAll("th")
  left.textContent = at(from)
  right.textContent = at(to)

  for (const pair of found?.pairs ?? []) {
    const row = (table.tBodies[0] as HTMLTableSectionElement).insertRow()
    const runs =
      pair.status === "changed" ? diffRuns(pair.before ?? "", pair.after ?? "") : undefined

    row.className = `history-${pair.status}`
    row.append(
      cell(
        pair.before,
        runs?.filter((run) => run.kind !== "ins"),
      ),
      cell(
        pair.after,
        runs?.filter((run) => run.kind !== "del"),
      ),
    )
  }

  element.append(found ? table : paragraph("These versions are not known."))
  return element
}

async function blockPast(urlPath: string, id: string): Promise<HTMLElement> {
  const found = await json<{ versions: BlockVersion[] }>(
    urlPath,
    `block-history=${encodeURIComponent(id)}`,
  )
  const versions = found?.versions ?? []
  const element = page(`A block of ${name(urlPath)}, through its versions`, urlPath)
  const list = document.createElement("ol")

  list.className = "history-timeline history-block"
  list.append(
    ...versions.map(({ version, at, text }, index) => {
      const item = document.createElement("li")
      const older = versions[index + 1]?.text
      const shown =
        text === undefined
          ? paragraph("Not in the document.")
          : older === undefined
            ? cell(text)
            : cell(
                text,
                diffRuns(older, text).filter((run) => run.kind !== "del"),
              )

      item.append(
        Object.assign(document.createElement("a"), {
          href: `${href(urlPath)}?history&at=${version}`,
          textContent: when(at),
        }),
        shown,
      )
      return item
    }),
  )
  element.append(versions.length > 0 ? list : paragraph("No history for this block."))
  return element
}

async function valuePast(urlPath: string, reference: string): Promise<HTMLElement> {
  const found = await json<{ results: ValueResult[] }>(
    urlPath,
    `value-history=${encodeURIComponent(reference)}`,
  )
  const results = [...(found?.results ?? [])].reverse()
  const element = page(`${reference} in ${name(urlPath)}, as it was shown`, urlPath)
  const list = document.createElement("ol")

  list.className = "history-timeline"
  list.append(
    ...results.map(({ at, value, table, error }) => {
      const item = document.createElement("li")
      const time = Object.assign(document.createElement("time"), {
        dateTime: new Date(at).toISOString(),
        textContent: when(at),
      })
      const shown = error
        ? paragraph(error)
        : table
          ? resultTable(table)
          : Object.assign(document.createElement("code"), { textContent: JSON.stringify(value) })

      item.append(time, " ", shown)
      return item
    }),
  )
  element.append(
    results.length > 0
      ? list
      : paragraph("No result kept yet: results are kept while a page shows them."),
  )
  return element
}

function resultTable(table: NonNullable<ValueResult["table"]>): HTMLElement {
  const element = document.createElement("table")
  const head = element.createTHead().insertRow()

  for (const column of table.columns) {
    head.append(Object.assign(document.createElement("th"), { textContent: column }))
  }

  const body = element.createTBody()

  for (const values of table.rows) {
    const row = body.insertRow()

    for (const value of values) {
      row.insertCell().textContent = value === null ? "" : String(value)
    }
  }

  const wrapper = document.createElement("div")
  wrapper.append(element)

  if (table.total > table.rows.length) {
    wrapper.append(paragraph(`The first ${table.rows.length} of ${table.total} rows.`))
  }

  return wrapper
}

function cell(text: string | undefined, runs?: ReturnType<typeof diffRuns>): HTMLElement {
  const element = document.createElement("td")
  const pre = document.createElement("pre")

  pre.className = "history-text"

  if (runs) {
    for (const { kind, text: part } of runs) {
      pre.append(
        kind === "same" ? part : Object.assign(document.createElement(kind), { textContent: part }),
      )
    }
  } else {
    pre.textContent = text ?? ""
  }

  element.append(pre)
  return element
}

function page(title: string, urlPath: string): HTMLElement {
  const element = document.createElement("article")
  const back = Object.assign(document.createElement("a"), {
    href: href(urlPath),
    textContent: urlPath,
  })
  const line = document.createElement("p")

  element.className = "markdown-body view"
  line.className = "history-of"
  line.append(back)
  element.append(Object.assign(document.createElement("h1"), { textContent: title }), line)
  return element
}

function paragraph(text: string): HTMLElement {
  return Object.assign(document.createElement("p"), { textContent: text })
}

function name(urlPath: string): string {
  return urlPath.split("/").pop() ?? urlPath
}

async function json<T>(urlPath: string, query: string): Promise<T | undefined> {
  const response = await fetch(`${href(urlPath)}?${query}`)
  return response.ok ? response.json() : undefined
}
