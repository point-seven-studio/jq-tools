/**
 * JQ Agents: the rules that turn the tail of a session transcript into one status row.
 *
 * Everything here is PURE (no fs, no network, no clock beyond an injected
 * `now`), so it can be golden-tested. The I/O half is collect.ts.
 *
 * Read-only by design: nothing in this module or its callers ever writes back
 * into a running session.
 */

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
   * while it is still working, where the question does not apply. See deriveTurnCheck.
   */
  turn_check?: TurnCheck | null

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

/**
 * What stands behind "done". A session that ends its turn has decided on its own that the
 * work is finished; this says whether anything but the session looked.
 *
 *   checked    a test, lint, type-check or build command ran after the last file edit
 *   failed     the last such command after the last edit reported an error
 *   unchecked  files were edited and no such command ran afterwards
 *   no-edits   the turn edited no file, so there was nothing to check
 *   unknown    the start of the turn is further back than the tail that was read
 */
export type TurnCheck = 'checked' | 'failed' | 'unchecked' | 'no-edits' | 'unknown'

/** Tools that change a file. A file changed by a shell command is not seen: see deriveTurnCheck. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** A shell command that tests, lints, type-checks or builds. The same rule as JQ Groundcrew's. */
export function looksLikeACheck(command: string): boolean {
  return /\b(test|tests|jest|vitest|pytest|mocha|lint|eslint|ruff|tsc|typecheck|type-check|mypy|pyright|check|build|cargo (test|check|clippy)|go (test|vet))\b/i.test(command)
}

type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean; input?: { command?: unknown } }
const blocks = (rec: TranscriptRecord): Block[] => (Array.isArray(rec.message?.content) ? (rec.message!.content as Block[]).filter((b) => !!b && typeof b === 'object') : [])

/** A record in which a person typed: a user record that is not only tool results. */
function isPrompt(rec: TranscriptRecord): boolean {
  if (rec.type !== 'user' || rec.isSidechain) return false
  const content = rec.message?.content
  return typeof content === 'string' ? content.trim() !== '' : blocks(rec).some((b) => b.type === 'text' || b.type === 'image')
}

/**
 * Whether a check ran after the last file edit of the current turn. `records` is the
 * transcript tail, newest last.
 *
 * It reads tool names, the text of shell commands on this machine, and the error flag of a
 * result. None of that is kept: one word comes out.
 *
 * Measured 2026-11-21 on 9 local transcripts: of 781 results of a check-shaped shell command,
 * 14 carried `is_error: true`. The flag follows the command's exit status, so a check whose
 * output is piped into another program can fail and still read as passed. "checked" therefore
 * means a check ran, not that the work is right.
 *
 * Two things it does not see, and both make it say less, not more: a file changed by a shell
 * command (no edit is counted, so the turn can read "no-edits"), and a check a subagent ran.
 */
export function deriveTurnCheck(records: TranscriptRecord[]): TurnCheck {
  let start = -1
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i] && isPrompt(records[i])) {
      start = i
      break
    }
  }
  let step = 0
  let lastEdit = -1
  const checks: Array<{ step: number; id: string | undefined }> = []
  const errored = new Set<string>()
  for (const rec of records.slice(start + 1)) {
    if (!rec || rec.isSidechain) continue
    for (const block of blocks(rec)) {
      step += 1
      if (block.type === 'tool_result' && block.is_error === true && block.tool_use_id) errored.add(block.tool_use_id)
      if (block.type !== 'tool_use') continue
      if (block.name && EDIT_TOOLS.has(block.name)) lastEdit = step
      else if (block.name === 'Bash' && typeof block.input?.command === 'string' && looksLikeACheck(block.input.command)) checks.push({ step, id: block.id })
    }
  }
  if (lastEdit < 0) return start >= 0 ? 'no-edits' : 'unknown'
  const after = checks.filter((c) => c.step > lastEdit)
  if (!after.length) return 'unchecked'
  const last = after[after.length - 1]
  return last.id && errored.has(last.id) ? 'failed' : 'checked'
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
    // "Said done" is an ended turn. A turn cut short, or one still running, has claimed nothing.
    turn_check: substantive?.type === 'assistant' && substantive.message?.stop_reason === 'end_turn' ? deriveTurnCheck(records) : null,
  }
}
