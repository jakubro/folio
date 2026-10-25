# folio development tasks

set shell := ["bash", "-euo", "pipefail", "-c"]

# Test runner wrapper: time and total resident memory caps, each with a backstop, and a per-process limit
RUN_CAPPED := justfile_directory() / "scripts/run-capped.sh"
# Clone detector, pinned exactly: its fingerprints are the baseline's format
JSCPD := "npx --yes jscpd@5.3.2 --config .jscpd.json --baseline .jscpd-baseline.json"
KNIP := "npx --yes knip@6.39.0 --no-progress"
# Browser test files run at once: a fifth of the cores, as the snapshot workers do
E2E_JOBS := `echo $(( $(nproc) / 5 > 1 ? $(nproc) / 5 : 1 ))`

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
    nice -n 19 {{ RUN_CAPPED }} 10 4096 131072 -- node --test {{ ARGS }} 2>&1 | tee /tmp/folio--test.log

# Run every documented behaviour in headless Chromium against the built command
e2e: build
    nice -n 19 {{ RUN_CAPPED }} 15 $(( {{ E2E_JOBS }} * 2048 )) 131072 -- \
        node --test --test-concurrency={{ E2E_JOBS }} --test-timeout=60000 e2e/*.test.ts 2>&1 | tee /tmp/folio--e2e.log

# Compare every page against its recorded image, naming each one that changed
snapshots: build
    nice -n 19 {{ RUN_CAPPED }} 15 8192 131072 -- npx playwright test 2>&1 | tee /tmp/folio--snapshots.log

# Re-record every page's image after an intended change to how it looks
update-snapshots: build
    nice -n 19 {{ RUN_CAPPED }} 15 8192 131072 -- \
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
    {{ JSCPD }} --fail-on-new-clones --reporters json,sarif,silent 2>&1 | tee -a /tmp/folio--lint.log \
        || { python3 scripts/new_clones.py /tmp/folio--jscpd/jscpd-report.json | tee -a /tmp/folio--lint.log; exit 1; }
    just clone-reasons 2>&1 | tee -a /tmp/folio--lint.log

# Refresh the clone baseline, print every clone, and list each accepted one still lacking a reason
dupes:
    {{ JSCPD }} --update-baseline --reporters console,sarif 2>&1 | tee /tmp/folio--dupes.log
    just clone-reasons 2>&1 | tee -a /tmp/folio--dupes.log

# Fail unless each clone in the baseline has a reason in .jscpd-reasons.json, and each reason a clone
clone-reasons:
    python3 scripts/clone_reasons.py /tmp/folio--jscpd/jscpd-report.sarif

# Auto-fix formatting and lint findings
fix:
    npx biome check --write 2>&1 | tee /tmp/folio--fix.log
