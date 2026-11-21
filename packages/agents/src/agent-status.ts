/**
 * JQ Agents: the rules that turn the tail of a session transcript into one status row.
 *
 * Everything here is PURE (no fs, no network, no clock beyond an injected
 * `now`), so it can be golden-tested. The I/O half is collect.ts.
 *
 * Read-only by design: nothing in this module or its callers ever writes back
 * into a running session.
 */

import { deriveTurnCheckDetail, type TurnCheck, type TurnCheckDetail } from './turn-check.js'

/** One JSONL record from ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. */
export interface TranscriptRecord {
  /** True on a record a subagent wrote. Its tool calls are not the session's own. */
  isSidechain?: boolean
  type?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  message?: {
    role?: string
    stop_reason?: string | null
    content?: unknown
  }
}

export interface AgentStatusRow {
  machine: string
  product: string
  working_tree: string
  branch: string | null
  session_id: string
  pid: number | null
  state: 'live' | 'idle' | 'stale' | 'dead'
  last_activity_at: string | null
  waiting: boolean
  stop_reason: string | null
  ends_with_question: boolean
  blocked_question: string | null
  question_redacted: boolean
  question_allowed: boolean
  /**
   * When the session has ended its turn: whether a check ran after its last file edit. NULL
   * while it is still working, where the question does not apply. See turn-check.ts.
   */
  turn_check?: TurnCheck | null
  /** How the last edit of the turn was made: an edit tool, or a shell command. */
  turn_check_via?: 'tool' | 'shell' | null

  // Resource attributes, attached by the relay after the pure build. Optional
  // because a session with no matched pid has nothing to sample, and because a
  // one-shot relay run has no previous tick to compute a rate against. NULL
  // means "not measured" — it must never render as zero.
  cpu_pct?: number | null
  rss_mb?: number | null
  net_rx_bps?: number | null
  net_tx_bps?: number | null
}

/**
 * Record types that are METADATA, not conversation turns. Measured on
 * 2026-08-18: reading the last *record* rather than the last *substantive* one
 * misses 25 of 235 transcripts outright AND reads the wrong timestamp for idle
 * time. Re-derive with:
 *   find ~/.claude/projects -name '*.jsonl' | while read -r f; do tail -1 "$f" \
 *     | python3 -c "import sys,json;print(json.load(sys.stdin).get('type'))"; done \
 *     | sort | uniq -c | sort -rn
 */
export const META_RECORD_TYPES = new Set([
  'last-prompt',
  'pr-link',
  'queue-operation',
  'mode',
  'ai-title',
  'attachment',
  'result',
  'summary',
])

/**
 * Idle thresholds, in seconds, for the live → idle → stale ladder.
 *
 * LIVE was 5 minutes and read wrong in practice: a session records nothing to
 * its transcript while a long tool call runs, so an actively-working session
 * showed `idle` and the board reported "0 live" with the operator watching it
 * work. 15 minutes matches how transcripts are actually written.
 */
export const LIVE_WITHIN_S = 15 * 60
export const IDLE_WITHIN_S = 2 * 60 * 60

/** Max characters of question text ever copied off the machine. */
export const QUESTION_MAX_CHARS = 400

/**
 * Secret shapes scrubbed from question text before it leaves the machine.
 *
 * Two lessons are baked in here, both learned the hard way on 2026-08-18:
 *  1. CLASSIFY, don't merely match. `eyJ` is the base64 prefix of `{"`, so a
 *     2-segment `eyJ…\.…` pattern matches any base64-encoded JSON — it reported
 *     127 "JWTs" for a tree whose real count was 2. The JWT pattern below
 *     therefore requires all three segments.
 *  2. A redactor that cries wolf gets switched off. `sk_live_` in a code
 *     comment is a placeholder, not a key, so the key patterns require a
 *     realistic body length.
 */
const REDACTIONS: Array<{ name: string; re: RegExp }> = [
  // Connection strings carrying user:password@host (the real finding on this machine).
  { name: 'db-url', re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@/gi },
  // Real 3-segment JWTs only — header.payload.signature.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g },
  { name: 'stripe-key', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: 'gh-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'supabase-key', re: /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // KEY=… / TOKEN=… / SECRET=… / PASSWORD=… assignments with a realistic value.
  { name: 'env-assign', re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?)\s*[=:]\s*["']?[^\s"']{12,}/g },
]

/** Scrub secret-shaped substrings. Returns the text and whether anything was hit. */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text
  let redacted = false
  for (const { name, re } of REDACTIONS) {
    out = out.replace(re, (match) => {
      redacted = true
      // Keep the assignment's variable name — it's the useful, non-secret half.
      if (name === 'env-assign') {
        const varName = match.split(/[=:]/)[0].trim()
        return `${varName}=[redacted]`
      }
      return `[redacted:${name}]`
    })
  }
  return { text: out, redacted }
}

/** Flatten a record's message content to plain text (content may be blocks). */
export function messageText(rec: TranscriptRecord): string {
  const content = rec.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string',
      )
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * Does this turn end by asking for something? Separates "wants a decision now"
 * from "idle but not blocking" — a completion summary closing with "let me know
 * if…" is lower-attention than "A or B?".
 */
export function endsWithQuestion(text: string): boolean {
  const tail = text.trimEnd().split('\n').filter((l) => l.trim()).slice(-3).join(' ')
  if (/\?\s*$/.test(text.trimEnd())) return true
  return /\?/.test(tail)
}

/** The last record that is an actual conversation turn, skipping metadata types. */
export function lastSubstantive(records: TranscriptRecord[]): TranscriptRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r?.type) continue
    if (META_RECORD_TYPES.has(r.type)) continue
    if (r.type === 'assistant' || r.type === 'user') return r
  }
  return null
}

/** The last assistant turn — the only text the relay ever considers copying. */
export function lastAssistant(records: TranscriptRecord[]): TranscriptRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.type === 'assistant') return records[i]
  }
  return null
}

/** Newest non-metadata timestamp — idle time must not read a meta record's clock. */
export function lastActivityAt(records: TranscriptRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r?.timestamp || (r.type && META_RECORD_TYPES.has(r.type))) continue
    return r.timestamp
  }
  return null
}

/**
 * live/idle/stale/dead from process liveness + how long since real activity.
 * A dead session isn't waiting, it's gone — the first conjunct of the
 * waiting-vs-stopped test.
 */
export function deriveState(
  alive: boolean,
  lastActivityIso: string | null,
  now: number,
): AgentStatusRow['state'] {
  if (!alive) return 'dead'
  if (!lastActivityIso) return 'stale'
  const ageS = Math.max(0, (now - Date.parse(lastActivityIso)) / 1000)
  if (ageS <= LIVE_WITHIN_S) return 'live'
  if (ageS <= IDLE_WITHIN_S) return 'idle'
  return 'stale'
}

/**
 * Is this session waiting on a human?
 *
 *   alive ∧ stop_reason === 'end_turn' ∧ (ends in a question) ∧ recent
 *
 * Each conjunct kills a distinct false positive. Note the equality test:
 * measured 2026-08-18, stop_reason is present on 114/114 last-substantive
 * assistant records with values end_turn 95 / null 18 / tool_use 1. The 18
 * nulls are interrupted turns — STOPPED, not waiting — so `!== 'tool_use'`
 * and `=== 'end_turn'` differ on exactly the rows that matter.
 *
 * That measured set (end_turn / null / tool_use) turned out to be INCOMPLETE:
 * a live dry run against real transcripts also produced `stop_sequence`. It is
 * excluded here deliberately — the equality test errs toward *not* claiming a
 * session wants you, and a board that under-reports is recoverable while one
 * that nags gets ignored. Re-derive the current value set before widening it:
 *   find ~/.claude/projects -name '*.jsonl' | while read -r f; do tail -1 "$f" \
 *     | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('message') or {}).get('stop_reason'))"; \
 *     done | sort | uniq -c | sort -rn
 */
export function deriveWaiting(rec: TranscriptRecord | null, alive: boolean): boolean {
  if (!alive || !rec || rec.type !== 'assistant') return false
  return rec.message?.stop_reason === 'end_turn'
}

/**
 * What a waiting session actually deserves from you.
 *
 * `waiting` alone is not actionable, and shipping it as the headline number was
 * a mistake: measured 2026-08-18, 8 of 9 "waiting" rows had last moved between
 * 5 and 32 HOURS earlier. A session abandoned yesterday is not waiting on you in
 * any sense you can act on — it is just stopped, holding an unanswered question.
 * Counting those together makes the number 89% noise, and a number that is
 * mostly noise stops being read at all.
 *
 *   needs-you   waiting AND still recent enough to matter (live/idle)
 *   abandoned   waiting but stale — an old unanswered question, not a request
 *   none        not waiting, or the session is gone
 */
export type Attention = 'needs-you' | 'abandoned' | 'none'

export function deriveAttention(state: AgentStatusRow['state'], waiting: boolean): Attention {
  if (!waiting) return 'none'
  if (state === 'live' || state === 'idle') return 'needs-you'
  if (state === 'stale') return 'abandoned'
  return 'none' // dead
}

/** Is this working tree allowed to report question text at all? */
export function isTreeAllowed(workingTree: string, allowlist: string[]): boolean {
  if (!workingTree) return false
  return allowlist.some((t) => t && (workingTree === t || workingTree.startsWith(t.replace(/\/+$/, '') + '/')))
}

/**
 * Build the row for one session. `records` is the transcript TAIL (newest last).
 * Pure — the caller supplies liveness, the allowlist and the clock.
 */
export function buildStatusRow(opts: {
  machine: string
  records: TranscriptRecord[]
  sessionIdFallback: string
  alive: boolean
  pid: number | null
  allowlist: string[]
  now: number
  /**
   * The session's cwd normalized to its git repo root. A session's raw `cwd`
   * follows it into subdirectories (a `cd apps/backend` would name the product
   * "backend" and break the PID↔tree match), so the caller resolves the root
   * and passes it here. Falls back to the raw cwd when not supplied.
   */
  workingTreeOverride?: string
  /** What a person has corrected for this tree, and whether they dismissed this session. */
  turnCheck?: { checks?: string[]; notEdits?: string[]; shellEdits?: boolean; muted?: boolean; dismissedAt?: string | null }
  /** Receives why the row got its word. Not part of the row: it holds command text. */
  onTurnDetail?: (detail: TurnCheckDetail) => void
}): AgentStatusRow | null {
  const { machine, records, sessionIdFallback, alive, pid, allowlist, now, workingTreeOverride } = opts
  const withCwd = [...records].reverse().find((r) => r?.cwd)
  const workingTree = workingTreeOverride || withCwd?.cwd || ''
  if (!workingTree) return null

  const sessionId =
    [...records].reverse().find((r) => r?.sessionId)?.sessionId || sessionIdFallback
  if (!sessionId) return null

  const branch = [...records].reverse().find((r) => r?.gitBranch)?.gitBranch || null
  const substantive = lastSubstantive(records)
  const assistant = lastAssistant(records)
  const activity = lastActivityAt(records)
  const state = deriveState(alive, activity, now)
  const waiting = deriveWaiting(substantive, alive)

  const rawText = assistant ? messageText(assistant) : ''
  const allowed = isTreeAllowed(workingTree, allowlist)

  let blocked_question: string | null = null
  let question_redacted = false
  if (allowed && waiting && rawText.trim()) {
    const { text, redacted } = redactSecrets(rawText.trim())
    question_redacted = redacted
    blocked_question =
      text.length > QUESTION_MAX_CHARS ? text.slice(0, QUESTION_MAX_CHARS).trimEnd() + '…' : text
  }

  // "Said done" is an ended turn. A turn cut short, or one still running, has claimed nothing.
  const saidDone = substantive?.type === 'assistant' && substantive.message?.stop_reason === 'end_turn'
  const detail = saidDone ? deriveTurnCheckDetail(records, opts.turnCheck) : null
  let turn_check: TurnCheck | null = detail?.result ?? null
  if (turn_check === 'unchecked' || turn_check === 'failed') {
    // A dismissal holds only until the session moves again.
    if (opts.turnCheck?.muted || (opts.turnCheck?.dismissedAt && opts.turnCheck.dismissedAt === activity)) turn_check = 'dismissed'
  }
  if (detail && opts.onTurnDetail) opts.onTurnDetail(detail)

  return {
    machine,
    product: workingTree.split('/').filter(Boolean).pop() || workingTree,
    working_tree: workingTree,
    branch,
    session_id: sessionId,
    pid,
    state,
    last_activity_at: activity,
    waiting,
    stop_reason: substantive?.type === 'assistant' ? substantive.message?.stop_reason ?? null : null,
    ends_with_question: rawText ? endsWithQuestion(rawText) : false,
    blocked_question,
    question_redacted,
    question_allowed: allowed,
    turn_check,
    turn_check_via: detail?.via ?? null,
  }
}
