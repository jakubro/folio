/** The ridge levels component: its committed build matches its source, which the skill's guide quotes as is. */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

const COMPONENTS = path.join(import.meta.dirname, "../visual/ridge/components")
const GUIDE = path.join(import.meta.dirname, "../plugin/skills/folio/references/components.md")

test("levels.js is what the components folder's own build makes of its source", () => {
  assert.ok(
    fs.existsSync(path.join(COMPONENTS, "node_modules")),
    "the ridge components' packages are missing: run just install",
  )

  const built = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "folio-levels-")), "levels.js")

  execFileSync(
    "npm",
    ["run", "--silent", "build", "--", `--outfile=${built}`, "--log-level=error"],
    {
      cwd: COMPONENTS,
      stdio: ["ignore", "ignore", "inherit"],
    },
  )
  assert.ok(
    fs.readFileSync(built).equals(fs.readFileSync(path.join(COMPONENTS, "levels.js"))),
    "levels.js is stale: run npm run build in visual/ridge/components",
  )
  fs.rmSync(path.dirname(built), { recursive: true })
})

test("the skill's guide to writing a component carries levels' source and build as they are", () => {
  const fences = [...fs.readFileSync(GUIDE, "utf8").matchAll(/^```(\w+)\n([\s\S]*?)^```$/gm)]
  const fence = (language: string, holding: string) =>
    fences.find(([, named, text]) => named === language && text.includes(holding))?.[2]
  const own = (file: string) => fs.readFileSync(path.join(COMPONENTS, file), "utf8")

  assert.equal(fence("tsx", "export default function levels"), own("src/levels.tsx"))
  assert.deepEqual(JSON.parse(fence("json", '"scripts"') ?? ""), JSON.parse(own("package.json")))
  assert.deepEqual(
    JSON.parse(fence("json", '"compilerOptions"') ?? ""),
    JSON.parse(own("tsconfig.json")),
  )
})
