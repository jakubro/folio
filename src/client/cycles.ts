/** Values that contain themselves, as a YAML alias can make one, found before anything walks them forever. */

/** The dotted path at which a value first contains one of its own ancestors, if it does. */
export function cycleIn(value: unknown): string | undefined {
  const open = new Set<object>()
  // A value reached again through an alias, once walked through, holds no cycle.
  // Walking it again could take as many steps as the aliases expand to.
  const done = new Set<object>()
  const visit = (node: unknown, at: string[]): string | undefined => {
    if (node === null || typeof node !== "object" || done.has(node)) {
      return undefined
    }

    if (open.has(node)) {
      return at.join(".") || "its top"
    }

    open.add(node)

    for (const [key, child] of Object.entries(node)) {
      const found = visit(child, [...at, key])

      if (found !== undefined) {
        return found
      }
    }

    open.delete(node)
    done.add(node)
    return undefined
  }

  return visit(value, [])
}
