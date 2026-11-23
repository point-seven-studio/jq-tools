/**
 * The worker's hands: the files it reads and writes, and the runs it starts.
 *
 *   <mailbox>/timers/                 timers waiting to be delivered
 *   <mailbox>/timers/done/            timers that fired once, or were cancelled
 *   <mailbox>/worker/<name>/
 *     ask.txt                         which commands wait for a person (worker.ts)
 *     state.json                      thread → session, and runs that are waiting
 *     answers/<call id>               allow or deny, written when a person has answered
 *     runs.jsonl                      one line per run, with how it ended
 *     lock/                           held while a worker for this name is running
 *
 * Nothing here calls out. The one process it starts is the agent tool, on this machine.
 */
import { spawn, spawnSync } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { writeMessage } from './message.js'
import { checkSignature, parseSigners } from './sign.js'
import { deliveryName, nextDue, parseSpan, parseTimer, renderTimer, slug, stamp, type Timer } from './timers.js'
import {
  DEFAULT_ASK,
  approvalRequest,
  buildPrompt,
  classify,
  dropReason,
  groupByThread,
  parseAnswer,
  parseAskRules,
  parseResult,
  parseRuns,
  runsToday,
  type PendingEvent,
  type RunRecord,
  type RunResult,
  answerDigest,
  requestDigest,
} from './worker.js'

const NAME = /^[a-z0-9][a-z0-9-]*$/

function header(raw: string, key: string): string {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return ''
  for (const line of fm[1].split('\n')) if (line.startsWith(`${key}: `)) return line.slice(key.length + 2).trim()
  return ''
}

function body(raw: string): string {
  const fm = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
  return fm ? fm[1] : raw
}

export function readSigners(root: string): Map<string, string> {
  const file = path.join(root, 'registry', 'signers.txt')
  return existsSync(file) ? parseSigners(readFileSync(file, 'utf8')) : new Map()
}

// ── timers ────────────────────────────────────────────────────────────

const timersDir = (root: string) => path.join(root, 'timers')

export function listTimers(root: string): Timer[] {
  const dir = timersDir(root)
  if (!existsSync(dir)) return []
  const out: Timer[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const t = parseTimer(f, readFileSync(path.join(dir, f), 'utf8'))
    if (t) out.push(t)
  }
  return out
}

export function addTimer(root: string, t: Omit<Timer, 'filename'>, now = Date.now()): string {
  for (const n of [t.from, t.to]) {
    if (!NAME.test(n) || !existsSync(path.join(root, 'inbox', n))) throw new Error(`unknown name: ${n} (no inbox/${n}/)`)
  }
  if (t.to === 'board' || t.from === 'board') throw new Error('a timer cannot be for the board')
  if (readSigners(root).has(t.from)) throw new Error(`${t.from} signs its mail (registry/signers.txt); a timer cannot send for it`)
  const dir = timersDir(root)
  mkdirSync(path.join(dir, 'done'), { recursive: true })
  const base = `${stamp(now)}-${t.to}-${slug(t.subject) || 'timer'}`
  let name = base
  for (let n = 2; existsSync(path.join(dir, `${name}.md`)) || existsSync(path.join(dir, 'done', `${name}.md`)); n++) name = `${base}-${n}`
  const file = path.join(dir, `${name}.md`)
  writeFileSync(file, renderTimer(t), { flag: 'wx' })
  return file
}

/** Move a timer out of the way. Its file is kept in timers/done/. */
export function cancelTimer(root: string, file: string): string {
  const dir = timersDir(root)
  const name = path.basename(file)
  const from = path.join(dir, name)
  if (!existsSync(from)) throw new Error(`no such timer: ${name} (crosstalk timers lists them)`)
  mkdirSync(path.join(dir, 'done'), { recursive: true })
  const to = path.join(dir, 'done', name)
  renameSync(from, to)
  return to
}

/**
 * Deliver every timer whose time has come. For each: write the message, then mark the
 * timer. If this stops between the two, the next pass finds the message already written
 * (its name comes from the timer and its due time) and only marks the timer.
 */
export function deliverDue(root: string, now = Date.now()): { delivered: string[]; skipped: string[] } {
  const delivered: string[] = []
  const skipped: string[] = []
  for (const t of listTimers(root)) {
    const due = Date.parse(t.due)
    if (due > now) continue
    if (!existsSync(path.join(root, 'inbox', t.to))) {
      skipped.push(`${t.filename}: no inbox/${t.to}/`)
      continue
    }
    const file = writeMessage(root, {
      from: t.from,
      to: t.to,
      subject: t.subject,
      kind: t.kind || 'brief',
      body: t.body,
      thread: t.thread || undefined,
      reply_to: t.reply_to || undefined,
      extra: { timer: t.filename },
      name: deliveryName(t, due),
      now,
    })
    if (file) delivered.push(file)
    const every = t.every ? parseSpan(t.every) : null
    if (every) {
      const { filename: _f, ...rest } = t
      writeFileSync(path.join(timersDir(root), t.filename), renderTimer({ ...rest, due: new Date(nextDue(due, every, now)).toISOString() }))
    } else {
      cancelTimer(root, t.filename)
    }
  }
  return { delivered, skipped }
}

// ── the worker's folder ───────────────────────────────────────────────

export interface Waiting {
  session_id: string
  tool_use_id: string
  tool: string
  /** File name of the approval request, in the approver's inbox. */
  request: string
  approver: string
  asked_at: string
  /** The mail the waiting run was started for. Acknowledged when the run finishes. */
  events: string[]
}

export interface WorkerState {
  /** Thread → the agent session that handles it, so later mail continues the same session. */
  sessions: Record<string, string>
  /** Thread → the approval a run of it is waiting for. */
  waiting: Record<string, Waiting>
  /** Message file → how many runs for it failed. */
  attempts: Record<string, number>
  /** Message files the worker has already recorded as dropped. */
  dropped: string[]
}

export const workerDir = (root: string, name: string) => path.join(root, 'worker', name)

export function readState(dir: string): WorkerState {
  const empty: WorkerState = { sessions: {}, waiting: {}, attempts: {}, dropped: [] }
  const file = path.join(dir, 'state.json')
  if (!existsSync(file)) return empty
  try {
    return { ...empty, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    throw new Error(`${file} cannot be read as JSON. Fix or remove it; removing it forgets which thread belongs to which session.`)
  }
}

export function writeState(dir: string, state: WorkerState): void {
  const file = path.join(dir, 'state.json')
  writeFileSync(`${file}.partial`, JSON.stringify(state, null, 2))
  renameSync(`${file}.partial`, file)
}

/** The names a worker has run for in this mailbox. */
export function listWorkers(root: string): string[] {
  const top = path.join(root, 'worker')
  if (!existsSync(top)) return []
  return readdirSync(top).filter((n) => NAME.test(n) && (existsSync(path.join(top, n, 'runs.jsonl')) || existsSync(path.join(top, n, 'state.json')))).sort()
}

export function readRuns(dir: string): RunRecord[] {
  const file = path.join(dir, 'runs.jsonl')
  return existsSync(file) ? parseRuns(readFileSync(file, 'utf8')) : []
}

function record(dir: string, r: RunRecord): void {
  appendFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify(r)}\n`)
}

/** Take the lock, or say who holds it. A lock whose process is gone is taken over. */
export function takeLock(dir: string): () => void {
  const lock = path.join(dir, 'lock')
  const pidFile = path.join(lock, 'pid')
  try {
    mkdirSync(lock)
  } catch {
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : NaN
    let alive = false
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (alive) throw new Error(`a worker for this name is already running (process ${pid}). One inbox has one worker.`)
  }
  mkdirSync(lock, { recursive: true })
  writeFileSync(pidFile, String(process.pid))
  let released = false
  return () => {
    if (released) return
    released = true
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Unread mail for a name, with what the signature check found. */
export function pendingEvents(root: string, name: string): PendingEvent[] {
  const dir = path.join(root, 'inbox', name)
  const signers = readSigners(root)
  const out: PendingEvent[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const file = path.join(dir, f)
    const raw = readFileSync(file, 'utf8')
    out.push({
      filename: f,
      path: file,
      from: header(raw, 'from') || 'unknown',
      subject: header(raw, 'subject'),
      kind: header(raw, 'kind'),
      thread: header(raw, 'thread'),
      reply_to: header(raw, 'reply_to'),
      signature: checkSignature(f, raw, signers).state,
      replayed: existsSync(path.join(root, 'archive', name, f)),
    })
  }
  return out
}

/** Every message file in the mailbox that says it is from this name. */
function sentBy(root: string, name: string): Set<string> {
  const out = new Set<string>()
  for (const base of ['inbox', 'archive']) {
    const top = path.join(root, base)
    if (!existsSync(top)) continue
    for (const who of readdirSync(top)) {
      const dir = path.join(top, who)
      let files: string[]
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        try {
          if (header(readFileSync(path.join(dir, f), 'utf8'), 'from') === name) out.add(`${who}/${f}`)
        } catch {
          /* moved while reading */
        }
      }
    }
  }
  return out
}

// ── starting a run ────────────────────────────────────────────────────

export interface WorkerOptions {
  root: string
  name: string
  /** The folder the agent runs in: the repository this session works on. */
  cwd: string
  /** The crosstalk command, so mail the worker acknowledges runs the mailbox's hook. */
  tool: string
  /** The built hook (dist/hook.mjs). */
  hook: string
  claude: string
  model: string | null
  /** Who answers approval requests; null when nobody does. */
  approver: string | null
  budgetUsd: number
  runsPerDay: number
  timeoutMs: number
  dryRun: boolean
  log: (line: string) => void
}

/** The mailbox commands a run may use without being asked. `approve`, `deny` and `worker` are not among them. */
export const MAIL_COMMANDS = ['read', 'inbox', 'reply', 'send', 'later', 'timers', 'board', 'verify']

function startRun(o: WorkerOptions, dir: string, prompt: string | null, sessionId: string | null): Promise<{ result: RunResult; duration: number }> {
  const settings = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${o.hook}"` }] }] },
  })
  const args = ['-p']
  if (prompt !== null) args.push(prompt)
  args.push('--output-format', 'json', '--max-budget-usd', String(o.budgetUsd), '--settings', settings)
  // The mailbox commands a run needs to read its mail and answer. Everything else is up
  // to the agent tool's own permission settings for the folder it runs in.
  args.push('--allowedTools', ...MAIL_COMMANDS.map((c) => `Bash(crosstalk ${c}:*)`))
  if (sessionId) args.push('--resume', sessionId)
  if (o.model) args.push('--model', o.model)
  const began = Date.now()
  return new Promise((resolve) => {
    const child = spawn(o.claude, args, {
      cwd: o.cwd,
      env: {
        ...process.env,
        PATH: `${path.dirname(o.tool)}${path.delimiter}${process.env.PATH ?? ''}`,
        CROSSTALK_DIR: o.root,
        CROSSTALK_SELF: o.name,
        CROSSTALK_WORKER_DIR: dir,
        CROSSTALK_WORKER_ASK: o.approver ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let timedOut = false
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, o.timeoutMs)
    const done = (result: RunResult) => {
      clearTimeout(timer)
      resolve({ result, duration: Date.now() - began })
    }
    child.on('error', (e) => done({ ok: false, session_id: '', cost_usd: null, deferred: null, reason: `could not start ${o.claude}: ${e.message}` }))
    child.on('close', (code) => {
      if (timedOut) return done({ ok: false, session_id: '', cost_usd: null, deferred: null, reason: `stopped after ${Math.round(o.timeoutMs / 60_000)} minutes` })
      const r = parseResult(out, code)
      if (!r.ok && !r.session_id && err.trim()) r.reason = `${r.reason}: ${err.trim().split('\n').pop()}`.slice(0, 300)
      done(r)
    })
  })
}

function ack(o: WorkerOptions, file: string): void {
  if (!existsSync(file)) return
  const r = spawnSync('bash', [o.tool, 'ack', file], { env: { ...process.env, CROSSTALK_DIR: o.root }, encoding: 'utf8' })
  if (r.status !== 0) o.log(`could not acknowledge ${path.basename(file)}: ${(r.stderr || '').trim()}`)
}

/** After a run: record it, and either acknowledge its mail, ask a person, or count a failure. */
function settle(o: WorkerOptions, dir: string, state: WorkerState, thread: string, events: string[], resumed: boolean, before: Set<string>, run: { result: RunResult; duration: number }): void {
  const { result, duration } = run
  const sent = [...sentBy(o.root, o.name)].filter((k) => !before.has(k)).length
  const ended = classify(result, sent)
  const base: RunRecord = { at: new Date().toISOString(), thread, events, ended, session_id: result.session_id || undefined, resumed, sent, cost_usd: result.cost_usd ?? undefined, duration_ms: duration }
  if (result.session_id) state.sessions[thread] = result.session_id
  const inbox = path.join(o.root, 'inbox', o.name)
  if (ended === 'failed') {
    for (const f of events) state.attempts[f] = (state.attempts[f] ?? 0) + 1
    delete state.waiting[thread]
    record(dir, { ...base, reason: result.reason })
    o.log(`thread ${thread}: the run failed (${result.reason}). Its mail stays unread.`)
  } else if (ended === 'asked' && result.deferred && o.approver) {
    const ask = approvalRequest(o.name, result.deferred)
    const file = writeMessage(o.root, { from: o.name, to: o.approver, subject: ask.subject, kind: 'question', body: ask.body, thread, extra: { approval: result.deferred.id } })
    state.waiting[thread] = { session_id: result.session_id, tool_use_id: result.deferred.id, tool: result.deferred.name, request: path.basename(file ?? ''), approver: o.approver, asked_at: base.at, events }
    record(dir, { ...base, reason: ask.subject })
    o.log(`thread ${thread}: waiting for ${o.approver} to answer "${ask.subject}"`)
  } else {
    delete state.waiting[thread]
    for (const f of events) {
      ack(o, path.join(inbox, f))
      delete state.attempts[f]
    }
    record(dir, base)
    o.log(`thread ${thread}: ${ended === 'message' ? `sent ${sent} ${sent === 1 ? 'message' : 'messages'}` : 'nothing to send'}${result.cost_usd !== null ? ` ($${result.cost_usd.toFixed(2)})` : ''}`)
  }
  writeState(dir, state)
}

/** Has the person answered? An answer file from `crosstalk approve`, or a reply to the request from the approver. */
/** The fingerprint of a waiting request as it is on disk, unread or acknowledged. Null when the file is gone. */
function requestOnDisk(root: string, w: Waiting): string | null {
  for (const where of ['inbox', 'archive']) {
    const file = path.join(root, where, w.approver, w.request)
    if (existsSync(file)) return requestDigest(body(readFileSync(file, 'utf8')))
  }
  return null
}

function findAnswer(o: WorkerOptions, dir: string, w: Waiting, events: PendingEvent[]): { answer: 'allow' | 'deny'; reply: PendingEvent | null } | null {
  const file = path.join(dir, 'answers', w.tool_use_id)
  if (existsSync(file)) {
    const a = readFileSync(file, 'utf8').trim()
    if (a === 'allow' || a === 'deny') return { answer: a, reply: null }
  }
  const signers = readSigners(o.root)
  for (const e of events) {
    if (e.reply_to !== w.request || e.from !== w.approver || e.replayed) continue
    // An approver with a key must have signed the answer. One without a key is taken at its word.
    if (signers.has(w.approver) ? e.signature !== 'verified' : e.signature !== 'not-required') continue
    const text = body(readFileSync(e.path, 'utf8'))
    // An answer that says which request text it read must have read this one.
    const claimed = answerDigest(text)
    if (claimed && claimed !== requestOnDisk(o.root, w)) continue
    const answer = parseAnswer(text)
    if (answer) return { answer, reply: e }
  }
  return null
}

/** Write an answer for a waiting call. Used by `crosstalk approve` and `crosstalk deny`. */
export function answerRequest(root: string, requestFile: string, answer: 'allow' | 'deny'): string {
  const raw = readFileSync(requestFile, 'utf8')
  const id = header(raw, 'approval')
  const name = header(raw, 'from')
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || !NAME.test(name)) throw new Error(`${path.basename(requestFile)} is not an approval request`)
  const dir = workerDir(root, name)
  const waiting = Object.values(readState(dir).waiting).find((w) => w.tool_use_id === id)
  if (!waiting) throw new Error('no run is waiting for this request. It was answered already, or the run ended.')
  mkdirSync(path.join(dir, 'answers'), { recursive: true })
  writeFileSync(path.join(dir, 'answers', id), answer)
  return name
}

/**
 * One pass: deliver due timers, resume runs that have been answered, then start a run
 * for each thread with new mail. Returns how many runs it started.
 */
export async function pass(o: WorkerOptions, now = Date.now()): Promise<number> {
  const dir = workerDir(o.root, o.name)
  mkdirSync(path.join(dir, 'answers'), { recursive: true })
  if (!existsSync(path.join(dir, 'ask.txt'))) writeFileSync(path.join(dir, 'ask.txt'), DEFAULT_ASK)
  parseAskRules(readFileSync(path.join(dir, 'ask.txt'), 'utf8')) // a rule that cannot be read stops the worker here, not inside a run

  const due = deliverDue(o.root, now)
  for (const f of due.delivered) o.log(`timer delivered: ${path.basename(f)}`)
  for (const s of due.skipped) o.log(`timer skipped: ${s}`)

  const state = readState(dir)
  let started = 0
  const capped = () => {
    if (runsToday(readRuns(dir), Date.now()) < o.runsPerDay) return false
    o.log(`${o.runsPerDay} runs were started today, which is the limit (--runs-per-day). Mail waits until tomorrow.`)
    return true
  }

  // 1. Runs waiting for a person.
  let events = pendingEvents(o.root, o.name)
  const used = new Set<string>()
  for (const [thread, w] of Object.entries(state.waiting)) {
    const found = findAnswer(o, dir, w, events)
    if (!found) continue
    if (capped()) return started
    if (found.reply) used.add(found.reply.filename)
    if (o.dryRun) {
      o.log(`would resume thread ${thread}: ${found.answer} for ${w.tool}`)
      continue
    }
    writeFileSync(path.join(dir, 'answers', w.tool_use_id), found.answer)
    o.log(`thread ${thread}: ${found.answer === 'allow' ? 'approved' : 'denied'}, resuming`)
    const before = sentBy(o.root, o.name)
    // No prompt: the agent tool runs the waiting call first, and a prompt would make it skip the call.
    const run = await startRun(o, dir, null, w.session_id)
    started++
    settle(o, dir, state, thread, w.events, true, before, run)
    // Every reply to the request is done with now, the ones that were not an answer too:
    // they were about a question that has been settled.
    for (const e of events) {
      if (e.reply_to === w.request && e.from === w.approver && !dropReason(e)) {
        used.add(e.filename)
        ack(o, e.path)
      }
    }
  }

  // 2. New mail.
  events = pendingEvents(o.root, o.name).filter((e) => !used.has(e.filename))
  const held = new Set(Object.values(state.waiting).flatMap((w) => w.events))
  const requests = new Set(Object.values(state.waiting).map((w) => w.request))
  const ready: PendingEvent[] = []
  for (const e of events) {
    if (held.has(e.filename)) continue
    // An answer that could not be read as one stays unread, for a person to look at.
    if (e.reply_to && requests.has(e.reply_to)) continue
    const why = dropReason(e) ?? ((state.attempts[e.filename] ?? 0) >= 3 ? 'three runs for it failed' : null)
    if (why) {
      if (!state.dropped.includes(e.filename)) {
        state.dropped.push(e.filename)
        record(dir, { at: new Date().toISOString(), thread: e.thread || e.filename.replace(/\.md$/, ''), events: [e.filename], ended: 'dropped', reason: why })
        o.log(`not run: ${e.filename} (${why}). It stays unread for a person.`)
        writeState(dir, state)
      }
      continue
    }
    ready.push(e)
  }
  for (const group of groupByThread(ready)) {
    // A thread with a run waiting takes no new run: a prompt would make the agent skip the waiting call.
    if (state.waiting[group.thread]) continue
    if (capped()) return started
    const files = group.events.map((e) => e.filename)
    const session = state.sessions[group.thread] ?? null
    if (o.dryRun) {
      o.log(`would ${session ? 'continue' : 'start'} thread ${group.thread} for ${files.join(', ')}`)
      continue
    }
    o.log(`thread ${group.thread}: ${session ? 'continuing' : 'starting'} a run for ${files.length} ${files.length === 1 ? 'message' : 'messages'}`)
    const before = sentBy(o.root, o.name)
    const run = await startRun(o, dir, buildPrompt(o.name, group.events), session)
    started++
    settle(o, dir, state, group.thread, files, Boolean(session), before, run)
  }
  return started
}
