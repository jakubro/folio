/**
 * A folio of its own over a copy of the ridge folder, with a git history committed on fixed dates and
 * every file dated alike, so a picture of history, change or reading comes out the same on any day.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const FIXTURE = path.join(import.meta.dirname, "ridge")
const CLI = path.join(import.meta.dirname, "../dist/cli.js")

const WRITTEN_AT = new Date("2026-10-15T17:45:00Z")

export const BROWSER_NOW = new Date("2026-10-20T09:00:00Z")

const TOVE = { name: "Tove Brann", email: "tove@example.com" }
const OREN = { name: "Oren Tallis", email: "oren@example.com" }

const REPORT_DRAFT = [
  "# October report",
  "",
  "The network logged {value: #totals#0.rain_mm} mm of rain in the first week of October.",
  "",
  "```sql query totals",
  "select round(sum(rain_mm), 1) as rain_mm, round(avg(temp_c), 1) as temp_c",
  "from 'data/daily.csv'",
  "```",
  "",
  "## Rain by station",
  "",
  "{table: queries/wettest.sql}",
  "",
].join("\n")

const REPORT_CHARTED = fixture("report.md")
  .replace(
    /^The network logged .*$/m,
    "The network logged {value: #totals#0.rain_mm} mm of rain in the first two weeks of October.",
  )
  .replace(/^\[North\].*\n\n/m, "")
  .replace(/\n\nThe storm of the 9th .*\n$/, "\n")

const EAST_BEFORE = fixture("stations/east.md").replace("2026-08-30", "2026-03-02")

/** `null` writes the fixture's text, and each file's last write must be `null` so the copy matches it. */
const COMMITS: {
  at: string
  by: typeof TOVE
  subject: string
  files: Record<string, string | null>
}[] = [
  {
    at: "2025-02-10T11:00:00Z",
    by: TOVE,
    subject: "Describe the old mast",
    files: { "notes/old-mast.md": null },
  },
  {
    at: "2026-10-05T16:30:00Z",
    by: TOVE,
    subject: "Add the ridge stations",
    files: {
      "README.md": null,
      "FOLIO.md": null,
      "data/daily.csv": null,
      "data/stations.json": null,
      "queries/wettest.sql": null,
      "stations/north.md": null,
      "stations/east.md": EAST_BEFORE,
      "stations/south.md": null,
      "stations/west.md": null,
      "report.md": REPORT_DRAFT,
    },
  },
  {
    at: "2026-10-06T08:20:00Z",
    by: OREN,
    subject: "Map the station sites",
    files: { "notes/sites.md": null, "notes/sites.geojson": null, "notes/funnel.stl": null },
  },
  {
    at: "2026-10-12T09:15:00Z",
    by: OREN,
    subject: "Chart the daily rain",
    files: { "report.md": REPORT_CHARTED, "stations/east.md": null },
  },
  {
    at: "2026-10-15T17:40:00Z",
    by: TOVE,
    subject: "Finish the October report",
    files: { "report.md": null, "notes/uplink.md": null },
  },
]

export interface Ridge {
  base: string
  /** Staged and renamed, so the model never reads it half written or before it carries its date. */
  write(file: string, text: string, at: Date): void
  close(): Promise<void>
}

export async function ridge(): Promise<Ridge> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-pictures-")))
  const folder = path.join(root, "ridge")

  fs.mkdirSync(folder)
  commit(folder)
  date(folder, WRITTEN_AT)

  const port = await free()
  const child = spawn(process.execPath, [CLI, folder, "--port", String(port)], {
    env: { ...process.env, XDG_STATE_HOME: path.join(root, "state") },
  })

  await indexed(child)

  return {
    base: `http://localhost:${port}`,
    write(file, text, at) {
      const target = path.join(folder, file)
      const staged = path.join(path.dirname(target), `.${path.basename(target)}.staged`)

      fs.writeFileSync(staged, text)
      fs.utimesSync(staged, at, at)
      fs.renameSync(staged, target)
    },
    async close() {
      const exited = new Promise((resolve) => child.once("exit", resolve))

      child.kill()
      await exited
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function fixture(file: string): string {
  return fs.readFileSync(path.join(FIXTURE, file), "utf8")
}

function commit(folder: string): void {
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
      cwd: folder,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    })

  git(["init", "--quiet"])

  for (const { at, by, subject, files } of COMMITS) {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true })
      fs.writeFileSync(path.join(folder, file), text ?? fixture(file))
    }

    git(["add", "--all"])
    git(["commit", "--quiet", "--message", subject], {
      GIT_AUTHOR_NAME: by.name,
      GIT_AUTHOR_EMAIL: by.email,
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: by.name,
      GIT_COMMITTER_EMAIL: by.email,
      GIT_COMMITTER_DATE: at,
    })
  }
}

function date(folder: string, at: Date): void {
  for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && !path.join(entry.parentPath, entry.name).includes(`${path.sep}.git`)) {
      fs.utimesSync(path.join(entry.parentPath, entry.name), at, at)
    }
  }
}

function free(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo

      probe.close(() => resolve(port))
    })
  })
}

/** The model's first walk ends with a line naming how many documents it indexed. */
function indexed(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let said = ""

    child.stdout?.on("data", (chunk) => {
      said += chunk

      if (said.includes("documents in")) {
        resolve()
      }
    })
    child.once("exit", (code) => reject(new Error(`folio exited with ${code}: ${said}`)))
  })
}
