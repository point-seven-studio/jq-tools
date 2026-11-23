/**
 * `crosstalk view`: a local, read-only page over one mailbox.
 *
 *   crosstalk view                 serve http://127.0.0.1:4318 (re-reads on every refresh)
 *   crosstalk view --html FILE     write the page to a file
 *   crosstalk view --json          print the report without bodies
 *   crosstalk view --port NUMBER
 *
 * It listens on this machine only and makes no outbound call.
 */
import { writeFileSync } from 'fs'
import { createServer } from 'http'
import { BOARD, boardPosts, deriveThreads, waitingBoard } from './board.js'
import { renderPage, type Report } from './page.js'
import { LAMP_PATH, lampReply, announce, readRunning, readTeamUrl, toolbar } from './presence.js'
import { startUpdateCheck } from './update-check.js'
import { readMailbox } from './read.js'
import { summarizeRuns } from './worker.js'
import { listTimers, listWorkers, readRuns, readState, workerDir } from './worker-run.js'

export const DEFAULT_PORT = 4318
const THREADS_SHOWN = 60

export function buildReport(root: string, now = Date.now()): Report {
  const messages = readMailbox(root)
  const waiting = waitingBoard(messages, now)
  const board = boardPosts(messages, now)
  const threads = deriveThreads(messages.filter((m) => m.to_session !== BOARD), now).slice(0, THREADS_SHOWN)
  const shown = new Set<string>()
  for (const i of waiting.inboxes) for (const m of i.items) shown.add(m.id)
  for (const t of threads) for (const m of t.messages) shown.add(m.id)
  for (const p of [...board.open, ...board.closed]) {
    shown.add(p.post.id)
    for (const r of p.replies) shown.add(r.id)
    if (p.closing) shown.add(p.closing.id)
  }
  const bodies: Record<string, string> = {}
  for (const m of messages) if (shown.has(m.id)) bodies[m.id] = m.body
  const timers = listTimers(root).map((t) => ({ subject: t.subject, from: t.from, to: t.to, due: t.due, every: t.every }))
  const workers = listWorkers(root).map((name) => {
    const dir = workerDir(root, name)
    const asks = Object.entries(readState(dir).waiting).map(([thread, w]) => ({ thread, tool: w.tool, request: w.request, approver: w.approver, asked_at: w.asked_at }))
    return { name, waiting: asks, runs: summarizeRuns(readRuns(dir), now, 7) }
  })
  return { mailbox: root, generated_at: new Date(now).toISOString(), total: messages.length, waiting, board, threads, bodies, timers, workers }
}

export function parseArgs(args: string[]): { root: string; html: string | null; json: boolean; port: number } {
  const [root, ...rest] = args
  if (!root) throw new Error('usage: crosstalk view [--html FILE | --json] [--port NUMBER]')
  let html: string | null = null
  let json = false
  let port = DEFAULT_PORT
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') json = true
    else if (rest[i] === '--html') html = rest[++i] ?? null
    else if (rest[i] === '--port') port = Number(rest[++i])
    else if (rest[i] === '--no-update-check') continue // read by update-check.ts
    else throw new Error(`unknown option: ${rest[i]}`)
  }
  if (rest.includes('--html') && !html) throw new Error('--html needs a file')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port needs a number from 1 to 65535')
  return { root, html, json, port }
}

export function run(args: string[], version = 'dev'): void {
  const parsed = parseArgs(args)
  if (parsed.json) {
    const { bodies: _bodies, ...rest } = buildReport(parsed.root)
    console.log(JSON.stringify(rest, null, 2))
    return
  }
  if (parsed.html) {
    writeFileSync(parsed.html, renderPage(buildReport(parsed.root)))
    console.log(`wrote ${parsed.html}`)
    return
  }
  // Only here, where a person has started the page. --json and --html never ask.
  const update = startUpdateCheck('@point-seven-studio/jq-crosstalk', version, { say: (line) => console.log(`crosstalk: ${line}`) })
  createServer((req, res) => {
    try {
      // The light a team board shows for this tool (presence.ts). Answered only where a team board is set up.
      if (req.url === LAMP_PATH) {
        const lamp = lampReply()
        res.writeHead(lamp.status, lamp.headers)
        res.end(lamp.body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderPage(buildReport(parsed.root), toolbar({ here: 'crosstalk', running: readRunning(), team: readTeamUrl(), update: update(), copy: true })))
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(e?.message || e))
    }
  }).listen(parsed.port, '127.0.0.1', () => {
    // Tell the other JQ pages on this machine where this one is, until it stops.
    announce('crosstalk', parsed.port)
    console.log(`crosstalk: http://127.0.0.1:${parsed.port} (Ctrl-C to stop)`)
  })
}
