/** A digest page: what changed in the folder over a period, grouped by folder, each section folding. */

import type { Digest, DigestDocument } from "../server/digest.ts"
import type { Paired } from "../server/history.ts"
import { diffRuns } from "./diff.ts"
import { href } from "./tree.ts"

type Period = { from?: number; since?: true }

const DAY_MS = 86_400_000
/** Past this many changes - documents and moved values - every section opens folded. */
const FOLDED_PAST = 50
/** A document with more changed blocks than this folds once they are drawn. */
const DOCUMENT_FOLDED_PAST = 10
const STATUS = { created: "created", changed: "changed", removed: "removed" }

export async function digestPage(query: URLSearchParams): Promise<HTMLElement> {
  const now = Date.now()
  const period = periodOf(query, now)
  const to = query.get("to") ? endOfDay(query.get("to") as string) : now
  const address = period.since
    ? `/?digest-data&since-last&to=${to}`
    : `/?digest-data&from=${period.from}&to=${to}`
  const response = await fetch(address)
  const digest: Digest | undefined = response.ok ? await response.json() : undefined
  const element = document.createElement("article")

  element.className = "markdown-body view digest"
  element.append(
    Object.assign(document.createElement("h1"), {
      textContent: digest ? `Digest: ${range(digest.from, digest.to)}` : "Digest",
    }),
    picker(query, now),
  )

  if (!digest) {
    element.append(paragraph("The digest could not be built."))
    return element
  }

  // Seen, it is the last digest: the page says so over its socket, never through the request.
  document.dispatchEvent(new CustomEvent("folio:digested", { detail: { to: digest.to } }))
  const total = digest.documents.length
  const busy = total + digest.values.length > FOLDED_PAST
  const shown: Promise<void>[] = []
  element.append(
    paragraph(
      `${count(total, "document")} created, changed or removed; ${count(digest.values.length, "value")} moved.`,
    ),
  )

  for (const [folder, documents] of grouped(digest.documents)) {
    const section = Object.assign(document.createElement("details"), {
      className: "digest-folder",
      open: !busy,
    })
    const summary = document.createElement("summary")

    summary.textContent = `${folder || "/"} - ${count(documents.length, "document")}`
    const entries = documents.map((found) => entry(found, busy))
    shown.push(...entries.map(({ shown: drawn }) => drawn))
    section.append(summary, ...entries.map(({ item }) => item))
    element.append(section)
  }

  if (digest.values.length > 0) {
    const values = Object.assign(document.createElement("details"), {
      className: "digest-folder",
      open: !busy,
    })
    const list = document.createElement("ul")

    values.append(
      Object.assign(document.createElement("summary"), {
        textContent: `Values - ${count(digest.values.length, "value")} moved`,
      }),
      list,
    )
    list.append(
      ...digest.values.map(({ document: from, reference, before, after }) => {
        const item = document.createElement("li")
        item.append(
          Object.assign(document.createElement("a"), {
            href: `${href(from)}?history&embed=${encodeURIComponent(reference)}`,
            textContent: `${from}: ${reference}`,
          }),
          ` ${before} -> ${after}`,
        )
        return item
      }),
    )
    element.append(values)
  }

  await Promise.all(shown)
  return element
}

/** A changed document's blocks are compared when its section first opens, so a busy period lists at once. */
function entry(found: DigestDocument, busy: boolean): { item: HTMLElement; shown: Promise<void> } {
  const item = Object.assign(document.createElement("details"), {
    className: `digest-document digest-${found.status}`,
    open: !busy,
  })
  const summary = document.createElement("summary")
  const link = Object.assign(document.createElement("a"), {
    href:
      found.from && found.to
        ? `${href(found.path)}?history&compare=${found.from},${found.to}`
        : `${href(found.path)}?history&at=${found.to ?? found.from}`,
    textContent: found.path,
  })
  let loading: Promise<void> | undefined
  const load = () => {
    loading ??= blocksOf(found).then((rows) => {
      item.append(...rows)

      if (rows.length > DOCUMENT_FOLDED_PAST) {
        item.open = false
      }
    })
    return loading
  }

  summary.append(
    link,
    ` ${STATUS[found.status]}`,
    found.status === "changed" && !found.from ? " - its text before the period was not kept" : "",
  )
  item.append(summary)
  item.addEventListener("toggle", () => {
    if (item.open) {
      void load()
    }
  })

  return { item, shown: item.open ? load() : Promise.resolve() }
}

async function blocksOf({ path, status, from, to }: DigestDocument): Promise<HTMLElement[]> {
  if (status !== "changed" || !from || !to) {
    return []
  }

  const response = await fetch(`${href(path)}?compare=${from},${to}`)
  const { pairs = [] }: { pairs?: Paired[] } = response.ok ? await response.json() : {}
  const changed = pairs.filter((pair) => pair.status !== "same")

  if (changed.length === 0) {
    return [paragraph("No block changed: only spacing did.")]
  }

  return changed.map((block) => {
    const runs =
      block.status === "changed" ? diffRuns(block.before ?? "", block.after ?? "") : undefined
    const row = document.createElement("div")

    row.className = `digest-block history-${block.status}`
    row.append(
      text(
        block.before,
        runs?.filter((run) => run.kind !== "ins"),
        "before",
      ),
      text(
        block.after,
        runs?.filter((run) => run.kind !== "del"),
        "after",
      ),
    )
    return row
  })
}

function picker(query: URLSearchParams, now: number): HTMLElement {
  const nav = document.createElement("p")
  const from = Object.assign(document.createElement("input"), {
    type: "date",
    value: query.get("from") ?? day(now - 7 * DAY_MS),
  })
  const to = Object.assign(document.createElement("input"), {
    type: "date",
    value: query.get("to") ?? day(now),
  })
  const go = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: "Show",
  })

  nav.className = "digest-periods"
  go.addEventListener("click", () => location.assign(`/?digest&from=${from.value}&to=${to.value}`))
  nav.append(
    link("/?digest", "Today"),
    " - ",
    link("/?digest&period=week", "This week"),
    " - ",
    link("/?digest&period=since-last", "Since the last digest"),
    " - from ",
    from,
    " to ",
    to,
    " ",
    go,
  )
  return nav
}

function periodOf(query: URLSearchParams, now: number): Period {
  const named = query.get("period")
  const from = query.get("from")
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  if (from) {
    return { from: new Date(`${from}T00:00:00`).getTime() }
  }

  if (named === "week") {
    const monday = new Date(today)
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
    return { from: monday.getTime() }
  }

  return named === "since-last" ? { since: true } : { from: today.getTime() }
}

function endOfDay(date: string): number {
  return new Date(`${date}T23:59:59.999`).getTime()
}

function day(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function range(from: number, to: number): string {
  return `${new Date(from).toLocaleString()} to ${new Date(to).toLocaleString()}`
}

function grouped(documents: DigestDocument[]): Map<string, DigestDocument[]> {
  const groups = new Map<string, DigestDocument[]>()

  for (const found of documents) {
    const folder = found.path.includes("/") ? found.path.slice(0, found.path.lastIndexOf("/")) : ""
    groups.set(folder, [...(groups.get(folder) ?? []), found])
  }

  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)))
}

function text(
  shown: string | undefined,
  runs: ReturnType<typeof diffRuns> | undefined,
  side: string,
): HTMLElement {
  const pre = Object.assign(document.createElement("pre"), { className: `history-text ${side}` })

  if (runs) {
    for (const { kind, text: part } of runs) {
      pre.append(
        kind === "same" ? part : Object.assign(document.createElement(kind), { textContent: part }),
      )
    }
  } else {
    pre.textContent = shown ?? ""
  }

  return pre
}

function link(address: string, label: string): HTMLAnchorElement {
  return Object.assign(document.createElement("a"), { href: address, textContent: label })
}

function paragraph(content: string): HTMLElement {
  return Object.assign(document.createElement("p"), { textContent: content })
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}
