/**
 * The report one machine sends: counts and scores per repository. This file is
 * the whole of what the server will accept and keep. Anything not named here is
 * dropped, so a sender cannot put a path, a question or a message on the board
 * even by mistake.
 */
export interface RepoReport {
  name: string
  /** host/owner/name of the origin remote. Names the same repository on two machines. */
  remote: string | null
  sessions: number
  live: number
  needs_you: number
  abandoned: number
  waiting_since: string | null
  last_activity_at: string | null
  setup: { score: number; fail: number; warn: number } | null
  /** null when the machine has no inbox for this repository: unknown, never zero. */
  unread: number | null
}

export interface TeamReport {
  v: 1
  generated_at: string
  repos: RepoReport[]
}

export const MAX_REPOS = 200
export const MAX_BODY_BYTES = 256 * 1024

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function count(v: unknown, field: string, max = 100_000): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new Error(`${field} must be a whole number from 0 to ${max}`)
  return v
}

function isoOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) throw new Error(`${field} must be a date or null`)
  return new Date(Date.parse(v)).toISOString()
}

/** A folder name: printable, one line, no slash (so it cannot be a path). */
function repoName(v: unknown): string {
  if (typeof v !== 'string') throw new Error('a repository needs a name')
  const name = v.trim()
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f/\\]/.test(name)) throw new Error('a repository name must be 1 to 100 characters with no slash')
  return name
}

/** host/owner/name. Anything else is dropped, not refused: the name still identifies the row. */
function remote(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 200 && /^[a-z0-9][a-z0-9.-]*(\/[A-Za-z0-9._~-]+)+$/.test(v) ? v : null
}

/** Throws with a plain reason when the value is not a report. Returns only the fields above. */
export function sanitizeReport(value: unknown): TeamReport {
  if (!isObj(value)) throw new Error('the report must be a JSON object')
  if (value.v !== 1) throw new Error('unknown report version (this server reads version 1)')
  const generated = isoOrNull(value.generated_at, 'generated_at')
  if (!generated) throw new Error('generated_at is missing')
  if (!Array.isArray(value.repos)) throw new Error('repos must be a list')
  if (value.repos.length > MAX_REPOS) throw new Error(`a report holds at most ${MAX_REPOS} repositories`)
  const repos = value.repos.map((r): RepoReport => {
    if (!isObj(r)) throw new Error('each repository must be an object')
    const setup = isObj(r.setup) ? { score: count(r.setup.score, 'setup.score', 100), fail: count(r.setup.fail, 'setup.fail'), warn: count(r.setup.warn, 'setup.warn') } : null
    return {
      name: repoName(r.name),
      remote: remote(r.remote),
      sessions: count(r.sessions, 'sessions'),
      live: count(r.live, 'live'),
      needs_you: count(r.needs_you, 'needs_you'),
      abandoned: count(r.abandoned, 'abandoned'),
      waiting_since: isoOrNull(r.waiting_since, 'waiting_since'),
      last_activity_at: isoOrNull(r.last_activity_at, 'last_activity_at'),
      setup,
      unread: r.unread === null || r.unread === undefined ? null : count(r.unread, 'unread'),
    }
  })
  return { v: 1, generated_at: generated, repos }
}
