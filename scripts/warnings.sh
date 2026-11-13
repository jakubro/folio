#!/bin/bash
# Fail on any warning line - npm, Node, Astro, Vite, esbuild or Biome - in the logs given, or with - on stdin.
set -euo pipefail

PATTERN='^npm (warn|notice)|\(node:[0-9]+\) (\[[A-Z0-9_]+\] )?[A-Za-z]*Warning|\[WARN\]|\[WARNING\]|^Found [0-9]+ warnings?\b|\(!\) |\bis deprecated\b|\bare deprecated\b'

if found=$(grep -hE "$PATTERN" "$@"); then
  echo "warnings.sh: a gate prints warnings, and a warning fails it:" >&2
  echo "$found" >&2
  exit 1
fi
