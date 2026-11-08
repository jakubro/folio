/** The plugin and server.json agree with the release they pin, and the plugin with its marketplace and skill. */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { parse } from "yaml"

const REPO = path.join(import.meta.dirname, "..")
const PLUGIN_DIR = path.join(REPO, "plugin")
const PACKAGE = read("package.json")
const MARKETPLACE = read(".claude-plugin/marketplace.json")
const PLUGIN = read("plugin/.claude-plugin/plugin.json")
const SERVER = read("server.json")

test("the plugin carries the package's version and runs folio mcp of that release with its setting", () => {
  assert.equal(PLUGIN.version, PACKAGE.version)
  assert.deepEqual(PLUGIN.mcpServers, {
    folio: {
      command: "npx",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code substitutes it, not JavaScript
      args: ["--yes", `@jakubro/folio@${PACKAGE.version}`, "mcp", "${user_config.folio}"],
    },
  })
  assert.equal(PACKAGE.name, "@jakubro/folio")
})

test("server.json is the package's mcpName, running folio mcp of the package's release", () => {
  const [server, ...others] = SERVER.packages

  assert.equal(SERVER.name, PACKAGE.mcpName)
  assert.equal(SERVER.version, PACKAGE.version)
  assert.deepEqual(others, [])
  assert.deepEqual(
    [server.registryType, server.identifier, server.version, server.runtimeHint, server.transport],
    ["npm", PACKAGE.name, PACKAGE.version, "npx", { type: "stdio" }],
  )
  assert.deepEqual(server.packageArguments[0], { type: "positional", value: "mcp" })
  assert.ok(
    server.packageArguments.every(({ isRequired }: { isRequired?: boolean }) => !isRequired),
  )
})

test("server.json's description fits the registry's 100 characters", () => {
  assert.ok(SERVER.description.length <= 100, `${SERVER.description.length} characters`)
})

test("the marketplace's one plugin is the plugin directory", () => {
  assert.equal(MARKETPLACE.name, "folio")
  assert.deepEqual(
    MARKETPLACE.plugins.map(({ name, source }: { name: string; source: string }) => [
      name,
      path.resolve(REPO, source),
    ]),
    [["folio", PLUGIN_DIR]],
  )
  assert.equal(PLUGIN.name, "folio")
})

test("every setting the server reads is declared, optional and without a default", () => {
  // Unset, an option reaches the server as "", read as no Folio named; a default arrives literally.
  const referenced = [
    ...JSON.stringify(PLUGIN.mcpServers).matchAll(/\$\{user_config\.(\w+)\}/g),
  ].map(([, name]) => name)

  assert.deepEqual(referenced, ["folio"])
  assert.deepEqual(Object.keys(PLUGIN.userConfig), ["folio"])
  assert.equal(PLUGIN.userConfig.folio.type, "string")
  assert.ok(!PLUGIN.userConfig.folio.required && !("default" in PLUGIN.userConfig.folio))
})

test("the skill is named for its folder and is its only copy in the repository", () => {
  const skill = fs.readFileSync(path.join(PLUGIN_DIR, "skills/folio/SKILL.md"), "utf8")

  assert.equal(parse(skill.split("---\n")[1]).name, "folio")
  assert.deepEqual(skills(REPO), [path.join(PLUGIN_DIR, "skills/folio/SKILL.md")])
})

function read(file: string) {
  return JSON.parse(fs.readFileSync(path.join(REPO, file), "utf8"))
}

function skills(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return [".git", "node_modules", "dist"].includes(entry.name) ? [] : skills(at)
    }

    return entry.name === "SKILL.md" ? [at] : []
  })
}
