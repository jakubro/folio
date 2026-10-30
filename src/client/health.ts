/** The health view: every problem in the folder by kind and by folder, patched in place as they come and go. */

import type { HealthDelta, HealthState, Problem } from "../server/health.ts"
import { problemKey } from "./problems.ts"
import { href } from "./tree.ts"

/** Rule violations are grouped by their severity, every other problem by its kind. */
const GROUPS: Record<string, string> = {
  figure: "Contradicted figures",
  link: "Broken links",
  include: "Includes pointing nowhere",
  loop: "Include loops",
  diagram: "Diagrams that cannot be drawn",
  chart: "Charts that cannot be drawn",
  query: "Failing queries",
  data: "Data that cannot be read",
  declaration: "Declarations that cannot be read",
  field: "Values that do not fit their field",
  "rule-error": "Rule errors",
  "rule-warning": "Rule warnings",
  view: "Saved views not written as asked",
}
/** Past this many problems in a kind, its folders open folded. */
const FOLDED_PAST = 20

let shown: { version: string; problems: Map<string, Problem>; article: HTMLElement } | undefined

export async function healthPage(): Promise<{ version: string; article: HTMLElement } | undefined> {
  const response = await fetch("/?health-data")
  const state: HealthState | undefined = response.ok ? await response.json() : undefined

  if (!state) {
    return undefined
  }

  const article = document.createElement("article")
  article.className = "markdown-body view"
  article.append(
    Object.assign(document.createElement("h1"), { textContent: "Health" }),
    document.createElement("p"),
  )
  shown = { version: state.version, problems: keyed(state.problems), article }
  draw(state.ready ? Object.keys(GROUPS) : [], state.ready)
  return { version: state.version, article }
}

/** Fetch what changed since the version shown and redraw only the kinds it touched. */
export async function updateHealth(): Promise<string | undefined> {
  const held = shown

  if (!held) {
    return undefined
  }

  const response = await fetch(`/?health-data&since=${encodeURIComponent(held.version)}`)
  const answer: HealthState | HealthDelta | undefined = response.ok
    ? await response.json()
    : undefined

  if (!answer || held !== shown) {
    return held.version
  }

  let kinds: Set<string>

  if ("since" in answer) {
    kinds = new Set()

    for (const key of answer.removed) {
      kinds.add(groupOf(held.problems.get(key)))
      held.problems.delete(key)
    }

    for (const problem of answer.added) {
      kinds.add(groupOf(problem))
      held.problems.set(problemKey(problem), problem)
    }
  } else {
    kinds = new Set(Object.keys(GROUPS))
    held.problems = keyed(answer.problems)
  }

  held.version = answer.version
  draw([...kinds], answer.ready)
  return held.version
}

function draw(kinds: string[], ready: boolean): void {
  if (!shown) {
    return
  }

  const { article, problems } = shown
  const total = article.children[1] as HTMLElement

  total.textContent = !ready
    ? "Not known yet: folio is still reading the folder."
    : problems.size === 0
      ? "Nothing is wrong in the folder."
      : `${problems.size} ${problems.size === 1 ? "problem" : "problems"} in the folder.`

  for (const kind of kinds.filter((name) => name in GROUPS)) {
    const old = article.querySelector<HTMLDetailsElement>(`:scope > [data-kind="${kind}"]`)
    const found = [...problems.values()]
      .filter((problem) => groupOf(problem) === kind)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line)
    const section = found.length > 0 ? sectionOf(kind, found, old) : undefined

    if (old && section) {
      old.replaceWith(section)
    } else if (old) {
      old.remove()
    } else if (section) {
      const after = Object.keys(GROUPS)
        .slice(Object.keys(GROUPS).indexOf(kind) + 1)
        .map((later) => article.querySelector(`:scope > [data-kind="${later}"]`))
        .find((element) => element !== null)
      article.insertBefore(section, after ?? null)
    }
  }
}

/** Folders a reader opened or folded keep that state when their kind is drawn again. */
function sectionOf(kind: string, found: Problem[], old: HTMLDetailsElement | null): HTMLElement {
  const section = Object.assign(document.createElement("details"), {
    className: `health-kind health-${kind}`,
    open: old?.open ?? true,
  })
  section.dataset.kind = kind
  section.append(
    Object.assign(document.createElement("summary"), {
      textContent: `${GROUPS[kind]} - ${found.length}`,
    }),
  )

  for (const [folder, entries] of byFolder(found)) {
    const was = old?.querySelector<HTMLDetailsElement>(
      `:scope > [data-folder="${CSS.escape(folder)}"]`,
    )
    const group = Object.assign(document.createElement("details"), {
      className: "health-folder",
      open: was?.open ?? found.length <= FOLDED_PAST,
    })
    const list = document.createElement("ul")

    group.dataset.folder = folder
    group.append(
      Object.assign(document.createElement("summary"), {
        textContent: `${folder || "/"} - ${entries.length}`,
      }),
      list,
    )
    list.append(...entries.map(entry))
    section.append(group)
  }

  return section
}

function entry({ path, line, block, anchor, opens, what }: Problem): HTMLElement {
  const item = document.createElement("li")
  const target = anchor
    ? `#${encodeURIComponent(anchor)}`
    : block
      ? `#^${encodeURIComponent(block)}`
      : ""

  item.append(
    Object.assign(document.createElement("a"), {
      href: `${href(opens ?? path)}${target}`,
      textContent: `${path}:${line}`,
    }),
    Object.assign(document.createElement("span"), {
      className: "health-what",
      textContent: ` ${what}`,
    }),
  )
  return item
}

function groupOf(problem: Problem | undefined): string {
  return problem?.kind === "rule" ? `rule-${problem.severity ?? "error"}` : (problem?.kind ?? "")
}

function byFolder(problems: Problem[]): [string, Problem[]][] {
  const folders = new Map<string, Problem[]>()

  for (const problem of problems) {
    const folder = problem.path.includes("/")
      ? problem.path.slice(0, problem.path.lastIndexOf("/"))
      : ""
    folders.set(folder, [...(folders.get(folder) ?? []), problem])
  }

  return [...folders].sort(([a], [b]) => a.localeCompare(b))
}

function keyed(problems: Problem[]): Map<string, Problem> {
  return new Map(problems.map((problem) => [problemKey(problem), problem]))
}
