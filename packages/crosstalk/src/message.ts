/**
 * Writing a message file from Node, in the format `crosstalk send` writes. Used by the
 * timers and the worker, which need to write mail without a shell.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import { slug, stamp } from './timers.js'

export interface NewMessage {
  from: string
  to: string
  subject: string
  kind: string
  body: string
  thread?: string
  reply_to?: string
  /** More header lines, such as `timer:` or `approval:`. */
  extra?: Record<string, string>
  /** A fixed name without `.md`. When a message of that name exists, nothing is written. */
  name?: string
  now?: number
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

/** Create the file only if no file of that name exists. */
function claim(file: string): boolean {
  try {
    writeFileSync(file, '', { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

/** Write a message into the recipient's inbox. Returns its path, or null when `name` was given and already delivered. */
export function writeMessage(root: string, m: NewMessage): string | null {
  const inbox = path.join(root, 'inbox', m.to)
  const archive = path.join(root, 'archive', m.to)
  if (!existsSync(inbox)) throw new Error(`unknown recipient: ${m.to} (no inbox/${m.to}/)`)
  mkdirSync(archive, { recursive: true })
  const now = m.now ?? Date.now()
  let name = m.name ?? ''
  if (name) {
    if (existsSync(path.join(archive, `${name}.md`)) || !claim(path.join(inbox, `${name}.md`))) return null
  } else {
    const base = `${stamp(now)}-${m.to}-${slug(m.subject)}`
    name = base
    for (let n = 2; existsSync(path.join(archive, `${name}.md`)) || !claim(path.join(inbox, `${name}.md`)); n++) {
      if (n > 99) throw new Error(`could not name the message: 99 with this subject were sent to ${m.to} this second`)
      name = `${base}-${n}`
    }
  }
  const lines = ['---', `from: ${oneLine(m.from)}`, `to: ${oneLine(m.to)}`, `subject: ${oneLine(m.subject)}`, `sent: ${new Date(now).toISOString().slice(0, 19)}Z`, `kind: ${oneLine(m.kind)}`, `thread: ${oneLine(m.thread || name)}`]
  if (m.reply_to) lines.push(`reply_to: ${oneLine(m.reply_to)}`)
  for (const [k, v] of Object.entries(m.extra ?? {})) lines.push(`${k}: ${oneLine(v)}`)
  lines.push(`needs_response: ${m.kind === 'notice' ? 'no' : 'yes'}`, '---', '', m.body.trim(), '')
  const file = path.join(inbox, `${name}.md`)
  writeFileSync(file, lines.join('\n'))
  return file
}
