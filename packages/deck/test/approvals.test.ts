/**
 * Tests for `jq-deck approvals`. The command moves two things across the edge of a machine:
 * the text of a waiting command goes out, and an answer that can let a `git push` run comes
 * in. A regression here either sends text nobody opted to send, or writes an answer into the
 * mailbox that its approver never gave.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fingerprint, generateSigningKey, renderSignedMessage, requestDigest } from '@point-seven-studio/jq-crosstalk'
import { applyAnswers, collectPending, parseAnswers, parseApprovalArgs, refusal, trustSigner, MAX_REQUEST_CHARS } from '../src/approvals.js'

const REQUEST = '20261201-090000-phone-approve-bash-git-push-origin-main.md'
const TEXT = 'A run of "api" stopped at this Bash call and is waiting for you.\n\n```\ngit push origin main\n```\n\nReply with `approve` or `deny` as the first line.'

let box: string
let keys: { publicKey: string; privateKey: string }

function request(text = TEXT, approver = 'phone', name = REQUEST) {
  writeFileSync(path.join(box, 'inbox', approver, name), `---\nfrom: api\nto: ${approver}\nsubject: Approve? Bash: git push origin main\nsent: 2026-12-01T09:00:00Z\nkind: question\nthread: t-1\napproval: toolu_1\nneeds_response: yes\n---\n\n${text}\n`)
  writeFileSync(path.join(box, 'worker/api/state.json'), JSON.stringify({ sessions: {}, attempts: {}, dropped: [], waiting: { 't-1': { session_id: 's', tool_use_id: 'toolu_1', tool: 'Bash', request: name, approver, asked_at: '2026-12-01T09:00:00Z', events: [] } } }))
}

function answer(over: Record<string, string> = {}, key = keys.privateKey, filename = '20261201-090500-api-re-approve-p1a2b3c4d.md') {
  const fields = { filename, from: 'phone', to: 'api', subject: 'Re: Approve? Bash: git push origin main', sent: '2026-12-01T09:05:00Z', kind: 'notice', thread: 't-1', reply_to: REQUEST, author: '', body: `approve\n\nrequest-sha256: ${requestDigest(TEXT)}`, ...over }
  return { worker: 'api', filename, content: renderSignedMessage(fields, key) }
}

beforeEach(() => {
  box = mkdtempSync(path.join(os.tmpdir(), 'jq-deck-approvals-'))
  for (const d of ['inbox/api', 'inbox/phone', 'inbox/owner', 'archive/api', 'archive/phone', 'registry', 'worker/api']) mkdirSync(path.join(box, d), { recursive: true })
  writeFileSync(path.join(box, '.crosstalk'), '')
  keys = generateSigningKey()
  writeFileSync(path.join(box, 'registry/signers.txt'), `phone: ${keys.publicKey}\n`)
})

describe('which requests are handed over', () => {
  it('hands over a waiting request with its text and the fingerprint of that text', () => {
    request()
    const { report, skipped } = collectPending(box, Date.parse('2026-12-01T09:01:00Z'))
    expect(skipped).toEqual([])
    expect(report).toMatchObject({ v: 1, generated_at: '2026-12-01T09:01:00.000Z' })
    expect(report.pending).toEqual([{ request: REQUEST, worker: 'api', approver: 'phone', thread: 't-1', subject: 'Approve? Bash: git push origin main', tool: 'Bash', asked_at: '2026-12-01T09:00:00Z', text: TEXT, digest: requestDigest(TEXT) }])
  })
  it('hands over nothing when no worker is waiting', () => {
    expect(collectPending(box).report.pending).toEqual([])
  })
  it('skips an approver with no key, and says why', () => {
    request(TEXT, 'owner')
    const { report, skipped } = collectPending(box)
    expect(report.pending).toEqual([])
    expect(skipped[0]).toContain('has no key')
  })
  it('skips a request too long to read on a phone', () => {
    request('x'.repeat(MAX_REQUEST_CHARS + 1))
    const { report, skipped } = collectPending(box)
    expect(report.pending).toEqual([])
    expect(skipped[0]).toContain('Answer it on this machine')
  })
})

describe('which answers are written into the mailbox', () => {
  const pending = () => collectPending(box).report.pending
  beforeEach(() => request())

  it('writes a signed answer to a waiting request, once', () => {
    const a = answer()
    expect(applyAnswers(box, pending(), [a])).toEqual({ written: [a.filename], already: [], refused: [] })
    expect(readFileSync(path.join(box, 'inbox/api', a.filename), 'utf8')).toBe(a.content)
    expect(applyAnswers(box, pending(), [a])).toEqual({ written: [], already: [a.filename], refused: [] })
  })
  it('does not put back an answer the worker already acknowledged', () => {
    const a = answer()
    writeFileSync(path.join(box, 'archive/api', a.filename), a.content)
    expect(applyAnswers(box, pending(), [a]).already).toEqual([a.filename])
    expect(readdirSync(path.join(box, 'inbox/api'))).toEqual([])
  })
  it('refuses an answer signed with another key', () => {
    expect(refusal(box, pending(), answer({}, generateSigningKey().privateKey))).toBe('its signature is failed')
  })
  it('refuses an answer with no signature', () => {
    const a = answer()
    expect(refusal(box, pending(), { ...a, content: a.content.replace(/^signature: .*\n/m, '') })).toBe('its signature is unsigned')
  })
  it('refuses an answer whose text was changed after it was signed', () => {
    const a = answer({ body: `deny\n\nrequest-sha256: ${requestDigest(TEXT)}` })
    expect(refusal(box, pending(), { ...a, content: a.content.replace('\ndeny\n', '\napprove\n') })).toBe('its signature is failed')
  })
  it('refuses an answer to a request that is not waiting', () => {
    expect(refusal(box, pending(), answer({ reply_to: '20261130-000000-phone-approve-bash-rm.md' }))).toBe('it answers no request that is waiting now')
    expect(refusal(box, [], answer())).toBe('it answers no request that is waiting now')
  })
  it('refuses an answer that names a different text, or names none', () => {
    expect(refusal(box, pending(), answer({ body: `approve\n\nrequest-sha256: ${requestDigest('git push --force origin main')}` }))).toBe('it does not name the text of the request that is waiting')
    expect(refusal(box, pending(), answer({ body: 'approve' }))).toBe('it does not name the text of the request that is waiting')
  })
  it('refuses an answer from a signer who was not the one asked', () => {
    const other = generateSigningKey()
    writeFileSync(path.join(box, 'registry/signers.txt'), `phone: ${keys.publicKey}\nlaptop: ${other.publicKey}\n`)
    expect(refusal(box, pending(), answer({ from: 'laptop' }, other.privateKey))).toBe('it is not from phone, who was asked')
  })
  it('refuses an answer that says neither approve nor deny', () => {
    expect(refusal(box, pending(), answer({ body: `maybe later\n\nrequest-sha256: ${requestDigest(TEXT)}` }))).toBe('it says neither approve nor deny')
  })
  it('refuses a file name that could land outside the inbox', () => {
    expect(refusal(box, pending(), { ...answer(), filename: '../../registry/signers.txt' })).toContain('not one this mailbox would write')
    expect(refusal(box, pending(), { ...answer(), worker: '../archive' })).toContain('not one this mailbox would write')
  })
  it('reads only a list of answers from what the command printed', () => {
    expect(parseAnswers('not json')).toEqual([])
    expect(parseAnswers('{"answers":"x"}')).toEqual([])
    expect(parseAnswers(JSON.stringify({ answers: [{ worker: 'api', filename: 'f.md', content: 'c' }, { worker: 1 }, null] }))).toEqual([{ worker: 'api', filename: 'f.md', content: 'c' }])
  })
})

describe('trusting a key', () => {
  it('adds the signer, makes its inbox, and gives the fingerprint to check', () => {
    const k = generateSigningKey()
    expect(trustSigner(box, 'tablet', k.publicKey)).toEqual({ fingerprint: fingerprint(k.publicKey), changed: true })
    expect(readFileSync(path.join(box, 'registry/signers.txt'), 'utf8')).toBe(`phone: ${keys.publicKey}\ntablet: ${k.publicKey}\n`)
    expect(readdirSync(path.join(box, 'inbox'))).toContain('tablet')
    expect(trustSigner(box, 'tablet', k.publicKey).changed).toBe(false)
  })
  it('will not swap a key unless told to, because that changes who can approve', () => {
    const k = generateSigningKey()
    expect(() => trustSigner(box, 'phone', k.publicKey)).toThrow('already has a different key')
    expect(trustSigner(box, 'phone', k.publicKey, true).changed).toBe(true)
    expect(readFileSync(path.join(box, 'registry/signers.txt'), 'utf8')).toBe(`phone: ${k.publicKey}\n`)
  })
  it('refuses what is not a key or not a name', () => {
    expect(() => trustSigner(box, 'phone2', 'hello')).toThrow('not a public key')
    expect(() => trustSigner(box, 'phone2', 'A'.repeat(60))).toThrow('could not be read')
    expect(() => trustSigner(box, 'Phone', keys.publicKey)).toThrow('lower-case')
  })
})

describe('the arguments', () => {
  it('needs a command to hand the requests to', () => {
    expect(() => parseApprovalArgs([])).toThrow('needs --exec')
    expect(parseApprovalArgs(['--exec', 'cat', '--watch'])).toMatchObject({ command: 'sync', exec: 'cat', watch: true, intervalS: 30 })
    expect(() => parseApprovalArgs(['--exec', 'cat', '--interval', '5'])).toThrow('10 seconds or more')
    expect(() => parseApprovalArgs(['--exec', 'cat', '--wat'])).toThrow('unknown option')
  })
  it('takes a name and a key for trust', () => {
    expect(parseApprovalArgs(['trust', 'phone', 'KEY'])).toMatchObject({ command: 'trust', positional: ['phone', 'KEY'], replace: false })
    expect(() => parseApprovalArgs(['trust', 'phone'])).toThrow('usage')
    expect(parseApprovalArgs(['trust', 'phone', 'KEY', '--mailbox', '/tmp/box'])).toMatchObject({ mailbox: '/tmp/box', positional: ['phone', 'KEY'] })
    expect(() => parseApprovalArgs(['--exec', 'cat', '--replace'])).toThrow('--replace goes with trust')
  })
})
