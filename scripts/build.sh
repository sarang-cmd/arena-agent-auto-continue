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

# Pack deterministically: sorted entries, a fixed timestamp and no extra file
# attributes. Two builds of identical sources then produce identical bytes, which
# is what lets CI check that the committed zip is current.
python3 - "$NAME" <<'PY_EOF'
import os, sys, zipfile

name = sys.argv[1]
out = name + ".zip"
files = []
for root, dirs, names in os.walk(name):
    dirs.sort()
    for n in sorted(names):
        files.append(os.path.join(root, n))
files.sort()

FIXED = (1980, 1, 1, 0, 0, 0)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for path in files:
        info = zipfile.ZipInfo(path.replace(os.sep, "/"), date_time=FIXED)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o644 & 0xFFFF) << 16
        info.create_system = 3
        with open(path, "rb") as fh:
            z.writestr(info, fh.read())
print("packed", out, len(files), "files")
PY_EOF

# The landing page offers a direct download, so the artifact ships with the site.
cp "$NAME.zip" ../site/"$NAME".zip

echo "Built dist/$NAME.zip and site/$NAME.zip"
python3 -c "import hashlib,sys;print('sha256', hashlib.sha256(open('$NAME.zip','rb').read()).hexdigest()[:16])"
