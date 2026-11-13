/** The components pages draw: scripts in the folders named when Folio starts, each found by its name. */

import fs from "node:fs"
import path from "node:path"
import { COMPONENT_NAME } from "../client/component.ts"
import { guarded } from "./failures.ts"
import { isInside } from "./files.ts"
import type { Model } from "./model.ts"
import { fileVersion } from "./versions.ts"

export interface Found {
  drawn?: string
  holders: string[]
}

export interface Listed {
  path: string
  version: string
  shadowed?: string[]
}

const COMPONENTS = new WeakMap<Model, Components>()
/** Linux follows at most 40 links in one path. */
const LINK_HOPS = 40

export function componentsOf(model: Model): Components {
  let components = COMPONENTS.get(model)

  if (!components) {
    components = guarded("components", new Components(model.root))
    COMPONENTS.set(model, components)
  }

  return components
}

export function componentFolders(root: string, given: string[]): string[] {
  const folders = given.map((written) => {
    const real = fs.existsSync(written) ? fs.realpathSync(written) : ""

    if (!real || !fs.statSync(real).isDirectory()) {
      throw new Error(`Not a folder: ${written}`)
    }

    if (!isInside(root, real)) {
      throw new Error(
        `A components folder must lie inside the folder Folio serves: ${written} is outside ${root}.`,
      )
    }

    return real
  })

  return [...new Set(folders)]
}

export class Components {
  readonly #root: string
  #folders: string[] = []

  constructor(root: string) {
    this.#root = root
  }

  use(folders: string[]): void {
    this.#folders = [...folders]
  }

  get folders(): string[] {
    return this.#folders
  }

  get foldersKey(): string {
    return this.#folders.map((folder) => this.#relative(folder)).join("\n")
  }

  candidates(name: string): string[] {
    return COMPONENT_NAME.test(name)
      ? this.#folders.map((folder) => path.join(folder, `${name}.js`))
      : []
  }

  /** The folders a change to the name's script lands in: every components folder, and where its links lead. */
  watched(name: string): string[] {
    const dirs = [...this.#folders]

    for (const candidate of this.candidates(name)) {
      let at = candidate

      for (let hop = 0; hop < LINK_HOPS; hop++) {
        try {
          at = path.resolve(path.dirname(at), fs.readlinkSync(at))
        } catch {
          break
        }

        dirs.push(path.dirname(at))
      }
    }

    return [...new Set(dirs.map(realDir))]
  }

  find(name: string): Found {
    const holders: string[] = []
    let drawn: string | undefined

    for (const [at, candidate] of this.candidates(name).entries()) {
      const real = this.#script(candidate)

      if (real) {
        drawn ??= real
        holders.push(this.#folders[at])
      }
    }

    return { ...(drawn && { drawn }), holders }
  }

  /** Carries the script's path, so a page hears when another folder's script takes over. */
  version(name: string): string | null {
    const { drawn } = this.find(name)
    const version = drawn && fileVersion(drawn)

    return version ? `${this.#relative(drawn)}:${version}` : null
  }

  list(): { folders: string[]; components: Record<string, Listed> } {
    const components = new Map<string, Listed>()

    for (const folder of this.#folders) {
      for (const entry of entriesOf(folder)) {
        const name = entry.slice(0, -".js".length)
        const real = entry.endsWith(".js") ? this.#script(path.join(folder, entry)) : undefined
        const version = real && COMPONENT_NAME.test(name) ? fileVersion(real) : undefined

        if (!real || !version) {
          continue
        }

        const held = components.get(name)

        if (held) {
          held.shadowed = [...(held.shadowed ?? []), this.#relative(real)]
        } else {
          components.set(name, { path: this.#relative(real), version })
        }
      }
    }

    return {
      folders: this.#folders.map((folder) => this.#relative(folder) || "."),
      components: Object.fromEntries(components),
    }
  }

  #script(candidate: string): string | undefined {
    try {
      const real = fs.realpathSync(candidate)
      return isInside(this.#root, real) && fs.statSync(real).isFile() ? real : undefined
    } catch {
      return undefined
    }
  }

  #relative(file: string): string {
    return path.relative(this.#root, file)
  }
}

/** A folder as the file system names it, through every link; one not there yet under its nearest real parent. */
function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    const parent = path.dirname(dir)
    return parent === dir ? dir : path.join(realDir(parent), path.basename(dir))
  }
}

function entriesOf(folder: string): string[] {
  try {
    return fs.readdirSync(folder).sort()
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return []
    }

    throw error
  }
}
