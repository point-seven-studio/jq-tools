/**
 * Timers: mail that is written now and delivered later. Pure.
 *
 * A timer is a file in `<mailbox>/timers/`. It looks like a message, with two more
 * header lines: `due:` (when to deliver it) and, for one that repeats, `every:`.
 * `crosstalk due` delivers each timer whose time has come as an ordinary message in the
 * recipient's inbox. A timer never starts work by itself: it only becomes mail.
 *
 * Two kinds, as in the usual always-on design:
 * - a follow-up, which a session sets for itself and which fires once;
 * - a schedule, which carries `every:` and moves to its next time after each delivery.
 */

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** A schedule may not repeat faster than this. Each delivery can start a run that costs money. */
export const SHORTEST_EVERY = 5 * MINUTE

const UNITS: Record<string, number> = { m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY }
const WORDS: Record<string, number> = { hour: HOUR, day: DAY, week: 7 * DAY }

/** `30m`, `2h`, `3d`, `1w`, or `hour`, `day`, `week`. Returns milliseconds, or null when it is none of these. */
export function parseSpan(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (WORDS[t]) return WORDS[t]
  const m = t.match(/^(\d{1,4})([mhdw])$/)
  if (!m) return null
  const n = Number(m[1])
  return n > 0 ? n * UNITS[m[2]] : null
}

/** When a timer is due: `+2h` and the like, counted from now, or a date and time that `Date` reads. */
export function parseWhen(text: string, now: number): number {
  const t = text.trim()
  if (t.startsWith('+')) {
    const span = parseSpan(t.slice(1))
    if (span === null) throw new Error(`--at ${text}: after "+" give a number and m, h, d or w, such as +2h`)
    return now + span
  }
  // A bare date means the start of that day in local time, as a person would read it.
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00` : t)
  if (Number.isNaN(ms)) throw new Error(`--at ${text}: give +2h, +3d, or a date such as 2026-12-01 or 2026-12-01T09:00`)
  return ms
}

export function parseEvery(text: string): number {
  const span = parseSpan(text)
  if (span === null) throw new Error(`--every ${text}: give hour, day, week, or a number and m, h, d or w`)
  if (span < SHORTEST_EVERY) throw new Error(`--every ${text}: the shortest is 5m`)
  return span
}

/** The first time after `now` that a schedule falls on. Missed times are skipped, never delivered in a burst. */
export function nextDue(due: number, every: number, now: number): number {
  if (due > now) return due
  return due + (Math.floor((now - due) / every) + 1) * every
}

export interface Timer {
  /** The file's name in timers/, with `.md`. */
  filename: string
  from: string
  to: string
  subject: string
  kind: string
  /** ISO time. */
  due: string
  /** Such as `1d`; '' for a timer that fires once. */
  every: string
  /** A follow-up in an existing thread carries the thread and the message it follows. */
  thread: string
  reply_to: string
  body: string
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function renderTimer(t: Omit<Timer, 'filename'>): string {
  const lines = ['---', `from: ${oneLine(t.from)}`, `to: ${oneLine(t.to)}`, `subject: ${oneLine(t.subject)}`, `kind: ${oneLine(t.kind)}`, `due: ${t.due}`]
  if (t.every) lines.push(`every: ${t.every}`)
  if (t.thread) lines.push(`thread: ${oneLine(t.thread)}`)
  if (t.reply_to) lines.push(`reply_to: ${oneLine(t.reply_to)}`)
  lines.push('---', '', t.body.trim(), '')
  return lines.join('\n')
}

/** Read a timer file. Returns null for a file that is not one: no header, no `to:`, or no readable `due:`. */
export function parseTimer(filename: string, raw: string): Timer | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fm) return null
  const t: Timer = { filename, from: '', to: '', subject: '', kind: 'brief', due: '', every: '', thread: '', reply_to: '', body: fm[2].trim() }
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    if (key === 'from' || key === 'to' || key === 'subject' || key === 'kind' || key === 'due' || key === 'every' || key === 'thread' || key === 'reply_to') t[key] = m[2].trim()
  }
  if (!t.from || !t.to || Number.isNaN(Date.parse(t.due))) return null
  if (t.every && parseSpan(t.every) === null) return null
  return t
}

/** `20261201-090000`, in UTC, as the mailbox names its files. */
export function stamp(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

export function slug(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

/**
 * The name of the message one firing of a timer becomes. It is made from the timer and
 * the time it was due, so delivering the same firing twice gives the same name, and the
 * second attempt finds the first and does nothing.
 */
export function deliveryName(t: Timer, dueMs: number): string {
  // A short mark of which timer it was, so two timers with one subject, due in the same
  // second, do not take each other's name.
  let h = 5381
  for (const c of t.filename) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
  return `${stamp(dueMs)}-${t.to}-${slug(t.subject) || 'timer'}-t${h.toString(36)}`
}
