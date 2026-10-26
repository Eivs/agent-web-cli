#!/usr/bin/env bash
# Build a single-file executable (the Bun runtime is embedded, so no Node/Bun is needed to run it).
#
#   bash scripts/build.sh          build for this machine  -> dist/web
#   bash scripts/build.sh all      cross-compile all targets -> dist/web-<os>-<arch>
#
# Cross-compiling downloads the target runtimes, so it needs network access.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

if [ "${1:-}" = "all" ]; then
  for target in bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64; do
    out="dist/web-${target#bun-}"
    [ "$target" = "bun-windows-x64" ] && out="$out.exe"
    echo "building $out"
    bun build --compile --minify --target="$target" src/cli.ts --outfile "$out"
  done
else
  bun build --compile --minify src/cli.ts --outfile dist/web
  echo "built dist/web"
fi
