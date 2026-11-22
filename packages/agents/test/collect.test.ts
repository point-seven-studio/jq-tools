/**
 * The collector and the page, over a made-up transcripts folder. No real session
 * is read: the folder, the socket folder and the clock are all supplied.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/cli.js'
import { collectRows, snapshot, tailRecords } from '../src/collect.js'
import { groupByTree, renderPage, totals } from '../src/page.js'
import { COPY_SCRIPT_TAG } from '../src/presence.js'

const NOW = Date.parse('2026-11-18T12:00:00Z')
let dir: string
let projects: string
let socks: string

function transcript(rel: string, records: object[], mtime = NOW): string {
  const file = path.join(projects, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}

const turn = (over: object) => ({ type: 'assistant', cwd: '/Users/x/code/proj', gitBranch: 'main', sessionId: 's1', timestamp: '2026-11-18T11:55:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Shall I merge it?' }] }, ...over })

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'jq-agents-'))
  projects = path.join(dir, 'projects')
  socks = path.join(dir, 'socks')
  mkdirSync(projects)
  mkdirSync(socks)
})

const opts = (over: object = {}) => ({ projectsDir: projects, sockDir: socks, now: NOW, machine: 'test-mac', ...over })

describe('collectRows', () => {
  it('finds transcripts at any depth and skips old ones', async () => {
    transcript('a/s1.jsonl', [turn({})])
    transcript('b/c/d/s2.jsonl', [turn({ sessionId: 's2', cwd: '/Users/x/code/other' })])
    transcript('old/s3.jsonl', [turn({ sessionId: 's3' })], NOW - 5 * 86_400_000)
    const rows = await collectRows(opts())
    expect(rows.map((r) => r.session_id).sort()).toEqual(['s1', 's2'])
    expect(rows.find((r) => r.session_id === 's2')).toMatchObject({ machine: 'test-mac', product: 'other', branch: 'main' })
  })

  it('reports no live session without a matching socket, and no question text by default', async () => {
    transcript('a/s1.jsonl', [turn({})])
    const [row] = await collectRows(opts())
    expect(row).toMatchObject({ pid: null, waiting: false, blocked_question: null, question_allowed: false })
    expect(row.state).not.toBe('live')
  })

  it('keeps the freshest transcript when a session id repeats', async () => {
    transcript('a/s1.jsonl', [turn({ timestamp: '2026-11-18T10:00:00Z', gitBranch: 'old' })])
    transcript('b/s1-resumed.jsonl', [turn({ timestamp: '2026-11-18T11:59:00Z', gitBranch: 'new' })])
    const rows = await collectRows(opts())
    expect(rows).toHaveLength(1)
    expect(rows[0].branch).toBe('new')
  })

  it('survives a file that is not JSON and an empty folder', async () => {
    writeFileSync(path.join(projects, 'junk.jsonl'), 'not json\n{also not\n')
    expect(await collectRows(opts())).toEqual([])
    expect(await collectRows(opts({ projectsDir: path.join(dir, 'missing') }))).toEqual([])
  })
})

describe('tailRecords', () => {
  it('reads the last records of a large file without the rest', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ type: 'user', n: i, pad: 'x'.repeat(200) }))
    const recs = await tailRecords(transcript('big/s.jsonl', many), 10)
    expect(recs.map((r: any) => r.n)).toEqual([4990, 4991, 4992, 4993, 4994, 4995, 4996, 4997, 4998, 4999])
  })
})

describe('snapshot and page', () => {
  it('builds a snapshot without sampling and renders it', async () => {
    transcript('a/s1.jsonl', [turn({})])
    const snap = await snapshot(opts({ sample: false }))
    expect(snap).toMatchObject({ machine: 'test-mac', host: null, bottleneck: null, generated_at: '2026-11-18T12:00:00.000Z' })
    const html = renderPage(snap, NOW)
    expect(html).toContain('Host not sampled.')
    expect(html).toContain('/Users/x/code/proj')
    // One script, the Copy button's, and no outside address.
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain(COPY_SCRIPT_TAG)
    expect(html.replace(COPY_SCRIPT_TAG, '')).not.toMatch(/<script|https?:\/\//)
  })

  it('counts attention from state, shows a question only when allowed, and escapes it', () => {
    const base = { machine: 'm', product: 'proj', working_tree: '/t/proj', branch: 'main', pid: 1, last_activity_at: '2026-11-18T11:59:00Z', stop_reason: 'end_turn', ends_with_question: true, question_redacted: false }
    const rows: any[] = [
      { ...base, session_id: 'a', state: 'live', waiting: true, blocked_question: '<b>Merge?</b>', question_allowed: true },
      { ...base, session_id: 'b', state: 'stale', waiting: true, blocked_question: null, question_allowed: false, working_tree: '/t/quiet', product: 'quiet' },
      { ...base, session_id: 'c', state: 'dead', waiting: true, blocked_question: null, question_allowed: false, working_tree: '/t/quiet', product: 'quiet' },
    ]
    expect(totals(rows)).toEqual({ sessions: 3, live: 1, needs_you: 1, abandoned: 1, trees: 2 })
    expect(groupByTree(rows).map((g) => g.product)).toEqual(['proj', 'quiet'])
    const html = renderPage({ machine: 'm', generated_at: 'now', sessions: rows, host: null, bottleneck: { kind: 'none', reason: null } }, NOW)
    expect(html).toContain('&lt;b&gt;Merge?&lt;/b&gt;')
    expect(html).not.toContain('<b>Merge?</b>')
    expect(html).toContain('Question text is off for this folder')
    expect(html).not.toContain('Bottleneck')
    const slow = renderPage({ machine: 'm', generated_at: 'now', sessions: rows, host: null, bottleneck: { kind: 'unknown', reason: null } }, NOW)
    expect(slow).toContain('Could not tell')
  })
})

describe('parseArgs', () => {
  it('defaults to a local page with no question text and no probe', () => {
    expect(parseArgs([])).toMatchObject({ json: false, watch: false, probe: false, sample: true, questionTrees: [], port: 4319, intervalS: 60, maxAgeDays: 3 })
  })
  it('reads flags and the environment', () => {
    expect(parseArgs(['--json', '--questions', '/a, /b', '--probe'], { JQ_AGENTS_MAX_AGE_DAYS: '7' })).toMatchObject({ json: true, questionTrees: ['/a', '/b'], probe: true, maxAgeDays: 7 })
    expect(parseArgs(['--watch', '--exec', 'cat >/dev/null', '--interval', '30'])).toMatchObject({ watch: true, exec: 'cat >/dev/null', intervalS: 30 })
  })
  it('refuses a watch with nowhere to send, and bad values', () => {
    expect(() => parseArgs(['--watch'])).toThrow('--watch needs --exec')
    expect(() => parseArgs(['--exec', 'x'])).toThrow('--exec goes with --watch')
    expect(() => parseArgs(['--port', '0'])).toThrow('--port')
    expect(() => parseArgs(['--interval', '1', '--watch', '--exec', 'x'])).toThrow('--interval')
    expect(() => parseArgs(['--html'])).toThrow('--html needs a value')
    expect(() => parseArgs(['--nope'])).toThrow('unknown option')
  })
})
