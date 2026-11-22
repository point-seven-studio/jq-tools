/**
 * The signals page: what is counted from a transcript, what is counted once, and what the page
 * says when a number is not there.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/cli.js'
import { NOT_MEASURED, addRecord, dayOf, emptyFileState, spread, summarize, type FileState } from '../src/signals.js'
import { count, duration, renderSignals } from '../src/signals-page.js'
import { createSignalsReader } from '../src/signals-read.js'

const NOW = new Date(2026, 10, 22, 15, 0, 0).getTime()
const at = (minutes: number) => new Date(NOW - 60 * 60_000 + minutes * 60_000).toISOString()
const CWD = '/code/shop'

const reply = (id: string, minute: number, over: Record<string, unknown> = {}, content: unknown[] = [{ type: 'text', text: 'ok' }], stop: string | null = null) => ({
  type: 'assistant',
  timestamp: at(minute),
  cwd: CWD,
  version: '2.1.330',
  message: { id, model: 'model-a', stop_reason: stop, content, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens_details: { thinking_tokens: 20 } } },
  ...over,
})
const prompt = (minute: number, text = 'please fix it') => ({ type: 'user', timestamp: at(minute), cwd: CWD, origin: { kind: 'human' }, message: { content: [{ type: 'text', text }] } })
const result = (id: string, minute: number, over: Record<string, unknown> = {}, isError = false) => ({ type: 'user', timestamp: at(minute), cwd: CWD, toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] }, ...over })
const use = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name })

function run(records: unknown[], seen = new Set<string>()): FileState {
  const state = emptyFileState()
  for (const r of records) addRecord(state, r, seen)
  return state
}
const sum = (records: unknown[], days = 1) => summarize([run(records)], NOW, days)

describe('counting a transcript', () => {
  it('counts a reply written as several records once', () => {
    const s = sum([reply('m1', 1, {}, [{ type: 'thinking' }]), reply('m1', 1, {}, [{ type: 'text', text: 'a' }]), reply('m1', 1, {}, [use('t1')])])
    expect(s.requests).toBe(1)
    expect(s.tokens).toEqual({ input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, thinking: 20 })
    expect(s.toolCalls).toBe(1)
  })

  it('counts a reply copied into a second file once', () => {
    const seen = new Set<string>()
    const a = run([reply('m1', 1)], seen)
    const b = run([reply('m1', 1), reply('m2', 2)], seen)
    expect(summarize([a, b], NOW, 1).requests).toBe(2)
  })

  it('reads the share of input that came from the cache', () => {
    expect(sum([reply('m1', 1)]).cacheShare).toBeCloseTo(1000 / 1060)
    expect(sum([]).cacheShare).toBeNull()
  })

  it('times a turn from the message to the end of the turn', () => {
    const s = sum([prompt(0), reply('m1', 1, {}, [use('t1')], 'tool_use'), result('t1', 2), reply('m2', 5, {}, undefined, 'end_turn')])
    expect(s.prompts).toBe(1)
    expect(s.turn).toEqual({ n: 1, medianMs: 5 * 60_000, p95Ms: 5 * 60_000 })
  })

  it('does not time a turn a person interrupted, and counts the interruption', () => {
    const s = sum([prompt(0), reply('m1', 1), { type: 'user', timestamp: at(2), cwd: CWD, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, reply('m2', 9, {}, undefined, 'end_turn')])
    expect(s.interruptions).toBe(1)
    expect(s.prompts).toBe(1)
    expect(s.turn).toBeNull()
  })

  it('does not take a notice, a tool result or injected context for a message from a person', () => {
    const s = sum([
      { type: 'user', timestamp: at(0), cwd: CWD, origin: { kind: 'task-notification' }, message: { content: '<task-notification>x' } },
      { type: 'user', timestamp: at(1), cwd: CWD, isMeta: true, message: { content: 'plain looking' } },
      { type: 'user', timestamp: at(2), cwd: CWD, message: { content: '<local-command-stdout>x' } },
      result('t9', 3),
      { type: 'user', timestamp: at(4), cwd: CWD, message: { content: 'typed in a terminal, no origin mark' } },
    ])
    expect(s.prompts).toBe(1)
  })

  it('times a tool call between its two records and counts a failure against the tool', () => {
    const s = sum([reply('m1', 1, {}, [use('t1'), use('t2', 'Read')]), result('t1', 3, {}, true), result('t2', 2)])
    expect(s.tools).toEqual([
      { name: 'Bash', calls: 1, failed: 1, time: { n: 1, medianMs: 120_000, p95Ms: 120_000 } },
      { name: 'Read', calls: 1, failed: 0, time: { n: 1, medianMs: 60_000, p95Ms: 60_000 } },
    ])
    expect(s.toolFailures).toBe(1)
  })

  it('counts a refused action as a refusal, not as the tool failing', () => {
    const s = sum([reply('m1', 1, {}, [use('t1')]), result('t1', 2, { toolDenialKind: 'user-rejected' }, true)])
    expect(s.denials).toEqual([{ kind: 'user-rejected', count: 1 }])
    expect(s.toolFailures).toBe(0)
    expect(s.tools[0].time).toBeNull()
  })

  it('adds only what a running cost total grew by, and all of a total that started over', () => {
    const cost = (total: number) => ({ type: 'cost-state', totalCostUSD: total })
    const s = sum([reply('m1', 1), cost(2), cost(5), cost(5), cost(1.5)])
    expect(s.costUsd).toBeCloseTo(6.5)
  })

  it('counts errors, retries, timeouts, compactions, refusals and a different model answering', () => {
    const s = sum([
      { type: 'assistant', timestamp: at(1), cwd: CWD, isApiErrorMessage: true, error: 'rate_limit', message: { id: 'e1', content: [] } },
      { type: 'system', subtype: 'api_error', timestamp: at(2), cwd: CWD },
      { type: 'system', subtype: 'compact_boundary', timestamp: at(3), cwd: CWD },
      { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: true, timestamp: at(3), cwd: CWD },
      result('none', 4, { toolUseResult: { timedOutAfterMs: 120000, dangerouslyDisableSandbox: true } }),
      reply('m1', 5, { requestedModel: 'model-b' }, undefined, 'refusal'),
    ])
    expect(s.apiErrors).toEqual([{ kind: 'rate_limit', count: 1 }])
    expect(s.requests).toBe(1) // the error is not a request that answered
    expect([s.retries, s.compactions, s.hookBlocks, s.timeouts, s.sandboxOff, s.refusals, s.fallbacks]).toEqual([1, 1, 1, 1, 1, 1, 1])
  })

  it('ignores a record it cannot place in time and one that is not an object', () => {
    const s = sum([null, 'x', { type: 'assistant', message: { id: 'm0', usage: { output_tokens: 5 } } }])
    expect(s.requests).toBe(0)
  })
})

describe('the window', () => {
  it('lists every day, the empty ones too, and leaves out what is older', () => {
    const old = { ...reply('old', 0), timestamp: new Date(NOW - 9 * 86_400_000).toISOString() }
    const s = sum([old, reply('m1', 1)], 7)
    expect(s.byDay).toHaveLength(7)
    expect(s.byDay[6].day).toBe(dayOf(NOW))
    expect(s.byDay.map((d) => d.requests)).toEqual([0, 0, 0, 0, 0, 0, 1])
    expect(s.requests).toBe(1)
    expect(sum([old, reply('m1', 1)], 30).requests).toBe(2)
  })

  it('names a folder through the caller and adds folders that share a name', () => {
    const state = run([reply('m1', 1), { ...reply('m2', 2), cwd: '/code/shop/api' }])
    const s = summarize([state], NOW, 1, () => 'shop')
    expect(s.folders).toEqual([{ name: 'shop', requests: 2, tokens: 2320, costUsd: 0 }])
  })

  it('finds the median and the 95th of a list', () => {
    expect(spread([])).toBeNull()
    expect(spread(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ n: 100, medianMs: 50, p95Ms: 95 })
  })
})

describe('reading files', () => {
  const line = (o: unknown) => JSON.stringify(o) + '\n'

  it('reads a file once, then only what was added, and waits for a line to be whole', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jq-signals-'))
    mkdirSync(path.join(dir, 'p', 'deep', 'subagents'), { recursive: true })
    const file = path.join(dir, 'p', 'a.jsonl')
    writeFileSync(file, line({ type: 'api-request-blob', message: 'x'.repeat(5000) }) + line(reply('m1', 1)))
    writeFileSync(path.join(dir, 'p', 'deep', 'subagents', 'b.jsonl'), line(reply('m2', 2, { isSidechain: true })))
    const reader = createSignalsReader(dir)

    const first = await reader.read(1, NOW)
    expect(first.files).toBe(2)
    expect(first.signals.requests).toBe(2)
    expect(first.signals.subagentRequests).toBe(1)

    const again = await reader.read(1, NOW)
    expect(again.bytesRead).toBe(0)
    expect(again.signals.requests).toBe(2)

    const whole = line(reply('m3', 3))
    appendFileSync(file, whole.slice(0, 40))
    expect((await reader.read(1, NOW)).signals.requests).toBe(2)
    appendFileSync(file, whole.slice(40))
    expect((await reader.read(1, NOW)).signals.requests).toBe(3)
  })

  it('answers with nothing for a folder that is not there', async () => {
    const out = await createSignalsReader(path.join(os.tmpdir(), 'jq-signals-missing')).read(7, NOW)
    expect(out.files).toBe(0)
    expect(out.signals.requests).toBe(0)
  })
})

describe('the page', () => {
  const page = (records: unknown[], days = 7) => renderSignals({ signals: summarize([run(records)], NOW, days), files: 1, bytesRead: 0, tookMs: 0 }, NOW)

  it('runs no script and asks for nothing from outside', () => {
    const html = page([prompt(0), reply('m1', 1, {}, [use('t1')]), result('t1', 2)])
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<img|<link|@import|url\(/i)
  })

  it('names, under every area, what a transcript does not hold', () => {
    const html = page([reply('m1', 1)])
    for (const key of ['traces', 'tokens', 'latency', 'drift', 'errors', 'cost', 'feedback', 'safety']) {
      expect(html).toContain(`id="${key}"`)
      expect(NOT_MEASURED[key].length).toBeGreaterThan(0)
    }
    expect(html.match(/Not in a transcript:/g)).toHaveLength(8)
    expect(html).toContain('time to first token')
    expect(html).toContain('PII detections')
  })

  it('escapes a tool, a model and a folder name', () => {
    const html = page([{ ...reply('m1', 1, {}, [use('t1', '<b>tool')]), cwd: '/code/<i>x' }].map((r) => ({ ...r, message: { ...r.message, model: '"><script>alert(1)</script>' } })))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>tool')
    expect(html).not.toContain('<i>x')
    expect(html).toContain('&lt;b&gt;tool')
  })

  it('says so when nothing was recorded, and never shows a missing time as zero', () => {
    const html = page([])
    expect(html).toContain('No session activity recorded in the last 7 days.')
    expect(html).toContain('none recorded')
    expect(html).not.toContain('0ms')
  })

  it('says the cost is an estimate and not a bill', () => {
    expect(page([reply('m1', 1)])).toContain('On a subscription it is not what you pay.')
  })

  it('formats a count and a length of time', () => {
    expect([count(0), count(9999), count(12_345), count(1_234_567), count(2_500_000_000)]).toEqual(['0', '9,999', '12.3k', '1.23M', '2.50B'])
    expect([duration(450), duration(4200), duration(42_000), duration(125_000), duration(3_720_000)]).toEqual(['450ms', '4.2s', '42s', '2m 5s', '1h 2m'])
  })
})

describe('the command', () => {
  it('takes --signals with --json and a number of days', () => {
    const a = parseArgs(['--signals', '--json', '--days', '30'])
    expect([a.signals, a.signalsDays]).toEqual([true, 30])
    expect(parseArgs([]).signalsDays).toBe(7)
  })
  it('refuses --signals alone and a number of days out of range', () => {
    expect(() => parseArgs(['--signals'])).toThrow(/--json/)
    expect(() => parseArgs(['--signals', '--json', '--days', '0'])).toThrow(/1 to 90/)
  })
})
