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
import { DEFAULT_VIEW, parseView, select, viewHref, waitingRows } from '../src/view.js'
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
    // The page loads nothing and runs nothing. The only addresses on it are links: to the
    // reader's own machine, and to a reported repository's own page.
    expect(page).not.toMatch(/<script|<img|<iframe|<link rel="stylesheet"| src="/)
    expect(page.replace(/http:\/\/127\.0\.0\.1:\d+/g, '').replace(/<a href="https:\/\/[a-z0-9][a-z0-9.-]*(\/[A-Za-z0-9._~-]+)+" target="_blank" rel="noopener noreferrer">/g, '')).not.toMatch(/https?:\/\//)
    expect(page).toContain('aria-label="JQ tools"')
    expect(page).toContain('this page cannot see whether it is running')
    expect(renderTeam(buildTeam([], NOW), 'lee', 't')).toContain('None yet')
  })

  it('puts what needs a person in the tab title, the totals and the waiting list, and says when each question was asked', () => {
    const asked = repo({ questions: [{ asked_at: '2026-11-19T11:20:00.000Z', text: 'Shall I merge it?' }] })
    const page = renderTeam(buildTeam([stored('a', 'Dana', 1, [asked]), stored('b', 'Lee', 90, [repo()])], NOW), 'owner', 't')
    expect(page).toContain('<title>(1) JQ Deck: team</title>')
    expect(page).toContain('<div class="metric hot"><dt>Waiting on a person</dt><dd><b>1</b><span>in 1 repository</span>')
    expect(page).toContain('<b>1<i> of 2</i></b><span>1 quiet: not counted</span>')
    expect(page).toContain('Waiting on a person <span>(1)</span>')
    expect(page).toContain('<b>Dana · <span class="mono">a</span></b><small>Answer on this machine</small>')
    // A link to the reader's own JQ Deck, by the folder's name: no path leaves the server, because it holds none.
    expect(page).toContain('<small>At a now? <a href="http://127.0.0.1:4316/?find=shop">Open it in JQ Deck there</a></small>')
    expect(page).toContain('<a href="https://github.com/acme/shop" target="_blank" rel="noopener noreferrer">github.com/acme/shop</a>')
    const odd = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo({ name: 'a b&c"<x>', remote: null })])], NOW), 'owner', 't')
    expect(odd).toContain('href="http://127.0.0.1:4316/?find=a%20b%26c%22%3Cx%3E"')
    expect(odd).not.toContain('<x>')
    expect(page).toContain('<b>40 minutes</b><small>waiting</small>')
    expect(page).toContain("Dana's session asked 40 minutes ago")
    expect(page).toContain('Read at <b class="mono">12:00 UTC</b>')
    expect(page).toContain('Signed in as <b>owner</b>')
    expect(page).toContain('<form method="post" action="/logout"><button>Sign out</button></form>')
    expect(page).toContain('<meta http-equiv="refresh" content="60">')
    // Read-only: signing out is the one thing the page can post. The other form only chooses what to show.
    expect(page.match(/<form[^>]*method="post"/g)).toHaveLength(1)
    expect(page.match(/<form/g)).toHaveLength(2)
    expect(page).toContain('<form class="find" method="get" action="/#reports"')
    expect(page).not.toMatch(/<textarea|type="text"|type="file"/)
  })

  it('lists every waiting report, longest wait first, on its own machine', () => {
    // The state on the live board: one repository in two folders on one machine, and a second machine.
    const reports = [
      stored('sandon-air', 'Sandon', 0, [repo({ name: 'hivejournal-2026', remote: 'github.com/p7/hivejournal-2026', sessions: 1, live: 1, waiting_since: '2026-11-19T11:58:00Z', setup: { score: 60, fail: 1, warn: 0 }, unread: null })]),
      stored('mac-mini2', 'Sandon', 0, [
        repo({ name: 'rose-gap-advisor', remote: 'github.com/acme/rose', sessions: 8, live: 1, waiting_since: '2026-11-19T11:54:00Z', setup: { score: 55, fail: 0, warn: 5 }, unread: null }),
        repo({ name: 'rose', remote: 'github.com/acme/rose', sessions: 1, live: 0, needs_you: 0, waiting_since: null, setup: { score: 58, fail: 1, warn: 0 }, unread: null }),
      ]),
    ]
    const team = buildTeam(reports, NOW)
    expect(waitingRows(team).map((r) => [r.name, r.machine, r.waiting_minutes])).toEqual([['rose-gap-advisor', 'mac-mini2', 6], ['hivejournal-2026', 'sandon-air', 2]])
    const page = renderTeam(team, 'owner', 't')
    expect(page.match(/Answer on this machine/g)).toHaveLength(2)
    expect(page.indexOf('<b>6 minutes</b><small>waiting</small>')).toBeLessThan(page.indexOf('<b>2 minutes</b><small>waiting</small>'))
    expect(page.indexOf('<b>6 minutes</b><small>waiting</small>')).toBeGreaterThan(0)
    // Two folders of one repository on one machine stay two rows, each named by its folder.
    expect(page).toContain('<small>folder <span class="mono">rose-gap-advisor</span></small>')
    expect(page).toContain('<small>folder <span class="mono">rose</span></small>')
    expect(page).toContain('2 reports · 1 waiting')
    expect(page.match(/<tr class="r"/g)).toHaveLength(3)
    // One machine is listed once, with its two reports and its one repository.
    expect(page).toContain('Sandon · 2 reports · 1 repository')
    expect(page).toContain('<b>2<i> of 2</i></b>')
    // "To fix" and "to look at" are never added together.
    expect(page).toContain('<dt>Setup items to fix</dt><dd><b>2</b><span>plus 5 to look at, in 3 setup checks</span>')
    expect(page).toContain('<span class="look">5 to look at</span>')
    expect(page).toContain('<dt>Sessions</dt><dd><b>10<i> · 2 live</i></b><span>in 3 reports</span>')
    // Grouped by machine: the same three rows, under two machines.
    const byMachine = renderTeam(team, 'owner', 't', parseView('group=machine'))
    expect(byMachine.match(/<tr class="r"/g)).toHaveLength(3)
    expect(byMachine.match(/<tr class="group">/g)).toHaveLength(2)
    expect(byMachine).toContain('<b class="mono">mac-mini2</b><span class="mono">Sandon · reporting</span>')
    expect(byMachine).toContain('<b>rose</b><small class="mono"><a href="https://github.com/acme/rose" target="_blank" rel="noopener noreferrer">github.com/acme/rose</a></small>')
    // A filter chooses rows. It changes no total and does not shorten the waiting list.
    const fix = renderTeam(team, 'owner', 't', parseView('filter=fix&group=machine'))
    expect(fix.match(/<tr class="r"/g)).toHaveLength(2)
    expect(fix).toContain('Reports <span>(2 of 3)</span>')
    expect(fix).toContain('<dt>Waiting on a person</dt><dd><b>2</b>')
    expect(fix.match(/Answer on this machine/g)).toHaveLength(2)
    expect(fix).toContain('<input type="hidden" name="group" value="machine"><input type="hidden" name="filter" value="fix">')
    expect(fix).toContain('<a href="?group=machine#reports">All reports<i>3</i></a>')
    expect(fix).toContain('<a href="?group=machine&amp;filter=fix#reports" aria-current="true">Setup to fix<i>2</i></a>')
  })

  it('shows nothing amber when all is clear, and no totals when no machine is known', () => {
    const calm = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo({ needs_you: 0, waiting_since: null })])], NOW), 'owner', 't')
    expect(calm).toContain('<title>JQ Deck: team</title>')
    expect(calm).not.toMatch(/class="metric hot"|class="queue"|class="count hot"|class="hot"/)
    expect(calm).toContain('<span>nothing waiting</span>')
    expect(calm).toContain('No session is reported waiting on a person.')
    expect(calm).toContain('1 report · none waiting')
    const none = renderTeam(buildTeam([], NOW), 'owner', 't')
    expect(none).not.toMatch(/class="metrics"|class="queue"|class="strip"|class="calm"|class="find"/)
    expect(none).toContain('No machine has reported yet.')
    expect(none).toContain('No repository to show.')
    expect(none).toContain('no machine reporting')
    expect(none).toContain('No setup check reported.')
  })

  it('never shows an old report as current', () => {
    const team = buildTeam([stored('a', 'Dana', 30, [repo()])], NOW)
    const stale = renderTeam(team, 'owner', 't')
    expect(stale).toContain('<p class="kick">Not current</p>')
    expect(stale).not.toMatch(/class="queue"|class="metric hot"|class="dot on"|class="pill on"/)
    expect(stale).toContain('<b>0<i> of 1</i></b>')
    expect(stale).toContain('<dt>Waiting on a person</dt><dd><b>—</b><span>no current report</span>')
    expect(stale).toContain('<dt>Sessions</dt><dd><b>—</b><span>no current report</span>')
    expect(stale).toContain('<tr class="r quiet">')
    expect(stale).toContain('<small>not current</small>')
    expect(stale).toContain('quiet, not counted')
    // A quiet machine's row is not a waiting row or a live row, whatever it last said.
    expect(select(team, parseView('filter=waiting')).rows).toHaveLength(0)
    expect(select(team, parseView('filter=live')).rows).toHaveLength(0)
    expect(waitingRows(team)).toHaveLength(0)
    const silent = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo()]), stored('c', 'Sam', 60 * 30, [repo({ name: 'old', remote: null })])], NOW), 'owner', 't')
    expect(silent).toContain('silent for over a day, rows hidden')
    expect(silent).not.toContain('<b>old</b>')
  })

  it('keeps unknown apart from zero, and adds up only what was reported', () => {
    const page = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo({ setup: null, unread: null, needs_you: 2, waiting_since: null }), repo({ name: 'docs', remote: null, unread: 0, needs_you: 0, waiting_since: null, abandoned: 3, setup: { score: 100, fail: 0, warn: 0 } })])], NOW), 'owner', 't')
    expect(page).toContain('<small>not checked</small>')
    expect(page).toContain('<small>no inbox</small>')
    expect(page).toContain('none unread')
    expect(page).toContain('<b class="amber">2 waiting</b><small>how long was not reported</small>')
    expect(page).toContain('<small>2 waiting sessions</small>')
    expect(page).toContain('<b aria-hidden="true">—</b><small>how long was not reported</small>')
    expect(page).toContain('<small>1 live · 3 abandoned</small>')
    expect(page).toContain('<dt>Setup items to fix</dt><dd><b>0</b><span>in 1 setup check</span>')
    expect(page).toContain('<small>all good</small>')
    expect(page).toContain('1 check has nothing to fix or look at.')
    const unchecked = renderTeam(buildTeam([stored('a', 'Dana', 1, [repo({ setup: null })])], NOW), 'owner', 't')
    expect(unchecked).toContain('<dt>Setup items to fix</dt><dd><b>—</b><span>no setup check reported</span>')
  })

  it('reads the view from the address, and nothing else', () => {
    expect(parseView(undefined)).toEqual(DEFAULT_VIEW)
    expect(parseView('group=machine&filter=live&sort=setup&q=%20Shop%20')).toEqual({ group: 'machine', filter: 'live', sort: 'setup', q: 'shop' })
    expect(parseView('group=<script>&filter=drop&sort=1&extra=x')).toEqual(DEFAULT_VIEW)
    expect(parseView(`q=${'x'.repeat(500)}`).q).toHaveLength(100)
    expect(viewHref(DEFAULT_VIEW)).toBe('/#reports')
    expect(viewHref(DEFAULT_VIEW, { group: 'machine', q: 'a b&c' })).toBe('?group=machine&q=a+b%26c#reports')
    post(JSON.stringify(report([repo(), repo({ name: 'docs', remote: null, needs_you: 0, waiting_since: null })])))
    const get = (query: string) => handle({ method: 'GET', path: '/', query, cookie: `jq_deck=${viewer}`, body: '' }, ctx).body
    expect(get('').match(/<tr class="r"/g)).toHaveLength(2)
    expect(get('q=docs').match(/<tr class="r"/g)).toHaveLength(1)
    expect(get('q=nothing-like-it')).toContain('No report matches.')
    // What is typed into the search comes back only as escaped text.
    const hostile = get(`q=${encodeURIComponent('"><img src=x onerror=1>')}`)
    expect(hostile).not.toContain('<img')
    expect(hostile).toContain('value="&quot;&gt;&lt;img src=x onerror=1&gt;"')
    // The view never reaches the JSON, and never widens what a viewer may see.
    const api = handle({ method: 'GET', path: '/api/team', query: 'filter=fix', authorization: `Bearer ${viewer}`, body: '' }, ctx)
    expect(JSON.parse(api.body).groups).toHaveLength(2)
    const narrow = addViewer(dir, 'contractor', ['docs'])
    const scoped = handle({ method: 'GET', path: '/', query: 'q=shop&group=machine', cookie: `jq_deck=${narrow}`, body: '' }, ctx).body
    expect(scoped).not.toContain('github.com/acme/shop')
    expect(scoped).toContain('No report matches.')
  })

  it('searches, filters and sorts the same rows, and stays readable with many', () => {
    const many = Array.from({ length: 12 }, (_, m) => stored(`box-${String(m).padStart(2, '0')}`, `Person ${m}`, 1, Array.from({ length: 5 }, (_, i) => repo({ name: `svc-${m}-${i}`, remote: `github.com/acme/svc-${i}`, live: i % 2, needs_you: m === 3 && i === 2 ? 1 : 0, waiting_since: m === 3 && i === 2 ? '2026-11-19T11:00:00Z' : null, setup: i === 4 ? null : { score: 50 + i * 10 + m, fail: i === 0 ? 1 : 0, warn: 0 } }))))
    const team = buildTeam(many, NOW)
    const all = select(team, DEFAULT_VIEW)
    expect(all.total).toBe(60)
    expect(all.counts).toEqual({ all: 60, waiting: 1, live: 24, fix: 12 })
    expect(all.sections).toHaveLength(5)
    expect(all.rows[0]).toMatchObject({ name: 'svc-3-2', machine: 'box-03' })
    expect(select(team, parseView('group=machine')).sections).toHaveLength(12)
    expect(select(team, parseView('group=machine&q=box-07')).rows.map((r) => r.machine)).toEqual(Array(5).fill('box-07'))
    expect(select(team, parseView('q=box-07')).counts).toEqual({ all: 5, waiting: 0, live: 2, fix: 1 })
    expect(select(team, parseView('sort=machine')).rows[0].machine).toBe('box-00')
    const bySetup = select(team, parseView('sort=setup')).rows
    expect(bySetup[0].setup?.score).toBe(50)
    // A folder with no setup check is last when sorting by score, never first.
    expect(bySetup[bySetup.length - 1].setup).toBeNull()
    // Every row appears once under either grouping.
    for (const group of ['repo', 'machine'] as const) expect(select(team, { ...DEFAULT_VIEW, group }).sections.reduce((n, s) => n + s.rows.length, 0)).toBe(60)
    const page = renderTeam(team, 'owner', 't', parseView('group=machine'))
    expect(page.match(/<tr class="r"/g)).toHaveLength(60)
    expect(page.match(/<thead>/g)).toHaveLength(1)
    expect(page.match(/Answer on this machine/g)).toHaveLength(1)
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
    // A full address that ends in /report is used as written, for a board mounted under a path.
    expect(reportUrl('https://api.example.com/api/jq-deck/report').href).toBe('https://api.example.com/api/jq-deck/report')
    expect(reportUrl('https://api.example.com/api/jq-deck/report?x=1#y').href).toBe('https://api.example.com/api/jq-deck/report')
    expect(reportUrl('https://deck.example.com/report').href).toBe('https://deck.example.com/report')
    expect(reportUrl('https://deck.example.com/reports').href).toBe('https://deck.example.com/report')
    expect(() => reportUrl('http://api.example.com/api/jq-deck/report')).toThrow('https')
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
