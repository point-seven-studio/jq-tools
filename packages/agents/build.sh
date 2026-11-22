#!/usr/bin/env bash
# Build jq-agents: dist/jq-agents.mjs (the command) and dist/index.mjs (the library).
#
#   ./build.sh            build
#   ./build.sh --check    build, then verify the bundles and run the command
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"
mkdir -p "$HERE/dist"
npx --no-install esbuild "$HERE/src/main.ts" --bundle --platform=node --target=node18 --format=esm \
  --define:__JQ_AGENTS_VERSION__="\"$VERSION\"" --banner:js='#!/usr/bin/env node' \
  --outfile="$HERE/dist/jq-agents.mjs" --log-level=warning
npx --no-install esbuild "$HERE/src/index.ts" --bundle --platform=node --target=node18 --format=esm \
  --outfile="$HERE/dist/index.mjs" --log-level=warning
chmod +x "$HERE/dist/jq-agents.mjs"
echo "built $HERE/dist (version $VERSION, $(wc -c < "$HERE/dist/jq-agents.mjs" | tr -d ' ') bytes)"

# Type declarations, so a TypeScript project can import the library.
rm -rf "$HERE/dist/types"
npx --no-install tsc -p "$HERE/tsconfig.build.json"
[ -f "$HERE/dist/types/index.d.ts" ] || { echo "error: no type declarations were written" >&2; exit 1; }

if [ "${1:-}" = "--check" ]; then
  # No database client and no env loader, ever.
  node "$HERE/../../scripts/check-outbound.mjs" "$HERE/dist/jq-agents.mjs" "$HERE/dist/index.mjs"
  if grep -n -E "@supabase|createClient\(|dotenv|XMLHttpRequest|WebSocket|sendBeacon" "$HERE/dist/jq-agents.mjs" "$HERE/dist/index.mjs"; then
    echo "error: a bundle names a database client or an env loader" >&2
    exit 1
  fi
  # Exactly two outbound destinations exist in the code: one behind --probe, and npm's
  # registry for the update check. A third means something new can leave the machine and
  # the README is now wrong.
  HOSTS="$(grep -o -E "https?://[a-zA-Z0-9./_-]+" "$HERE/dist/jq-agents.mjs" | grep -v -E "^http://127\.0\.0\.1" | sort -u)"
  [ "$HOSTS" = "$(printf 'https://api.anthropic.com/\nhttps://registry.npmjs.org')" ] || { echo "error: unexpected outbound address in the bundle:"; echo "$HOSTS"; exit 1; } >&2
  grep -q "Apache License" "$HERE/LICENSE" || { echo "error: the package must ship its licence" >&2; exit 1; }
  [ "$(node "$HERE/dist/jq-agents.mjs" --version)" = "$VERSION" ] || { echo "error: wrong version" >&2; exit 1; }
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  CLAUDE_CONFIG_DIR="$T" node "$HERE/dist/jq-agents.mjs" --json --no-sample | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.sessions.length!==0)process.exit(1);console.log("ran: 0 sessions in an empty folder")})'
  echo "check passed"
fi
