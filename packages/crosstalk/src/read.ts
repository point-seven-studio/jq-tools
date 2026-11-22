/**
 * Read a mailbox folder into messages. Filesystem only: no network, no database.
 *
 * A message in inbox/<name>/ is unread; one in archive/<name>/ has been acknowledged.
 * The same file can briefly be in both while it is being moved; the archive wins,
 * because acknowledged is the final state.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import type { Message } from './board.js'
import { parseMessage } from './parse.js'
import { checkSignature, parseSigners } from './sign.js'

export interface MailboxMessage extends Message {
  body: string
}

function names(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory())
}

export function readMailbox(root: string): MailboxMessage[] {
  if (!existsSync(path.join(root, 'inbox'))) throw new Error(`not a crosstalk mailbox (no inbox/ folder): ${root}`)
  // Signed mail: check each message from a signer as it is read, so a view can say so.
  const signersFile = path.join(root, 'registry', 'signers.txt')
  const signers = existsSync(signersFile) ? parseSigners(readFileSync(signersFile, 'utf8')) : new Map<string, string>()
  const byKey = new Map<string, MailboxMessage>()
  for (const [base, acked] of [['inbox', false], ['archive', true]] as const) {
    for (const name of names(path.join(root, base))) {
      const dir = path.join(root, base, name)
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const raw = readFileSync(path.join(dir, file), 'utf8')
        const row = parseMessage(file, raw, name, acked)
        const state = checkSignature(file, raw, signers).state
        // The same filename in two inboxes is two deliveries, so the key has both.
        const key = `${name}/${file}`
        const prev = byKey.get(key)
        if (!prev || (acked && !prev.acked)) byKey.set(key, { id: key, ...row, signature_state: state === 'not-required' ? null : state })
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id))
}
