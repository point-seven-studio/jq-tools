/**
 * How a reader has asked to see the board: grouped by repository or by machine,
 * searched, filtered, sorted. All of it is in the page's address, so the page
 * needs no script and the one-minute reload keeps the choice.
 *
 * A view only chooses and orders rows that buildTeam() already made for this
 * viewer. It never changes a number, and it never merges two rows: one row is
 * one folder on one machine, and two folders of the same repository on one
 * machine stay two rows.
 */
import type { Team, TeamRow } from './team.js'

export type GroupBy = 'repo' | 'machine'
export type Filter = 'all' | 'waiting' | 'live' | 'fix'
export type Sort = 'waiting' | 'repository' | 'machine' | 'setup'

export interface View {
  group: GroupBy
  filter: Filter
  sort: Sort
  /** Lower-cased search text; '' for none. */
  q: string
}

export const DEFAULT_VIEW: View = { group: 'repo', filter: 'all', sort: 'waiting', q: '' }
export const MAX_SEARCH_CHARS = 100

const GROUPS: GroupBy[] = ['repo', 'machine']
const FILTERS: Filter[] = ['all', 'waiting', 'live', 'fix']
const SORTS: Sort[] = ['waiting', 'repository', 'machine', 'setup']

/** Reads a query string. Anything it does not know becomes the default: an address cannot break the page. */
export function parseView(query: string | undefined): View {
  const p = new URLSearchParams(query || '')
  const pick = <T extends string>(name: string, allowed: T[], fallback: T): T => (allowed.includes(p.get(name) as T) ? (p.get(name) as T) : fallback)
  const q = (p.get('q') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_SEARCH_CHARS).toLowerCase()
  return { group: pick('group', GROUPS, DEFAULT_VIEW.group), filter: pick('filter', FILTERS, DEFAULT_VIEW.filter), sort: pick('sort', SORTS, DEFAULT_VIEW.sort), q }
}

/** The query string of a view, defaults left out. '' when everything is the default. */
export function viewQuery(v: View): string {
  const p = new URLSearchParams()
  if (v.group !== DEFAULT_VIEW.group) p.set('group', v.group)
  if (v.filter !== DEFAULT_VIEW.filter) p.set('filter', v.filter)
  if (v.sort !== DEFAULT_VIEW.sort) p.set('sort', v.sort)
  if (v.q) p.set('q', v.q)
  return p.toString()
}

/** A link to this view with some of it changed, landing on the reports. */
export function viewHref(v: View, change: Partial<View> = {}): string {
  const query = viewQuery({ ...v, ...change })
  return `${query ? `?${query}` : '/'}#reports`
}

/** One reported folder on one machine, with the repository it was grouped under. */
export interface ReportRow extends TeamRow {
  /** The repository group's key and name: the same for every folder that shares a remote. */
  repo_key: string
  repo_name: string
}

export interface Section {
  key: string
  rows: ReportRow[]
  /** Sessions waiting on a person in the rows that are current. */
  waiting: number
}

export interface Selection {
  /** Every row this viewer may see, before search and filter. */
  total: number
  rows: ReportRow[]
  sections: Section[]
  /** How many rows each filter would show, within the search. */
  counts: Record<Filter, number>
}

const fresh = (r: TeamRow) => r.freshness === 'fresh'

/** A quiet machine's numbers are not current, so it is never listed as waiting or live. */
export const FILTER_TEST: Record<Filter, (r: TeamRow) => boolean> = {
  all: () => true,
  waiting: (r) => fresh(r) && r.needs_you > 0,
  live: (r) => fresh(r) && r.live > 0,
  fix: (r) => (r.setup?.fail ?? 0) > 0,
}

export function allRows(team: Team): ReportRow[] {
  return team.groups.flatMap((g) => g.rows.map((r) => ({ ...r, repo_key: g.key, repo_name: g.name })))
}

/** The rows waiting on a person, longest wait first. A wait that was not reported comes last, never first. */
export function waitingRows(team: Team): ReportRow[] {
  return allRows(team)
    .filter(FILTER_TEST.waiting)
    .sort((a, b) => (b.waiting_minutes ?? -1) - (a.waiting_minutes ?? -1))
}

const text = (a: string, b: string) => a.localeCompare(b)

const ORDER: Record<Sort, (a: ReportRow, b: ReportRow) => number> = {
  waiting: (a, b) => (b.waiting_minutes ?? -1) - (a.waiting_minutes ?? -1) || Number(FILTER_TEST.waiting(b)) - Number(FILTER_TEST.waiting(a)),
  repository: (a, b) => text(a.repo_name, b.repo_name) || text(a.name, b.name) || text(a.machine, b.machine),
  machine: (a, b) => text(a.machine, b.machine) || text(a.repo_name, b.repo_name) || text(a.name, b.name),
  // Lowest score first. A folder with no setup check has no score: it goes last, not first.
  setup: (a, b) => (a.setup?.score ?? 101) - (b.setup?.score ?? 101),
}

export function select(team: Team, view: View): Selection {
  const every = allRows(team)
  const found = view.q ? every.filter((r) => [r.name, r.repo_name, r.remote ?? '', r.machine, r.who].some((s) => s.toLowerCase().includes(view.q))) : every
  const counts = { all: found.length, waiting: found.filter(FILTER_TEST.waiting).length, live: found.filter(FILTER_TEST.live).length, fix: found.filter(FILTER_TEST.fix).length }
  // The sort is stable, so rows that tie keep the board's own order: longest wait first.
  const rows = found.filter(FILTER_TEST[view.filter]).sort(ORDER[view.sort])
  const sections = new Map<string, Section>()
  for (const r of rows) {
    const key = view.group === 'repo' ? r.repo_key : `machine:${r.machine}`
    const s = sections.get(key) ?? { key, rows: [], waiting: 0 }
    s.rows.push(r)
    if (fresh(r)) s.waiting += r.needs_you
    sections.set(key, s)
  }
  return { total: every.length, rows, sections: [...sections.values()], counts }
}
