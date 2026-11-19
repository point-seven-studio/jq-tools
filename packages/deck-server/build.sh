#!/usr/bin/env bash
# Build jq-deck-server: dist/jq-deck-server.mjs (the command) and dist/index.mjs (the library).
#
#   ./build.sh            build
#   ./build.sh --check    build, then verify the bundles and run the command
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"
OUT="$HERE/dist/jq-deck-server.mjs"
mkdir -p "$HERE/dist"
npx --no-install esbuild "$HERE/src/main.ts" --bundle --platform=node --target=node18 --format=esm \
  --define:__JQ_DECK_SERVER_VERSION__="\"$VERSION\"" --banner:js='#!/usr/bin/env node' \
  --outfile="$OUT" --log-level=warning
npx --no-install esbuild "$HERE/src/index.ts" --bundle --platform=node --target=node18 --format=esm \
  --outfile="$HERE/dist/index.mjs" --log-level=warning
chmod +x "$OUT"
echo "built $HERE/dist (version $VERSION, $(wc -c < "$OUT" | tr -d ' ') bytes)"

rm -rf "$HERE/dist/types"
npx --no-install tsc -p "$HERE/tsconfig.build.json"
[ -f "$HERE/dist/types/index.d.ts" ] || { echo "error: no type declarations were written" >&2; exit 1; }

if [ "${1:-}" = "--check" ]; then
  if grep -n -E "@supabase|createClient\(|dotenv|SERVICE_ROLE|XMLHttpRequest|WebSocket|sendBeacon|https?\.request|node:https|child_process" "$OUT" "$HERE/dist/index.mjs"; then
    echo "error: a bundle names a database client, an env loader, a second way to call out, or a way to run a command" >&2
    exit 1
  fi
  # One outbound call exists: `send`, to the address the user passes. No address is written into the code.
  CALLS="$(grep -c -E "(^|[^a-zA-Z_.])fetch\(|= fetch\b" "$OUT" || true)"
  [ "$CALLS" = "1" ] || { echo "error: expected exactly one place that calls out, found $CALLS" >&2; exit 1; }
  if grep -n -o -E "https?://[a-zA-Z0-9./_-]+" "$OUT" | grep -v -E "http://(127\.0\.0\.1|\\$)"; then
    echo "error: an address is written into the bundle" >&2; exit 1
  fi
  grep -q "Apache License" "$HERE/LICENSE" || { echo "error: the package must ship its licence" >&2; exit 1; }
  [ "$(node "$OUT" --version)" = "$VERSION" ] || { echo "error: wrong version" >&2; exit 1; }
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  node "$OUT" init "$T/data" >/dev/null
  JQ_DECK_SERVER_DIR="$T/data" node "$OUT" add-machine build-box --who "Build" | grep -q "jqm_" || { echo "error: no machine token printed" >&2; exit 1; }
  if grep -q "jqm_" "$T/data/config.json"; then echo "error: a token was stored in the clear" >&2; exit 1; fi
  JQ_DECK_SERVER_DIR="$T/data" node "$OUT" list
  echo "check passed"
fi
