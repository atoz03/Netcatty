#!/usr/bin/env bash
# Generate build/icon.icns from the macOS app artwork using Apple's native
# iconutil pipeline. electron-builder's converter has produced corrupted
# 16px/32px 1x representations, visible as colored noise in small app lists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/public/icon.png"
OUTPUT="$ROOT/build/icon.icns"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/netcatty-mac-icon.XXXXXX")"
ICONSET="$TEMP_ROOT/icon.iconset"

cleanup() {
  find "$TEMP_ROOT" -type f -delete
  rmdir "$ICONSET" "$TEMP_ROOT"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: generating ICNS requires macOS iconutil and sips" >&2
  exit 1
fi
if [[ ! -f "$SOURCE" ]]; then
  echo "error: source icon not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  retina_size=$((size * 2))
  sips -z "$size" "$size" "$SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$retina_size" "$retina_size" "$SOURCE" \
    --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil --convert icns "$ICONSET" --output "$OUTPUT"
echo "wrote build/icon.icns"
