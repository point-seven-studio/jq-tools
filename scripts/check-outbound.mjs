#!/usr/bin/env node
// What a built JQ tool may call out to, checked on the built file itself.
//
//   node scripts/check-outbound.mjs <command bundle> [other bundle or script ...]
//
// The command bundle may hold exactly one thing that calls out without being asked: the
// update check (update-check.ts), which asks npm's registry for a version number. The
// other files named may hold none. A second call, or the one call pointed somewhere else,
// fails the build: the READMEs say what leaves a machine, and this is where that is held.
import { readFileSync } from 'fs'

const REGISTRY = 'https://registry.npmjs.org'
const [commandBundle, ...others] = process.argv.slice(2)
if (!commandBundle) {
  console.error('usage: check-outbound.mjs <command bundle> [other files...]')
  process.exit(2)
}

// Every use of the global `fetch` as a value: called, or handed on as a default.
const FETCH_USE = /(^|[^a-zA-Z0-9_.$'"`-])fetch\b(?!\s*:)/gm
const uses = (text) => [...text.matchAll(FETCH_USE)].length
const fail = (message) => {
  console.error(`error: ${message}`)
  process.exit(1)
}

const command = readFileSync(commandBundle, 'utf-8')
const found = uses(command)
if (found !== 1) fail(`${commandBundle}: expected exactly one use of fetch (the update check), found ${found}`)

// That one use must be the update check's, and must go to the registry and nowhere else.
const ask = command.match(/async function askRegistry\([^)]*\)\s*\{[\s\S]*?\n\}/)
if (!ask) fail(`${commandBundle}: the update check's askRegistry function is missing`)
if (uses(ask[0]) !== 1) fail(`${commandBundle}: the one use of fetch is not inside askRegistry`)
if (!/\$\{REGISTRY\}\/\$\{pkg\}\/latest/.test(ask[0])) fail(`${commandBundle}: askRegistry does not call REGISTRY/<package>/latest`)
const registries = [...command.matchAll(/\bREGISTRY\d*\s*=\s*["']([^"']+)["']/g)].map((m) => m[1])
if (registries.length !== 1 || registries[0] !== REGISTRY) fail(`${commandBundle}: REGISTRY must be ${REGISTRY} and nothing else, found ${JSON.stringify(registries)}`)
if (/redirect:\s*["']follow["']/.test(ask[0]) || !/redirect:\s*["']error["']/.test(ask[0])) fail(`${commandBundle}: the update check must refuse a redirect`)

for (const file of others) {
  const text = readFileSync(file, 'utf-8')
  if (uses(text) !== 0) fail(`${file}: must not use fetch at all`)
  if (text.includes('registry.npmjs.org')) fail(`${file}: must not name the registry`)
}
console.log(`outbound: one call, to ${REGISTRY}, in ${commandBundle.split('/').slice(-2).join('/')}; none in ${others.length} other ${others.length === 1 ? 'file' : 'files'}`)
