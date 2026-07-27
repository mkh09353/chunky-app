#!/usr/bin/env bash
set -euo pipefail

RELEASE_URL="https://github.com/mkh09353/chunky-app/releases/latest/download"
DMG_NAME="stable-macos-arm64-Chunky.dmg"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Chunky installation is currently supported on macOS only." >&2
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "Chunky currently provides an Apple Silicon (arm64) installer only." >&2
  exit 1
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/chunky-install.XXXXXX")"
mount_point=""
cleanup() {
  if [ -n "$mount_point" ]; then
    hdiutil detach "$mount_point" -quiet || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT INT TERM

dmg="$workdir/$DMG_NAME"
echo "Downloading Chunky…"
curl --fail --location --silent --show-error "$RELEASE_URL/$DMG_NAME" --output "$dmg"

echo "Mounting installer…"
mount_point="$(hdiutil attach -nobrowse -readonly "$dmg" | awk -F '\t' '/\/Volumes\// { print $NF; exit }')"
if [ -z "$mount_point" ] || [ ! -d "$mount_point/Chunky.app" ]; then
  echo "The downloaded DMG did not contain Chunky.app." >&2
  exit 1
fi

echo "Installing Chunky to /Applications (administrator permission may be required)…"
sudo -v
sudo rm -rf /Applications/Chunky.app
sudo ditto "$mount_point/Chunky.app" /Applications/Chunky.app

if codesign --verify --deep --strict /Applications/Chunky.app >/dev/null 2>&1; then
  echo "Verified Chunky's code signature; leaving macOS quarantine metadata intact."
else
  # Keep compatibility with older unsigned releases. This is harmless when no
  # quarantine attribute exists, and can be removed after old releases expire.
  echo "No valid code signature found; removing quarantine for a legacy unsigned build."
  sudo xattr -dr com.apple.quarantine /Applications/Chunky.app || true
fi

echo "Chunky installed at /Applications/Chunky.app"
echo "Open it from Applications to get started."
