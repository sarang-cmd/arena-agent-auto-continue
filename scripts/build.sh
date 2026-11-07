#!/usr/bin/env bash
# Packs the extension into dist/baton.zip.
# Only the runtime files go in: the site, tests and screenshots stay out.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="baton"
DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST/$NAME"

cp manifest.json content.js popup.html popup.js LICENSE "$DIST/$NAME/"
[ -f README.md ] && cp README.md "$DIST/$NAME/"
cp -r icons "$DIST/$NAME/"

cd "$DIST"
if command -v zip >/dev/null 2>&1; then
  zip -qr "$NAME.zip" "$NAME"
else
  # Portable fallback for machines without zip
  python3 -c "import shutil; shutil.make_archive('$NAME', 'zip', '.', '$NAME')"
fi

echo "Built dist/$NAME.zip"
unzip -l "$NAME.zip" | tail -n +2 | head -20
