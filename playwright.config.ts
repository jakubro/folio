/**
 * Screenshot gate: folio's pages and the documentation's pictures, served from the fixture folder and
 * compared against recorded images.
 */

import { defineConfig } from "@playwright/test";

const PORT = 8650;

export default defineConfig({
  testDir: "visual",
  outputDir: "/tmp/folio--snapshots",
  workers: "20%",
  fullyParallel: true,
  reporter: [["list"]],
  forbidOnly: true,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  },
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", threshold: 0 },
  },
  projects: [
    {
      name: "visual",
      testMatch: "pages.spec.ts",
      snapshotPathTemplate: "visual/snapshots/{arg}{ext}",
    },
    // The pictures the documentation embeds are recorded straight into docs/, so none goes stale unseen.
    { name: "docs", testMatch: "pictures.spec.ts", snapshotPathTemplate: "docs/{arg}{ext}" },
  ],
  webServer: {
    // A fresh state each run: what an earlier run read would otherwise show as marks on its pages.
    command: `rm -rf /tmp/folio--snapshots-state && node dist/cli.js visual/station --port ${PORT}`,
    env: { XDG_STATE_HOME: "/tmp/folio--snapshots-state" },
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
  },
});
