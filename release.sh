#!/usr/bin/env bash
# TabFiler release helper.
#
# Usage:  ./release.sh 0.2.0
#
# What it does:
#   1. Sets the version in manifest.json to the argument.
#   2. Adds (or updates) the matching entry in updates.json, pointing at the
#      GitHub release asset for that version.
#   3. Builds a clean zip (manifest at root) ready to sign on AMO.
#
# After running:
#   - Upload the zip to addons.mozilla.org (unlisted) to get a SIGNED .xpi.
#   - Rename the signed file to  tabfiler-<version>.xpi
#   - Create a GitHub release tagged  v<version>  and attach that signed .xpi.
#   - Commit the updated manifest.json + updates.json and push (Pages serves them).
#
# Firefox then sees the new version in updates.json and auto-updates installed copies.

set -euo pipefail

GH_USER="bensh"
GH_REPO="tabfiler"
ADDON_ID="tabfiler@bensh.github.io"
MIN_VER="140.0"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>   e.g. $0 0.2.0" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must look like 1.2.3" >&2
  exit 1
fi

cd "$(dirname "$0")"

# 1. Bump manifest version (portable sed).
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  m.version = process.argv[1];
  fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n");
  console.log("manifest.json version -> " + m.version);
' "$VERSION"

# 2. Rebuild updates.json with this version appended (or replaced).
node -e '
  const fs = require("fs");
  const [version, user, repo, id, minVer] = process.argv.slice(1);
  const path = "updates.json";
  let data = { addons: {} };
  try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
  data.addons[id] = data.addons[id] || { updates: [] };
  const link = `https://github.com/${user}/${repo}/releases/download/v${version}/${repo}-${version}.xpi`;
  const entry = {
    version,
    update_link: link,
    applications: { gecko: { strict_min_version: minVer } },
  };
  const list = data.addons[id].updates.filter((u) => u.version !== version);
  list.push(entry);
  // keep sorted by version (simple semver-ish sort)
  list.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  data.addons[id].updates = list;
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log("updates.json -> added " + version);
' "$VERSION" "$GH_USER" "$GH_REPO" "$ADDON_ID" "$MIN_VER"

# 3. Build the clean zip for signing (exclude dev/tooling files).
OUT="tabfiler-${VERSION}.zip"
rm -f "$OUT"
zip -r -FS -q "$OUT" . \
  -x "release.sh" "./release.sh" \
     "*.pyc" "*.DS_Store" \
     "*.zip" "./*.zip" \
     "*.xpi" "./*.xpi" \
     "README.md" "./README.md" \
     ".git/*" "./.git/*" "node_modules/*" "./node_modules/*"
echo "built $OUT"

echo
echo "Next steps:"
echo "  1. Upload $OUT to https://addons.mozilla.org/developers/ (choose 'On your own')."
echo "  2. Download the SIGNED .xpi, rename it to  ${GH_REPO}-${VERSION}.xpi"
echo "  3. Create GitHub release  v${VERSION}  and attach that signed .xpi."
echo "  4. Commit & push manifest.json + updates.json (GitHub Pages serves updates.json)."
