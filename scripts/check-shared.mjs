#!/usr/bin/env node
// presence.ts is the same file in every package (see its header). This fails when the
// copies differ, or when a port in it is not the port that tool serves on. `--write` copies packages/deck/src/presence.ts over the others.
import { copyFileSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = (pkg) => path.join(root, 'packages', pkg, 'src', 'presence.ts')
const SOURCE = 'deck'
const COPIES = ['agents', 'groundcrew', 'crosstalk', 'deck-server']

if (process.argv.includes('--write')) {
  for (const pkg of COPIES) copyFileSync(file(SOURCE), file(pkg))
  console.log(`copied packages/${SOURCE}/src/presence.ts to ${COPIES.join(', ')}`)
}
const source = readFileSync(file(SOURCE), 'utf-8')
const differ = COPIES.filter((pkg) => {
  try {
    return readFileSync(file(pkg), 'utf-8') !== source
  } catch {
    return true
  }
})
if (differ.length) {
  console.error(`presence.ts differs from packages/${SOURCE} in: ${differ.join(', ')}. Run: node scripts/check-shared.mjs --write`)
  process.exit(1)
}
console.log('presence.ts is the same in every package')

// update-check.ts is the same file in the four tools that run on a person's machine.
// jq-deck-server has no copy: that server calls nothing.
const updateFile = (pkg) => path.join(root, 'packages', pkg, 'src', 'update-check.ts')
const UPDATE_COPIES = ['agents', 'groundcrew', 'crosstalk']
if (process.argv.includes('--write')) {
  for (const pkg of UPDATE_COPIES) copyFileSync(updateFile(SOURCE), updateFile(pkg))
  console.log(`copied packages/${SOURCE}/src/update-check.ts to ${UPDATE_COPIES.join(', ')}`)
}
const updateSource = readFileSync(updateFile(SOURCE), 'utf-8')
const updateDiffer = UPDATE_COPIES.filter((pkg) => {
  try {
    return readFileSync(updateFile(pkg), 'utf-8') !== updateSource
  } catch {
    return true
  }
})
if (updateDiffer.length) {
  console.error(`update-check.ts differs from packages/${SOURCE} in: ${updateDiffer.join(', ')}. Run: node scripts/check-shared.mjs --write`)
  process.exit(1)
}
try {
  readFileSync(updateFile('deck-server'), 'utf-8')
  console.error('packages/deck-server must not hold update-check.ts: that server calls nothing')
  process.exit(1)
} catch {
  /* absent, as it should be */
}
console.log('update-check.ts is the same in the four local tools, and absent from the server')

// The bar links each tool at the port in presence.ts. That must be the port the tool serves on.
const PORT_SOURCE = { deck: 'deck/src/cli.ts', agents: 'agents/src/cli.ts', groundcrew: 'groundcrew/src/groundcrew-cli.ts', crosstalk: 'crosstalk/src/view.ts' }
let wrong = 0
for (const [id, rel] of Object.entries(PORT_SOURCE)) {
  const served = readFileSync(path.join(root, 'packages', rel), 'utf-8').match(/export const DEFAULT_PORT = (\d+)/)?.[1]
  const linked = source.match(new RegExp(`id: '${id}'[^}]*port: (\\d+)`))?.[1]
  if (!served || served !== linked) {
    console.error(`${id}: presence.ts links port ${linked}, and packages/${rel} serves on ${served}`)
    wrong++
  }
}
if (wrong) process.exit(1)
console.log('the bar links each tool at the port it serves on')
