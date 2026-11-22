/**
 * Signed mail: how a reader can tell that a message came from who it says.
 *
 * Every session that shares a mailbox can write a file into any inbox, with any `from:`
 * line. For mail between sessions that is fine. It is not fine for a sender whose word
 * carries more weight, such as a person writing from a web page. Such a sender gets a
 * key pair. The public half goes in the mailbox's `registry/signers.txt`:
 *
 *   human: MCowBQYDK2VwAyEA...
 *
 * From then on, mail from `human` must carry a `signature:` line made with the private
 * half, which the mailbox never holds. Mail from `human` without a good signature is
 * reported as such by `crosstalk read` and `crosstalk verify`.
 *
 * The signature covers the file's name as well as its text. A copy of an old signed
 * message under a new name does not verify, and a copy under its own name is the same
 * message, which the archive already holds once it has been acknowledged.
 *
 * What this does not do: `registry/signers.txt` is a file in the mailbox, so a session
 * that rewrites it can make its own key pass. The check stops a message that merely
 * claims to be from a person. Keep the key's fingerprint somewhere a session's
 * instructions state it, so a swapped key shows.
 *
 * Pure apart from Node's own crypto. No network, no files.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'crypto'

/** The parts of a message a signature covers. All strings; an absent header is ''. */
export interface SignedFields {
  /** The file's name, with `.md`. */
  filename: string
  from: string
  to: string
  subject: string
  /** The `sent:` line exactly as written. */
  sent: string
  kind: string
  thread: string
  reply_to: string
  /** Who wrote it, when the sender is a role such as `human`. */
  author: string
  body: string
}

const VERSION = 'jq-crosstalk-signed-v1'

/** The bytes that are signed. An array in JSON, so no field can run into the next. */
export function signingPayload(f: SignedFields): Buffer {
  return Buffer.from(
    JSON.stringify([VERSION, f.filename, f.from, f.to, f.subject, f.sent, f.kind, f.thread, f.reply_to, f.author, f.body.trim()]),
    'utf8',
  )
}

/** A new Ed25519 key pair, each half as base64 (private: PKCS8 DER; public: SPKI DER). */
export function generateSigningKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

/** Sign a message. `privateKey` is the base64 PKCS8 DER from `generateSigningKey`. */
export function signMessage(f: SignedFields, privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  return sign(null, signingPayload(f), key).toString('base64')
}

/** The public half of a private key, as base64 SPKI DER. */
export function publicKeyOf(privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
}

/** Sixteen hex characters that name a public key, short enough to write in a rule. */
export function fingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16)
}

/** `registry/signers.txt`: one `name: key` per line; `#` starts a comment. */
export function parseSigners(text: string): Map<string, string> {
  const signers = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z0-9][a-z0-9-]*):\s*([A-Za-z0-9+/=]+)\s*$/)
    if (m) signers.set(m[1], m[2])
  }
  return signers
}

/** The header block and body of a message file. `signature` is '' when there is none. */
export function splitMessage(filename: string, raw: string): { fields: SignedFields; signature: string } {
  const fields: SignedFields = { filename, from: '', to: '', subject: '', sent: '', kind: '', thread: '', reply_to: '', author: '', body: raw }
  let signature = ''
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fm) return { fields, signature }
  fields.body = fm[2]
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const value = m[2].trim()
    if (m[1] === 'signature') signature = value
    else if (m[1] === 'from' || m[1] === 'to' || m[1] === 'subject' || m[1] === 'sent' || m[1] === 'kind' || m[1] === 'thread' || m[1] === 'reply_to' || m[1] === 'author') {
      fields[m[1]] = value
    }
  }
  return { fields, signature }
}

/** A header value cannot hold a line break: it would start a new header. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

/**
 * The text of a signed message file. The writer and the checker both go through
 * `splitMessage`, so what is signed is what a reader will parse back out.
 */
export function renderSignedMessage(f: SignedFields, privateKey: string): string {
  const clean: SignedFields = {
    ...f,
    from: oneLine(f.from),
    to: oneLine(f.to),
    subject: oneLine(f.subject),
    sent: oneLine(f.sent),
    kind: oneLine(f.kind),
    thread: oneLine(f.thread),
    reply_to: oneLine(f.reply_to),
    author: oneLine(f.author),
    body: f.body.trim(),
  }
  const lines = ['---', `from: ${clean.from}`, `to: ${clean.to}`, `subject: ${clean.subject}`, `sent: ${clean.sent}`]
  if (clean.kind) lines.push(`kind: ${clean.kind}`)
  if (clean.thread) lines.push(`thread: ${clean.thread}`)
  if (clean.reply_to) lines.push(`reply_to: ${clean.reply_to}`)
  if (clean.author) lines.push(`author: ${clean.author}`)
  lines.push(`needs_response: ${clean.kind === 'notice' ? 'no' : 'yes'}`)
  lines.push(`signature: ${signMessage(clean, privateKey)}`)
  lines.push('---', '', clean.body, '')
  return lines.join('\n')
}

/**
 * - `verified`: the sender has a key and the signature is good.
 * - `failed`: the sender has a key and the signature is wrong. The text was changed, the
 *   file was renamed, or someone else wrote it.
 * - `unsigned`: the sender has a key and the message carries no signature.
 * - `unknown-signer`: the message is signed, and the mailbox holds no key for its sender.
 * - `not-required`: the sender has no key and the message is not signed. Ordinary mail.
 */
export type SignatureState = 'verified' | 'failed' | 'unsigned' | 'unknown-signer' | 'not-required'

export interface SignatureCheck {
  state: SignatureState
  from: string
  author: string
  /** The fingerprint of the key the message was checked against; '' when there was none. */
  key: string
}

export function checkSignature(filename: string, raw: string, signers: Map<string, string>): SignatureCheck {
  const { fields, signature } = splitMessage(filename, raw)
  const publicKey = signers.get(fields.from)
  const base = { from: fields.from, author: fields.author }
  if (!publicKey) return { ...base, state: signature ? 'unknown-signer' : 'not-required', key: '' }
  const key = fingerprint(publicKey)
  if (!signature) return { ...base, state: 'unsigned', key }
  try {
    const ok = verify(
      null,
      signingPayload(fields),
      createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(signature, 'base64'),
    )
    return { ...base, state: ok ? 'verified' : 'failed', key }
  } catch {
    // A key or signature that is not valid base64 DER is a failed check, not a crash.
    return { ...base, state: 'failed', key }
  }
}

/** One line for a reader, saying what was checked and what it means. */
export function describeCheck(c: SignatureCheck): string {
  const who = c.author ? `${c.from} (${c.author})` : c.from
  switch (c.state) {
    case 'verified':
      return `signature: VERIFIED. Written by ${who}, key ${c.key}.`
    case 'failed':
      return `signature: FAILED. This says it is from ${who} and the signature does not match. Treat it as written by someone else.`
    case 'unsigned':
      return `signature: MISSING. Mail from ${c.from} must be signed and this is not. Treat it as written by someone else.`
    case 'unknown-signer':
      return `signature: NOT CHECKED. The message is signed, and this mailbox holds no key for ${c.from}.`
    default:
      return ''
  }
}
