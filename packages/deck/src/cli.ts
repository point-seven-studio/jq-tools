/**
 * The `jq-deck` command: one local page over jq-agents, jq-groundcrew and
 * jq-crosstalk.
 *
 *   jq-deck            serve the page at http://127.0.0.1:4316
 *   jq-deck --json     print the overview
 *
 * The server listens on this machine only, answers only requests addressed to
 * this machine by name, and may not be framed by another site.
 */
import { createServer } from 'http'
import path from 'path'
import { renderPage as renderSessions, snapshot } from '@point-seven-studio/jq-agents'
import { buildReport, renderPage as renderMail } from '@point-seven-studio/jq-crosstalk'
import { renderPage as renderSetup, report as setupReport } from '@point-seven-studio/jq-groundcrew'
import { collectOverview, type DeckOptions } from './collect.js'
import { defaultConfigFile, expandHome, findMailbox, loadConfig, type Overview } from './deck.js'
import { renderShell, TABS, type Tab } from './page.js'

export const DEFAULT_PORT = 4316

export interface Args {
  json: boolean
  port: number
  mailbox: string | null
  config: string
  questionTrees: string[] | null
  probe: boolean
  sample: boolean
  maxAgeDays: number
}

const list = (s: string | undefined) => (s || '').split(',').map((x) => x.trim()).filter(Boolean)

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Args {
  const a: Args = {
    json: false,
    port: DEFAULT_PORT,
    mailbox: null,
    config: env.JQ_DECK_CONFIG || defaultConfigFile(),
    questionTrees: env.JQ_AGENTS_QUESTION_TREES ? list(env.JQ_AGENTS_QUESTION_TREES) : null,
    probe: false,
    sample: true,
    maxAgeDays: Number(env.JQ_AGENTS_MAX_AGE_DAYS) || 3,
  }
  const value = (i: number, flag: string) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]
    if (f === '--json') a.json = true
    else if (f === '--probe') a.probe = true
    else if (f === '--no-sample') a.sample = false
    else if (f === '--port') a.port = Number(value(i++, f))
    else if (f === '--mailbox') a.mailbox = value(i++, f)
    else if (f === '--config') a.config = value(i++, f)
    else if (f === '--questions') a.questionTrees = list(value(i++, f))
    else if (f === '--max-age-days') a.maxAgeDays = Number(value(i++, f))
    else throw new Error(`unknown option: ${f}`)
  }
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) throw new Error('--port needs a number from 1 to 65535')
  if (!(a.maxAgeDays > 0)) throw new Error('--max-age-days needs a number above 0')
  return a
}

export interface Context {
  port: number
  version: string
  deck: DeckOptions
  probe: boolean
  sample: boolean
}

/** Flags, then the config file, then the environment. */
export function buildContext(a: Args, env: Record<string, string | undefined>, cwd: string, version: string): Context {
  const config = loadConfig(expandHome(a.config))
  return {
    port: a.port,
    version,
    probe: a.probe,
    sample: a.sample,
    deck: {
      mailbox: findMailbox({ flag: a.mailbox, config: config.mailbox, env: env.CROSSTALK_DIR, cwd }),
      names: config.names,
      // Off unless asked for: question text is a session's own words.
      questionTrees: (a.questionTrees ?? config.questions ?? []).map((t) => path.resolve(expandHome(t))),
      maxAgeDays: a.maxAgeDays,
      cwd,
    },
  }
}

export interface Reply {
  status: number
  type: 'text/html; charset=utf-8' | 'text/plain; charset=utf-8'
  body: string
}
const html = (body: string): Reply => ({ status: 200, type: 'text/html; charset=utf-8', body })
const plain = (status: number, body: string): Reply => ({ status, type: 'text/plain; charset=utf-8', body })

/**
 * A page on another site can make a browser call 127.0.0.1 under a name that
 * site controls. Answering only to this machine's own names stops it reading
 * the reply.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

export async function handle(url: string, host: string | undefined, ctx: Context, overview: (o: DeckOptions) => Promise<Overview> = collectOverview): Promise<Reply> {
  if (!hostAllowed(host, ctx.port)) return plain(403, 'jq-deck answers only on this machine')
  const u = new URL(url, 'http://127.0.0.1')
  if (u.pathname === '/') {
    const asked = u.searchParams.get('tab')
    const tab: Tab = (TABS as readonly string[]).includes(asked ?? '') ? (asked as Tab) : 'overview'
    return html(renderShell(await overview(ctx.deck), tab, u.searchParams.get('repo'), ctx.version))
  }
  if (u.pathname === '/raw/sessions') {
    return html(renderSessions(await snapshot({ questionTrees: ctx.deck.questionTrees, maxAgeDays: ctx.deck.maxAgeDays, projectsDir: ctx.deck.projectsDir, sockDir: ctx.deck.sockDir, probe: ctx.probe, sample: ctx.sample })))
  }
  if (u.pathname === '/raw/setup') {
    // The id is looked up among the repositories on the page, so a URL can never
    // name a folder of its own choosing.
    const row = (await overview(ctx.deck)).repos.find((r) => r.id === u.searchParams.get('repo'))
    if (!row || !row.setup) return plain(404, 'no such repository on this page')
    return html(renderSetup(setupReport(row.tree)))
  }
  if (u.pathname === '/raw/mail') {
    if (!ctx.deck.mailbox) return plain(404, 'no mailbox set')
    return html(renderMail(buildReport(ctx.deck.mailbox)))
  }
  return plain(404, 'not found')
}

export async function run(argv: string[], version: string): Promise<void> {
  const a = parseArgs(argv, process.env)
  const ctx = buildContext(a, process.env, process.cwd(), version)
  if (a.json) {
    console.log(JSON.stringify(await collectOverview(ctx.deck), null, 2))
    return
  }
  createServer(async (req, res) => {
    let reply: Reply
    try {
      reply = req.method === 'GET' ? await handle(req.url || '/', req.headers.host, ctx) : plain(405, 'read-only')
    } catch (e: any) {
      reply = plain(500, String(e?.message || e))
    }
    res.writeHead(reply.status, {
      'content-type': reply.type,
      'cache-control': 'no-store',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
    })
    res.end(reply.body)
  }).listen(a.port, '127.0.0.1', () => {
    console.log(`jq-deck: http://127.0.0.1:${a.port} (Ctrl-C to stop)`)
    console.log(ctx.deck.mailbox ? `jq-deck: mailbox ${ctx.deck.mailbox}` : 'jq-deck: no mailbox found (pass --mailbox DIR to show mail)')
  })
}
