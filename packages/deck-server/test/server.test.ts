/**
 * The report rules, the store, the team rules and the HTTP handler. Every
 * folder is made here and the clock is supplied.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { parse } from '../src/cli.js'
import { renderTeam } from '../src/page.js'
import { sanitizeReport, type TeamReport } from '../src/report.js'
import { reportUrl, send } from '../src/send.js'
import { handle, startServer, type ServerContext } from '../src/server.js'
import { addMachine, addViewer, initStore, machineFor, readConfig, readReports, remove, viewerFor } from '../src/store.js'
import { buildTeam, duration, freshness, visible } from '../src/team.js'
import type { StoredReport } from '../src/store.js'

const NOW = Date.parse('2026-11-19T12:00:00Z')
const repo = (over: object = {}) => ({ name: 'shop', remote: 'github.com/acme/shop', sessions: 2, live: 1, needs_you: 1, abandoned: 0, waiting_since: '2026-11-19T11:20:00.000Z', last_activity_at: '2026-11-19T11:59:00.000Z', setup: { score: 80, fail: 1, warn: 0 }, unread: 3, ...over })
const report = (repos: object[] = [repo()]): TeamReport => ({ v: 1, generated_at: '2026-11-19T12:00:00.000Z', repos: repos as TeamReport['repos'] })
const stored = (machine: string, who: string, minutesAgo: number, repos: object[]): StoredReport => ({ machine, who, received_at: new Date(NOW - minutesAgo * 60_000).toISOString(), report: report(repos) })

let dir: string
let ctx: ServerContext
beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'jq-deck-server-')), 'data')
  initStore(dir)
  ctx = { dir, version: 't', secureCookie: true, now: () => NOW }
})

describe('sanitizeReport', () => {
  it('keeps the fields of a report and drops everything else', () => {
    const dirty = { ...report([{ ...repo(), tree: '/Users/dana/code/shop', blocked_question: 'Shall I drop the table?', inbox: 'shop' }]), machine: 'spoofed', mailbox: '/Users/dana/crosstalk' }
    const clean = sanitizeReport(dirty)
    expect(clean).toEqual(report())
    expect(JSON.stringify(clean)).not.toMatch(/Users|drop the table|spoofed/)
  })
  it('drops a remote that is not host/owner/name, and keeps the row', () => {
    expect(sanitizeReport(report([repo({ remote: 'https://token@github.com/acme/shop' })])).repos[0].remote).toBeNull()
    expect(sanitizeReport(report([repo({ remote: '<script>' })])).repos[0].remote).toBeNull()
  })
  it('refuses what is not a report, with a reason', () => {
    expect(() => sanitizeReport(null)).toThrow('JSON object')
    expect(() => sanitizeReport({ v: 2 })).toThrow('version')
    expect(() => sanitizeReport(report([repo({ name: '../etc/passwd' })]))).toThrow('no slash')
    expect(() => sanitizeReport(report([repo({ name: 'a\nb' })]))).toThrow('name')
    expect(() => sanitizeReport(report([repo({ sessions: -1 })]))).toThrow('sessions')
    expect(() => sanitizeReport(report([repo({ needs_you: 1.5 })]))).toThrow('needs_you')
    expect(() => sanitizeReport(report([repo({ setup: { score: 101, fail: 0, warn: 0 } })]))).toThrow('setup.score')
    expect(() => sanitizeReport(report([repo({ waiting_since: 'yesterday' })]))).toThrow('waiting_since')
    expect(() => sanitizeReport(report(Array.from({ length: 201 }, () => repo())))).toThrow('at most 200')
  })
  it('takes question text only as short plain text', () => {
    const q = (questions: unknown) => sanitizeReport(report([repo({ questions })])).repos[0].questions
    expect(q([{ asked_at: '2026-11-19T11:20:00Z', text: '  Shall I merge it?\u0000\u001b[31m  ', extra: 1 }])).toEqual([{ asked_at: '2026-11-19T11:20:00.000Z', text: 'Shall I merge it?[31m' }])
    expect(q([{ asked_at: null, text: 'x'.repeat(900) }])![0].text).toHaveLength(400)
    expect(q([{ asked_at: null, text: '   ' }])).toBeUndefined()
    expect(q(undefined)).toBeUndefined()
    expect(sanitizeReport(report([repo()])).repos[0]).not.toHaveProperty('questions')
    expect(() => q('Shall I?')).toThrow('questions')
    expect(() => q([{ text: 5 }])).toThrow('text')
    expect(() => q(Array.from({ length: 21 }, () => ({ asked_at: null, text: 'q' })))).toThrow('at most 20')
  })
  it('keeps unknown as unknown', () => {
    const r = sanitizeReport(report([repo({ unread: null, setup: null, waiting_since: null })])).repos[0]
    expect(r).toMatchObject({ unread: null, setup: null, waiting_since: null })
  })
})

describe('the store', () => {
  it('never keeps a token, and tells a machine from a viewer', () => {
    const m = addMachine(dir, 'dana-laptop', 'Dana')
    const v = addViewer(dir, 'lee', ['shop'])
    const text = readFileSync(path.join(dir, 'config.json'), 'utf8')
    expect(text).not.toContain(m)
    expect(text).not.toContain(v)
    const config = readConfig(dir)
    expect(machineFor(config, m)).toMatchObject({ name: 'dana-laptop', who: 'Dana' })
    expect(viewerFor(config, v)).toMatchObject({ name: 'lee', repos: ['shop'] })
    // A machine token is not a viewer token, and the other way round.
    expect(viewerFor(config, m)).toBeNull()
    expect(machineFor(config, v)).toBeNull()
    expect(machineFor(config, 'nope')).toBeNull()
    expect(machineFor(config, '')).toBeNull()
    expect(machineFor(config, undefined)).toBeNull()
  })
  it('refuses a bad or taken name, and a missing --who', () => {
    addMachine(dir, 'box', 'Dana')
    expect(() => addMachine(dir, 'box', 'Lee')).toThrow('in use')
    expect(() => addViewer(dir, 'box')).toThrow('in use')
    expect(() => addMachine(dir, '../x', 'Lee')).toThrow('a name is')
    expect(() => addMachine(dir, 'ok', '  ')).toThrow('--who')
    expect(() => initStore(dir)).toThrow('already')
  })
  it('stops a token working when its owner is removed, and forgets the report', () => {
    const token = addMachine(dir, 'box', 'Dana')
    expect(handle({ method: 'POST', path: '/report', authorization: `Bearer ${token}`, body: JSON.stringify(report()) }, ctx).status).toBe(204)
    expect(readReports(dir, readConfig(dir))).toHaveLength(1)
    expect(remove(dir, 'box')).toBe(true)
    expect(remove(dir, 'box')).toBe(false)
    expect(handle({ method: 'POST', path: '/report', authorization: `Bearer ${token}`, body: JSON.stringify(report()) }, ctx).status).toBe(401)
    expect(readReports(dir, readConfig(dir))).toHaveLength(0)
  })
  it('skips a damaged report file', () => {
    addMachine(dir, 'box', 'Dana')
    writeFileSync(path.join(dir, 'reports', 'box.json'), '{half')
    expect(readReports(dir, readConfig(dir))).toEqual([])
  })
})

describe('buildTeam', () => {
  it('groups one repository across machines, longest wait first', () => {
    const team = buildTeam(
      [
        stored('dana-laptop', 'Dana', 1, [repo({ waiting_since: '2026-11-19T11:20:00Z' }), repo({ name: 'docs', remote: null, needs_you: 0, waiting_since: null })]),
        stored('lee-desktop', 'Lee', 2, [repo({ name: 'shop-clone', needs_you: 2, waiting_since: '2026-11-19T09:00:00Z' })]),
      ],
      NOW,
    )
    expect(team.groups.map((g) => g.name)).toEqual(['shop', 'docs'])
    expect(team.groups[0].rows.map((r) => [r.who, r.waiting_minutes])).toEqual([['Lee', 180], ['Dana', 40]])
    expect(team.groups[0].needs_you).toBe(3)
    expect(team.totals).toMatchObject({ needs_you: 3, sessions: 6, machines_fresh: 2 })
    expect(team.headline).toBe('3 sessions are waiting on a person, on 2 machines. The longest has waited 3 hours: shop-clone, Lee.')
  })
  it('never counts a machine that has gone quiet, and hides a silent one', () => {
    const team = buildTeam([stored('a', 'Dana', 1, [repo({ needs_you: 0, waiting_since: null })]), stored('b', 'Lee', 90, [repo({ needs_you: 4 })]), stored('c', 'Sam', 60 * 30, [repo({ name: 'old', remote: null })])], NOW)
    expect(team.totals).toMatchObject({ needs_you: 0, sessions: 2, machines_fresh: 1, machines_quiet: 1, machines_silent: 1 })
    expect(team.groups.map((g) => g.name)).toEqual(['shop'])
    expect(team.groups[0].rows.find((r) => r.who === 'Lee')).toMatchObject({ freshness: 'quiet', waiting_minutes: null })
    expect(team.headline).toBe('No session is waiting on a person: 2 sessions on 1 machine read. 2 machines have gone quiet and are not counted.')
    expect(team.machines.map((m) => m.freshness)).toEqual(['fresh', 'quiet', 'silent'])
  })
  it('says so when nothing is current, and when nothing has reported', () => {
    expect(buildTeam([], NOW).headline).toBe('No machine has reported yet.')
    expect(buildTeam([stored('a', 'Dana', 30, [repo()])], NOW).headline).toBe('No machine has reported in the last 5 minutes (1 machine known), so nothing below is current.')
  })
  it('scopes before it counts, and does not list a machine with nothing to show', () => {
    const reports = [stored('a', 'Dana', 1, [repo(), repo({ name: 'secret', remote: 'github.com/acme/secret', needs_you: 5 })]), stored('b', 'Lee', 1, [repo({ name: 'secret', remote: 'github.com/acme/secret', needs_you: 2 })])]
    const scoped = buildTeam(reports, NOW, { repos: ['Shop'] })
    expect(scoped.scoped).toBe(true)
    expect(scoped.groups.map((g) => g.name)).toEqual(['shop'])
    expect(scoped.totals).toMatchObject({ needs_you: 1, sessions: 2, machines_fresh: 1 })
    expect(scoped.machines.map((m) => m.machine)).toEqual(['a'])
    expect(JSON.stringify(scoped)).not.toMatch(/secret|Lee/)
    expect(buildTeam(reports, NOW, { repos: ['github.com/acme/secret'] }).totals.needs_you).toBe(7)
    expect(buildTeam(reports, NOW, { repos: ['nothing'] }).headline).toBe('No machine has reported a repository you can see.')
    expect(visible(null, repo())).toBe(true)
    expect(visible({ repos: [] }, repo())).toBe(true)
  })
  it('shows a question only to who may see the repository, and only while it is current', () => {
    const asked = { questions: [{ asked_at: '2026-11-19T11:20:00.000Z', text: 'Shall I <b>merge</b> it?' }] }
    const reports = [stored('a', 'Dana', 1, [repo(asked)]), stored('b', 'Lee', 1, [repo({ name: 'secret', remote: null, questions: [{ asked_at: null, text: 'Rotate the key?' }] })]), stored('c', 'Sam', 30, [repo({ questions: [{ asked_at: null, text: 'An old one?' }] })])]
    const all = renderTeam(buildTeam(reports, NOW), 'owner', 't')
    expect(all).toContain('Shall I &lt;b&gt;merge&lt;/b&gt; it?')
    expect(all).toContain('Rotate the key?')
    expect(all).not.toContain('An old one?')
    expect(all).not.toContain('<b>merge')
    const scoped = buildTeam(reports, NOW, { repos: ['shop'] })
    expect(JSON.stringify(scoped)).toContain('merge')
    expect(JSON.stringify(scoped)).not.toMatch(/Rotate|An old one/)
  })
  it('measures staleness and durations plainly', () => {
    expect(freshness(new Date(NOW - 5 * 60_000).toISOString(), NOW).freshness).toBe('fresh')
    expect(freshness(new Date(NOW - 6 * 60_000).toISOString(), NOW).freshness).toBe('quiet')
    expect(freshness(new Date(NOW - 25 * 3_600_000).toISOString(), NOW).freshness).toBe('silent')
    expect([0, 1, 59, 60, 150, 60 * 72].map(duration)).toEqual(['under a minute', '1 minute', '59 minutes', '1 hour', '2 hours', '3 days'])
  })
})

describe('the HTTP handler', () => {
  let machine: string
  let viewer: string
  beforeEach(() => {
    machine = addMachine(dir, 'dana-laptop', 'Dana')
    viewer = addViewer(dir, 'lee')
  })
  const post = (body: string, token = machine) => handle({ method: 'POST', path: '/report', authorization: `Bearer ${token}`, body }, ctx)

  it('takes a report only from a machine token, and stores it under that machine', () => {
    expect(post(JSON.stringify(report()), 'wrong').status).toBe(401)
    expect(post(JSON.stringify(report()), viewer).status).toBe(401)
    expect(handle({ method: 'POST', path: '/report', body: JSON.stringify(report()) }, ctx).status).toBe(401)
    expect(post('{nope').status).toBe(400)
    expect(post(JSON.stringify({ v: 1 })).status).toBe(400)
    expect(post(JSON.stringify({ ...report(), machine: 'someone-else', who: 'Mallory' })).status).toBe(204)
    expect(readReports(dir, readConfig(dir))[0]).toMatchObject({ machine: 'dana-laptop', who: 'Dana', received_at: new Date(NOW).toISOString() })
  })

  it('shows the board only to a viewer', () => {
    post(JSON.stringify(report()))
    expect(handle({ method: 'GET', path: '/', body: '' }, ctx)).toMatchObject({ status: 303, headers: { location: '/login' } })
    expect(handle({ method: 'GET', path: '/', cookie: `jq_deck=${machine}`, body: '' }, ctx).status).toBe(303)
    expect(handle({ method: 'GET', path: '/api/team', body: '' }, ctx).status).toBe(401)
    expect(handle({ method: 'GET', path: '/api/team', authorization: `Bearer ${machine}`, body: '' }, ctx).status).toBe(401)
    const page = handle({ method: 'GET', path: '/', cookie: `other=1; jq_deck=${viewer}`, body: '' }, ctx)
    expect(page.status).toBe(200)
    expect(page.body).toContain('1 session is waiting on a person, on 1 machine. The longest has waited 40 minutes: shop, Dana.')
    const api = handle({ method: 'GET', path: '/api/team', authorization: `Bearer ${viewer}`, body: '' }, ctx)
    expect(JSON.parse(api.body).totals.needs_you).toBe(1)
  })

  it('signs in with a viewer token, and marks the cookie', () => {
    expect(handle({ method: 'GET', path: '/login', body: '' }, ctx).body).toContain('Viewer token')
    const bad = handle({ method: 'POST', path: '/login', body: 'token=nope' }, ctx)
    expect(bad.status).toBe(401)
    expect(bad.headers['set-cookie']).toBeUndefined()
    const wrongKind = handle({ method: 'POST', path: '/login', body: `token=${encodeURIComponent(machine)}` }, ctx)
    expect(wrongKind.status).toBe(401)
    expect(wrongKind.body).toContain('That is a machine token')
    expect(wrongKind.headers['set-cookie']).toBeUndefined()
    const ok = handle({ method: 'POST', path: '/login', body: `token=${encodeURIComponent(viewer)}` }, ctx)
    expect(ok.status).toBe(303)
    expect(ok.headers['set-cookie']).toMatch(/^jq_deck=jqv_.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/)
    expect(handle({ method: 'POST', path: '/login', body: `token=${viewer}` }, { ...ctx, secureCookie: false }).headers['set-cookie']).not.toContain('Secure')
    expect(handle({ method: 'POST', path: '/logout', body: '' }, ctx).headers['set-cookie']).toContain('Max-Age=0')
  })

  it('answers a health check without the data folder, and nothing else unknown', () => {
    expect(handle({ method: 'GET', path: '/healthz', body: '' }, { ...ctx, dir: '/nowhere' })).toMatchObject({ status: 200, body: 'ok' })
    expect(handle({ method: 'GET', path: '/reports/dana-laptop.json', body: '' }, ctx).status).toBe(404)
    expect(handle({ method: 'GET', path: '/config.json', body: '' }, ctx).status).toBe(404)
    expect(handle({ method: 'DELETE', path: '/report', body: '' }, ctx).status).toBe(404)
  })

  it('escapes what a machine sends, and loads nothing', () => {
    post(JSON.stringify(report([repo({ name: '<img src=x onerror=alert(1)>', remote: null })])))
    const page = handle({ method: 'GET', path: '/', cookie: `jq_deck=${viewer}`, body: '' }, ctx).body
    expect(page).not.toContain('<img')
    expect(page).toContain('&lt;img')
    // The only addresses on the page are the reader's own machine: the links to the local tools.
    expect(page.replace(/http:\/\/127\.0\.0\.1:\d+/g, '')).not.toMatch(/<script|https?:\/\//)
    expect(page).toContain('aria-label="JQ tools"')
    expect(page).toContain('this page cannot see whether it is running')
    expect(renderTeam(buildTeam([], NOW), 'lee', 't')).toContain('None yet')
  })

  it('puts what needs a person in the tab title, the totals and the strip, and says when each question was asked', () => {
    const asked = repo({ questions: [{ asked_at: '2026-11-19T11:20:00.000Z', text: 'Shall I merge it?' }] })
    const page = renderTeam(buildTeam([stored('a', 'Dana', 1, [asked]), stored('b', 'Lee', 90, [repo()])], NOW), 'owner', 't')
    expect(page).toContain('<title>(1) JQ Deck: team</title>')
    expect(page).toContain('<div class="metric hot"><dt>Waiting on a person</dt><dd><b>1</b><span>in 1 repository</span>')
    expect(page).toContain('<b>1<small> of 2</small></b><span>1 quiet: not counted</span>')
    expect(page).toContain('Needs attention · 1 waiting session')
    expect(page).toContain('shop is waiting on a person')
    expect(page).toContain('Dana on a. Answer in the session on that machine.')
    expect(page).toContain('<b>40 minutes</b><span>longest wait</span>')
    expect(page).toContain("Dana's session asked 40 minutes ago")
    expect(page).toContain('Read at <b class="mono">12:00 UTC</b>')
    expect(page).toContain('Signed in as <b>owner</b>')
    expect(page).toContain('<form method="post" action="/logout"><button>Sign out</button></form>')
    expect(page).toContain('<meta http-equiv="refresh" content="60">')
    // Read-only: signing out is the one thing the page can send.
    expect(page.match(/<form/g)).toHaveLength(1)
    expect(page).not.toMatch(/<input|<textarea|<select/)
  })

  it('shows nothing amber when all is clear, and no totals when no machine is known', () => {
    const calm = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo({ needs_you: 0, waiting_since: null })])], NOW), 'owner', 't')
    expect(calm).toContain('<title>JQ Deck: team</title>')
    expect(calm).not.toMatch(/class="metric hot"|class="strip|class="chip hot"/)
    expect(calm).toContain('<span>nothing waiting</span>')
    expect(calm).toContain('<span class="chip">none waiting</span>')
    const none = renderTeam(buildTeam([], NOW), 'owner', 't')
    expect(none).not.toMatch(/class="metrics"|class="strip/)
    expect(none).toContain('No machine has reported yet.')
    expect(none).toContain('No repository to show.')
    expect(none).toContain('no machine reporting')
    expect(none).toContain('No setup check reported.')
  })

  it('never shows an old report as current', () => {
    const stale = renderTeam(buildTeam([stored('a', 'Dana', 30, [repo()])], NOW), 'owner', 't')
    expect(stale).toContain('<p class="kick">Not current</p>')
    expect(stale).not.toMatch(/class="strip hot"|class="metric hot"|class="dot on"|class="pill on"/)
    expect(stale).toContain('<b>0<small> of 1</small></b>')
    expect(stale).toContain('<dt>Waiting on a person</dt><dd><b>—</b><span>no current report</span>')
    expect(stale).toContain('<dt>Sessions</dt><dd><b>—</b><span>no current report</span>')
    expect(stale).toContain('<li class="quiet">')
    expect(stale).toContain('<small>not current</small>')
    expect(stale).toContain('quiet, not counted')
    const silent = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo()]), stored('c', 'Sam', 60 * 30, [repo({ name: 'old', remote: null })])], NOW), 'owner', 't')
    expect(silent).toContain('silent for over a day, rows hidden')
    expect(silent).not.toContain('<h3>old</h3>')
  })

  it('keeps unknown apart from zero, and adds up only what was reported', () => {
    const page = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo({ setup: null, unread: null, needs_you: 2, waiting_since: null }), repo({ name: 'docs', remote: null, unread: 0, needs_you: 0, waiting_since: null, setup: { score: 100, fail: 0, warn: 0 } })])], NOW), 'owner', 't')
    expect(page).toContain('<small>not checked</small>')
    expect(page).toContain('<small>no inbox</small>')
    expect(page).toContain('none unread')
    expect(page).toContain('<small>how long was not reported</small>')
    expect(page).toContain('2 sessions are waiting on a person</h2><p>Answer each one in the session where it is running.</p>')
    expect(page).not.toContain('longest wait</span>')
    expect(page).toContain('<dt>Setup items to fix</dt><dd><b>0</b><span>across 1 setup check</span>')
    const unchecked = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo({ setup: null })])], NOW), 'owner', 't')
    expect(unchecked).toContain('<dt>Setup items to fix</dt><dd><b>—</b><span>no setup check reported</span>')
  })

  it('names the longest wait across repositories and machines, and counts the rest', () => {
    const page = renderTeam(buildTeam([stored('dana-laptop', 'Dana', 1, [repo(), repo({ name: 'docs', remote: null, live: 0 })]), stored('lee-desktop', 'Lee', 2, [repo({ needs_you: 2, waiting_since: '2026-11-19T09:00:00Z' })])], NOW), 'owner', 't')
    expect(page).toContain('Needs attention · 4 waiting sessions')
    expect(page).toContain('Lee on lee-desktop. Answer in the session on that machine. 2 more waiting, listed below.')
    expect(page).toContain('<b>3 hours</b><span>longest wait</span>')
    expect(page).toContain('<span>in 2 repositories</span>')
    expect(page).toContain('<dt>Sessions</dt><dd><b>6</b><span>2 live</span>')
    expect(page.indexOf('<h3>shop</h3>')).toBeLessThan(page.indexOf('<h3>docs</h3>'))
    expect(page).toContain('Dana · 2 repositories shown')
    expect(page).toContain('href="#repositories"')
    expect(page).toContain('id="machines"')
    expect(page).toContain('id="setup"')
  })

  it('works over a real socket, with its headers and its size limit', async () => {
    const server = startServer({ ...ctx, now: undefined }, 0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      await send(base, machine, JSON.stringify({ ...report(), extra: '/Users/dana' }))
      const res = await fetch(`${base}/api/team`, { headers: { authorization: `Bearer ${viewer}` } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect((await res.json()).machines).toHaveLength(1)
      const big = await fetch(`${base}/report`, { method: 'POST', headers: { authorization: `Bearer ${machine}` }, body: 'x'.repeat(300 * 1024) })
      expect(big.status).toBe(413)
      await expect(send(base, 'jqm_wrong', JSON.stringify(report()))).rejects.toThrow('401')
    } finally {
      server.close()
    }
  })
})

describe('send and the command line', () => {
  it('refuses plain http off this machine, credentials in the address, and a missing token', async () => {
    expect(reportUrl('https://deck.example.com/team/').href).toBe('https://deck.example.com/report')
    expect(reportUrl('http://127.0.0.1:4320').href).toBe('http://127.0.0.1:4320/report')
    expect(() => reportUrl('http://deck.example.com')).toThrow('https')
    expect(() => reportUrl('https://user:pw@deck.example.com')).toThrow('user name')
    expect(() => reportUrl('deck')).toThrow('not an address')
    await expect(send('https://deck.example.com', undefined, '{}')).rejects.toThrow('JQ_DECK_TOKEN')
  })
  it('sends only the fields of a report', async () => {
    let sent: any
    const fake = (async (url: URL, init: RequestInit) => {
      sent = { url: url.href, init }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    await send('https://deck.example.com', 'jqm_t', JSON.stringify({ ...report(), headline: 'x', mailbox: '/Users/dana/crosstalk' }), fake)
    expect(sent.url).toBe('https://deck.example.com/report')
    expect(JSON.parse(sent.init.body)).toEqual(report())
    expect(sent.init.headers.authorization).toBe('Bearer jqm_t')
  })
  it('parses commands', () => {
    expect(parse(['add-viewer', 'lee', '--repos', 'shop,api'])).toMatchObject({ command: 'add-viewer', positional: ['lee'], options: { '--repos': 'shop,api' } })
    expect(() => parse(['serve', '--port'])).toThrow('--port needs a value')
    expect(() => parse(['serve', '--wat'])).toThrow('unknown option')
  })
})
