#!/bin/bash
# Run the screenshot gate inside the pinned Playwright image, where every machine draws the pictures alike.
set -euo pipefail

cd "$(dirname "$0")/.."

# A fifth of the cores draw at once, as playwright.config.ts sets, each with a Folio and a browser of its own.
WORKERS=$(($(nproc) / 5 > 1 ? $(nproc) / 5 : 1))
GATE=(scripts/run-capped.sh 15 $((WORKERS * 2048 > 8192 ? WORKERS * 2048 : 8192)) 131072 -- npx playwright test "$@")

# The release gate already runs inside the image, and a machine known to draw as it does may skip it.
if [[ ${FOLIO_DRAW_HERE:-} == 1 ]]; then
  exec "${GATE[@]}"
fi

if ! command -v podman > /dev/null; then
  echo "pictures.sh: the pictures are drawn inside the Playwright image, which needs podman; FOLIO_DRAW_HERE=1 draws them on this machine instead" >&2
  exit 1
fi

# The image carries the browsers of exactly one Playwright release, so it follows the pin.
playwright=$(sed -nE 's/^ *"playwright": "([0-9.]+)",?$/\1/p' package.json)
image="mcr.microsoft.com/playwright:v${playwright}-noble"
echo "==> pictures drawn inside $image" >&2

# Attached only when a terminal is watching, so Ctrl-C reaches the gate and piped output stays clean.
TTY_FLAGS=()
[[ -t 1 ]] && TTY_FLAGS=(--interactive --tty)

# Playwright writes a failed comparison's images there, which would otherwise vanish with the container.
# SELinux confinement is off rather than `:z`, which would relabel the repository for every other reader.
mkdir -p /tmp/folio--snapshots
exec podman run --rm "${TTY_FLAGS[@]}" \
  --security-opt label=disable \
  --env FOLIO_DRAW_HERE=1 \
  --volume "$PWD:/work" \
  --volume /tmp/folio--snapshots:/tmp/folio--snapshots \
  --workdir /work \
  "$image" \
  scripts/pictures.sh "$@"
