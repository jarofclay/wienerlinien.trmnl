#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
OUT_ZIP="$DIST_DIR/vienna-transit-trmnl.zip"

mkdir -p "$DIST_DIR"
rm -f "$OUT_ZIP"

# TRMNL Private Plugin / Recipe ZIP archives MUST be flat (no subdirectories).
(
  cd "$ROOT_DIR/src"
  zip -q -X "$OUT_ZIP" \
    settings.yml \
    transform.js \
    shared.liquid \
    full.liquid \
    half_horizontal.liquid \
    half_vertical.liquid \
    quadrant.liquid
)

echo "Built TRMNL plugin archive: $OUT_ZIP"
unzip -l "$OUT_ZIP"
