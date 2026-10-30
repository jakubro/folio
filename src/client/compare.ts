/** Records compared: what sets a filter's records apart from the rest, and every field by the values of one. */

import type { Comparison, FieldComparison } from "../server/data.ts"
import { copyButton } from "./copy.ts"
import type { Picked } from "./stats.ts"

const FINDINGS = 6
const NUMBER = new Intl.NumberFormat("en")
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 })
const SMALL = new Intl.NumberFormat("en", { maximumSignificantDigits: 2 })
const SVG = "http://www.w3.org/2000/svg"

export function findingsOf(
  comparison: Comparison,
  picked: Picked,
  pick: (next: Picked) => void,
): HTMLElement {
  const [here, elsewhere] = comparison.sets
  const card = document.createElement("section")
  const title = document.createElement("p")
  const legend = document.createElement("span")
  const list = document.createElement("div")
  const found = comparison.fields.filter(({ standing }) => standing === "apart").slice(0, FINDINGS)
  const fixed = comparison.fields.filter(({ standing }) => standing === "fixed")

  card.className = "data-findings"
  title.className = "data-findings-title"
  title.append(
    `What sets the ${NUMBER.format(here.count)} records where ${picked.label} apart from the other ${NUMBER.format(elsewhere.count)}`,
  )
  legend.className = "data-legend"
  legend.append(swatch("data-here"), "here", swatch("data-elsewhere"), "elsewhere")
  title.append(legend)
  list.className = "data-findings-list"

  for (const field of found) {
    const line = document.createElement("button")
    const name = document.createElement("code")
    const said = document.createElement("span")
    const [top] = field.values ?? []

    line.type = "button"
    line.className = "data-finding"
    name.textContent = field.name
    said.className = "data-finding-said"

    if (top) {
      said.append(
        `${top.label} `,
        strong(percent(top.shares[0])),
        ` here, ${percent(top.shares[1])} elsewhere`,
      )
      line.append(name, said, paired(top.shares))
      line.disabled = top.label === "(empty)"
      line.title = line.disabled ? "" : `Show only ${field.name} = ${top.label}`
      line.addEventListener("click", () =>
        pick({
          filter: { field: field.name, eq: top.label },
          label: `${field.name} = ${top.label}`,
        }),
      )
    } else {
      const [inside, outside] = (field.medians ?? []).map((median) => shown(field, median))
      said.append("median ", strong(inside), ` here, ${outside} elsewhere`)
      line.append(name, said, mirrored(field.bins ?? [], 120, 13))
      line.disabled = true
    }

    list.append(line)
  }

  if (found.length === 0) {
    list.append(note("Every other field is spread alike here and elsewhere."))
  }

  card.append(title, list)

  if (fixed.length > 0) {
    card.append(
      note(`Fixed by the filter, so left out: ${fixed.map(({ name }) => name).join(", ")}`),
    )
  }

  return card
}

export function comparedView(comparison: Comparison, by: string): HTMLElement {
  const view = document.createElement("div")
  const title = document.createElement("p")
  const table = document.createElement("table")
  const head = table.createTHead().insertRow()
  const body = table.createTBody()
  const found = comparison.fields.filter(({ standing }) => standing === "apart")
  const fixed = comparison.fields.filter(({ standing }) => standing === "fixed")
  const alike = comparison.fields.filter(({ standing }) => standing === "alike")

  view.className = "data-compare"
  title.className = "data-findings-title"
  title.textContent = `Every field compared by ${by}, the fields set most apart first`
  table.className = "data-compare-table"
  head.appendChild(document.createElement("th")).textContent = by

  for (const set of comparison.sets) {
    const cell = head.appendChild(document.createElement("th"))
    cell.append(set.label, note(`${NUMBER.format(set.count)} records`))
  }

  for (const field of found) {
    const line = body.insertRow()
    const label = line.appendChild(document.createElement("th"))
    const [top] = field.values ?? []
    const name = document.createElement("code")

    name.textContent = field.name
    label.append(name, top ? ` = ${top.label}` : " median")

    if (top) {
      for (const share of top.shares) {
        line.insertCell().append(strong(`${(100 * share).toFixed(1)}%`), bar(share))
      }
    } else {
      const bins = (field.bins ?? []).map(shares)
      const most = Math.max(0.0001, ...bins.flat())

      for (const [index, median] of (field.medians ?? []).entries()) {
        line.insertCell().append(strong(shown(field, median)), spark(bins[index] ?? [], most))
      }
    }
  }

  view.append(title, table)

  if (fixed.length > 0) {
    view.append(note(`Fixed by ${by}, so left out: ${fixed.map(({ name }) => name).join(", ")}`))
  }

  if (alike.length > 0) {
    view.append(
      note(`Spread alike by ${by}, so left out: ${alike.map(({ name }) => name).join(", ")}`),
    )
  }

  if (comparison.query) {
    const query = comparison.query
    const pre = document.createElement("pre")
    const code = pre.appendChild(document.createElement("code"))

    code.className = "language-sql"
    code.textContent = query
    pre.append(copyButton(() => query, "Copy the query", "code-copy"))
    view.append(note("As a query"), pre)
  }

  return view
}

function shown(field: FieldComparison, median: number | null | undefined): string {
  if (median === null || median === undefined) {
    return "-"
  }

  return field.kind === "date"
    ? new Date(median)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")
        .replace(/ 00:00$/, "")
    : (Math.abs(median) < 1 && median !== 0 ? SMALL : COMPACT).format(median)
}

function percent(share: number): string {
  return `${share < 0.1 && share > 0 ? (100 * share).toFixed(1) : Math.round(100 * share)}%`
}

function shares(bins: number[]): number[] {
  const total = bins.reduce((sum, n) => sum + n, 0) || 1
  return bins.map((n) => n / total)
}

function strong(text: string): HTMLElement {
  const shown = document.createElement("strong")
  shown.textContent = text
  return shown
}

function note(text: string): HTMLElement {
  const line = document.createElement("p")
  line.className = "data-findings-note"
  line.textContent = text
  return line
}

function swatch(set: string): HTMLElement {
  const mark = document.createElement("span")
  mark.className = `data-swatch ${set}`
  return mark
}

function bar(share: number): HTMLElement {
  const track = document.createElement("span")
  const fill = document.createElement("span")
  track.className = "data-track data-compare-bar"
  fill.className = "data-fill"
  fill.style.width = `${100 * share}%`
  track.append(fill)
  return track
}

function paired(values: number[]): HTMLElement {
  const box = document.createElement("span")
  box.className = "data-paired"

  for (const [index, share] of values.slice(0, 2).entries()) {
    const track = document.createElement("span")
    const fill = document.createElement("span")
    track.className = "data-track"
    fill.className = `data-fill ${index === 0 ? "data-here" : "data-elsewhere"}`
    fill.style.width = `${100 * share}%`
    track.append(fill)
    box.append(track)
  }

  return box
}

/** Bars are shares of each set's own records, as the sets differ in size: here above the line, elsewhere below. */
function mirrored(bins: number[][], width: number, half: number): SVGSVGElement {
  const [up = [], down = []] = bins.map(shares)
  const chart = document.createElementNS(SVG, "svg")
  const most = Math.max(0.0001, ...up, ...down)
  const step = width / Math.max(1, up.length)

  chart.setAttribute("class", "data-chart data-mirrored")
  chart.setAttribute("width", String(width))
  chart.setAttribute("height", String(2 * half + 1))

  for (const [index, value] of up.entries()) {
    for (const [share, below] of [
      [value, false],
      [down[index] ?? 0, true],
    ] as [number, boolean][]) {
      const rect = document.createElementNS(SVG, "rect")
      const tall = (share / most) * half
      rect.setAttribute("x", String(index * step))
      rect.setAttribute("y", String(below ? half + 1 : half - tall))
      rect.setAttribute("width", String(Math.max(1, step - 1)))
      rect.setAttribute("height", String(tall))
      rect.setAttribute("class", below ? "data-bar data-elsewhere" : "data-bar")
      chart.append(rect)
    }
  }

  return chart
}

function spark(bins: number[], most: number): SVGSVGElement {
  const chart = document.createElementNS(SVG, "svg")
  const width = 96
  const height = 16
  const step = width / Math.max(1, bins.length)

  chart.setAttribute("class", "data-chart data-compare-spark")
  chart.setAttribute("width", String(width))
  chart.setAttribute("height", String(height))

  for (const [index, share] of bins.entries()) {
    const rect = document.createElementNS(SVG, "rect")
    const tall = share === 0 ? 0 : Math.max(1, (share / most) * height)
    rect.setAttribute("x", String(index * step))
    rect.setAttribute("y", String(height - tall))
    rect.setAttribute("width", String(Math.max(1, step - 1)))
    rect.setAttribute("height", String(tall))
    rect.setAttribute("class", "data-bar")
    chart.append(rect)
  }

  return chart
}
