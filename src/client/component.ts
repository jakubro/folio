/** A component fence as page and server read it alike: the name after `component`, and its YAML. */

import { parse as parseYaml } from "yaml"
import { cycleIn } from "./cycles.ts"

export interface ComponentFence {
  data: Record<string, string>
  options: Record<string, unknown>
}

export const COMPONENT_NAME = /^[A-Za-z0-9_-]+$/

export function componentName(meta: string): string {
  const name = meta.trim()

  if (!name) {
    throw new Error("A component fence names its component after the word component.")
  }

  if (!COMPONENT_NAME.test(name)) {
    throw new Error(`A component's name is letters, digits, _ and -, not ${name}.`)
  }

  return name
}

export function missingComponent(name: string, folders: number): string {
  return folders > 0
    ? `No components folder holds ${name}.js.`
    : `No components folder holds ${name}.js: none was named with --components.`
}

export function readComponent(source: string): ComponentFence {
  let read: unknown

  try {
    read = parseYaml(source) ?? {}
  } catch (error) {
    throw new Error(`The fence is not YAML: ${(error as Error).message}`)
  }

  if (typeof read !== "object" || read === null || Array.isArray(read)) {
    throw new Error("A component fence holds a YAML map of its data and options.")
  }

  const loop = cycleIn(read)

  if (loop !== undefined) {
    throw new Error(`The fence refers to itself at ${loop}.`)
  }

  const { data, ...options } = read as Record<string, unknown>
  const entries = data ?? {}

  if (
    typeof entries !== "object" ||
    Array.isArray(entries) ||
    Object.values(entries).some((reference) => typeof reference !== "string" || !reference.trim())
  ) {
    throw new Error("data names each entry and the reference it reads, as name: path.")
  }

  return { data: entries as Record<string, string>, options }
}
