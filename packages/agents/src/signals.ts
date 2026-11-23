/**
 * JQ Agents signals: counts read out of Claude Code's own session transcripts.
 *
 * The usual map of "AI observability" names eight areas: traces, token usage, latency, quality
 * drift, errors, cost, user feedback and safety signals. Most of what such a map lists needs an
 * instrumented application. A transcript is not that, but it does record a good part of it, and
 * this file counts only that part. What a transcript does not hold is listed in `NOT_MEASURED`
 * and shown on the page, so a missing number never reads as a zero.
 *
 * Counts only. No prompt, reply, command or file content is kept: the one piece of text read is
 * the start of a person's message, to tell an interruption from a prompt, and it is not stored.
 *
 * ⚠️ The transcript format is a Claude Code internal and can change in any release. Every field
 * is read defensively; a field that goes away makes its count fall to nothing, which the page
 * says as "none recorded", never as "none happened".
 *
 * Pure: the caller supplies records and the clock. signals-read.ts does the file work.
 */

export interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Part of `output`, not added to it. */
  thinking: number
}

/** One local day in one working folder. */
export interface Bucket {
  requests: number
  /** Requests made by a subagent. Part of `requests`. */
  subagentRequests: number
  /** Messages a person sent. */
  prompts: number
  tokens: Tokens
  tools: Record<string, { calls: number; failed: number }>
  toolMs: Record<string, number[]>
  turnMs: number[]
  thinkMs: number[]
  models: Record<string, { requests: number; output: number }>
  versions: Record<string, number>
  apiErrors: Record<string, number>
  retries: number
  timeouts: number
  fallbacks: number
  compactions: number
  costUsd: number
  interruptions: number
  denials: Record<string, number>
  refusals: number
  hookBlocks: number
  sandboxOff: number
}

export const emptyBucket = (): Bucket => ({
  requests: 0,
  subagentRequests: 0,
  prompts: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
  tools: {},
  toolMs: {},
  turnMs: [],
  thinkMs: [],
  models: {},
  versions: {},
  apiErrors: {},
  retries: 0,
  timeouts: 0,
  fallbacks: 0,
  compactions: 0,
  costUsd: 0,
  interruptions: 0,
  denials: {},
  refusals: 0,
  hookBlocks: 0,
  sandboxOff: 0,
})

/** What one transcript file has added so far. Kept between reads so a file is read once. */
export interface FileState {
  /** `${day}\n${cwd}` to its bucket. */
  buckets: Map<string, Bucket>
  /** Tool call id to its name and when it was asked for, until its result arrives. */
  toolNames: Map<string, { name: string; at: number }>
  lastTs: number
  lastCwd: string
  /** When the person's open prompt was sent, until the turn ends. */
  promptAt: number | null
  /** The running total Claude Code last wrote for this session. */
  lastCost: number
  /** Tokens the newest request carried in, which is how full the context was. */
  context: number
  contextAt: number
}

export const emptyFileState = (): FileState => ({ buckets: new Map(), toolNames: new Map(), lastTs: 0, lastCwd: '', promptAt: null, lastCost: 0, context: 0, contextAt: 0 })

/** Samples kept per bucket for a median. Past this the newest replace the oldest. */
const MAX_SAMPLES = 2000
const push = (list: number[], v: number) => {
  if (!(v >= 0) || !Number.isFinite(v)) return
  if (list.length >= MAX_SAMPLES) list.shift()
  list.push(v)
}
const bump = (rec: Record<string, number>, key: string, by = 1) => {
  rec[key] = (rec[key] || 0) + by
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** The local calendar day of a time, as YYYY-MM-DD. */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const INTERRUPTED = '[Request interrupted by user'

function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') return b.text
  return ''
}

/**
 * Whether a user record is a person's own message. Claude Code marks it (`origin.kind`). A
 * record with no mark counts only when it is plain text: tool results, command output, notices
 * and injected context all start with `<` or `[`.
 */
function isPrompt(o: any, text: string): boolean {
  if (o.isMeta || o.isSidechain || o.isCompactSummary || o.toolUseResult !== undefined) return false
  const kind = o.origin && typeof o.origin === 'object' ? o.origin.kind : undefined
  if (kind !== undefined) return kind === 'human'
  return text !== '' && text[0] !== '<' && text[0] !== '['
}

/**
 * Add one transcript record. `seen` holds the id of every model reply counted so far, across
 * all files: a reply is written as several records with the same usage, and a resumed or
 * forked session copies its history into a new file. Without it tokens count several times.
 */
export function addRecord(state: FileState, o: any, seen: Set<string>): void {
  if (!o || typeof o !== 'object') return
  const parsed = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  if (Number.isFinite(parsed)) state.lastTs = parsed
  if (typeof o.cwd === 'string' && o.cwd) state.lastCwd = o.cwd
  const ts = state.lastTs
  if (!ts) return
  const key = `${dayOf(ts)}\n${state.lastCwd}`
  let b = state.buckets.get(key)
  const bucket = () => {
    if (!b) state.buckets.set(key, (b = emptyBucket()))
    return b
  }

  if (o.type === 'cost-state') {
    // A running total, written now and then. A total below the last one is a session that
    // started over, so its whole amount is new.
    const total = num(o.totalCostUSD)
    bucket().costUsd += total >= state.lastCost ? total - state.lastCost : total
    state.lastCost = total
    return
  }

  if (o.type === 'system') {
    if (o.subtype === 'api_error') bucket().retries++
    else if (o.subtype === 'compact_boundary') bucket().compactions++
    else if (o.subtype === 'stop_hook_summary' && o.preventedContinuation === true) bucket().hookBlocks++
    return
  }

  const m = o.message && typeof o.message === 'object' ? o.message : {}

  if (o.type === 'assistant') {
    if (o.isApiErrorMessage) {
      bump(bucket().apiErrors, typeof o.error === 'string' && o.error ? o.error : 'unknown')
      state.promptAt = null // the turn did not end with an answer
      return
    }
    const content = Array.isArray(m.content) ? m.content : []
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || typeof block.id !== 'string' || state.toolNames.has(block.id)) continue
      const name = typeof block.name === 'string' && block.name ? block.name : 'unknown'
      state.toolNames.set(block.id, { name, at: ts })
      const t = (bucket().tools[name] ??= { calls: 0, failed: 0 })
      t.calls++
    }
    if (typeof o.thinkingDurationMs === 'number') push(bucket().thinkMs, o.thinkingDurationMs)
    const id = typeof m.id === 'string' ? m.id : ''
    if (id && !seen.has(id) && m.model !== '<synthetic>') {
      seen.add(id)
      const B = bucket()
      B.requests++
      if (o.isSidechain) B.subagentRequests++
      const u = m.usage && typeof m.usage === 'object' ? m.usage : {}
      B.tokens.input += num(u.input_tokens)
      B.tokens.output += num(u.output_tokens)
      B.tokens.cacheRead += num(u.cache_read_input_tokens)
      B.tokens.cacheWrite += num(u.cache_creation_input_tokens)
      B.tokens.thinking += num(u.output_tokens_details?.thinking_tokens)
      const model = typeof m.model === 'string' && m.model ? m.model : 'unknown'
      const mm = (B.models[model] ??= { requests: 0, output: 0 })
      mm.requests++
      mm.output += num(u.output_tokens)
      if (typeof o.version === 'string') bump(B.versions, o.version)
      if (typeof o.requestedModel === 'string' && o.requestedModel && o.requestedModel !== model) B.fallbacks++
      if (!o.isSidechain) {
        state.context = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
        state.contextAt = ts
      }
    }
    if (m.stop_reason === 'refusal') bucket().refusals++
    if (m.stop_reason === 'end_turn' && !o.isSidechain && state.promptAt !== null) {
      push(bucket().turnMs, ts - state.promptAt)
      state.promptAt = null
    }
    return
  }

  if (o.type === 'user') {
    const text = firstText(m.content)
    if (text.startsWith(INTERRUPTED)) {
      bucket().interruptions++
      state.promptAt = null
      return
    }
    if (typeof o.toolDenialKind === 'string' && o.toolDenialKind) {
      bump(bucket().denials, o.toolDenialKind)
      // A denied call never ran: it is not a failure of the tool, and it has no time.
      if (Array.isArray(m.content)) for (const block of m.content) if (block && typeof block.tool_use_id === 'string') state.toolNames.delete(block.tool_use_id)
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const call = state.toolNames.get(block.tool_use_id)
        if (!call) continue
        state.toolNames.delete(block.tool_use_id)
        const B = bucket()
        if (block.is_error === true) (B.tools[call.name] ??= { calls: 0, failed: 0 }).failed++
        // Few tools record their own time, so it is the gap between the two records: from the
        // model asking to the result landing, which includes any wait for permission.
        push((B.toolMs[call.name] ??= []), ts - call.at)
      }
    }
    const r = o.toolUseResult
    if (r && typeof r === 'object') {
      if (num(r.timedOutAfterMs)) bucket().timeouts++
      if (r.dangerouslyDisableSandbox === true) bucket().sandboxOff++
    }
    if (isPrompt(o, text)) {
      bucket().prompts++
      if (!o.isSidechain) state.promptAt = ts
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

export interface Spread {
  n: number
  medianMs: number
  p95Ms: number
}

export function spread(samples: number[]): Spread | null {
  if (!samples.length) return null
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
  return { n: s.length, medianMs: at(0.5), p95Ms: at(0.95) }
}

export interface Signals {
  days: number
  /** Oldest first, one per day in the window, days with nothing included. */
  byDay: { day: string; requests: number; tokens: Tokens; errors: number; costUsd: number; models: Record<string, number> }[]
  requests: number
  subagentRequests: number
  prompts: number
  tokens: Tokens
  /** Share of input that was read from the cache, 0 to 1, or null with no input. */
  cacheShare: number | null
  tools: { name: string; calls: number; failed: number; time: Spread | null }[]
  toolCalls: number
  toolFailures: number
  turn: Spread | null
  thinking: Spread | null
  models: { name: string; requests: number; output: number }[]
  versions: { name: string; requests: number }[]
  apiErrors: { kind: string; count: number }[]
  retries: number
  timeouts: number
  fallbacks: number
  compactions: number
  costUsd: number
  folders: { name: string; requests: number; tokens: number; costUsd: number }[]
  interruptions: number
  denials: { kind: string; count: number }[]
  refusals: number
  hookBlocks: number
  sandboxOff: number
  /** Sessions with a request in the last day, fullest first. Tokens the newest request carried in. */
  contexts: { name: string; tokens: number; at: string }[]
}

const sumRec = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) bump(into, k, v)
}
const ranked = (rec: Record<string, number>) =>
  Object.entries(rec)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))

/**
 * Add the files up over the last `days` local days, today included. `nameOf` turns a working
 * folder into what the page calls it (a repository's folder name).
 */
export function summarize(states: FileState[], now: number, days: number, nameOf: (cwd: string) => string = (c) => c): Signals {
  const wanted: string[] = []
  const start = new Date(now)
  start.setHours(12, 0, 0, 0) // noon, so a clock change cannot skip or repeat a day
  for (let i = days - 1; i >= 0; i--) wanted.push(dayOf(start.getTime() - i * 86_400_000))
  const inWindow = new Set(wanted)
  const day = new Map(wanted.map((d) => [d, { day: d, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, errors: 0, costUsd: 0, models: {} as Record<string, number> }]))
  const total = emptyBucket()
  const toolMs: Record<string, number[]> = {}
  const versions: Record<string, number> = {}
  const folders = new Map<string, { name: string; requests: number; tokens: number; costUsd: number }>()

  for (const state of states) {
    for (const [key, b] of state.buckets) {
      const cut = key.indexOf('\n')
      const d = day.get(key.slice(0, cut))
      if (!d || !inWindow.has(d.day)) continue
      const errors = Object.values(b.apiErrors).reduce((a, n) => a + n, 0)
      const moved = b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheWrite
      d.requests += b.requests
      d.errors += errors
      d.costUsd += b.costUsd
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking'] as const) {
        d.tokens[k] += b.tokens[k]
        total.tokens[k] += b.tokens[k]
      }
      for (const [name, m] of Object.entries(b.models)) {
        bump(d.models, name, m.requests)
        const t = (total.models[name] ??= { requests: 0, output: 0 })
        t.requests += m.requests
        t.output += m.output
      }
      total.requests += b.requests
      total.subagentRequests += b.subagentRequests
      total.prompts += b.prompts
      for (const [name, t] of Object.entries(b.tools)) {
        const into = (total.tools[name] ??= { calls: 0, failed: 0 })
        into.calls += t.calls
        into.failed += t.failed
      }
      for (const [name, list] of Object.entries(b.toolMs)) (toolMs[name] ??= []).push(...list)
      total.turnMs.push(...b.turnMs)
      total.thinkMs.push(...b.thinkMs)
      sumRec(versions, b.versions)
      sumRec(total.apiErrors, b.apiErrors)
      sumRec(total.denials, b.denials)
      for (const k of ['retries', 'timeouts', 'fallbacks', 'compactions', 'costUsd', 'interruptions', 'refusals', 'hookBlocks', 'sandboxOff'] as const) total[k] += b[k]
      const name = nameOf(key.slice(cut + 1)) || 'unknown folder'
      const f = folders.get(name) ?? { name, requests: 0, tokens: 0, costUsd: 0 }
      f.requests += b.requests
      f.tokens += moved
      f.costUsd += b.costUsd
      folders.set(name, f)
    }
  }

  const tools = Object.entries(total.tools)
    .map(([name, t]) => ({ name, calls: t.calls, failed: t.failed, time: spread(toolMs[name] ?? []) }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
  const input = total.tokens.input + total.tokens.cacheRead + total.tokens.cacheWrite
  return {
    days,
    byDay: [...day.values()],
    requests: total.requests,
    subagentRequests: total.subagentRequests,
    prompts: total.prompts,
    tokens: total.tokens,
    cacheShare: input ? total.tokens.cacheRead / input : null,
    tools,
    toolCalls: tools.reduce((a, t) => a + t.calls, 0),
    toolFailures: tools.reduce((a, t) => a + t.failed, 0),
    turn: spread(total.turnMs),
    thinking: spread(total.thinkMs),
    models: Object.entries(total.models)
      .map(([name, m]) => ({ name, ...m }))
      .sort((a, b) => b.requests - a.requests),
    versions: Object.entries(versions)
      .map(([name, requests]) => ({ name, requests }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    apiErrors: ranked(total.apiErrors),
    retries: total.retries,
    timeouts: total.timeouts,
    fallbacks: total.fallbacks,
    compactions: total.compactions,
    costUsd: total.costUsd,
    folders: [...folders.values()].filter((f) => f.requests || f.costUsd).sort((a, b) => b.tokens - a.tokens),
    interruptions: total.interruptions,
    denials: ranked(total.denials),
    refusals: total.refusals,
    hookBlocks: total.hookBlocks,
    sandboxOff: total.sandboxOff,
    contexts: states
      .filter((s) => s.context > 0 && now - s.contextAt < 86_400_000)
      .map((s) => ({ name: nameOf(s.lastCwd) || 'unknown folder', tokens: s.context, at: new Date(s.contextAt).toISOString() }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8),
  }
}

/**
 * What the usual eight-area map lists that a transcript cannot answer. Shown under each area,
 * so the page is plain about its own edges.
 */
export const NOT_MEASURED: Record<string, string[]> = {
  traces: ['nested spans', 'retrieval steps'],
  tokens: ['how full the context is as a share of the model limit (the limit is not in the transcript)'],
  latency: ['time to first token', 'tokens per second', 'retrieval latency'],
  drift: ['eval score trends', 'groundedness', 'embedding drift', 'input topic shift', 'prompt version diffs'],
  errors: ['schema or parse errors'],
  cost: ['cost per request', 'budget alerts'],
  feedback: ['thumbs up or down', 'written comments', 'edit rate', 'regenerations', 'session abandonment over time'],
  safety: ['jailbreak attempts', 'PII detections', 'toxicity flags', 'policy violations'],
  runs: ['whether a message was worth sending', 'how long a run waited for its answer'],
}
