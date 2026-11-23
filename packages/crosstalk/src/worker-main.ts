/**
 * Entry point of dist/worker.mjs, run by the `crosstalk` commands for timers and the worker.
 *
 *   later <to> "<subject>" --at <when> [--every <span>] [--kind K] [--re <path>] [-f bodyfile]
 *   timers                                  list timers waiting to be delivered
 *   cancel <timer>
 *   due                                     deliver timers whose time has come
 *   worker [<name>] --cwd DIR [options]     run headless agent runs for a name's mail
 *   approve <request> | deny <request>      answer a run that is waiting
 *   runs [<name>] [--json]                  how the worker's runs ended
 *
 * Reads and writes files in one mailbox. The one process it starts is the agent tool.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseEvery, parseWhen } from './timers.js'
import { ENDINGS, summarizeRuns } from './worker.js'
import { addTimer, answerRequest, cancelTimer, deliverDue, listTimers, listWorkers, pass, readRuns, readSigners, readState, takeLock, workerDir, type WorkerOptions } from './worker-run.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function header(raw: string, key: string): string {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return ''
  for (const line of fm[1].split('\n')) if (line.startsWith(`${key}: `)) return line.slice(key.length + 2).trim()
  return ''
}

/** Split arguments into `--flag value` pairs, bare `--flag`s and the rest. */
function parse(args: string[], withValue: string[], bare: string[]): { flags: Record<string, string>; on: Set<string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const on = new Set<string>()
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (withValue.includes(a)) {
      const v = args[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      flags[a] = v
    } else if (bare.includes(a)) on.add(a)
    else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option: ${a}`)
    else rest.push(a)
  }
  return { flags, on, rest }
}

function later(root: string, args: string[]): void {
  const { flags, rest } = parse(args, ['--at', '--every', '--kind', '--re', '-f', '--from'], [])
  const [to, subject, extra] = rest
  if (!to || !subject || extra) throw new Error('usage: crosstalk later <to> "<subject>" --at <when> [--every <span>] [--kind brief|question|notice] [--re <path>] [-f bodyfile]')
  if (!flags['--at']) throw new Error('later needs --at: +2h, +3d, or a date such as 2026-12-01T09:00')
  const from = flags['--from'] ?? process.env.CROSSTALK_SELF
  if (!from) throw new Error('who is sending? use --from <name> or set $CROSSTALK_SELF')
  const kind = flags['--kind'] ?? 'brief'
  if (!['brief', 'question', 'notice'].includes(kind)) throw new Error(`unknown kind: ${kind} (brief, question or notice)`)
  const now = Date.now()
  const due = parseWhen(flags['--at'], now)
  if (flags['--every']) parseEvery(flags['--every'])
  let thread = ''
  let reply_to = ''
  if (flags['--re']) {
    if (!existsSync(flags['--re'])) throw new Error(`--re: no such message: ${flags['--re']}`)
    reply_to = path.basename(flags['--re'])
    thread = header(readFileSync(flags['--re'], 'utf8'), 'thread') || reply_to.replace(/\.md$/, '')
  }
  const body = flags['-f'] ? readFileSync(flags['-f'], 'utf8') : process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
  const file = addTimer(root, { from, to, subject, kind, due: new Date(due).toISOString(), every: flags['--every'] ?? '', thread, reply_to, body }, now)
  console.log(file)
  console.log(`due ${new Date(due).toISOString()}${flags['--every'] ? `, then every ${flags['--every']}` : ''}. Delivered by: crosstalk due, or a running crosstalk worker.`)
}

function timers(root: string): void {
  const list = listTimers(root)
  if (!list.length) return console.log('no timers')
  const now = Date.now()
  for (const t of list) {
    console.log(t.subject)
    console.log(`    from ${t.from} to ${t.to} · due ${t.due}${Date.parse(t.due) <= now ? ' (now)' : ''}${t.every ? ` · every ${t.every}` : ''}`)
    console.log(`    ${path.join(root, 'timers', t.filename)}`)
  }
}

async function worker(root: string, args: string[]): Promise<void> {
  const { flags, on, rest } = parse(args, ['--cwd', '--every', '--runs-per-day', '--budget', '--approver', '--model', '--timeout', '--claude'], ['--once', '--dry-run'])
  const name = rest[0] ?? process.env.CROSSTALK_SELF
  if (!name || rest.length > 1) throw new Error('usage: crosstalk worker [<name>] --cwd DIR [--once] [--every SECONDS] [--runs-per-day N] [--budget USD] [--approver NAME] [--model M] [--timeout MINUTES] [--dry-run]')
  if (!existsSync(path.join(root, 'inbox', name)) || name === 'board') throw new Error(`unknown name: ${name} (no inbox/${name}/)`)
  if (!flags['--cwd']) throw new Error('worker needs --cwd: the folder the agent runs in, such as the repository this session works on')
  const cwd = path.resolve(flags['--cwd'])
  if (!existsSync(cwd)) throw new Error(`--cwd: no such folder: ${cwd}`)
  const num = (flag: string, fallback: number, min: number, max: number) => {
    if (flags[flag] === undefined) return fallback
    const n = Number(flags[flag])
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${flag} needs a number from ${min} to ${max}`)
    return n
  }
  const signers = readSigners(root)
  // Whoever answers approval requests. By default the mailbox's signer, when it has exactly one.
  let approver: string | null = flags['--approver'] ?? (signers.size === 1 ? [...signers.keys()][0] : null)
  if (approver === 'none') approver = null
  if (approver && (!existsSync(path.join(root, 'inbox', approver)) || approver === name || approver === 'board')) throw new Error(`--approver: ${approver} has no inbox in this mailbox, or is the worker itself`)
  const o: WorkerOptions = {
    root,
    name,
    cwd,
    tool: path.join(HERE, '..', 'bin', 'crosstalk'),
    hook: path.join(HERE, 'hook.mjs'),
    claude: flags['--claude'] ?? process.env.CROSSTALK_CLAUDE ?? 'claude',
    model: flags['--model'] ?? null,
    approver,
    budgetUsd: num('--budget', 1, 0.01, 100),
    runsPerDay: num('--runs-per-day', 20, 1, 500),
    timeoutMs: num('--timeout', 30, 1, 240) * 60_000,
    dryRun: on.has('--dry-run'),
    log: (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`),
  }
  const every = num('--every', 60, 10, 3600) * 1000
  const dir = workerDir(root, name)
  mkdirSync(dir, { recursive: true })
  const release = o.dryRun ? () => {} : takeLock(dir)
  const stop = () => {
    release()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    console.log(`crosstalk worker for ${name}, running in ${cwd}`)
    console.log(`  at most ${o.runsPerDay} runs a day, $${o.budgetUsd.toFixed(2)} a run, ${Math.round(o.timeoutMs / 60_000)} minutes a run`)
    if (approver) console.log(`  commands in worker/${name}/ask.txt wait for ${approver}${signers.has(approver) ? ', whose answers must be signed' : ' (no key: any session that shares the mailbox could write the answer)'}`)
    else console.log(`  nobody to ask: commands in worker/${name}/ask.txt are refused`)
    for (;;) {
      await pass(o)
      if (on.has('--once') || o.dryRun) break
      await new Promise((r) => setTimeout(r, every))
    }
  } finally {
    release()
  }
}

function answer(root: string, args: string[], which: 'allow' | 'deny'): void {
  const [file, extra] = args
  if (!file || extra) throw new Error(`usage: crosstalk ${which === 'allow' ? 'approve' : 'deny'} <path of the approval request>`)
  if (!existsSync(file)) throw new Error(`no such message: ${file}`)
  const name = answerRequest(root, file, which)
  console.log(`${which === 'allow' ? 'approved' : 'denied'}. The worker for ${name} resumes the run on its next pass.`)
}

function runs(root: string, args: string[]): void {
  const { on, rest } = parse(args, [], ['--json'])
  const list = rest[0] ? [rest[0]] : listWorkers(root)
  const now = Date.now()
  const report = list.map((name) => {
    const dir = workerDir(root, name)
    const waiting = Object.entries(readState(dir).waiting).map(([thread, w]) => ({ thread, tool: w.tool, request: w.request, approver: w.approver, asked_at: w.asked_at }))
    return { name, waiting, ...summarizeRuns(readRuns(dir), now, 7) }
  })
  if (on.has('--json')) return console.log(JSON.stringify(report, null, 2))
  if (!report.length) return console.log('no worker has run in this mailbox')
  for (const r of report) {
    console.log(`${r.name}: ${r.total} in the last 7 days${r.cost_usd ? `, $${r.cost_usd.toFixed(2)}` : ''}`)
    console.log(`    ${ENDINGS.map((e) => `${e} ${r.by_ending[e]}`).join(' · ')}`)
    for (const w of r.waiting) console.log(`    waiting for ${w.approver} since ${w.asked_at}: inbox/${w.approver}/${w.request}`)
  }
}

async function main(): Promise<void> {
  const [command, root, ...args] = process.argv.slice(2)
  if (!command || !root) throw new Error('usage: worker.mjs <command> <mailbox> ...')
  if (command === 'later') later(root, args)
  else if (command === 'timers') timers(root)
  else if (command === 'cancel') {
    if (!args[0]) throw new Error('usage: crosstalk cancel <timer>')
    console.log(`cancelled → ${cancelTimer(root, args[0])}`)
  } else if (command === 'due') {
    const r = deliverDue(root)
    for (const f of r.delivered) console.log(f)
    for (const s of r.skipped) console.error(`skipped: ${s}`)
    if (!r.delivered.length) console.error('no timer is due')
  } else if (command === 'worker') await worker(root, args)
  else if (command === 'approve') answer(root, args, 'allow')
  else if (command === 'deny') answer(root, args, 'deny')
  else if (command === 'runs') runs(root, args)
  else throw new Error(`unknown command: ${command}`)
}

main().catch((error: any) => {
  console.error(error.message || error)
  process.exit(1)
})
