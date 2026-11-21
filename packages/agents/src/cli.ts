/**
 * The `jq-agents` command.
 *
 *   jq-agents                       serve the board at http://127.0.0.1:4319
 *   jq-agents --html FILE           write the board to a file
 *   jq-agents --json                print one snapshot
 *   jq-agents --watch --exec CMD    every interval, pipe a snapshot (JSON) to CMD
 *
 * The page server listens on this machine only. Nothing leaves the machine unless
 * you say so: --exec hands the snapshot to a command of yours, and --probe times a
 * TLS handshake to the API host.
 *
 * The page can save corrections to the check label. That is the one thing this tool
 * writes: the `turnCheck` key of ~/.jq/config.json. A save must come from the page this
 * process served (see `allowedPost`). --no-manage serves the page with no forms.
 */
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { writeFileSync } from 'fs'
import { createServer, type IncomingMessage } from 'http'
import { snapshot, type Snapshot } from './collect.js'
import { defaultConfigFile, readTurnCheckConfig, writeTurnCheckConfig } from './config.js'
import { renderPage } from './page.js'
import { applyAction, parseAction } from './turn-check.js'

export const DEFAULT_PORT = 4319

export interface Args {
  json: boolean
  html: string | null
  watch: boolean
  exec: string | null
  intervalS: number
  port: number
  probe: boolean
  sample: boolean
  questionTrees: string[]
  maxAgeDays: number
  /** Whether the served page offers forms that save corrections. */
  manage: boolean
  configFile: string
}

const list = (s: string | undefined) => (s || '').split(',').map((x) => x.trim()).filter(Boolean)

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Args {
  const a: Args = {
    json: false,
    html: null,
    watch: false,
    exec: null,
    intervalS: Number(env.JQ_AGENTS_INTERVAL_S) || 60,
    port: DEFAULT_PORT,
    probe: false,
    sample: true,
    questionTrees: list(env.JQ_AGENTS_QUESTION_TREES),
    maxAgeDays: Number(env.JQ_AGENTS_MAX_AGE_DAYS) || 3,
    manage: true,
    configFile: env.JQ_CONFIG || defaultConfigFile(),
  }
  const value = (i: number, flag: string) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]
    if (f === '--json') a.json = true
    else if (f === '--watch') a.watch = true
    else if (f === '--probe') a.probe = true
    else if (f === '--no-sample') a.sample = false
    else if (f === '--no-manage') a.manage = false
    else if (f === '--config') a.configFile = value(i++, f)
    else if (f === '--html') a.html = value(i++, f)
    else if (f === '--exec') a.exec = value(i++, f)
    else if (f === '--interval') a.intervalS = Number(value(i++, f))
    else if (f === '--port') a.port = Number(value(i++, f))
    else if (f === '--questions') a.questionTrees = list(value(i++, f))
    else if (f === '--max-age-days') a.maxAgeDays = Number(value(i++, f))
    else throw new Error(`unknown option: ${f}`)
  }
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) throw new Error('--port needs a number from 1 to 65535')
  if (!(a.intervalS >= 5)) throw new Error('--interval needs 5 seconds or more')
  if (!(a.maxAgeDays > 0)) throw new Error('--max-age-days needs a number above 0')
  if (a.watch && !a.exec) throw new Error('--watch needs --exec CMD (what should receive each snapshot?)')
  if (a.exec && !a.watch && !a.json) throw new Error('--exec goes with --watch')
  return a
}

/** `evidence` is asked for by the local page only: it holds command text. */
const collect = (a: Args, evidence = false): Promise<Snapshot> =>
  snapshot({ questionTrees: a.questionTrees, maxAgeDays: a.maxAgeDays, probe: a.probe, sample: a.sample, turnCheck: readTurnCheckConfig(a.configFile), evidence })

/**
 * Whether a POST may change the config. Three things must hold, because any web page a
 * person visits can make their browser post to 127.0.0.1:
 *  - the Host is this server, by its loopback name (a page that points a name of its own at
 *    127.0.0.1 sends that name);
 *  - the Origin, when the browser sends one, is this server;
 *  - the form carries the token this process put in the page it served.
 */
export function allowedPost(headers: { host?: string; origin?: string }, port: number, token: string, sent: string | undefined): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!headers.host || !hosts.includes(headers.host)) return false
  if (headers.origin !== undefined && !hosts.map((h) => `http://${h}`).includes(headers.origin)) return false
  return typeof sent === 'string' && sent.length === token.length && sent === token
}

const MAX_BODY = 8 * 1024
function readForm(req: IncomingMessage): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))))
    req.on('error', () => resolve(null))
  })
}

/** Pipe one snapshot to the user's command. Resolves with its exit code. */
function hand(cmd: string, snap: Snapshot): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
    child.on('error', () => resolve(127))
    child.on('close', (code) => resolve(code ?? 1))
    child.stdin.on('error', () => {}) // a command that does not read stdin is its own business
    child.stdin.end(JSON.stringify(snap))
  })
}

export async function run(argv: string[]): Promise<void> {
  const a = parseArgs(argv, process.env)
  if (a.watch) {
    const tick = async () => {
      try {
        const snap = await collect(a)
        const code = await hand(a.exec as string, snap)
        const line = `jq-agents: ${snap.sessions.length} sessions handed to your command`
        // Say so every time it fails: a sink that dies quietly is invisible.
        if (code === 0) console.log(line)
        else console.error(`${line}, which FAILED (exit ${code})`)
      } catch (e: any) {
        console.error('jq-agents: snapshot failed:', e?.message || e)
      }
    }
    await tick()
    console.log(`jq-agents: watching every ${a.intervalS}s (Ctrl-C to stop)`)
    setInterval(tick, a.intervalS * 1000)
    return
  }
  if (a.json) {
    console.log(JSON.stringify(await collect(a), null, 2))
    return
  }
  if (a.html) {
    writeFileSync(a.html, renderPage(await collect(a)))
    console.log(`wrote ${a.html}`)
    return
  }
  const token = randomBytes(16).toString('hex')
  // What the last served page showed. A form may only name a tree or a session from it.
  let shown: { trees: string[]; sessions: Record<string, string | null> } = { trees: [], sessions: {} }
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // No script, no outside resource, forms only to this server, and no framing by another page.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
  }
  createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/turn-check' && a.manage) {
        const form = await readForm(req)
        if (!form || !allowedPost({ host: req.headers.host, origin: req.headers.origin }, a.port, token, form.token)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Refused. Reload the board and try again.')
          return
        }
        const config = readTurnCheckConfig(a.configFile)
        const action = parseAction(form, shown, config)
        if (action) writeTurnCheckConfig(applyAction(config, action), a.configFile)
        res.writeHead(303, { location: '/', 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
        res.end('Method not allowed.')
        return
      }
      const snap = await collect(a, a.manage)
      shown = { trees: [...new Set(snap.sessions.map((r) => r.working_tree))], sessions: Object.fromEntries(snap.sessions.map((r) => [r.session_id, r.last_activity_at])) }
      const page = renderPage(snap, Date.now(), a.manage ? { token, config: readTurnCheckConfig(a.configFile) } : undefined)
      res.writeHead(200, headers)
      res.end(page)
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(e?.message || e))
    }
  }).listen(a.port, '127.0.0.1', () => console.log(`jq-agents: http://127.0.0.1:${a.port} (Ctrl-C to stop)`))
}
