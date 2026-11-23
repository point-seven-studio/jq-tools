/**
 * "What used my week": where a person's Claude usage went, by repository, model and session.
 *
 * A Claude subscription has a weekly limit, and Claude's own usage page shows how much of it
 * is used. It does not show where it went. The transcripts on this machine do: each reply
 * carries its token counts, and signals.ts prices them into five-minute slots (prices.ts).
 *
 * Two units, and which one to trust:
 *
 *  - **A share** (this repository was 80% of it) needs no bill and no setup. It is the firm
 *    number here.
 *  - **A percent of the week** needs one reading from the person's own usage page ("12% used"
 *    at a known time). The estimate up to that moment, divided by the reading, gives dollars
 *    per percent, and every other figure is turned into percent with it. It can be checked
 *    against the usage page at any time, which a dollar figure on a subscription cannot.
 *  - **Dollars** are list price and are labelled as an estimate everywhere.
 *
 * Only this machine. Usage on another computer, or in the Claude apps, is not in these files.
 * A reading covers every device, so the percent here is right only while the other devices
 * keep the part of the person's use that they had at the reading.
 *
 * Pure: the caller supplies the states and the clock.
 */
import { PRICES_READ } from './prices.js'
import type { FileState } from './signals.js'

export const SLOT_MS = 5 * 60_000
const DAY = 86_400_000

export interface Resets {
  /** 0 is Sunday. */
  weekday: number
  hour: number
  minute: number
}

export interface Reading {
  /** What the usage page showed, 0.1 to 100. */
  percent: number
  /** When it showed it. */
  at: number
}

export interface WeekConfig {
  resets: Resets | null
  reading: Reading | null
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** "sun 06:00", "Sunday 6:00 AM", "wed 14:30". Null when it is not a weekday and a time. */
export function parseResets(text: unknown): Resets | null {
  if (typeof text !== 'string') return null
  const m = text.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) return null
  const weekday = DAYS.indexOf(m[1])
  let hour = Number(m[2])
  const minute = Number(m[3] ?? 0)
  if (m[4]) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (m[4] === 'pm' ? 12 : 0)
  }
  if (weekday < 0 || hour > 23 || minute > 59) return null
  return { weekday, hour, minute }
}

export const resetsText = (r: Resets): string => `${DAYS[r.weekday]} ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`

/** The `week` key of the config file: `{ "resets": "sun 06:00", "reading": { "percent": 12, "at": "2026-11-23T21:41:00Z" } }`. */
export function parseWeekConfig(raw: unknown): WeekConfig {
  const o = raw && typeof raw === 'object' ? (raw as any) : {}
  const percent = Number(o.reading?.percent)
  const at = typeof o.reading?.at === 'string' ? Date.parse(o.reading.at) : NaN
  const reading = percent >= 0.1 && percent <= 100 && Number.isFinite(at) ? { percent, at } : null
  return { resets: parseResets(o.resets), reading }
}

export function weekConfigJson(c: WeekConfig): Record<string, unknown> {
  return { ...(c.resets ? { resets: resetsText(c.resets) } : {}), ...(c.reading ? { reading: { percent: c.reading.percent, at: new Date(c.reading.at).toISOString() } } : {}) }
}

/** The most recent reset at or before `now`, in this machine's local time. */
export function lastReset(now: number, r: Resets): number {
  const d = new Date(now)
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), r.hour, r.minute, 0, 0)
  at.setDate(at.getDate() - ((d.getDay() - r.weekday + 7) % 7))
  if (at.getTime() > now) at.setDate(at.getDate() - 7)
  return at.getTime()
}

export interface Share {
  name: string
  usd: number
  requests: number
  /** Part of the window's total, 0 to 1. */
  share: number
}

export interface WeekView {
  /** `week`: since the reset the person told us. `7 days`: no reset known, so the last seven days. */
  window: 'week' | '7 days'
  since: string
  until: string
  /** List-price estimate for the window. Not a bill. */
  usd: number
  requests: number
  /** Replies from a model with no row in the price table. They are in no dollar figure. */
  unpriced: { model: string; requests: number }[]
  folders: Share[]
  models: Share[]
  /** The ten largest sessions. Named by their folder and start, never by anything a person typed. */
  sessions: (Share & { started: string })[]
  /** Part of `usd` that subagents spent. */
  subagentUsd: number
  /** Present when a reading from the usage page can be used. */
  percent: {
    /** Estimated dollars at list price behind one percent of the week. */
    usdPerPercent: number
    /** The window's estimate as a percent of the week. */
    ofWeek: number
    readingPercent: number
    readingAt: string
    /** True when the reading is from an earlier week than the one shown. */
    fromEarlierWeek: boolean
  } | null
  /** Why there is no percent, in words for the page. */
  percentMissing: string | null
  pricesRead: string
}

interface Line {
  slot: number
  cwd: string
  model: string
  sub: boolean
  usd: number
  requests: number
  unpriced: number
  session: string
  started: number
}

function lines(states: FileState[]): Line[] {
  const out: Line[] = []
  // A subagent's file names its parent's session, so its spend lands on that session.
  const started = new Map<string, number>()
  for (const s of states) if (s.sessionId && s.firstTs) started.set(s.sessionId, Math.min(started.get(s.sessionId) ?? Infinity, s.firstTs))
  for (const s of states) {
    for (const [key, v] of s.spend) {
      const [slot, cwd, model, sub] = key.split('\n')
      out.push({ slot: Number(slot) * SLOT_MS, cwd, model, sub: sub === '1', usd: v.usd, requests: v.requests, unpriced: v.unpriced, session: s.sessionId || '', started: started.get(s.sessionId) ?? s.firstTs })
    }
  }
  return out
}

const between = (all: Line[], from: number, to: number) => all.filter((l) => l.slot >= from - SLOT_MS && l.slot < to)

function shares<T extends { usd: number; requests: number }>(groups: Map<string, T>, total: number): (T & { name: string; share: number })[] {
  return [...groups.entries()].map(([name, g]) => ({ ...g, name, share: total ? g.usd / total : 0 })).sort((a, b) => b.usd - a.usd)
}

export function summarizeWeek(states: FileState[], now: number, config: WeekConfig, nameOf: (cwd: string) => string): WeekView {
  const all = lines(states)
  const since = config.resets ? lastReset(now, config.resets) : now - 7 * DAY
  const mine = between(all, since, now + SLOT_MS)
  const usd = mine.reduce((a, l) => a + l.usd, 0)
  const group = <K extends string>(keyOf: (l: Line) => K) => {
    const m = new Map<K, { usd: number; requests: number }>()
    for (const l of mine) {
      const g = m.get(keyOf(l)) ?? { usd: 0, requests: 0 }
      g.usd += l.usd
      g.requests += l.requests
      m.set(keyOf(l), g)
    }
    return m
  }
  const unpriced = new Map<string, number>()
  for (const l of mine) if (l.unpriced) unpriced.set(l.model, (unpriced.get(l.model) ?? 0) + l.unpriced)

  const bySession = new Map<string, { usd: number; requests: number; started: number; cwd: string }>()
  for (const l of mine) {
    const g = bySession.get(l.session) ?? { usd: 0, requests: 0, started: l.started, cwd: l.cwd }
    g.usd += l.usd
    g.requests += l.requests
    bySession.set(l.session, g)
  }
  const sessions = [...bySession.values()]
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 10)
    .map((s) => ({ name: nameOf(s.cwd) || 'unknown folder', usd: s.usd, requests: s.requests, share: usd ? s.usd / usd : 0, started: s.started ? new Date(s.started).toISOString() : '' }))

  let percent: WeekView['percent'] = null
  let percentMissing: string | null = null
  if (!config.resets) percentMissing = 'Say when your week resets and what your usage page shows, and this page can show percent of your week.'
  else if (!config.reading) percentMissing = 'Give one reading from your usage page, and this page can show percent of your week.'
  else if (config.reading.at > now + SLOT_MS) percentMissing = 'The reading is dated in the future.'
  else {
    const start = lastReset(config.reading.at, config.resets)
    const then = between(all, start, config.reading.at).reduce((a, l) => a + l.usd, 0)
    if (then <= 0) percentMissing = 'Nothing on this machine was counted in the week of your reading, so it cannot be used. The session files from then may have been deleted. Take a new reading.'
    else {
      const usdPerPercent = then / config.reading.percent
      percent = { usdPerPercent, ofWeek: usd / usdPerPercent, readingPercent: config.reading.percent, readingAt: new Date(config.reading.at).toISOString(), fromEarlierWeek: start < since }
    }
  }

  return {
    window: config.resets ? 'week' : '7 days',
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    usd,
    requests: mine.reduce((a, l) => a + l.requests, 0),
    unpriced: [...unpriced.entries()].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests),
    folders: shares(new Map([...group((l) => nameOf(l.cwd) || 'unknown folder')]), usd),
    models: shares(new Map([...group((l) => l.model)]), usd),
    sessions,
    subagentUsd: mine.filter((l) => l.sub).reduce((a, l) => a + l.usd, 0),
    percent,
    percentMissing,
    pricesRead: PRICES_READ,
  }
}
