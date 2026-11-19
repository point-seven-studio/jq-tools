#!/usr/bin/env bash
# Build jq-crosstalk: dist/view.mjs (the page behind `crosstalk view`) and
# dist/index.mjs (the rules and the reader, as a library). No dependency in either.
#
#   ./build.sh            build
#   ./build.sh --check    build, then verify the bundles and run the tool end to end
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/dist"
for entry in main:view index:index; do
  npx --no-install esbuild "$HERE/src/${entry%%:*}.ts" --bundle --platform=node --target=node18 --format=esm \
    --outfile="$HERE/dist/${entry##*:}.mjs" --log-level=warning
done
echo "built $HERE/dist (view.mjs $(wc -c < "$HERE/dist/view.mjs" | tr -d ' ') bytes)"

# Type declarations, so a TypeScript project can import the library.
rm -rf "$HERE/dist/types"
npx --no-install tsc -p "$HERE/tsconfig.build.json"
[ -f "$HERE/dist/types/index.d.ts" ] || { echo "error: no type declarations were written" >&2; exit 1; }

if [ "${1:-}" = "--check" ]; then
  # The package promises plain files on your machine. Fail if a bundle or the tool
  # names a database, an env loader or an outbound call.
  if grep -n -E "supabase|dotenv|SERVICE_ROLE|fetch\(|https?\.request|node:https|from \"https\"|XMLHttpRequest|WebSocket|curl |wget " "$HERE/dist/view.mjs" "$HERE/dist/index.mjs" "$HERE/bin/crosstalk"; then
    echo "error: the package names a database, an env loader or a network call" >&2
    exit 1
  fi
  grep -q "Apache License" "$HERE/LICENSE" || { echo "error: the package must ship its licence" >&2; exit 1; }
  bash -n "$HERE/bin/crosstalk"
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  "$HERE/bin/crosstalk" init "$T/mb" api web >/dev/null
  echo "hello" | CROSSTALK_DIR="$T/mb" "$HERE/bin/crosstalk" send api "Build check" --from web >/dev/null
  CROSSTALK_DIR="$T/mb" "$HERE/bin/crosstalk" view --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.waiting.total_unread!==1)process.exit(1);console.log("ran: "+r.waiting.headline)})'
  echo "check passed"
fi
