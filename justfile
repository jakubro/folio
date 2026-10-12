# folio development tasks

set shell := ["bash", "-euo", "pipefail", "-c"]

# Test runner wrappers: wall-clock time and per-process address space, and total resident memory
RUN_BOUNDED := justfile_directory() / "scripts/run-bounded.sh"
RUN_CAPPED := justfile_directory() / "scripts/run-capped.sh"
# Clone detector, pinned exactly: its fingerprints are the baseline's format
JSCPD := "npx --yes jscpd@5.3.2 --config .jscpd.json --baseline .jscpd-baseline.json"
KNIP := "npx --yes knip@6.39.0 --no-progress"

# List available recipes
default:
    @just --list

# Every gate: formatting, lint, types, unused code, clones, unit tests, build
check: lint test build

# Install dependencies from the lockfile
install:
    npm ci 2>&1 | tee /tmp/folio--install.log
    npx playwright install chromium 2>&1 | tee -a /tmp/folio--install.log

# Run the unit tests; ARGS narrows to files
test *ARGS="test/*.test.ts":
    {{ RUN_BOUNDED }} 10m 4096 -- node --test {{ ARGS }} 2>&1 | tee /tmp/folio--test.log

# Run every documented behaviour in headless Chromium against the built command
e2e: build
    {{ RUN_CAPPED }} 8192 -- {{ RUN_BOUNDED }} 15m 131072 -- \
        node --test --test-concurrency=1 --test-timeout=60000 e2e/*.test.ts 2>&1 | tee /tmp/folio--e2e.log

# Compare every page against its recorded image, naming each one that changed
snapshots: build
    {{ RUN_CAPPED }} 8192 -- {{ RUN_BOUNDED }} 15m 131072 -- npx playwright test 2>&1 | tee /tmp/folio--snapshots.log

# Re-record every page's image after an intended change to how it looks
update-snapshots: build
    {{ RUN_CAPPED }} 8192 -- {{ RUN_BOUNDED }} 15m 131072 -- \
        npx playwright test --update-snapshots=all 2>&1 | tee /tmp/folio--update-snapshots.log

# Build the documentation site from docs/ into site/dist/, failing on any broken link
[working-directory('site')]
site:
    npm ci 2>&1 | tee /tmp/folio--site.log
    npm run build 2>&1 | tee -a /tmp/folio--site.log

# Serve the documentation site with live reload; HOST=0.0.0.0 to reach it from outside
[working-directory('site')]
preview HOST="127.0.0.1" PORT="4321":
    npm ci
    npm run dev -- --host {{ HOST }} --port {{ PORT }}

# Build the package into dist/
build:
    node build.mjs 2>&1 | tee /tmp/folio--build.log

# Lint, type-check, and fail on unused code and on new clones
lint:
    rm -f /tmp/folio--lint.log
    npx biome check 2>&1 | tee -a /tmp/folio--lint.log
    npx tsc 2>&1 | tee -a /tmp/folio--lint.log
    {{ KNIP }} 2>&1 | tee -a /tmp/folio--lint.log
    {{ JSCPD }} --fail-on-new-clones --reporters console 2>&1 | tee -a /tmp/folio--lint.log
    just clone-reasons 2>&1 | tee -a /tmp/folio--lint.log

# Refresh the clone baseline, print every clone, and list each accepted one still lacking a reason
dupes:
    {{ JSCPD }} --update-baseline --reporters console 2>&1 | tee /tmp/folio--dupes.log
    just clone-reasons 2>&1 | tee -a /tmp/folio--dupes.log

# Fail unless each clone in the baseline has a reason in .jscpd-reasons.json, and each reason a clone
clone-reasons:
    #!/usr/bin/env node
    const fs = require("node:fs");
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    const accepted = Object.keys(read(".jscpd-baseline.json").fingerprints);
    const reasons = read(".jscpd-reasons.json");
    const problems = [
      ...accepted.filter((print) => !reasons[print]?.trim()).map((print) => `${print}: accepted without a reason`),
      ...Object.keys(reasons).filter((print) => !accepted.includes(print)).map((print) => `${print}: reason for no accepted clone`),
    ];
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }

# Auto-fix formatting and lint findings
fix:
    npx biome check --write 2>&1 | tee /tmp/folio--fix.log
