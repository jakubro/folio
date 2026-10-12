// Include expansion: every {include: <path>} is replaced by that file's text before the page renders.

import fs from "node:fs";
import path from "node:path";
import { confine, isInside } from "./files.ts";

export interface Expansion {
  text: string;
  /** Every file the text depends on, the page first, including missing targets a save could create. */
  files: string[];
}

const TOKEN = /\{include:\s*([^}\n]*?)\s*\}/g;

/**
 * Expand includes in a real file inside root, recursively. Paths resolve against the including
 * file's folder, or against root when they start with a slash. An unresolved target, one outside
 * root and a cycle each expand to nothing.
 */
export function expand(root: string, file: string): Expansion {
  const files = new Set<string>();
  const text = expandFile(root, file, [], files) ?? "";

  return { text, files: [...files] };
}

function expandFile(
  root: string,
  file: string,
  stack: string[],
  files: Set<string>,
): string | undefined {
  let text: string;

  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }

  files.add(file);

  const nested = [...stack, file];

  return text.replace(TOKEN, (_, target: string) => {
    const relative = target.startsWith("/")
      ? target
      : path.relative(root, path.join(path.dirname(file), target));
    const resolved = confine(root, relative);

    if (!resolved) {
      const missing = path.join(root, relative);

      if (isInside(root, missing)) {
        files.add(missing);
      }

      return "";
    }

    return nested.includes(resolved) ? "" : (expandFile(root, resolved, nested, files) ?? "");
  });
}
