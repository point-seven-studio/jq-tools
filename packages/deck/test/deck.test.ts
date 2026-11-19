/**
 * The join, the shell page and the request handler. No real session, mailbox or
 * home folder is read: every folder is made here and the clock is supplied.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Snapshot } from '@point-seven-studio/jq-agents'
import { waitingBoard, type Message } from '@point-seven-studio/jq-crosstalk'
import { buildContext, handle, hostAllowed, parseArgs, type Context } from '../src/cli.js'
import { collectOverview } from '../src/collect.js'
import { buildOverview, findMailbox, loadConfig, matchInbox, repoId, type Overview, type SetupResult } from '../src/deck.js'
import { pickRepo, renderShell } from '../src/page.js'

const NOW = Date.parse('2026-11-18T12:00:00Z')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'jq-deck-'))
})

const session = (over: object) => ({
  machine: 'test-mac', product: 'shop', working_tree: '/code/shop', branch: 'main', session_id: 's1', pid: 1, state: 'live' as const,
  last_activity_at: '2026-11-18T11:55:00Z', waiting: false, stop_reason: null, ends_with_question: false, blocked_question: null, question_redacted: false, question_allowed: false, ...over,
})
const snap = (sessions: object[]): Snapshot => ({ machine: 'test-mac', generated_at: '2026-11-18T12:00:00.000Z', sessions: sessions as Snapshot['sessions'], host: null, bottleneck: null })
const good: SetupResult = { summary: { pass: 9, warn: 0, fail: 0, info: 3, score: 100 } }
const broken: SetupResult = { summary: { pass: 6, warn: 1, fail: 2, info: 3, score: 67 } }
const mail = (to: string, n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${to}/m${i}.md`, filename: `m${i}.md`, from_session: 'other', to_session: to, subject: 'Hi', sent_at: '2026-11-16T12:00:00Z', acked: false, body: '' }) as unknown as Message)

describe('matchInbox', () => {
  it('takes the exact name, then a single prefix before a separator', () => {
    expect(matchInbox('shop', ['shop', 'api'])).toBe('shop')
    expect(matchInbox('shop-v2', ['shop', 'api'])).toBe('shop')
    expect(matchInbox('Shop_2026', ['shop'])).toBe('shop')
  })
  it('refuses a prefix with no separator, and two candidates', () => {
    expect(matchInbox('shopping', ['shop'])).toBeNull()
    expect(matchInbox('shop-api-v2', ['shop', 'shop-api'])).toBeNull()
    expect(matchInbox('web', ['shop'])).toBeNull()
  })
})

describe('buildOverview', () => {
  const two = snap([
    session({ session_id: 'a', working_tree: '/code/shop', product: 'shop', last_activity_at: '2026-11-18T11:59:00Z' }),
    session({ session_id: 'b', working_tree: '/code/api', product: 'api', state: 'idle', waiting: true, last_activity_at: '2026-11-18T11:00:00Z' }),
    session({ session_id: 'c', working_tree: '/code/api', product: 'api', state: 'stale', waiting: true, last_activity_at: '2026-11-17T09:00:00Z' }),
  ])
  const setups = new Map<string, SetupResult>([['/code/shop', broken], ['/code/api', good]])

  it('gives one row per repository, what needs a person first', () => {
    const o = buildOverview({ snapshot: two, trees: ['/code/shop', '/code/api'], setups, waiting: null, mailbox: null })
    expect(o.repos.map((r) => r.name)).toEqual(['api', 'shop'])
    expect(o.repos[0]).toMatchObject({ sessions: 2, needs_you: 1, abandoned: 1, live: 0, setup: { score: 100, fail: 0 } })
    expect(o.repos[1]).toMatchObject({ sessions: 1, needs_you: 0, live: 1, setup: { score: 67, fail: 2, warn: 1 } })
    expect(o.headline).toBe('1 session is waiting on you, no mailbox set, 1 repository has a setup check to fix.')
    expect(o.mail).toBeNull()
  })

  it('counts unread per matched inbox, and never calls a missing inbox zero', () => {
    const waiting = waitingBoard([...mail('shop', 2), ...mail('billing', 3)], NOW)
    const o = buildOverview({ snapshot: two, trees: ['/code/shop', '/code/api'], setups, waiting, inboxes: ['shop', 'billing'], mailbox: '/mb' })
    const shop = o.repos.find((r) => r.name === 'shop')!
    const api = o.repos.find((r) => r.name === 'api')!
    expect(shop).toMatchObject({ inbox: 'shop', unread: 2, oldest_unread_days: 2 })
    expect(api).toMatchObject({ inbox: null, unread: null })
    expect(o.mail).toMatchObject({ total_unread: 5, unmatched: [{ inbox: 'billing', unread: 3 }] })
    expect(o.headline).toContain('5 unread messages')
  })

  it('lets the config file tie an inbox to a folder, and reads an empty inbox as 0', () => {
    const waiting = waitingBoard(mail('billing', 3), NOW)
    const o = buildOverview({ snapshot: two, trees: ['/code/shop', '/code/api'], setups, waiting, inboxes: ['shop', 'billing'], mailbox: '/mb', names: { billing: '/code/api' } })
    expect(o.repos.find((r) => r.name === 'api')).toMatchObject({ inbox: 'billing', unread: 3 })
    expect(o.repos.find((r) => r.name === 'shop')).toMatchObject({ inbox: 'shop', unread: 0 })
    expect(o.mail!.unmatched).toEqual([])
  })

  it('shows a repository with no session, and says why a check did not run', () => {
    const o = buildOverview({ snapshot: snap([]), trees: ['/code/new', '/code/gone'], setups: new Map<string, SetupResult>([['/code/new', good], ['/code/gone', { error: 'the folder is gone' }]]), waiting: null, mailbox: '/mb', mailNote: 'not a crosstalk mailbox' })
    expect(o.repos.find((r) => r.name === 'new')).toMatchObject({ sessions: 0, setup: { score: 100 } })
    expect(o.repos.find((r) => r.name === 'gone')).toMatchObject({ setup: null, setup_note: 'the folder is gone' })
    expect(o.headline).toBe('No session is waiting on you (0 sessions read), the mailbox could not be read, no failing setup check in 1 repository.')
  })
})

describe('config and mailbox', () => {
  it('reads a config file, expands ~ and drops what is not a string', () => {
    const file = path.join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ mailbox: '~/mb', names: { shop: '~/code/shop', bad: 3 }, questions: ['~/code/shop', 7] }))
    expect(loadConfig(file)).toEqual({ mailbox: path.join(os.homedir(), 'mb'), names: { shop: path.join(os.homedir(), 'code/shop') }, questions: [path.join(os.homedir(), 'code/shop')] })
    expect(loadConfig(path.join(dir, 'missing.json'))).toEqual({})
  })
  it('names the file when it cannot be parsed', () => {
    const file = path.join(dir, 'config.json')
    writeFileSync(file, '{nope')
    expect(() => loadConfig(file)).toThrow(file)
  })
  it('finds the mailbox: flag, config, environment, then a .crosstalk file above', () => {
    const deep = path.join(dir, 'mb', 'a', 'b')
    mkdirSync(deep, { recursive: true })
    writeFileSync(path.join(dir, 'mb', '.crosstalk'), '')
    expect(findMailbox({ flag: '/f', config: '/c', env: '/e', cwd: deep })).toBe('/f')
    expect(findMailbox({ config: '/c', env: '/e', cwd: deep })).toBe('/c')
    expect(findMailbox({ env: '/e', cwd: deep })).toBe('/e')
    expect(findMailbox({ cwd: deep })).toBe(path.join(dir, 'mb'))
    expect(findMailbox({ cwd: os.tmpdir() })).toBeNull()
  })
  it('keeps question text off unless asked for', () => {
    const none = path.join(dir, 'none.json')
    expect(buildContext(parseArgs(['--config', none]), {}, dir, 't').deck.questionTrees).toEqual([])
    expect(buildContext(parseArgs(['--config', none, '--questions', '/code/shop']), {}, dir, 't').deck.questionTrees).toEqual(['/code/shop'])
    expect(() => parseArgs(['--port', '0'])).toThrow('--port')
    expect(() => parseArgs(['--wat'])).toThrow('unknown option')
  })
})

describe('the page', () => {
  const o: Overview = buildOverview({
    snapshot: snap([session({ working_tree: '/code/<b>x</b>', product: '<b>x</b>', state: 'idle', waiting: true })]),
    trees: ['/code/<b>x</b>', '/code/ok'],
    setups: new Map<string, SetupResult>([['/code/<b>x</b>', good], ['/code/ok', broken]]),
    waiting: null,
    mailbox: null,
  })
  it('escapes names and paths', () => {
    const page = renderShell(o, 'overview', null, '0.0.0')
    expect(page).not.toContain('<b>x</b>')
    expect(page).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
  it('opens Setup on the asked repository, else the first with something to fix', () => {
    expect(pickRepo(o.repos, null)!.name).toBe('ok')
    expect(pickRepo(o.repos, repoId('/code/<b>x</b>'))!.name).toBe('<b>x</b>')
    expect(pickRepo(o.repos, 'nope')!.name).toBe('ok')
    expect(renderShell(o, 'setup', null, '0')).toContain(`/raw/setup?repo=${repoId('/code/ok')}`)
  })
  it('tells you how to make a mailbox when there is none', () => {
    const page = renderShell(o, 'mail', null, '0')
    expect(page).toContain('jq-crosstalk init')
    expect(page).not.toContain('<iframe')
  })
  it('has no script and loads nothing from outside', () => {
    for (const tab of ['overview', 'sessions', 'setup', 'mail'] as const) {
      const page = renderShell(o, tab, null, '0')
      expect(page).not.toMatch(/<script|https?:\/\//)
    }
  })
})

describe('the request handler', () => {
  const tree = () => path.join(dir, 'proj')
  const ctx = (over: Partial<Context['deck']> = {}): Context => ({ port: 4316, version: 't', probe: false, sample: false, deck: { mailbox: null, projectsDir: path.join(dir, 'projects'), sockDir: path.join(dir, 'socks'), now: NOW, machine: 'test-mac', ...over } })
  beforeEach(() => {
    mkdirSync(path.join(dir, 'projects', 'a'), { recursive: true })
    mkdirSync(path.join(dir, 'socks'))
    mkdirSync(tree())
    writeFileSync(path.join(tree(), 'CLAUDE.md'), '# Project\n')
    const file = path.join(dir, 'projects', 'a', 's1.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'assistant', cwd: tree(), gitBranch: 'main', sessionId: 's1', timestamp: '2026-11-18T11:55:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Shall I merge it?' }] } }) + '\n')
    utimesSync(file, NOW / 1000, NOW / 1000)
  })

  it('answers only to this machine', async () => {
    expect(hostAllowed('127.0.0.1:4316', 4316)).toBe(true)
    expect(hostAllowed('localhost:4316', 4316)).toBe(true)
    expect(hostAllowed('evil.example', 4316)).toBe(false)
    expect(hostAllowed('127.0.0.1:9999', 4316)).toBe(false)
    expect(hostAllowed(undefined, 4316)).toBe(false)
    expect((await handle('/', 'evil.example:4316', ctx())).status).toBe(403)
  })

  it('reads a session, checks its repository and serves each tab', async () => {
    const o = await collectOverview(ctx().deck)
    expect(o.repos).toHaveLength(1)
    expect(o.repos[0]).toMatchObject({ tree: tree(), sessions: 1 })
    expect(o.repos[0].setup).not.toBeNull()
    const host = '127.0.0.1:4316'
    expect((await handle('/', host, ctx())).body).toContain('JQ Deck')
    expect((await handle('/?tab=nonsense', host, ctx())).body).toContain('<table>')
    expect((await handle('/raw/sessions', host, ctx())).body).toContain('JQ Agents')
    const setup = await handle(`/raw/setup?repo=${o.repos[0].id}`, host, ctx())
    expect(setup.status).toBe(200)
    expect(setup.body).toContain('Groundcrew')
  })

  it('never checks a folder the page does not list', async () => {
    const host = '127.0.0.1:4316'
    expect((await handle('/raw/setup?repo=../../etc', host, ctx())).status).toBe(404)
    expect((await handle(`/raw/setup?repo=${repoId('/etc')}`, host, ctx())).status).toBe(404)
    expect((await handle('/raw/setup', host, ctx())).status).toBe(404)
    expect((await handle('/raw/mail', host, ctx())).status).toBe(404)
    expect((await handle('/anything', host, ctx())).status).toBe(404)
  })

  it('keeps the other tabs when the mailbox is broken', async () => {
    const o = await collectOverview(ctx({ mailbox: path.join(dir, 'not-a-mailbox') }).deck)
    expect(o.mail).toBeNull()
    expect(o.mail_note).toContain('not a crosstalk mailbox')
    expect(o.repos).toHaveLength(1)
  })

  it('shows a real mailbox', async () => {
    const mb = path.join(dir, 'mb')
    mkdirSync(path.join(mb, 'inbox', 'proj'), { recursive: true })
    writeFileSync(path.join(mb, 'inbox', 'proj', '20261117-100000-from-web.md'), '---\nfrom: web\nto: proj\nsubject: Hello\nsent: 2026-11-17T10:00:00Z\nkind: question\n---\n\nBody.\n')
    const o = await collectOverview(ctx({ mailbox: mb }).deck)
    expect(o.repos[0]).toMatchObject({ inbox: 'proj', unread: 1 })
    expect((await handle('/raw/mail', '127.0.0.1:4316', ctx({ mailbox: mb }))).body).toContain('Hello')
  })
})
