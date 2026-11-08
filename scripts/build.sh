#!/usr/bin/env bash
# Packs the extension into dist/baton.zip.
# Only the runtime files go in: the site, tests and screenshots stay out.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="baton"
DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST/$NAME"

cp manifest.json content.js background.js settings.html settings.js LICENSE "$DIST/$NAME/"
mkdir -p "$DIST/$NAME/ui" "$DIST/$NAME/notifications"
cp ui/settings.js ui/panel.js "$DIST/$NAME/ui/"
cp notifications/events.js notifications/observe.js notifications/dedupe.js notifications/notifier.js notifications/worker.js "$DIST/$NAME/notifications/"
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
# Fail loudly if the manifest points at a file that did not make it in. A missing
# content script only shows up as a silently dead feature in the browser.
import json
with open(os.path.join(name, "manifest.json")) as fh:
    manifest = json.load(fh)
wanted = ["manifest.json"]
for cs in manifest.get("content_scripts", []):
    wanted += cs.get("js", [])
wanted += manifest.get("web_accessible_resources", [])
for res in manifest.get("web_accessible_resources", []):
    if isinstance(res, dict):
        wanted = [w for w in wanted if w is not res] + res.get("resources", [])
bg = manifest.get("background", {})
wanted += bg.get("scripts", [])
icon_default = manifest.get("action", {}).get("default_icon", {})
if isinstance(icon_default, dict):
    wanted += list(icon_default.values())
elif icon_default:
    wanted.append(icon_default)
wanted += list(manifest.get("icons", {}).values())
packed = set(p.replace(os.sep, "/") for p in files)
missing = []
for w in wanted:
    if '*' in w:
        continue
    if name + "/" + w.lstrip("/") not in packed:
        missing.append(w)
if missing:
    raise SystemExit("build is missing files the manifest loads: " + ", ".join(sorted(set(missing))))
print("packed", out, len(files), "files")
PY_EOF

# The landing page offers a direct download, so the artifact ships with the site.
cp "$NAME.zip" ../site/"$NAME".zip

echo "Built dist/$NAME.zip and site/$NAME.zip"
python3 -c "import hashlib,sys;print('sha256', hashlib.sha256(open('$NAME.zip','rb').read()).hexdigest()[:16])"
