#!/usr/bin/env bash
# Install the agent-web-cli (web) binary from GitHub Releases and optionally the
# agent skill. Safe to re-run; that is how you upgrade.
#
#   curl -fsSL https://raw.githubusercontent.com/Eivs/agent-web-cli/main/install.sh | sh
#   ./install.sh --version v0.1.0 --dir ~/.local/bin --no-skill
set -euo pipefail

REPO="${WEB_REPO:-Eivs/agent-web-cli}"
VERSION="${WEB_VERSION:-latest}"
INSTALL_DIR="${WEB_INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="${WEB_BASE_URL:-https://github.com/$REPO/releases/download}"
INSTALL_SKILL=1
FORCE=0

# Large binaries over a flaky link: retry transient failures.
CURL=(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20)

usage() {
  cat <<'USAGE'
Install the `web` CLI from GitHub Releases.

Usage: install.sh [options]

Options:
  --version <tag>   Release tag to install (default: latest, e.g. v0.1.0)
  --dir <path>      Install directory (default: $HOME/.local/bin)
  --no-skill        Do not install the agent skill (SKILL.md)
  --force           Overwrite a locally modified skill file
  -h, --help        Show this help

Environment: WEB_REPO, WEB_VERSION, WEB_INSTALL_DIR, WEB_BASE_URL
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --no-skill) INSTALL_SKILL=0; shift ;;
    --force)   FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

fail() { echo "install.sh: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  MINGW*|MSYS*|CYGWIN*) fail "This script does not support Windows. Download web-windows-x64.exe from https://github.com/$REPO/releases and put it on PATH." ;;
  *) fail "Unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "Unsupported CPU architecture: $(uname -m)" ;;
esac

asset="web-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  echo "Resolving the latest release of $REPO ..."
  tag=$("${CURL[@]}" "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || fail "could not resolve the latest release (rate limited?) - pass --version vX.Y.Z"
  VERSION="$tag"
fi

base="$BASE_URL/$VERSION"
echo "Installing $asset $VERSION"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t web-install)
trap 'rm -rf "$tmp"' EXIT

# Prefer the gzip asset (~1/4 the size); older releases only have the raw file.
compressed=0
if "${CURL[@]}" "$base/$asset.gz" -o "$tmp/$asset.gz" 2>/dev/null; then
  compressed=1
  dl="$asset.gz"
elif "${CURL[@]}" "$base/$asset" -o "$tmp/$asset"; then
  dl="$asset"
else
  fail "download failed: $base/$asset(.gz) (no asset for $os/$arch in this release?)"
fi

if "${CURL[@]}" "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  if grep -q " $dl\$" "$tmp/SHA256SUMS"; then
    ( cd "$tmp" && grep " $dl\$" SHA256SUMS > "$dl.sha256" )
    if command -v sha256sum >/dev/null 2>&1; then
      ( cd "$tmp" && sha256sum -c "$dl.sha256" >/dev/null ) || fail "checksum verification failed"
    else
      ( cd "$tmp" && shasum -a 256 -c "$dl.sha256" >/dev/null ) || fail "checksum verification failed"
    fi
    echo "Checksum OK"
  fi
else
  echo "Warning: SHA256SUMS not found for this release; skipping verification" >&2
fi

if [ "$compressed" = 1 ]; then
  gzip -dc "$tmp/$asset.gz" > "$tmp/$asset" || fail "corrupted gzip: $asset.gz"
fi

mkdir -p "$INSTALL_DIR"
target="$INSTALL_DIR/web"
tmp_bin="$INSTALL_DIR/.web.$$"
cp "$tmp/$asset" "$tmp_bin"
chmod 755 "$tmp_bin"
# mv replaces a symlink instead of writing through it.
mv -f "$tmp_bin" "$target"
echo "Installed: $target ($("$target" --version))"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: $INSTALL_DIR is not on PATH. Add it, e.g.:"
     echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc" ;;
esac

if [ "$INSTALL_SKILL" = 1 ]; then
  if [ "$FORCE" = 1 ]; then
    "$target" skill install --force || echo "Warning: skill install failed; run '$target skill install' manually." >&2
  else
    "$target" skill install || echo "Warning: skill install failed; run '$target skill install' manually." >&2
  fi
fi

echo
echo "Next: web doctor   (checks config, proxy, fetching and search)"
