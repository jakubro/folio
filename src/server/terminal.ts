/** What a running folio tells a person watching it, coloured and with a live progress line on a terminal only. */

import { styleText } from "node:util"
import type { Help } from "./args.ts"
import type { Level, Log } from "./http.ts"
import type { Model } from "./model.ts"

type Format = Parameters<typeof styleText>[0]

const COLOURS: Partial<Record<Level, Format>> = { warning: "yellow", error: "red" }
const SPINNER = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"]
const TURN_MS = 80

/** A live line's text, or a function giving it, asked again at each turn of the spinner. */
export type Progress = string | (() => string)

export interface Terminal {
  log: Log
  progress(text: Progress | undefined): void
}

export function terminal(stream: NodeJS.WriteStream, verbose: boolean): Terminal {
  const live = stream.isTTY === true
  let text: Progress | undefined
  let shown = false
  let frame = 0
  let turning: NodeJS.Timeout | undefined
  const paint = (format: Format, line: string) => styleText(format, line, { stream })
  const hide = () => {
    if (shown) {
      stream.write("\r\x1b[2K")
      shown = false
    }
  }
  const show = () => {
    if (text !== undefined) {
      const line = `${SPINNER[frame]} ${typeof text === "function" ? text() : text}`
      // Clearing reaches one row only: a line the terminal wraps would leave its first row behind.
      stream.write(paint("dim", stream.columns > 1 ? line.slice(0, stream.columns - 1) : line))
      shown = true
    }
  }
  const turn = () => {
    frame = (frame + 1) % SPINNER.length
    hide()
    show()
  }

  return {
    log: (line, level = "error") => {
      if (!verbose && (level === "request" || level === "update")) {
        return
      }

      const colour = COLOURS[level]
      hide()
      stream.write(
        `${paint("dim", new Date().toISOString().slice(11, 19))} ${colour ? paint(colour, line) : line}\n`,
      )
      show()
    },
    progress: (next) => {
      hide()
      text = live ? next : undefined

      if (text === undefined) {
        clearInterval(turning)
        turning = undefined
      } else if (!turning) {
        turning = setInterval(turn, TURN_MS)
        turning.unref()
      }

      show()
    },
  }
}

export function clientName(client: unknown): string | undefined {
  const { name, version } = (client ?? {}) as { name?: unknown; version?: unknown }

  if (typeof name !== "string" || !name) {
    return undefined
  }

  return typeof version === "string" && version ? `${name} ${version}` : name
}

export function reading(model: Model): string {
  return `reading the folder: ${model.paths().length} documents`
}

export function painter(stream: NodeJS.WriteStream): (format: Format, text: string) => string {
  return (format, text) => styleText(format, text, { stream })
}

export function helpText({ title, sections }: Help, stream: NodeJS.WriteStream): string {
  const paint = painter(stream)
  const lines = [paint("bold", title)]

  for (const { title: heading, rows } of sections) {
    const width = Math.max(0, ...rows.map((row) => (Array.isArray(row) ? row[0].length : 0)))

    lines.push("", paint("bold", heading))

    for (const row of rows) {
      lines.push(
        Array.isArray(row) ? `  ${paint("cyan", row[0].padEnd(width))}  ${row[1]}` : `  ${row}`,
      )
    }
  }

  return `${lines.join("\n")}\n`
}
