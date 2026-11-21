/**
 * Golden tests for the JQ Agents deterministic core — transcript tail →
 * status row. The two things worth locking are both privacy- or
 * correctness-critical and both fail SILENTLY if they regress:
 *
 *  1. Redaction. A loosened pattern ships credentials off your machine
 *     to wherever the snapshot is sent. A tightened one cries wolf and gets
 *     switched off. Both are one-character edits away.
 *  2. Waiting detection. `stop_reason === 'end_turn'` vs `!== 'tool_use'`
 *     look equivalent and differ on interrupted turns — measured 2026-08-18,
 *     18 of 114 last-substantive assistant records had a null stop_reason.
 *     Getting it wrong makes the board nag about sessions that simply died.
 *
 * agent-status.ts is pure and imports nothing, so no module mocking is needed.
 */
import { describe, expect, it, test } from 'vitest'
import {
  buildStatusRow,
  deriveAttention,
  deriveState,
  deriveWaiting,
  endsWithQuestion,
  isTreeAllowed,
  lastActivityAt,
  lastAssistant,
  lastSubstantive,
  messageText,
  redactSecrets,
  QUESTION_MAX_CHARS,
  type TranscriptRecord,
} from '../src/agent-status.js'
import { deriveTurnCheck } from '../src/turn-check.js'

const NOW = Date.parse('2026-08-18T15:00:00.000Z')
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

function assistant(text: string, stop: string | null = 'end_turn', at = iso(30)): TranscriptRecord {
  return {
    type: 'assistant',
    timestamp: at,
    sessionId: 'sess-1',
    cwd: '/Users/x/code/proj',
    gitBranch: 'main',
    message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  }
}

describe('redactSecrets', () => {
  it('scrubs credentialed connection strings', () => {
    const { text, redacted } = redactSecrets('run psql postgres://admin:hunter2@db.example.com:5432/app')
    expect(redacted).toBe(true)
    expect(text).not.toContain('hunter2')
    expect(text).toContain('[redacted:db-url]')
  })

  it('scrubs real 3-segment JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTIzNH0.' + 'a'.repeat(30)
    const { text, redacted } = redactSecrets(`token is ${jwt} ok`)
    expect(redacted).toBe(true)
    expect(text).not.toContain(jwt)
  })

  it('does NOT flag 2-segment base64 JSON as a JWT', () => {
    // `eyJ` is the base64 prefix of `{"`, so a 2-segment pattern matches any
    // base64-encoded JSON. This exact over-match reported 127 "JWTs" for a tree
    // whose real count was 2 (2026-08-18).
    const blob = 'eyJmb28iOiJiYXIiLCJiYXoiOjEyM30.eyJxdXV4IjoicXV1eCIsInp6eiI6OTk5fQ'
    const { text, redacted } = redactSecrets(`payload ${blob}`)
    expect(redacted).toBe(false)
    expect(text).toContain(blob)
  })

  it('does NOT flag sk_live_ placeholders in prose', () => {
    // A redactor that cries wolf gets switched off, which costs more than the
    // false positive did. Short/placeholder bodies must not match.
    const { redacted } = redactSecrets('set STRIPE_SECRET_KEY to your sk_live_... value')
    expect(redacted).toBe(false)
  })

  it('scrubs a realistic stripe key but keeps the variable name on assignments', () => {
    const { text: t1 } = redactSecrets('key sk_live_' + 'A1b2C3d4E5f6G7h8I9j0')
    expect(t1).toContain('[redacted:stripe-key]')
    const { text: t2 } = redactSecrets('SUPABASE_SERVICE_ROLE_KEY=abcdefghijklmnopqrstuvwxyz')
    expect(t2).toContain('SUPABASE_SERVICE_ROLE_KEY=[redacted]')
    expect(t2).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('leaves ordinary prose untouched', () => {
    const prose = 'Should I merge PR #42 or rebase it onto main first?'
    const { text, redacted } = redactSecrets(prose)
    expect(redacted).toBe(false)
    expect(text).toBe(prose)
  })
})

describe('record selection', () => {
  const records: TranscriptRecord[] = [
    assistant('older turn', 'end_turn', iso(600)),
    { type: 'user', timestamp: iso(300), message: { content: 'tool result' } },
    assistant('the question?', 'end_turn', iso(120)),
    // Metadata records land AFTER the real turn and must not be mistaken for it.
    { type: 'last-prompt', timestamp: iso(10) },
    { type: 'pr-link', timestamp: iso(5) },
  ]

  it('skips metadata records when finding the last substantive turn', () => {
    expect(lastSubstantive(records)?.type).toBe('assistant')
    expect(messageText(lastSubstantive(records)!)).toBe('the question?')
  })

  it('reads idle time from the last real turn, not a metadata record', () => {
    // A meta record's clock would report 5s idle for a session last active 2m ago.
    expect(lastActivityAt(records)).toBe(iso(120))
  })

  it('finds the last assistant turn', () => {
    expect(messageText(lastAssistant(records)!)).toBe('the question?')
  })
})

describe('deriveState', () => {
  it('reports dead when no live process holds the tree', () => {
    expect(deriveState(false, iso(5), NOW)).toBe('dead')
  })
  it('walks live → idle → stale by age', () => {
    expect(deriveState(true, iso(60), NOW)).toBe('live')
    // 9 minutes must still read live: transcripts record nothing while a long
    // tool call runs, and a 5-minute threshold reported "0 live" on a machine
    // whose operator was watching it work.
    expect(deriveState(true, iso(9 * 60), NOW)).toBe('live')
    expect(deriveState(true, iso(30 * 60), NOW)).toBe('idle')
    expect(deriveState(true, iso(5 * 3600), NOW)).toBe('stale')
  })
})

describe('deriveWaiting', () => {
  it('is true for a live session that ended its turn', () => {
    expect(deriveWaiting(assistant('done, which one?'), true)).toBe(true)
  })

  it('is false mid-tool-use — working, not blocked', () => {
    expect(deriveWaiting(assistant('running tests', 'tool_use'), true)).toBe(false)
  })

  it('is false for an INTERRUPTED turn (null stop_reason)', () => {
    // The 18-of-114 case. `!== 'tool_use'` would wrongly call this waiting.
    expect(deriveWaiting(assistant('half a sent', null), true)).toBe(false)
  })

  it('is false for stop_sequence — observed live, deliberately not treated as waiting', () => {
    // The measured set (end_turn/null/tool_use) was incomplete; a real dry run
    // produced stop_sequence too. Excluded on purpose: under-reporting is
    // recoverable, a board that nags gets ignored.
    expect(deriveWaiting(assistant('...', 'stop_sequence'), true)).toBe(false)
  })

  it('is false when the process is gone — stopped, not waiting', () => {
    expect(deriveWaiting(assistant('anything?'), false)).toBe(false)
  })

  it('is false when the last substantive record is the user', () => {
    expect(deriveWaiting({ type: 'user', message: { content: 'hi' } }, true)).toBe(false)
  })
})

describe('deriveAttention', () => {
  it('flags a recent waiting session as needing you', () => {
    expect(deriveAttention('live', true)).toBe('needs-you')
    expect(deriveAttention('idle', true)).toBe('needs-you')
  })

  it('demotes a STALE waiting session to abandoned, not needs-you', () => {
    // The measured failure: 8 of 9 "waiting" rows had last moved 5–32 HOURS
    // earlier. Counting those as needing you made the headline 89% noise.
    expect(deriveAttention('stale', true)).toBe('abandoned')
  })

  it('never asks for attention for a dead session', () => {
    expect(deriveAttention('dead', true)).toBe('none')
  })

  it('is none when the session is not waiting at all', () => {
    expect(deriveAttention('live', false)).toBe('none')
    expect(deriveAttention('stale', false)).toBe('none')
  })
})

describe('endsWithQuestion', () => {
  it('detects a trailing question', () => {
    expect(endsWithQuestion('Two options. A or B?')).toBe(true)
  })
  it('is false for a completion summary', () => {
    expect(endsWithQuestion('Merged and pushed. All four PRs are on main.')).toBe(false)
  })
})

describe('isTreeAllowed', () => {
  it('is false when the allowlist is empty — the fail-closed default', () => {
    expect(isTreeAllowed('/Users/x/code/proj', [])).toBe(false)
  })
  it('matches an exact tree and its subpaths, not a sibling prefix', () => {
    expect(isTreeAllowed('/Users/x/proj', ['/Users/x/proj'])).toBe(true)
    expect(isTreeAllowed('/Users/x/proj/apps/web', ['/Users/x/proj'])).toBe(true)
    expect(isTreeAllowed('/Users/x/proj-other', ['/Users/x/proj'])).toBe(false)
  })
})

describe('buildStatusRow', () => {
  const base = {
    machine: 'test-mac',
    sessionIdFallback: 'fallback',
    pid: 4242,
    now: NOW,
  }

  it('never copies question text for a tree that is not allowlisted', () => {
    const row = buildStatusRow({
      ...base,
      records: [assistant('secret-ish question with postgres://u:p@h/db')],
      alive: true,
      allowlist: [],
    })!
    expect(row.question_allowed).toBe(false)
    expect(row.blocked_question).toBeNull()
    // Liveness still reports — that half is never gated.
    expect(row.state).toBe('live')
    expect(row.waiting).toBe(true)
    expect(row.branch).toBe('main')
    expect(row.product).toBe('proj')
  })

  it('copies redacted, truncated text for an allowlisted tree', () => {
    const long = 'q '.repeat(400) + 'postgres://u:secretpw@host/db ?'
    const row = buildStatusRow({
      ...base,
      records: [assistant(long)],
      alive: true,
      allowlist: ['/Users/x/code/proj'],
    })!
    expect(row.question_allowed).toBe(true)
    expect(row.blocked_question!.length).toBeLessThanOrEqual(QUESTION_MAX_CHARS + 1)
    expect(row.blocked_question).not.toContain('secretpw')
  })

  it('flags redaction when a secret was scrubbed', () => {
    const row = buildStatusRow({
      ...base,
      records: [assistant('use postgres://u:pw@h/db to check?')],
      alive: true,
      allowlist: ['/Users/x/code/proj'],
    })!
    expect(row.question_redacted).toBe(true)
    expect(row.blocked_question).not.toContain('pw@h')
  })

  it('withholds question text when the session is not waiting', () => {
    const row = buildStatusRow({
      ...base,
      records: [assistant('mid-flight output', 'tool_use')],
      alive: true,
      allowlist: ['/Users/x/code/proj'],
    })!
    expect(row.waiting).toBe(false)
    expect(row.blocked_question).toBeNull()
  })

  it('returns null without a working tree — nothing to key on', () => {
    expect(
      buildStatusRow({
        ...base,
        records: [{ type: 'assistant', timestamp: iso(1), message: { stop_reason: 'end_turn' } }],
        alive: true,
        allowlist: [],
      }),
    ).toBeNull()
  })
})

describe('deriveTurnCheck: what stands behind "done"', () => {
  let n = 0
  const prompt = (text = 'fix the bug'): TranscriptRecord => ({ type: 'user', message: { role: 'user', content: text } })
  const use = (name: string, command?: string): TranscriptRecord & { id: string } => {
    const id = `tool-${++n}`
    return { id, type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: command ? { command } : {} }] } }
  }
  const result = (of: { id: string }, isError = false): TranscriptRecord => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: of.id, is_error: isError, content: 'output' }] },
  })
  const done = assistant('Done. The bug is fixed.')

  it('checked: a check ran after the last edit', () => {
    const test = use('Bash', 'npm test')
    expect(deriveTurnCheck([prompt(), use('Edit'), test, result(test), done])).toBe('checked')
  })
  it('unchecked: an edit after the last check is not covered by it', () => {
    const test = use('Bash', 'npm test')
    expect(deriveTurnCheck([prompt(), use('Edit'), test, result(test), use('Write'), done])).toBe('unchecked')
    expect(deriveTurnCheck([prompt(), use('Edit'), use('Bash', 'git status'), done])).toBe('unchecked')
  })
  it('failed: the last check after the last edit reported an error', () => {
    const first = use('Bash', 'npx tsc --noEmit')
    const second = use('Bash', 'npm run lint')
    expect(deriveTurnCheck([prompt(), use('Edit'), first, result(first), second, result(second, true), done])).toBe('failed')
    // A failure that a later check follows is not the last word.
    expect(deriveTurnCheck([prompt(), use('Edit'), second, result(second, true), first, result(first), done])).toBe('checked')
  })
  it('no-edits: a turn that changed no file has nothing to check', () => {
    expect(deriveTurnCheck([prompt('what does this do?'), use('Read'), done])).toBe('no-edits')
  })
  it('only the current turn counts: a check in the turn before does not', () => {
    const test = use('Bash', 'npm test')
    expect(deriveTurnCheck([prompt(), use('Edit'), test, result(test), done, prompt('now rename it'), use('Edit'), done])).toBe('unchecked')
  })
  it('a tool result is not the start of a turn', () => {
    const test = use('Bash', 'npm test')
    expect(deriveTurnCheck([prompt(), use('Edit'), use('Bash', 'ls'), result(test), test, result(test), done])).toBe('checked')
  })
  it('unknown: no edit in the tail and the start of the turn is not in it', () => {
    expect(deriveTurnCheck([use('Read'), done])).toBe('unknown')
    // An edit in the tail is enough to answer, wherever the turn began.
    expect(deriveTurnCheck([use('Edit'), done])).toBe('unchecked')
  })
  it('ignores what a subagent did', () => {
    const side = { ...use('Bash', 'npm test'), isSidechain: true }
    expect(deriveTurnCheck([prompt(), use('Edit'), side, done])).toBe('unchecked')
  })

  const row = (records: TranscriptRecord[]) =>
    buildStatusRow({ machine: 'm', records, sessionIdFallback: 's', alive: true, pid: 1, allowlist: [], now: NOW })
  it('is set only when the session has ended its turn', () => {
    expect(row([prompt(), use('Edit'), done])?.turn_check).toBe('unchecked')
    expect(row([prompt(), use('Edit'), assistant('working', 'tool_use')])?.turn_check).toBeNull()
    expect(row([prompt(), use('Edit'), assistant('cut off', null)])?.turn_check).toBeNull()
  })
  it('sends one word and none of the command', () => {
    const test = use('Bash', 'npm test -- --secret-flag')
    const built = row([prompt(), use('Edit'), test, result(test), done])
    expect(built?.turn_check).toBe('checked')
    expect(JSON.stringify(built)).not.toContain('secret-flag')
  })
})
