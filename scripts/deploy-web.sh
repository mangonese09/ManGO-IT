#!/usr/bin/env bash
# ManGO:IT web deploy (1.18.5). Minifies js/*.js + css/styles.css into dist/
# (sources stay readable; paths and ?v= busters unchanged), parse-checks every
# minified module, then uploads MODULES FIRST and the shell (index.html,
# service worker, version.json) LAST, so no device can precache a new shell
# beside old modules (the 1.5.0 torn-state lesson). The API server is never
# touched here: the owner uploads it.
#   bash scripts/deploy-web.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VPS=root@107.172.39.168
WEB=/var/www/mangoit

rm -rf dist
node scripts/minify.mjs dist js/*.js css/styles.css
TMPM=$(mktemp -d)
for f in dist/js/*.js; do cp "$f" "$TMPM/check.mjs"; node --check "$TMPM/check.mjs" || { echo "PARSE FAILED $f" >&2; exit 1; }; done
rm -rf "$TMPM"

scp -q dist/js/*.js "$VPS:$WEB/js/"
scp -q dist/css/styles.css "$VPS:$WEB/css/"
scp -q gsi-return.html manifest.json "$VPS:$WEB/"
scp -q index.html service-worker.js version.json "$VPS:$WEB/"

LOCAL_V=$(node -pe "require('./version.json').version")
LIVE_V=$(curl -s "https://it.mangonese.dev/version.json?_=$(date +%s)" | node -pe "JSON.parse(require('fs').readFileSync(0)).version")
[ "$LOCAL_V" = "$LIVE_V" ] || { echo "DEPLOY MISMATCH: local $LOCAL_V vs live $LIVE_V" >&2; exit 1; }
echo "== deployed v$LOCAL_V (minified web)"
