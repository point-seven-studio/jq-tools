/**
 * The mailbox tool, run for real in a throwaway mailbox. It is a shell script, so
 * the only honest test is to run it and read the files it leaves.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseMessage } from '../src/parse.js'
import { buildReport } from '../src/view.js'
import { renderPage } from '../src/page.js'

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/crosstalk')

let box: string

/** Run the tool; returns stdout, or throws with stderr in the message. */
function ct(args: string[], opts: { self?: string; body?: string; dir?: string | null } = {}): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  if (opts.dir !== null) env.CROSSTALK_DIR = opts.dir ?? box
  if (opts.self) env.CROSSTALK_SELF = opts.self
  return execFileSync('bash', [TOOL, ...args], { env, input: opts.body ?? 'body', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function fails(args: string[], opts: Parameters<typeof ct>[1] = {}): string {
  try {
    ct(args, opts)
  } catch (e: any) {
    return String(e.stderr)
  }
  throw new Error(`expected "crosstalk ${args.join(' ')}" to fail`)
}

const header = (file: string, name: string) => parseMessage(path.basename(file), readFileSync(file, 'utf8'), name, false)

beforeEach(() => {
  box = path.join(mkdtempSync(path.join(os.tmpdir(), 'crosstalk-')), 'mb')
  ct(['init', box, 'api', 'web', 'mobile'], { dir: null })
})

describe('init', () => {
  it('creates an inbox and an archive per name, the board, and a tags file', () => {
    expect(readdirSync(path.join(box, 'inbox')).sort()).toEqual(['api', 'board', 'mobile', 'web'])
    expect(readdirSync(path.join(box, 'archive')).sort()).toEqual(['api', 'board', 'mobile', 'web'])
    expect(readFileSync(path.join(box, 'registry/expertise.txt'), 'utf8')).toContain('api: ')
  })
  it('refuses a mailbox that exists, one name, and the reserved name', () => {
    expect(fails(['init', box, 'a', 'b'], { dir: null })).toContain('already a mailbox')
    expect(fails(['init', `${box}-2`, 'solo'], { dir: null })).toContain('at least two names')
    expect(fails(['init', `${box}-3`, 'api', 'board'], { dir: null })).toContain('reserved')
  })
})

describe('send, reply, ack', () => {
  it('stamps kind, thread and reply_to, and derives needs_response', () => {
    const q = ct(['send', 'api', 'Does checkout accept guests?', '--kind', 'question'], { self: 'web' })
    expect(readFileSync(q, 'utf8')).toContain('needs_response: yes')
    const first = header(q, 'api')
    expect(first).toMatchObject({ from_session: 'web', kind: 'question', thread_id: path.basename(q, '.md'), reply_to: null })

    const a = ct(['reply', q, '--kind', 'notice'], { self: 'api', body: 'Yes.' })
    expect(path.dirname(a)).toBe(path.join(box, 'inbox/web'))
    expect(header(a, 'web')).toMatchObject({ subject: 'Re: Does checkout accept guests?', thread_id: first.thread_id, reply_to: path.basename(q), kind: 'notice', body: 'Yes.' })
    expect(readFileSync(a, 'utf8')).toContain('needs_response: no')
  })
  it('never guesses the sender', () => {
    expect(fails(['send', 'api', 'Hello'])).toContain('who is sending?')
    expect(fails(['send', 'api', 'Hello'], { self: 'stranger' })).toContain('unknown sender')
    expect(fails(['send', 'api', 'Hello'], { self: 'api' })).toContain('cannot equal recipient')
    expect(fails(['send', 'nobody', 'Hello'], { self: 'web' })).toContain('unknown recipient')
    expect(fails(['send', 'api', 'Hello', '--kind', 'chat'], { self: 'web' })).toContain('unknown kind')
  })
  it('acks by moving the file to the archive', () => {
    const f = ct(['send', 'api', 'Please look'], { self: 'web' })
    expect(ct(['inbox', 'api'])).toBe(path.basename(f))
    ct(['ack', f])
    expect(ct(['inbox', 'api'])).toBe('')
    expect(existsSync(path.join(box, 'archive/api', path.basename(f)))).toBe(true)
  })
  it('finds the mailbox from a folder inside it', () => {
    const out = execFileSync('bash', [TOOL, 'inbox', 'api'], { cwd: path.join(box, 'inbox/web'), env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' })
    expect(out.trim()).toBe('')
  })
})

describe('the board', () => {
  const tag = (name: string, tags: string) => {
    const file = path.join(box, 'registry/expertise.txt')
    writeFileSync(file, readFileSync(file, 'utf8').replace(`${name}: `, `${name}: ${tags}`))
  }

  it('runs a post from question to close', () => {
    tag('mobile', 'payments')
    tag('web', 'seo')
    const p = ct(['post', 'How do refunds work?', '--tags', 'Payments,orders'], { self: 'api' })
    expect(header(p, 'board')).toMatchObject({ kind: 'post', tags: ['payments', 'orders'], to_session: 'board' })
    expect(header(p, 'board').expires_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    expect(ct(['board'], { self: 'mobile' })).toContain('How do refunds work?')
    expect(ct(['board'], { self: 'web' })).toContain('1 other open')
    expect(ct(['board', '--all'])).toContain('0 replies')

    expect(fails(['reply', p], { self: 'mobile' })).toContain('--evidence')
    const r = ct(['reply', p, '--evidence', 'verified'], { self: 'mobile', body: 'Through the dashboard.' })
    expect(header(r, 'board')).toMatchObject({ evidence: 'verified', to_session: 'board', thread_id: header(p, 'board').thread_id })

    expect(fails(['ack', p])).toContain('closed by their asker')
    expect(fails(['close', p, '--settled-by', 'fix'], { self: 'mobile' })).toContain('only the asker, api')
    expect(fails(['close', p, '--settled-by', 'vibes'], { self: 'api' })).toContain('--settled-by')
    expect(ct(['close', p, '--settled-by', 'fix'], { self: 'api', body: 'Refund, then cancel the order.' })).toContain('settled by fix')

    expect(readdirSync(path.join(box, 'inbox/board'))).toEqual([])
    expect(readdirSync(path.join(box, 'archive/board'))).toHaveLength(3)
    expect(ct(['board', '--all'])).toBe('no open board posts')

    const report = buildReport(box)
    expect(report.board.closed.map((c) => [c.title, c.settled_by, c.replies.length])).toEqual([['How do refunds work?', 'fix', 1]])
  })
  it('keeps both of two replies sent in the same second', () => {
    const post = ct(['post', 'Who owns refunds?', '--tags', 'payments'], { self: 'web' })
    // Fired without waiting, so several land in one second on any machine.
    const replies = [
      ct(['reply', post, '--evidence', 'verified'], { self: 'api', body: 'from api' }),
      ct(['reply', post, '--evidence', 'assumed'], { self: 'mobile', body: 'from mobile' }),
      ct(['reply', post, '--evidence', 'assumed'], { self: 'api', body: 'api again' }),
    ]
    expect(new Set(replies).size).toBe(3)
    const bodies = replies.map((f) => readFileSync(f, 'utf8'))
    expect(bodies[0]).toContain('from api')
    expect(bodies[1]).toContain('from mobile')
    expect(bodies[2]).toContain('api again')
    const board = buildReport(box).board.open[0]
    expect(board.replies).toHaveLength(3)
    // Same again for plain mail: a name is not reused, even after an ack.
    const first = ct(['send', 'api', 'Same subject'], { self: 'web', body: 'one' })
    ct(['ack', first], { self: 'api' })
    const second = ct(['send', 'api', 'Same subject'], { self: 'web', body: 'two' })
    expect(path.basename(second)).not.toBe(path.basename(first))
  })

  it('needs tags and takes only posts and replies', () => {
    expect(fails(['post', 'No tags'], { self: 'api' })).toContain('--tags')
    expect(fails(['send', 'board', 'Direct'], { self: 'api' })).toContain('posts and replies')
    expect(fails(['post', 'x'.repeat(121), '--tags', 'a'], { self: 'api' })).toContain('keep it to 120')
  })
})

describe('the after-hook', () => {
  it('runs after a send and reports a failure on the next command', async () => {
    mkdirSync(path.join(box, 'hooks'))
    const hook = path.join(box, 'hooks/after')
    writeFileSync(hook, '#!/bin/bash\necho "copy failed: disk full"\nexit 3\n')
    chmodSync(hook, 0o755)
    ct(['send', 'api', 'First'], { self: 'web' })
    for (let i = 0; i < 50 && !existsSync(path.join(box, '.crosstalk-hook.status')); i++) await new Promise((r) => setTimeout(r, 100))
    expect(readFileSync(path.join(box, '.crosstalk-hook.status'), 'utf8').trim()).toBe('3')
    const stderr = execFileSync('bash', ['-c', `"${TOOL}" send api Second --from web 2>&1 >/dev/null </dev/null`], { env: { PATH: process.env.PATH ?? '', CROSSTALK_DIR: box }, encoding: 'utf8' })
    expect(stderr).toContain('FAILED (exit 3)')
    expect(stderr).toContain('copy failed: disk full')
  })
})

describe('the page', () => {
  it('shows waiting mail and escapes message text', () => {
    ct(['send', 'api', '<script>alert(1)</script>'], { self: 'web', body: '<img src=x onerror=alert(2)>' })
    const report = buildReport(box)
    expect(report.waiting.headline).toContain('1 unread message in 1 inbox')
    const html = renderPage(report)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toMatch(/<script|https?:\/\//)
  })
})
