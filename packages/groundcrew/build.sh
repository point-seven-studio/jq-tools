#!/usr/bin/env bash
# Build jq-groundcrew into one file with no dependency: dist/groundcrew.mjs.
#
#   ./build.sh            build
#   ./build.sh --check    build, then verify the bundle and run it on this repository
#
# --check fails if the bundle names a database, an env loader or a network call other than
# the update check: the package promises to send nothing about a project anywhere, and this
# is where that promise is enforced.
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
# The same code as a library, for a tool that wants the checks without the command.
npx --no-install esbuild "$HERE/src/index.ts" --bundle --platform=node --target=node18 --format=esm \
  --outfile="$HERE/dist/index.mjs" --log-level=warning
echo "built $OUT (version $VERSION, $(wc -c < "$OUT" | tr -d ' ') bytes)"

# Type declarations, so a TypeScript project can import the library.
rm -rf "$HERE/dist/types"
npx --no-install tsc -p "$HERE/tsconfig.build.json"
[ -f "$HERE/dist/types/index.d.ts" ] || { echo "error: no type declarations were written" >&2; exit 1; }

if [ "${1:-}" = "--check" ]; then
  # The one call allowed is the update check, held by check-outbound.mjs. The library holds
  # it too, because it exports runLocal, the page server. A caller of the library never
  # triggers it: runLocal asks npm only when it is handed a real version, and only the
  # command does that.
  node "$HERE/../../scripts/check-outbound.mjs" "$OUT"
  node "$HERE/../../scripts/check-outbound.mjs" "$HERE/dist/index.mjs"
  if grep -n -E "supabase|dotenv|SERVICE_ROLE|https?\.request|node:https|require\(\"https\"\)|from \"https\"|XMLHttpRequest|WebSocket" "$OUT" "$HERE/dist/index.mjs"; then
    echo "error: the bundle names a database, an env loader or a network call" >&2
    exit 1
  fi
  grep -q "Apache License" "$HERE/LICENSE" || { echo "error: the package must ship its licence" >&2; exit 1; }
  [ "$(node "$OUT" --version)" = "$VERSION" ] || { echo "error: the bundle reports the wrong version" >&2; exit 1; }
  node -e "import('$HERE/dist/index.mjs').then(m=>{for(const k of ['runChecks','gather','boardSummary','runLocal','renderPage'])if(typeof m[k]!=='function'){console.error('missing export: '+k);process.exit(1)}})"
  node "$OUT" "$HERE/../.." --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("ran: "+r.checks.length+" checks, score "+r.summary.score)})'
  echo "check passed"
fi
