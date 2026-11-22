#!/usr/bin/env bash
# Build jq-deck: dist/jq-deck.mjs (the command) and dist/index.mjs (the library).
# The three tools it shows are bundled in, so the published package has no dependency.
#
#   ./build.sh            build
#   ./build.sh --deps     build the three sibling packages if they are not built yet
#   ./build.sh --check    build, then verify the bundles and run the command
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"

if [ "${1:-}" = "--deps" ]; then
  # This package imports the others by name, which resolves to their built files.
  for dep in agents crosstalk groundcrew; do
    if [ ! -f "$HERE/../$dep/dist/index.mjs" ] || [ ! -f "$HERE/../$dep/dist/types/index.d.ts" ]; then
      "$HERE/../$dep/build.sh"
    fi
  done
  exit 0
fi

mkdir -p "$HERE/dist"
npx --no-install esbuild "$HERE/src/main.ts" --bundle --platform=node --target=node18 --format=esm \
  --define:__JQ_DECK_VERSION__="\"$VERSION\"" --banner:js='#!/usr/bin/env node' \
  --outfile="$HERE/dist/jq-deck.mjs" --log-level=warning
npx --no-install esbuild "$HERE/src/index.ts" --bundle --platform=node --target=node18 --format=esm \
  --outfile="$HERE/dist/index.mjs" --log-level=warning
chmod +x "$HERE/dist/jq-deck.mjs"
echo "built $HERE/dist (version $VERSION, $(wc -c < "$HERE/dist/jq-deck.mjs" | tr -d ' ') bytes)"

rm -rf "$HERE/dist/types"
npx --no-install tsc -p "$HERE/tsconfig.build.json"
[ -f "$HERE/dist/types/index.d.ts" ] || { echo "error: no type declarations were written" >&2; exit 1; }

if [ "${1:-}" = "--check" ]; then
  # No database client, no env loader, and one outbound call from the command: the update
  # check, held by check-outbound.mjs.
  node "$HERE/../../scripts/check-outbound.mjs" "$HERE/dist/jq-deck.mjs" "$HERE/dist/index.mjs"
  if grep -n -E "@supabase|createClient\(|dotenv|SERVICE_ROLE|XMLHttpRequest|WebSocket|sendBeacon|https?\.request|node:https|from \"https\"" "$HERE/dist/jq-deck.mjs" "$HERE/dist/index.mjs"; then
    echo "error: a bundle names a database client, an env loader or a network call" >&2
    exit 1
  fi
  # The page server must never listen on anything but this machine.
  grep -q '"127.0.0.1"' "$HERE/dist/jq-deck.mjs" || { echo "error: the server is not bound to 127.0.0.1" >&2; exit 1; }
  if grep -n -E 'listen\([^)]*0\.0\.0\.0' "$HERE/dist/jq-deck.mjs"; then echo "error: the server listens beyond this machine" >&2; exit 1; fi
  grep -q "Apache License" "$HERE/LICENSE" || { echo "error: the package must ship its licence" >&2; exit 1; }
  [ "$(node "$HERE/dist/jq-deck.mjs" --version)" = "$VERSION" ] || { echo "error: wrong version" >&2; exit 1; }
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  mkdir "$T/empty"
  (cd "$T/empty" && CLAUDE_CONFIG_DIR="$T" CROSSTALK_DIR= node "$HERE/dist/jq-deck.mjs" --json --config "$T/none.json") | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.repos.length!==0||r.mail!==null)process.exit(1);console.log("ran: "+r.headline)})'
  echo "check passed"
fi
