#!/usr/bin/env bash
# Build jq-groundcrew into one file with no dependency: dist/groundcrew.mjs.
#
#   ./build.sh            build
#   ./build.sh --check    build, then verify the bundle and run it on this repository
#
# --check fails if the bundle names a database, an env loader or a network call: the package
# promises to send nothing anywhere, and this is where that promise is enforced.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"
OUT="$HERE/dist/groundcrew.mjs"

mkdir -p "$HERE/dist"
npx --no-install esbuild "$HERE/src/main.ts" \
  --bundle --platform=node --target=node18 --format=esm \
  --define:__GROUNDCREW_VERSION__="\"$VERSION\"" \
  --banner:js='#!/usr/bin/env node' \
  --outfile="$OUT" --log-level=warning
chmod +x "$OUT"
echo "built $OUT (version $VERSION, $(wc -c < "$OUT" | tr -d ' ') bytes)"

if [ "${1:-}" = "--check" ]; then
  if grep -n -E "supabase|dotenv|SERVICE_ROLE|fetch\(|https?\.request|node:https|require\(\"https\"\)|from \"https\"|XMLHttpRequest|WebSocket" "$OUT"; then
    echo "error: the bundle names a database, an env loader or a network call" >&2
    exit 1
  fi
  grep -q "Apache License" "$HERE/LICENSE" || { echo "error: the package must ship its licence" >&2; exit 1; }
  [ "$(node "$OUT" --version)" = "$VERSION" ] || { echo "error: the bundle reports the wrong version" >&2; exit 1; }
  node "$OUT" "$HERE/../.." --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("ran: "+r.checks.length+" checks, score "+r.summary.score)})'
  echo "check passed"
fi
