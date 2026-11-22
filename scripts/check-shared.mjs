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
