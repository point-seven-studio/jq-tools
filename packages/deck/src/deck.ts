/**
 * JQ Deck: the join. One row per repository, built from what the three tools
 * already know: its sessions (jq-agents), its setup score (jq-groundcrew) and
 * its unread mail (jq-crosstalk).
 *
 * Everything here is a pure function of its arguments. Reading the machine is
 * in collect.ts.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { deriveAttention, type AgentStatusRow, type Snapshot } from '@point-seven-studio/jq-agents'
import type { WaitingBoard } from '@point-seven-studio/jq-crosstalk'
import type { Summary } from '@point-seven-studio/jq-groundcrew'

export interface DeckConfig {
  /** The crosstalk mailbox folder. */
  mailbox?: string
  /** Inbox name → repository folder, for when the two are not named alike. */
  names?: Record<string, string>
  /** Folders whose waiting sessions may show their question text. */
  questions?: string[]
  /** The repositories --watch may report to a team board: names, remotes or folders. */
  report?: string[]
}

export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p)

export function defaultConfigFile(): string {
  return path.join(os.homedir(), '.jq', 'config.json')
}

/** A missing file is no config. A file that cannot be parsed is an error, named. */
export function loadConfig(file: string): DeckConfig {
  if (!existsSync(file)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e: any) {
    throw new Error(`cannot read ${file}: ${e?.message || e}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`)
  const r = raw as Record<string, unknown>
  const out: DeckConfig = {}
  if (typeof r.mailbox === 'string') out.mailbox = expandHome(r.mailbox)
  if (r.names && typeof r.names === 'object' && !Array.isArray(r.names)) {
    out.names = {}
    for (const [k, v] of Object.entries(r.names as Record<string, unknown>)) if (typeof v === 'string') out.names[k] = path.resolve(expandHome(v))
  }
  if (Array.isArray(r.report)) out.report = r.report.filter((q): q is string => typeof q === 'string')
  if (Array.isArray(r.questions)) out.questions = r.questions.filter((q): q is string => typeof q === 'string').map(expandHome)
  return out
}

/**
 * Which mailbox: the flag, then the config file, then $CROSSTALK_DIR, then the
 * nearest folder above `cwd` holding a .crosstalk file. The same order the
 * `crosstalk` command uses for the last two. null when there is none.
 */
export function findMailbox(opts: { flag?: string | null; config?: string; env?: string; cwd: string }): string | null {
  const named = opts.flag || opts.config || opts.env
  if (named) return path.resolve(expandHome(named))
  let dir = path.resolve(opts.cwd)
  for (;;) {
    if (existsSync(path.join(dir, '.crosstalk'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** A short, stable id for a folder, so a URL never carries a path. */
export const repoId = (tree: string) => createHash('sha1').update(tree).digest('hex').slice(0, 10)

/**
 * The inbox for a folder when the config file names none: the inbox with exactly
 * the folder's name, else the only inbox the folder's name starts with before a
 * separator ("shop-v2" → "shop"). Two candidates is no match: a wrong inbox
 * would show another session's unread count.
 */
export function matchInbox(folder: string, inboxes: string[]): string | null {
  const f = folder.toLowerCase()
  const exact = inboxes.find((i) => i.toLowerCase() === f)
  if (exact) return exact
  const starts = inboxes.filter((i) => f.startsWith(i.toLowerCase()) && /[-_. ]/.test(f[i.length] ?? ''))
  return starts.length === 1 ? starts[0] : null
}

export type SetupResult = { summary: Summary } | { error: string }

export interface RepoRow {
  id: string
  name: string
  tree: string
  sessions: number
  live: number
  /** Sessions that ended their turn and are alive: they need a person now. */
  needs_you: number
  /** Sessions that asked something and were left. */
  abandoned: number
  last_activity_at: string | null
  /** When the longest-waiting session that needs a person last did anything. */
  waiting_since: string | null
  /** The origin remote as host/owner/name, when the folder has one. Names the same repository on two machines. */
  remote: string | null
  /** null when the setup check could not run; `setup_note` says why. */
  setup: { score: number; fail: number; warn: number } | null
  setup_note: string | null
  /** The inbox matched to this repository, or null when none matches. */
  inbox: string | null
  /** null when there is no matched inbox: unknown, never zero. */
  unread: number | null
  oldest_unread_days: number | null
}

export interface Overview {
  machine: string
  generated_at: string
  /** One sentence. Says what was counted, so zero never reads as "failed to load". */
  headline: string
  repos: RepoRow[]
  mailbox: string | null
  /** null when no mailbox was found, or it could not be read (`mail_note`). */
  mail: { total_unread: number; headline: string; unmatched: { inbox: string; unread: number }[] } | null
  mail_note: string | null
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function buildHeadline(repos: RepoRow[], mail: Overview['mail'], mailNote: string | null): string {
  const needs = repos.reduce((n, r) => n + r.needs_you, 0)
  const sessions = repos.reduce((n, r) => n + r.sessions, 0)
  const failing = repos.filter((r) => r.setup && r.setup.fail > 0).length
  const checked = repos.filter((r) => r.setup).length
  const parts = [
    needs > 0 ? `${plural(needs, 'session is', 'sessions are')} waiting on you` : `No session is waiting on you (${plural(sessions, 'session', 'sessions')} read)`,
    mail ? (mail.total_unread > 0 ? plural(mail.total_unread, 'unread message', 'unread messages') : 'no unread mail') : mailNote ? 'the mailbox could not be read' : 'no mailbox set',
    failing > 0 ? `${plural(failing, 'repository has', 'repositories have')} a setup check to fix` : `no failing setup check in ${plural(checked, 'repository', 'repositories')}`,
  ]
  return parts.join(', ') + '.'
}

export function buildOverview(input: {
  snapshot: Snapshot
  /** Every repository to show: the trees with a session, plus any others. */
  trees: string[]
  setups: Map<string, SetupResult>
  /** null when there is no mailbox, or it could not be read. */
  waiting: WaitingBoard | null
  /** Every inbox in the mailbox, so "no unread" can be told from "no inbox". */
  inboxes?: string[]
  mailbox: string | null
  mailNote?: string | null
  names?: Record<string, string>
  /** Folder → origin remote, as host/owner/name. */
  remotes?: Map<string, string>
}): Overview {
  const { snapshot, waiting } = input
  const byTree = new Map<string, AgentStatusRow[]>()
  for (const r of snapshot.sessions) byTree.set(r.working_tree, [...(byTree.get(r.working_tree) ?? []), r])
  const inboxes = new Set(input.inboxes ?? [])
  const named = new Map(Object.entries(input.names ?? {}).map(([inbox, tree]) => [tree, inbox]))
  const matched = new Set<string>()

  const repos: RepoRow[] = [...new Set(input.trees)].map((tree) => {
    const rows = byTree.get(tree) ?? []
    const attention = rows.map((r) => deriveAttention(r.state, r.waiting))
    const name = rows[0]?.product || tree.split('/').filter(Boolean).pop() || tree
    const setup = input.setups.get(tree)
    const inbox = waiting ? (named.get(tree) ?? matchInbox(name, [...inboxes])) : null
    if (inbox) matched.add(inbox)
    const waitingFor = inbox ? waiting?.inboxes.find((i) => i.product === inbox) : undefined
    return {
      id: repoId(tree),
      name,
      tree,
      sessions: rows.length,
      live: rows.filter((r) => r.state === 'live').length,
      needs_you: attention.filter((a) => a === 'needs-you').length,
      abandoned: attention.filter((a) => a === 'abandoned').length,
      last_activity_at: rows.map((r) => r.last_activity_at || '').sort().pop() || null,
      waiting_since: rows.filter((_, i) => attention[i] === 'needs-you').map((r) => r.last_activity_at || '').filter(Boolean).sort()[0] ?? null,
      remote: input.remotes?.get(tree) ?? null,
      setup: setup && 'summary' in setup ? { score: setup.summary.score, fail: setup.summary.fail, warn: setup.summary.warn } : null,
      setup_note: setup && 'error' in setup ? setup.error : setup ? null : 'not checked',
      inbox,
      unread: inbox ? (waitingFor?.unread ?? 0) : null,
      oldest_unread_days: waitingFor?.oldest_age_days ?? null,
    }
  })
  // What needs a person first, then the most recently active.
  repos.sort((a, b) => b.needs_you - a.needs_you || (b.last_activity_at || '').localeCompare(a.last_activity_at || '') || a.name.localeCompare(b.name))

  const mail = waiting
    ? {
        total_unread: waiting.total_unread,
        headline: waiting.headline,
        unmatched: waiting.inboxes.filter((i) => !matched.has(i.product)).map((i) => ({ inbox: i.product, unread: i.unread })),
      }
    : null
  const mailNote = input.mailNote ?? null
  return {
    machine: snapshot.machine,
    generated_at: snapshot.generated_at,
    headline: buildHeadline(repos, mail, mailNote),
    repos,
    mailbox: input.mailbox,
    mail,
    mail_note: mailNote,
  }
}

/**
 * "git@github.com:acme/shop.git" and "https://github.com/acme/shop" are both
 * "github.com/acme/shop". Any user name or token in the address is dropped.
 * null when the address is not one of the shapes git hosts use.
 */
export function normalizeRemote(url: string): string | null {
  const u = url.trim()
  const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u) ?? /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(u)
  if (!m) return null
  const repoPath = m[2].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (!repoPath || /\s/.test(repoPath)) return null
  return `${m[1].toLowerCase()}/${repoPath}`
}

/** The url of [remote "origin"] in a git config file's text. */
export function originIn(config: string): string | null {
  let inOrigin = false
  for (const line of config.split('\n')) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line)
    if (section) inOrigin = /^remote\s+"origin"$/.test(section[1].trim())
    else if (inOrigin) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
      if (url) return normalizeRemote(url[1])
    }
  }
  return null
}

/**
 * What one machine tells a team board: counts and scores per repository. It
 * carries no folder path, no question text, no message and no file name.
 */
export interface TeamReport {
  v: 1
  generated_at: string
  repos: {
    name: string
    remote: string | null
    sessions: number
    live: number
    needs_you: number
    abandoned: number
    waiting_since: string | null
    last_activity_at: string | null
    setup: { score: number; fail: number; warn: number } | null
    unread: number | null
  }[]
}

/** Is this repository on the list? An entry is a folder name, a remote (host/owner/name) or a folder path. */
export function reportable(r: Pick<RepoRow, 'name' | 'remote' | 'tree'>, only: string[]): boolean {
  return only.some((entry) => {
    const e = entry.trim()
    if (!e) return false
    if (e.toLowerCase() === r.name.toLowerCase() || (!!r.remote && e.toLowerCase() === r.remote.toLowerCase())) return true
    return /^[~/.]/.test(e) && path.resolve(expandHome(e)) === r.tree
  })
}

/**
 * `only` is the list of repositories this machine agreed to report. With a
 * list, nothing else is in the report, not even as a count. null reports all.
 */
export function teamReport(o: Overview, only: string[] | null = null): TeamReport {
  return {
    v: 1,
    generated_at: o.generated_at,
    repos: o.repos.filter((r) => only === null || reportable(r, only)).map((r) => ({
      name: r.name,
      remote: r.remote,
      sessions: r.sessions,
      live: r.live,
      needs_you: r.needs_you,
      abandoned: r.abandoned,
      waiting_since: r.waiting_since,
      last_activity_at: r.last_activity_at,
      setup: r.setup,
      unread: r.unread,
    })),
  }
}
