/**
 * The team board, as a pure function of the stored reports, the clock and who
 * is looking. A report that has gone quiet never counts as current: a machine
 * that last spoke hours ago may have closed every session since.
 */
import type { RepoReport } from './report.js'
import type { StoredReport, Viewer } from './store.js'

/** Heard from within this long: its numbers count. Five missed one-minute reports. */
export const FRESH_MS = 5 * 60_000
/** Not heard from for this long: its rows are dropped and it is listed as silent. */
export const SILENT_MS = 24 * 3_600_000

export type Freshness = 'fresh' | 'quiet' | 'silent'

export interface MachineState {
  machine: string
  who: string
  received_at: string
  freshness: Freshness
  /** Whole minutes since the server last heard from it. */
  minutes_ago: number
}

export interface TeamRow extends RepoReport {
  machine: string
  who: string
  freshness: Freshness
  minutes_ago: number
  /** Whole minutes the longest-waiting session has waited. null when none waits, or the report is not fresh. */
  waiting_minutes: number | null
}

export interface TeamGroup {
  /** The remote when there is one, else the folder name. */
  key: string
  name: string
  remote: string | null
  needs_you: number
  rows: TeamRow[]
}

export interface Team {
  generated_at: string
  headline: string
  totals: { needs_you: number; sessions: number; machines_fresh: number; machines_quiet: number; machines_silent: number }
  groups: TeamGroup[]
  machines: MachineState[]
  /** True when this viewer sees only some repositories. */
  scoped: boolean
}

export function freshness(receivedAt: string, now: number): { freshness: Freshness; minutes_ago: number } {
  const age = Math.max(0, now - Date.parse(receivedAt))
  return { freshness: age <= FRESH_MS ? 'fresh' : age <= SILENT_MS ? 'quiet' : 'silent', minutes_ago: Math.floor(age / 60_000) }
}

const lower = (s: string) => s.toLowerCase()

/** May this viewer see this repository? No list means every repository. */
export function visible(viewer: Pick<Viewer, 'repos'> | null, repo: Pick<RepoReport, 'name' | 'remote'>): boolean {
  if (!viewer?.repos || viewer.repos.length === 0) return true
  const allowed = new Set(viewer.repos.map(lower))
  return allowed.has(lower(repo.name)) || (!!repo.remote && allowed.has(lower(repo.remote)))
}

export function duration(minutes: number): string {
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  return `${Math.floor(hours / 24)} days`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function buildTeam(reports: StoredReport[], now: number, viewer: Pick<Viewer, 'repos'> | null = null): Team {
  const scoped = !!viewer?.repos?.length
  const groups = new Map<string, TeamGroup>()
  const machines: MachineState[] = []

  for (const stored of reports) {
    const state = freshness(stored.received_at, now)
    const mine = stored.report.repos.filter((r) => visible(viewer, r))
    // Scoping comes before every count: a machine with nothing this viewer may
    // see is not listed at all, so its existence is not disclosed either.
    if (scoped && mine.length === 0) continue
    machines.push({ machine: stored.machine, who: stored.who, received_at: stored.received_at, ...state })
    if (state.freshness === 'silent') continue
    for (const repo of mine) {
      const key = repo.remote ? lower(repo.remote) : `name:${lower(repo.name)}`
      const group = groups.get(key) ?? { key, name: repo.name, remote: repo.remote, needs_you: 0, rows: [] }
      const fresh = state.freshness === 'fresh'
      const since = fresh && repo.needs_you > 0 && repo.waiting_since ? Math.max(0, Math.floor((now - Date.parse(repo.waiting_since)) / 60_000)) : null
      group.rows.push({ ...repo, machine: stored.machine, who: stored.who, ...state, waiting_minutes: since })
      if (fresh) group.needs_you += repo.needs_you
      groups.set(key, group)
    }
  }

  const longest = (g: TeamGroup) => Math.max(-1, ...g.rows.map((r) => r.waiting_minutes ?? -1))
  const list = [...groups.values()]
  for (const g of list) g.rows.sort((a, b) => (b.waiting_minutes ?? -1) - (a.waiting_minutes ?? -1) || a.who.localeCompare(b.who) || a.machine.localeCompare(b.machine))
  list.sort((a, b) => longest(b) - longest(a) || b.needs_you - a.needs_you || a.name.localeCompare(b.name))
  machines.sort((a, b) => a.minutes_ago - b.minutes_ago || a.machine.localeCompare(b.machine))

  const freshRows = list.flatMap((g) => g.rows).filter((r) => r.freshness === 'fresh')
  const totals = {
    needs_you: freshRows.reduce((n, r) => n + r.needs_you, 0),
    sessions: freshRows.reduce((n, r) => n + r.sessions, 0),
    machines_fresh: machines.filter((m) => m.freshness === 'fresh').length,
    machines_quiet: machines.filter((m) => m.freshness === 'quiet').length,
    machines_silent: machines.filter((m) => m.freshness === 'silent').length,
  }

  let headline: string
  if (machines.length === 0) headline = scoped ? 'No machine has reported a repository you can see.' : 'No machine has reported yet.'
  else if (totals.machines_fresh === 0) headline = `No machine has reported in the last 5 minutes (${plural(machines.length, 'machine', 'machines')} known), so nothing below is current.`
  else if (totals.needs_you === 0) headline = `No session is waiting on a person: ${plural(totals.sessions, 'session', 'sessions')} on ${plural(totals.machines_fresh, 'machine', 'machines')} read.`
  else {
    const top = freshRows.filter((r) => r.waiting_minutes !== null).sort((a, b) => (b.waiting_minutes as number) - (a.waiting_minutes as number))[0]
    const where = top ? ` The longest has waited ${duration(top.waiting_minutes as number)}: ${top.name}, ${top.who}.` : ''
    headline = `${plural(totals.needs_you, 'session is', 'sessions are')} waiting on a person, on ${plural(totals.machines_fresh, 'machine', 'machines')}.${where}`
  }
  const late = totals.machines_quiet + totals.machines_silent
  if (late > 0 && totals.machines_fresh > 0) headline += ` ${plural(late, 'machine has', 'machines have')} gone quiet and ${late === 1 ? 'is' : 'are'} not counted.`

  return { generated_at: new Date(now).toISOString(), headline, totals, groups: list, machines, scoped }
}
