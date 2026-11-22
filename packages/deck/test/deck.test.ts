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
import { buildContext, handle, hostAllowed, parseArgs, reportList, type Context } from '../src/cli.js'
import { collectOverview } from '../src/collect.js'
import { buildOverview, findMailbox, loadConfig, matchInbox, normalizeRemote, originIn, repoId, reportable, teamReport, type Overview, type SetupResult } from '../src/deck.js'
import { remoteOf } from '../src/collect.js'
import { pickRepo, renderShell } from '../src/page.js'
import { COPY_SCRIPT_TAG } from '../src/presence.js'

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

describe('the team report', () => {
  it('reads an origin remote in any shape, and drops a user name or token', () => {
    expect(normalizeRemote('git@github.com:acme/shop.git')).toBe('github.com/acme/shop')
    expect(normalizeRemote('https://github.com/acme/shop')).toBe('github.com/acme/shop')
    expect(normalizeRemote('https://dana:ghp_secret@GitHub.com/acme/shop.git')).toBe('github.com/acme/shop')
    expect(normalizeRemote('ssh://git@host.example:2222/team/sub/shop.git')).toBe('host.example/team/sub/shop')
    expect(normalizeRemote('/srv/git/shop.git')).toBeNull()
    expect(originIn('[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/shop.git\n[remote "origin"]\n\turl = git@github.com:acme/shop.git\n[branch "main"]\n\tremote = origin\n')).toBe('github.com/acme/shop')
    expect(originIn('[core]\n\tbare = false\n')).toBeNull()
  })
  it('finds the remote of a folder and of a worktree, running no command', () => {
    const repo = path.join(dir, 'shop')
    mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/shop.git\n')
    writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    const wt = path.join(dir, 'wt')
    mkdirSync(wt)
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`)
    expect(remoteOf(repo)).toBe('github.com/acme/shop')
    expect(remoteOf(wt)).toBe('github.com/acme/shop')
    expect(remoteOf(dir)).toBeNull()
  })
  it('carries counts and scores, and no path, question or message', () => {
    const o = buildOverview({
      snapshot: snap([session({ working_tree: '/Users/dana/code/shop', state: 'idle', waiting: true, blocked_question: 'Shall I drop the table?', question_allowed: true, last_activity_at: '2026-11-18T11:00:00Z' })]),
      trees: ['/Users/dana/code/shop'],
      setups: new Map<string, SetupResult>([['/Users/dana/code/shop', broken]]),
      waiting: waitingBoard(mail('shop', 2), NOW),
      inboxes: ['shop'],
      mailbox: '/Users/dana/crosstalk',
      remotes: new Map([['/Users/dana/code/shop', 'github.com/acme/shop']]),
    })
    const report = teamReport(o)
    expect(o.repos[0].questions).toEqual([{ asked_at: '2026-11-18T11:00:00Z', text: 'Shall I drop the table?' }])
    expect(report.repos).toEqual([{ name: 'shop', remote: 'github.com/acme/shop', sessions: 1, live: 0, needs_you: 1, abandoned: 0, waiting_since: '2026-11-18T11:00:00Z', last_activity_at: '2026-11-18T11:00:00Z', setup: { score: 67, fail: 2, warn: 1 }, unread: 2 }])
    const text = JSON.stringify(report)
    for (const secret of ['/Users/', 'dana', 'drop the table', 'crosstalk', 'Hi']) expect(text).not.toContain(secret)
  })
})

describe('question text in a report', () => {
  const asked = (over: object = {}) => session({ working_tree: '/code/shop', state: 'idle', waiting: true, blocked_question: 'Shall I merge it?', question_allowed: true, last_activity_at: '2026-11-18T11:00:00Z', ...over })
  const o = buildOverview({
    snapshot: snap([asked(), asked({ session_id: 'b', blocked_question: 'Which region?', last_activity_at: '2026-11-18T10:00:00Z' }), asked({ session_id: 'c', working_tree: '/code/client-x', product: 'client-x', blocked_question: 'Rotate the key?' }), asked({ session_id: 'd', question_allowed: false, blocked_question: null }), asked({ session_id: 'e', state: 'stale', blocked_question: 'Old one?' })]),
    trees: ['/code/shop', '/code/client-x'],
    setups: new Map(),
    waiting: null,
    mailbox: null,
  })
  it('is sent only for a folder that opted in, longest-waiting first', () => {
    expect(JSON.stringify(teamReport(o))).not.toMatch(/merge it|Which region|Rotate/)
    const sent = teamReport(o, null, ['/code/shop'])
    expect(sent.repos.find((r) => r.name === 'shop')!.questions).toEqual([{ asked_at: '2026-11-18T10:00:00Z', text: 'Which region?' }, { asked_at: '2026-11-18T11:00:00Z', text: 'Shall I merge it?' }])
    expect(sent.repos.find((r) => r.name === 'client-x')).not.toHaveProperty('questions')
    expect(JSON.stringify(sent)).not.toMatch(/Rotate|Old one/)
    expect(teamReport(o, null, ['/code']).repos.every((r) => r.questions)).toBe(true)
    expect(teamReport(o, null, ['/code/sho']).repos.some((r) => r.questions)).toBe(false)
  })
  it('is never sent for a repository that is not reported', () => {
    expect(JSON.stringify(teamReport(o, ['client-x'], ['/code/shop']))).not.toMatch(/merge it|Which region|shop/)
  })
  it('needs its own flag: showing questions on your screen does not send them', () => {
    const none = path.join(dir, 'none.json')
    const base = ['--config', none, '--watch', '--exec', 'cat', '--all-repos']
    expect(buildContext(parseArgs([...base, '--questions', '/code/shop']), {}, dir, 't').sendQuestions).toEqual([])
    expect(buildContext(parseArgs([...base, '--send-questions', '/code/shop']), {}, dir, 't').sendQuestions).toEqual(['/code/shop'])
    expect(() => parseArgs(['--send-questions', '/code/shop'])).toThrow('--watch')
  })
})

describe('which repositories a machine reports', () => {
  const o = buildOverview({
    snapshot: snap([session({ working_tree: '/code/shop', product: 'shop' }), session({ session_id: 'z', working_tree: '/code/client-x', product: 'client-x' })]),
    trees: ['/code/shop', '/code/client-x'],
    setups: new Map(),
    waiting: null,
    mailbox: null,
    remotes: new Map([['/code/shop', 'github.com/acme/shop']]),
  })
  it('reports only what is listed, by name, remote or folder', () => {
    expect(teamReport(o, ['Shop']).repos.map((r) => r.name)).toEqual(['shop'])
    expect(teamReport(o, ['github.com/acme/shop']).repos.map((r) => r.name)).toEqual(['shop'])
    expect(teamReport(o, ['/code/client-x']).repos.map((r) => r.name)).toEqual(['client-x'])
    expect(teamReport(o, ['nothing']).repos).toEqual([])
    expect(JSON.stringify(teamReport(o, ['shop']))).not.toContain('client-x')
    expect(teamReport(o, null).repos).toHaveLength(2)
    expect(reportable({ name: 'shop', remote: null, tree: '/code/shop' }, ['', ' '])).toBe(false)
  })
  it('refuses to report with no list', () => {
    const none = path.join(dir, 'none.json')
    expect(() => buildContext(parseArgs(['--config', none, '--watch', '--exec', 'cat']), {}, dir, 't')).toThrow('which repositories')
    expect(buildContext(parseArgs(['--config', none, '--watch', '--exec', 'cat', '--repos', 'shop,api']), {}, dir, 't').report).toEqual(['shop', 'api'])
    expect(buildContext(parseArgs(['--config', none, '--watch', '--exec', 'cat', '--all-repos']), {}, dir, 't').report).toBeNull()
    expect(reportList({ repos: null, allRepos: false }, ['docs'])).toEqual(['docs'])
    expect(() => parseArgs(['--repos', 'shop'])).toThrow('--watch')
    expect(() => parseArgs(['--watch', '--exec', 'cat', '--repos', 'a', '--all-repos'])).toThrow('not both')
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
    expect(() => parseArgs(['--watch'])).toThrow('--exec')
    expect(() => parseArgs(['--exec', 'cat'])).toThrow('--watch')
    expect(parseArgs(['--watch', '--exec', 'cat', '--interval', '30'])).toMatchObject({ watch: true, exec: 'cat', intervalS: 30 })
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
  it('marks the repository a team board asked for by name, and says so when it is not on this machine', () => {
    const hit = renderShell(o, 'overview', null, '0', '', 'ok')
    expect(hit.match(/<tr class="found">/g)).toHaveLength(1)
    expect(hit).toContain('The team board sent you here for <b>ok</b>, marked below. No session in it is waiting on you now.')
    expect(renderShell(o, 'overview', null, '0', '', '<b>x</b>')).toContain('sent you here for <b>&lt;b&gt;x&lt;/b&gt;</b>, marked below. A session in it is waiting on you.')
    const miss = renderShell(o, 'overview', null, '0', '', '<i>nope</i>')
    expect(miss).not.toContain('class="found"')
    expect(miss).not.toContain('<i>nope</i>')
    expect(miss).toContain('no repository of that name has a session on this machine. The waiting session is on another machine.')
    expect(renderShell(o, 'overview', null, '0')).not.toMatch(/class="found"|sent you here/)
  })
  it('links each repository to its folder in the editor, with the path escaped', () => {
    const page = renderShell(o, 'overview', null, '0')
    expect(page).toContain('<a class="open" href="vscode://file/code/ok">Open folder in VS Code</a>')
    expect(page).toContain('href="vscode://file/code/%3Cb%3Ex%3C/b%3E"')
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
  it('runs one script, for the Copy button, and loads nothing from outside', () => {
    for (const tab of ['overview', 'sessions', 'setup', 'mail'] as const) {
      const page = renderShell(o, tab, null, '0')
      expect(page.match(/<script/g)).toHaveLength(1)
      expect(page).toContain(COPY_SCRIPT_TAG)
      expect(page.replace(COPY_SCRIPT_TAG, '')).not.toMatch(/<script|https?:\/\//)
    }
  })
})

describe('the request handler', () => {
  const tree = () => path.join(dir, 'proj')
  const ctx = (over: Partial<Context['deck']> = {}): Context => ({ runningDir: path.join(dir, 'running'), configFile: '/nonexistent/config.json', port: 4316, version: 't', probe: false, sample: false, report: null, sendQuestions: [], deck: { mailbox: null, projectsDir: path.join(dir, 'projects'), sockDir: path.join(dir, 'socks'), now: NOW, machine: 'test-mac', ...over } })
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
