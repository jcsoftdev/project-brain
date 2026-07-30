#!/bin/sh
# project-brain installer — no Node, no Bun, no package manager.
#
# Downloads the prebuilt binary for this platform from the GitHub release and
# drops it on your PATH. The published binary is a `bun build --compile`
# artifact with the runtime, WASM grammars and templates embedded, so nothing
# else is required at runtime.
#
#   curl -fsSL https://raw.githubusercontent.com/jcsoftdev/project-brain/main/scripts/install.sh | sh
#
# Environment:
#   BRAIN_VERSION      tag to install (default: latest release)
#   BRAIN_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#
# Updating: re-run this script. `project-brain update` cannot drive this channel
# and will say so rather than guessing a package-manager command.

set -eu

REPO="jcsoftdev/project-brain"
INSTALL_DIR="${BRAIN_INSTALL_DIR:-$HOME/.local/bin}"

die() {
  echo "error: $*" >&2
  exit 1
}

# --- platform → release asset -------------------------------------------------
# Keep in step with the build matrix in .github/workflows/release.yml. A target
# in one and not the other is asserted against by tests/distribution/install-script.test.ts.
detect_asset() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin)
      case "$arch" in
        arm64|aarch64) echo "project-brain-darwin-arm64" ;;
        x86_64)
          die "Intel macOS is not built. Only Apple Silicon (arm64) has a published binary.
  Install with a JavaScript package manager instead: npm install -g project-brain"
          ;;
        *) die "unsupported macOS architecture: $arch" ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64|amd64) echo "project-brain-linux-x64" ;;
        arm64|aarch64) echo "project-brain-linux-arm64" ;;
        *) die "unsupported Linux architecture: $arch" ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows is not supported by this script.
  Use Scoop:  scoop install project-brain
  or npm:     npm install -g project-brain"
      ;;
    *) die "unsupported operating system: $os" ;;
  esac
}

# --- resolve version ----------------------------------------------------------
resolve_version() {
  if [ -n "${BRAIN_VERSION:-}" ]; then
    echo "$BRAIN_VERSION"
    return
  fi
  # Read the tag off the latest-release redirect: no jq, no API token.
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  tag="${url##*/}"
  [ -n "$tag" ] && [ "$tag" != "latest" ] || die "could not determine the latest release tag"
  echo "$tag"
}

command -v curl >/dev/null 2>&1 || die "curl is required"

ASSET="$(detect_asset)"
VERSION="$(resolve_version)"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"

echo "project-brain $VERSION ($ASSET)"

TMP="$(mktemp -d)"
# Clean up on every exit path, including failure — a half-downloaded binary must
# never be left where a later run might treat it as complete.
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "  downloading…"
curl -fSL --progress-bar "$URL" -o "$TMP/project-brain" \
  || die "download failed: $URL
  That asset may not exist for this release. Check https://github.com/$REPO/releases/tag/$VERSION"

chmod +x "$TMP/project-brain"

# Prove the binary runs on this machine BEFORE putting it on PATH. A wrong-arch
# or truncated download fails here instead of at first real use.
"$TMP/project-brain" --version >/dev/null 2>&1 \
  || die "the downloaded binary does not run on this machine (wrong architecture, or a truncated download)"

mkdir -p "$INSTALL_DIR"
mv "$TMP/project-brain" "$INSTALL_DIR/project-brain"

echo "  installed to $INSTALL_DIR/project-brain"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "  $INSTALL_DIR is not on your PATH. Add it:"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "  Next:  project-brain setup      # register MCP + install host skills"
echo "         project-brain init       # in a project"
