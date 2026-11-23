/**
 * "What used my week". A wrong number here is believed: a person decides which project to
 * slow down on, or thinks they were charged. So: each reply is priced once, a model with no
 * price is never counted as free, a dollar is always called an estimate, and percent of the
 * week comes only from a reading the person gave.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseArgs, saveWeek } from '../src/cli.js'
import { readWeekConfig, writeWeekConfig } from '../src/config.js'
import { estimateUsd, priceFor } from '../src/prices.js'
import { addRecord, emptyFileState, type FileState } from '../src/signals.js'
import { headline, renderWeek, sharePct, weekPct, weekText } from '../src/week-page.js'
import { lastReset, parseResets, parseWeekConfig, resetsText, summarizeWeek, type WeekConfig } from '../src/week.js'

// A Wednesday afternoon, in whatever zone the test runs in.
const NOW = new Date(2026, 10, 25, 15, 0, 0).getTime()
const SUNDAY_6 = new Date(2026, 10, 22, 6, 0, 0).getTime()
const HOUR = 3_600_000
const M = 1_000_000

const reply = (id: string, at: number, over: Record<string, unknown> = {}, usage: Record<string, unknown> = { input_tokens: 0, output_tokens: M }, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  timestamp: new Date(at).toISOString(),
  cwd: '/code/shop',
  sessionId: 's-1',
  message: { id, model, content: [], usage },
  ...over,
})

function state(records: unknown[], seen = new Set<string>()): FileState {
  const s = emptyFileState()
  for (const r of records) addRecord(s, r, seen)
  return s
}
const name = (cwd: string) => path.basename(cwd)
const config = (over: Partial<WeekConfig> = {}): WeekConfig => ({ resets: { weekday: 0, hour: 6, minute: 0 }, reading: null, ...over })

describe('prices', () => {
  it('finds a model by the start of its id, the longest match first', () => {
    expect(priceFor('claude-opus-5-5')?.output).toBe(20)
    expect(priceFor('claude-opus-5-5-20261001')?.output).toBe(20)
    expect(priceFor('claude-opus-5')?.output).toBe(25)
    expect(priceFor('claude-haiku-4-5-20251001')?.input).toBe(1)
  })
  it('has no price for a model it does not know, and never treats that as free', () => {
    expect(priceFor('claude-opus-9')).toBeNull()
    expect(priceFor('claude-opus-55')).toBeNull()
    expect(estimateUsd('some-other-model', { output_tokens: M })).toBeNull()
  })
  it('prices each kind of token at its own rate', () => {
    expect(estimateUsd('claude-opus-5-5', { input_tokens: M })).toBeCloseTo(4)
    expect(estimateUsd('claude-opus-5-5', { output_tokens: M })).toBeCloseTo(20)
    expect(estimateUsd('claude-opus-5-5', { cache_read_input_tokens: M })).toBeCloseTo(0.2)
  })
  it('prices a one-hour cache write above a five-minute one, when the record says which', () => {
    expect(estimateUsd('claude-haiku-4-5', { cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: M, ephemeral_5m_input_tokens: 0 } })).toBeCloseTo(2)
    expect(estimateUsd('claude-haiku-4-5', { cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: M } })).toBeCloseTo(1.25)
    // No kinds recorded: the lower rate, so the estimate does not claim more than it knows.
    expect(estimateUsd('claude-haiku-4-5', { cache_creation_input_tokens: M })).toBeCloseTo(1.25)
  })
  it('does not drop or double a cache write whose kinds do not add up', () => {
    expect(estimateUsd('claude-haiku-4-5', { cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: M / 2 } })).toBeCloseTo(1 + 0.625)
  })
  it('charges fast mode double, a US-only request a tenth more, and a long Haiku 5.5 prompt five times', () => {
    expect(estimateUsd('claude-opus-5-5', { output_tokens: M, speed: 'fast' })).toBeCloseTo(40)
    expect(estimateUsd('claude-opus-5-5', { output_tokens: M, inference_geo: 'us' })).toBeCloseTo(22)
    expect(estimateUsd('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: M })).toBeCloseTo(0.005 + 0.5)
    expect(estimateUsd('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: M })).toBeCloseTo(0.1 + 2.5)
  })
})

describe('when the week resets', () => {
  it('reads the day and time as a usage page writes them', () => {
    expect(parseResets('sun 06:00')).toEqual({ weekday: 0, hour: 6, minute: 0 })
    expect(parseResets('Sunday 6:00 AM')).toEqual({ weekday: 0, hour: 6, minute: 0 })
    expect(parseResets('wed 2:30 pm')).toEqual({ weekday: 3, hour: 14, minute: 30 })
    expect(parseResets('fri 12 am')).toEqual({ weekday: 5, hour: 0, minute: 0 })
    expect(resetsText({ weekday: 3, hour: 14, minute: 30 })).toBe('wed 14:30')
  })
  it('refuses what is not a weekday and a time', () => {
    for (const bad of ['', 'sunday', '06:00', 'sun 25:00', 'sun 6:75', 'xyz 06:00', 'sun 13 pm', 12]) expect(parseResets(bad)).toBeNull()
  })
  it('finds the last reset before now, in local time', () => {
    const r = { weekday: 0, hour: 6, minute: 0 }
    expect(lastReset(NOW, r)).toBe(SUNDAY_6)
    expect(lastReset(SUNDAY_6, r)).toBe(SUNDAY_6)
    // An hour before the reset belongs to the week before.
    expect(lastReset(SUNDAY_6 - HOUR, r)).toBe(new Date(2026, 10, 15, 6, 0, 0).getTime())
  })
})

describe('where the week went', () => {
  const records = [
    reply('a', SUNDAY_6 + HOUR),
    reply('b', SUNDAY_6 + 2 * HOUR, { cwd: '/code/api' }, { output_tokens: M / 4 }),
    reply('c', SUNDAY_6 + 3 * HOUR, { isSidechain: true }, { output_tokens: M / 4 }, 'claude-haiku-4-5'),
    reply('old', SUNDAY_6 - 3 * HOUR), // the week before
  ]

  it('adds up only what came after the reset, by repository and by model', () => {
    const v = summarizeWeek([state(records)], NOW, config(), name)
    expect(v.window).toBe('week')
    expect(v.requests).toBe(3)
    expect(v.usd).toBeCloseTo(20 + 5 + 1.25)
    expect(v.folders.map((f) => [f.name, Math.round(f.usd * 100) / 100])).toEqual([['shop', 21.25], ['api', 5]])
    expect(v.models.map((m) => m.name)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5'])
    expect(v.folders[0].share + v.folders[1].share).toBeCloseTo(1)
    expect(v.subagentUsd).toBeCloseTo(1.25)
  })
  it('uses the last seven days when no reset is known, and says so', () => {
    const v = summarizeWeek([state(records)], NOW, config({ resets: null }), name)
    expect(v.window).toBe('7 days')
    expect(v.requests).toBe(4)
    expect(v.percent).toBeNull()
    expect(v.percentMissing).toContain('when your week resets')
  })
  it('counts a reply once, however many records and files it is written to', () => {
    const seen = new Set<string>()
    const first = state([reply('a', SUNDAY_6 + HOUR), reply('a', SUNDAY_6 + HOUR)], seen)
    const copy = state([reply('a', SUNDAY_6 + HOUR)], seen) // a resumed session copies its history
    expect(summarizeWeek([first, copy], NOW, config(), name).requests).toBe(1)
  })
  it('keeps a model with no price out of every dollar figure, and names it', () => {
    const v = summarizeWeek([state([reply('a', SUNDAY_6 + HOUR), reply('x', SUNDAY_6 + HOUR, {}, { output_tokens: M }, 'claude-new-9')])], NOW, config(), name)
    expect(v.usd).toBeCloseTo(20)
    expect(v.requests).toBe(2)
    expect(v.unpriced).toEqual([{ model: 'claude-new-9', requests: 1 }])
  })
  it('puts a subagent file on its parent session', () => {
    const main = state([reply('a', SUNDAY_6 + HOUR)])
    const sub = state([reply('s', SUNDAY_6 + 2 * HOUR, { isSidechain: true })])
    const v = summarizeWeek([main, sub], NOW, config(), name)
    expect(v.sessions).toHaveLength(1)
    expect(v.sessions[0]).toMatchObject({ name: 'shop', requests: 2, started: new Date(SUNDAY_6 + HOUR).toISOString() })
  })
})

describe('percent of the week', () => {
  // By the reading, 10% was used and this machine had spent $20. So one percent is $2.
  const reading = { percent: 10, at: SUNDAY_6 + 2 * HOUR }
  const records = [reply('a', SUNDAY_6 + HOUR), reply('b', SUNDAY_6 + 5 * HOUR)]

  it('turns the estimate into percent with one reading from the usage page', () => {
    const v = summarizeWeek([state(records)], NOW, config({ reading }), name)
    expect(v.percent).toMatchObject({ readingPercent: 10, fromEarlierWeek: false })
    expect(v.percent!.usdPerPercent).toBeCloseTo(2)
    expect(v.percent!.ofWeek).toBeCloseTo(20)
  })
  it('says a reading is from an earlier week, and still uses it', () => {
    const later = NOW + 7 * 24 * HOUR
    const v = summarizeWeek([state([...records, reply('c', later - HOUR)])], later, config({ reading }), name)
    expect(v.percent!.fromEarlierWeek).toBe(true)
    expect(v.percent!.ofWeek).toBeCloseTo(10)
  })
  it('gives no percent when nothing was counted in the week of the reading', () => {
    const v = summarizeWeek([state([reply('b', SUNDAY_6 + 5 * HOUR)])], NOW, config({ reading }), name)
    expect(v.percent).toBeNull()
    expect(v.percentMissing).toContain('Take a new reading')
  })
  it('gives no percent without a reading, or from a reading dated ahead', () => {
    expect(summarizeWeek([state(records)], NOW, config(), name).percentMissing).toContain('one reading')
    expect(summarizeWeek([state(records)], NOW, config({ reading: { percent: 10, at: NOW + HOUR } }), name).percentMissing).toContain('future')
  })
})

describe('the settings', () => {
  it('keeps every other key in the file', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'jq-week-')), 'config.json')
    writeFileSync(file, JSON.stringify({ questions: ['/code/shop'], other: 1 }))
    writeWeekConfig({ resets: { weekday: 0, hour: 6, minute: 0 }, reading: { percent: 12, at: Date.parse('2026-11-23T21:41:00Z') } }, file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ questions: ['/code/shop'], other: 1, week: { resets: 'sun 06:00', reading: { percent: 12, at: '2026-11-23T21:41:00.000Z' } } })
    expect(readWeekConfig(file)).toEqual({ resets: { weekday: 0, hour: 6, minute: 0 }, reading: { percent: 12, at: Date.parse('2026-11-23T21:41:00Z') } })
  })
  it('reads nothing from a file that is missing or holds nonsense', () => {
    expect(readWeekConfig('/no/such/file.json')).toEqual({ resets: null, reading: null })
    expect(parseWeekConfig({ resets: 'whenever', reading: { percent: 400, at: 'x' } })).toEqual({ resets: null, reading: null })
  })
  it('takes the flags, and refuses a reading with no reset time', () => {
    const a = parseArgs(['--week', '--week-resets', 'sun 06:00', '--week-reading', '12'])
    expect(a).toMatchObject({ week: true, weekResets: 'sun 06:00', weekReading: 12 })
    expect(saveWeek({ resets: null, reading: null }, a, NOW)).toEqual({ resets: { weekday: 0, hour: 6, minute: 0 }, reading: { percent: 12, at: NOW } })
    expect(() => saveWeek({ resets: null, reading: null }, { weekResets: null, weekReading: 12 }, NOW)).toThrow('when your week resets')
    expect(() => parseArgs(['--week-reading', '12'])).toThrow('go with --week')
    expect(() => parseArgs(['--week', '--week-resets', 'soon'])).toThrow('a weekday and a time')
    expect(() => parseArgs(['--week', '--week-reading', '0'])).toThrow('from 0.1 to 100')
    expect(() => parseArgs(['--week', '--signals', '--json'])).toThrow('use it alone')
  })
})

describe('the page', () => {
  const records = [reply('a', SUNDAY_6 + HOUR), reply('b', SUNDAY_6 + 5 * HOUR, { cwd: '/code/<b>api<b>' })]

  it('leads with dollars only when it has nothing firmer, and always calls them an estimate', () => {
    const plain = summarizeWeek([state(records)], NOW, config(), name)
    expect(headline(plain).big).toBe('$40.00 at list price')
    expect(headline(plain).under).toContain('It is not a bill')
    const withReading = summarizeWeek([state(records)], NOW, config({ reading: { percent: 10, at: SUNDAY_6 + 2 * HOUR } }), name)
    expect(headline(withReading).big).toBe('About 20% of your week')
    expect(headline(withReading).under).toContain('an estimate and not a bill')
  })
  it('says nothing was counted, not zero dollars', () => {
    const none = summarizeWeek([], NOW, config(), name)
    expect(headline(none).big).toBe('Nothing counted')
    expect(renderWeek(none)).toContain('Nothing counted.')
  })
  it('escapes a folder name, and says what the figures are not', () => {
    const html = renderWeek(summarizeWeek([state(records)], NOW, config(), name))
    expect(html).not.toContain('<b>api<b>')
    expect(html).toContain('&lt;b&gt;api&lt;b&gt;')
    expect(html).toContain('This machine only.')
    expect(html).toContain('It is not what you are billed.')
    expect(html).not.toContain('<script')
  })
  it('never shows a small share as nothing', () => {
    expect(sharePct(0.93)).toBe('93%')
    expect(sharePct(0.004)).toBe('0.4%')
    expect(sharePct(0.0004)).toBe('under 0.1%')
    expect(sharePct(0)).toBe('0%')
    expect(weekPct(11.4)).toBe('11%')
    expect(weekPct(0.52)).toBe('0.5%')
    expect(weekPct(0.04)).toBe('under 0.1%')
  })
  it('prints the same for a terminal, with the command to set it up when there is no reading', () => {
    const text = weekText(summarizeWeek([state(records)], NOW, config({ resets: null }), name))
    expect(text).toContain('By repository:')
    expect(text).toContain('jq-agents --week --week-resets "sun 06:00" --week-reading 12')
    expect(text).toContain('An estimate at list price, not a bill.')
  })
})
