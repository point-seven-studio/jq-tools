/**
 * `jq-deck approvals`: let a person answer a worker's waiting command from somewhere else.
 *
 * A crosstalk worker stops at a command on its ask list and writes an approval request into
 * the approver's inbox (jq-crosstalk, "Commands that wait for a person"). This command hands
 * those requests to a command of yours, and takes back signed answers to put in the mailbox.
 *
 * What it does, and does not:
 *  - It is OFF unless you run it. `jq-deck` and `jq-deck --watch` never read or send a request.
 *  - What leaves the machine is the TEXT of each waiting request, which quotes the command.
 *    A command that holds a secret puts the secret in that text.
 *  - It hands requests over only for an approver whose mail must be signed
 *    (registry/signers.txt). An approver with no key is skipped: an answer from elsewhere
 *    could not be told from a forged one.
 *  - It writes an answer into the mailbox only when the signature is good for that approver,
 *    the answer replies to a request that is waiting right now, and it names that request's
 *    exact text (`request-sha256:`). Anything else is refused and said so.
 *  - This file calls nothing. Your `--exec` command does the sending, as with `--watch`.
 */
import { spawn } from 'child_process'
import { createPublicKey } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { answerDigest, buildReport, checkSignature, fingerprint, parseAnswer, parseSigners, requestDigest, splitMessage } from '@point-seven-studio/jq-crosstalk'
import { defaultConfigFile, expandHome, findMailbox, loadConfig } from './deck.js'

/** A request longer than this is not handed over: the reader could not check all of it on a phone. */
export const MAX_REQUEST_CHARS = 8000
export const MAX_PENDING = 20
const MAX_ANSWER_BYTES = 20_000
const MAX_REPLY_BYTES = 1_000_000
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const FILE = /^[0-9]{8}-[0-9]{6}-[a-z0-9][a-z0-9-]{0,100}\.md$/

export interface PendingApproval {
  /** File name of the request in the approver's inbox. An answer's `reply_to`. */
  request: string
  /** The worker that asked. An answer goes to its inbox. */
  worker: string
  approver: string
  thread: string
  subject: string
  tool: string
  asked_at: string
  /** The request's text, which quotes the command. */
  text: string
  /** `requestDigest(text)`: what an answer must carry as `request-sha256:`. */
  digest: string
}

export interface ApprovalsReport {
  v: 1
  generated_at: string
  pending: PendingApproval[]
}

export interface ApprovalAnswer {
  worker: string
  filename: string
  /** A whole signed message file. */
  content: string
}

function readSigners(mailbox: string): Map<string, string> {
  try {
    return parseSigners(readFileSync(path.join(mailbox, 'registry', 'signers.txt'), 'utf8'))
  } catch {
    return new Map()
  }
}

/** The requests a person can answer from elsewhere, and why any other was left out. */
export function collectPending(mailbox: string, now = Date.now()): { report: ApprovalsReport; skipped: string[] } {
  const signers = readSigners(mailbox)
  const pending: PendingApproval[] = []
  const skipped: string[] = []
  for (const worker of buildReport(mailbox, now).workers ?? []) {
    for (const w of worker.waiting) {
      if (!signers.has(w.approver)) {
        skipped.push(`${w.request}: its approver "${w.approver}" has no key in registry/signers.txt`)
        continue
      }
      const file = path.join(mailbox, 'inbox', w.approver, w.request)
      if (!existsSync(file)) {
        skipped.push(`${w.request}: the request is no longer in inbox/${w.approver}`)
        continue
      }
      const { fields } = splitMessage(w.request, readFileSync(file, 'utf8'))
      const text = fields.body.trim()
      if (text.length > MAX_REQUEST_CHARS) {
        skipped.push(`${w.request}: the request is longer than ${MAX_REQUEST_CHARS} characters. Answer it on this machine.`)
        continue
      }
      pending.push({ request: w.request, worker: worker.name, approver: w.approver, thread: fields.thread || w.thread, subject: fields.subject, tool: w.tool, asked_at: w.asked_at, text, digest: requestDigest(text) })
    }
  }
  if (pending.length > MAX_PENDING) skipped.push(`${pending.length - MAX_PENDING} more requests are waiting than one pass hands over`)
  return { report: { v: 1, generated_at: new Date(now).toISOString(), pending: pending.slice(0, MAX_PENDING) }, skipped }
}

/** The answers in what the command printed. Anything that is not a list of answers is none. */
export function parseAnswers(printed: string): ApprovalAnswer[] {
  let data: any
  try {
    data = JSON.parse(printed)
  } catch {
    return []
  }
  const list = Array.isArray(data?.answers) ? data.answers : []
  return list.filter((a: any) => a && typeof a.worker === 'string' && typeof a.filename === 'string' && typeof a.content === 'string')
}

/** Why an answer may not be written into the mailbox, or null when it may. Reads the mailbox, writes nothing. */
export function refusal(mailbox: string, pending: PendingApproval[], a: ApprovalAnswer, signers = readSigners(mailbox)): string | null {
  if (!NAME.test(a.worker) || !FILE.test(a.filename)) return 'its name is not one this mailbox would write'
  if (Buffer.byteLength(a.content) > MAX_ANSWER_BYTES) return 'it is too long to be an answer'
  const { fields } = splitMessage(a.filename, a.content)
  const asked = pending.find((p) => p.worker === a.worker && p.request === fields.reply_to)
  if (!asked) return 'it answers no request that is waiting now'
  if (fields.to !== a.worker) return 'it is addressed to someone else'
  if (fields.from !== asked.approver) return `it is not from ${asked.approver}, who was asked`
  const check = checkSignature(a.filename, a.content, signers)
  if (check.state !== 'verified') return `its signature is ${check.state}`
  if (answerDigest(fields.body) !== asked.digest) return 'it does not name the text of the request that is waiting'
  if (!parseAnswer(fields.body)) return 'it says neither approve nor deny'
  return null
}

export interface Applied {
  written: string[]
  /** Already in the inbox or the archive: delivered on an earlier pass. */
  already: string[]
  refused: { filename: string; why: string }[]
}

/** Write each good answer into its worker's inbox, once. */
export function applyAnswers(mailbox: string, pending: PendingApproval[], answers: ApprovalAnswer[]): Applied {
  const signers = readSigners(mailbox)
  const out: Applied = { written: [], already: [], refused: [] }
  for (const a of answers) {
    const why = refusal(mailbox, pending, a, signers)
    if (why) {
      out.refused.push({ filename: String(a.filename).slice(0, 120), why })
      continue
    }
    const inbox = path.join(mailbox, 'inbox', a.worker)
    if (existsSync(path.join(inbox, a.filename)) || existsSync(path.join(mailbox, 'archive', a.worker, a.filename))) {
      out.already.push(a.filename)
      continue
    }
    if (!existsSync(inbox)) {
      out.refused.push({ filename: a.filename, why: `inbox/${a.worker} does not exist` })
      continue
    }
    try {
      // `wx`: never over a file that appeared since the check above.
      writeFileSync(path.join(inbox, a.filename), a.content, { flag: 'wx', mode: 0o600 })
      out.written.push(a.filename)
    } catch {
      out.already.push(a.filename)
    }
  }
  return out
}

/**
 * Add a signer to registry/signers.txt, and make the inbox its requests are written to.
 * Returns the key's fingerprint. A name that already has a different key is refused unless
 * `replace` is set, because changing a key changes who can approve.
 */
export function trustSigner(mailbox: string, name: string, publicKey: string, replace = false): { fingerprint: string; changed: boolean } {
  if (!NAME.test(name)) throw new Error('a signer\'s name is lower-case letters, digits and hyphens')
  if (!/^[A-Za-z0-9+/=]{40,200}$/.test(publicKey)) throw new Error('that is not a public key. Copy the whole key from the board.')
  // A key that cannot be read would make every answer fail later, with a worse message.
  let kind: string | undefined
  try {
    kind = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType
  } catch {
    kind = undefined
  }
  if (kind !== 'ed25519') throw new Error('that key could not be read. Copy the whole key from the board.')
  const file = path.join(mailbox, 'registry', 'signers.txt')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const have = parseSigners(text).get(name)
  const print = fingerprint(publicKey)
  for (const dir of ['inbox', 'archive']) mkdirSync(path.join(mailbox, dir, name), { recursive: true })
  if (have === publicKey) return { fingerprint: print, changed: false }
  if (have && !replace) throw new Error(`${name} already has a different key (fingerprint ${fingerprint(have)}). Pass --replace to change it: that changes who can approve.`)
  mkdirSync(path.dirname(file), { recursive: true })
  if (have) {
    const kept = text.split('\n').filter((line) => !new RegExp(`^${name}:\\s`).test(line)).join('\n')
    writeFileSync(file, `${kept.trim() ? kept.replace(/\n*$/, '\n') : ''}${name}: ${publicKey}\n`)
  } else if (text) appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${name}: ${publicKey}\n`)
  else writeFileSync(file, `# Senders whose mail must be signed. One line per sender: \`name: public key\`.\n${name}: ${publicKey}\n`)
  return { fingerprint: print, changed: true }
}

/** Pipe the requests to the user's command and collect what it prints. */
function hand(cmd: string, report: ApprovalsReport): Promise<{ code: number; printed: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_REPLY_BYTES) chunks.push(chunk)
    })
    child.on('error', () => resolve({ code: 127, printed: '' }))
    child.on('close', (code) => resolve({ code: code ?? 1, printed: size <= MAX_REPLY_BYTES ? Buffer.concat(chunks).toString('utf8') : '' }))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(report))
  })
}

export interface ApprovalArgs {
  command: 'sync' | 'trust'
  exec: string | null
  watch: boolean
  intervalS: number
  quiet: boolean
  mailbox: string | null
  config: string
  replace: boolean
  positional: string[]
}

export function parseApprovalArgs(argv: string[], env: Record<string, string | undefined> = {}): ApprovalArgs {
  const a: ApprovalArgs = { command: 'sync', exec: null, watch: false, intervalS: 30, quiet: false, mailbox: null, config: env.JQ_DECK_CONFIG || defaultConfigFile(), replace: false, positional: [] }
  let rest = argv
  if (argv[0] === 'trust') {
    a.command = 'trust'
    rest = argv.slice(1)
  }
  const value = (i: number, flag: string) => {
    const v = rest[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i]
    if (f === '--exec') a.exec = value(i++, f)
    else if (f === '--watch') a.watch = true
    else if (f === '--quiet') a.quiet = true
    else if (f === '--replace') a.replace = true
    else if (f === '--interval') a.intervalS = Number(value(i++, f))
    else if (f === '--mailbox') a.mailbox = value(i++, f)
    else if (f === '--config') a.config = value(i++, f)
    else if (f.startsWith('--')) throw new Error(`unknown option: ${f}`)
    else a.positional.push(f)
  }
  if (a.command === 'trust') {
    if (a.positional.length !== 2) throw new Error('usage: jq-deck approvals trust NAME KEY   (the board shows both)')
    if (a.exec || a.watch) throw new Error('trust takes a name and a key, and nothing to run')
    return a
  }
  if (a.positional.length) throw new Error(`unknown word: ${a.positional[0]}`)
  if (!a.exec) throw new Error('approvals needs --exec CMD (what should receive the waiting requests?)')
  if (!(a.intervalS >= 10)) throw new Error('--interval needs 10 seconds or more')
  if (a.replace) throw new Error('--replace goes with trust')
  return a
}

export async function runApprovals(argv: string[], env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Promise<void> {
  const a = parseApprovalArgs(argv, env)
  const mailbox = findMailbox({ flag: a.mailbox, config: loadConfig(expandHome(a.config)).mailbox, env: env.CROSSTALK_DIR, cwd })
  if (!mailbox || !existsSync(path.join(mailbox, 'inbox'))) throw new Error('no crosstalk mailbox found. Pass --mailbox DIR, or set $CROSSTALK_DIR.')
  if (a.command === 'trust') {
    const [name, key] = a.positional
    const done = trustSigner(mailbox, name, key, a.replace)
    console.log(done.changed ? `jq-deck: ${name} may now sign answers in ${mailbox}.` : `jq-deck: ${name} already has this key.`)
    console.log(`jq-deck: key fingerprint ${done.fingerprint}. Check it against the one the board shows.`)
    console.log(`jq-deck: start a worker with --approver ${name} for its requests to go there.`)
    return
  }
  // After a pass that handed something over, one more pass runs even with nothing
  // waiting, so the other side learns the requests are gone.
  let handedLast = true
  const tick = async () => {
    try {
      const { report, skipped } = collectPending(mailbox)
      for (const line of skipped) console.error(`jq-deck: not handed over: ${line}`)
      if (!report.pending.length && !handedLast) return
      handedLast = report.pending.length > 0
      const { code, printed } = await hand(a.exec as string, report)
      if (code !== 0) {
        console.error(`${new Date().toISOString()} jq-deck: ${report.pending.length} waiting ${report.pending.length === 1 ? 'request' : 'requests'} handed to your command, which FAILED (exit ${code})`)
        return
      }
      const done = applyAnswers(mailbox, report.pending, parseAnswers(printed))
      for (const r of done.refused) console.error(`jq-deck: answer ${r.filename} REFUSED: ${r.why}`)
      for (const f of done.written) console.log(`jq-deck: answer ${f} is in the mailbox. The worker takes it on its next pass.`)
      if (!a.quiet && !done.written.length) console.log(`jq-deck: ${report.pending.length} waiting ${report.pending.length === 1 ? 'request' : 'requests'} handed to your command`)
    } catch (e: any) {
      console.error('jq-deck: approvals pass failed:', e?.message || e)
    }
  }
  console.log('jq-deck: the TEXT of each waiting approval request is handed to your command. It quotes the command that is waiting.')
  await tick()
  if (!a.watch) return
  console.log(`jq-deck: looking every ${a.intervalS}s (Ctrl-C to stop)`)
  setInterval(tick, a.intervalS * 1000)
}
