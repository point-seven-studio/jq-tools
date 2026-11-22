/**
 * The `jq-deck` command: one local page over jq-agents, jq-groundcrew and
 * jq-crosstalk.
 *
 *   jq-deck            serve the page at http://127.0.0.1:4316
 *   jq-deck --json     print the overview
 *   jq-deck --watch --exec CMD    every interval, pipe a team report (JSON) to CMD
 *
 * The server listens on this machine only, answers only requests addressed to
 * this machine by name, and may not be framed by another site.
 */
import { spawn } from 'child_process'
import { createServer } from 'http'
import { LAMP_PATH, announce, lampReply, readRunning, readTeamUrl, runningDir, toolbar } from './presence.js'
import { startUpdateCheck, type UpdateNotice } from './update-check.js'
import path from 'path'
import { readTurnCheckConfig, renderPage as renderSessions, snapshot } from '@point-seven-studio/jq-agents'
import { buildReport, renderPage as renderMail } from '@point-seven-studio/jq-crosstalk'
import { renderPage as renderSetup, report as setupReport } from '@point-seven-studio/jq-groundcrew'
import { collectOverview, type DeckOptions } from './collect.js'
import { defaultConfigFile, expandHome, findMailbox, loadConfig, teamReport, type Overview, type TeamReport } from './deck.js'
import { renderShell, TABS, type Tab } from './page.js'

export const DEFAULT_PORT = 4316

export interface Args {
  json: boolean
  watch: boolean
  /** --watch says nothing when a report goes through. For a login job, whose log would otherwise grow by a line a minute. */
  quiet: boolean
  exec: string | null
  intervalS: number
  /** Repositories --watch may report. null: not said on the command line. */
  repos: string[] | null
  allRepos: boolean
  /** Folders whose question text --watch may send. null: not said on the command line. */
  sendQuestions: string[] | null
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
    watch: false,
    quiet: false,
    exec: null,
    intervalS: Number(env.JQ_DECK_INTERVAL_S) || 60,
    repos: null,
    allRepos: false,
    sendQuestions: null,
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
    else if (f === '--watch') a.watch = true
    else if (f === '--quiet') a.quiet = true
    else if (f === '--no-update-check') continue // read by update-check.ts
    else if (f === '--exec') a.exec = value(i++, f)
    else if (f === '--repos') a.repos = list(value(i++, f))
    else if (f === '--all-repos') a.allRepos = true
    else if (f === '--send-questions') a.sendQuestions = list(value(i++, f))
    else if (f === '--interval') a.intervalS = Number(value(i++, f))
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
  if (!(a.intervalS >= 15)) throw new Error('--interval needs 15 seconds or more')
  if (a.watch && !a.exec) throw new Error('--watch needs --exec CMD (what should receive each report?)')
  if (a.exec && !a.watch) throw new Error('--exec goes with --watch')
  if ((a.repos || a.allRepos || a.sendQuestions) && !a.watch) throw new Error('--repos, --all-repos and --send-questions go with --watch')
  if (a.repos && a.allRepos) throw new Error('pass --repos or --all-repos, not both')
  return a
}

export interface Context {
  /** Where running tools leave their notes (presence.ts), read for the links at the foot of the page. */
  runningDir: string
  /** The config file, read again on each page load for corrections made on the JQ Agents board. */
  configFile: string
  port: number
  version: string
  deck: DeckOptions
  probe: boolean
  sample: boolean
  /** What --watch may report: a list, or null for every repository. */
  report: string[] | null
  /** Folders whose question text --watch may send. Empty unless asked for. */
  sendQuestions: string[]
  /** Gives the newer version, when one is known. Set only where the page is served to a person. */
  update?: () => UpdateNotice | null
}

/**
 * Which repositories a machine reports. Naming them is required: a machine
 * often holds work for more than one team, and a repository's name alone can
 * be something its owner did not agree to share.
 */
export function reportList(a: Pick<Args, 'repos' | 'allRepos'>, fromConfig: string[] | undefined): string[] | null {
  if (a.allRepos) return null
  const listed = a.repos ?? fromConfig ?? []
  if (listed.length === 0) throw new Error('--watch needs to know which repositories to report: --repos name,name (or "report" in the config file), or --all-repos')
  return listed
}

/** Flags, then the config file, then the environment. */
export function buildContext(a: Args, env: Record<string, string | undefined>, cwd: string, version: string): Context {
  const config = loadConfig(expandHome(a.config))
  return {
    runningDir: runningDir(env),
    configFile: expandHome(a.config),
    port: a.port,
    version,
    probe: a.probe,
    sample: a.sample,
    report: a.watch ? reportList(a, config.report) : null,
    sendQuestions: a.watch ? (a.sendQuestions ?? config.sendQuestions ?? []).map((t) => path.resolve(expandHome(t))) : [],
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
  type: 'text/html; charset=utf-8' | 'text/plain; charset=utf-8' | 'image/svg+xml'
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
  // The light a team board shows for this tool (presence.ts). Answered only where a team board is set up.
  if (u.pathname === LAMP_PATH) {
    const lamp = lampReply(ctx.configFile)
    return lamp.status === 200 ? { status: 200, type: 'image/svg+xml', body: lamp.body } : plain(404, 'not found')
  }
  if (u.pathname === '/') {
    const asked = u.searchParams.get('tab')
    const tab: Tab = (TABS as readonly string[]).includes(asked ?? '') ? (asked as Tab) : 'overview'
    const bar = toolbar({ here: 'deck', running: readRunning(ctx.runningDir), team: readTeamUrl(ctx.configFile), update: ctx.update?.() ?? null, copy: true })
    // ?find=NAME is how a team board points at one repository: it knows names, never paths.
    const find = u.searchParams.get('find')
    return html(renderShell(await overview(ctx.deck), tab, u.searchParams.get('repo'), ctx.version, bar, find === null ? null : find.slice(0, 100)))
  }
  if (u.pathname === '/raw/sessions') {
    return html(renderSessions(await snapshot({ questionTrees: ctx.deck.questionTrees, maxAgeDays: ctx.deck.maxAgeDays, projectsDir: ctx.deck.projectsDir, sockDir: ctx.deck.sockDir, probe: ctx.probe, sample: ctx.sample, turnCheck: readTurnCheckConfig(ctx.configFile) })))
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

/** Pipe one report to the user's command. Resolves with its exit code. */
function hand(cmd: string, report: TeamReport): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
    child.on('error', () => resolve(127))
    child.on('close', (code) => resolve(code ?? 1))
    child.stdin.on('error', () => {}) // a command that does not read stdin is its own business
    child.stdin.end(JSON.stringify(report))
  })
}

export async function run(argv: string[], version: string): Promise<void> {
  const a = parseArgs(argv, process.env)
  const ctx = buildContext(a, process.env, process.cwd(), version)
  if (a.watch) {
    // --questions is about this machine's own screen and plays no part here.
    // Question text is read, and sent, only for the folders in --send-questions.
    const tick = async () => {
      try {
        const report = teamReport(await collectOverview({ ...ctx.deck, questionTrees: ctx.sendQuestions }), ctx.report, ctx.sendQuestions)
        const code = await hand(a.exec as string, report)
        const line = `jq-deck: ${report.repos.length} ${report.repos.length === 1 ? 'repository' : 'repositories'} reported to your command`
        // Say so every time it fails: a sink that dies quietly is invisible.
        if (code === 0) {
          if (!a.quiet) console.log(line)
        } else console.error(`${new Date().toISOString()} ${line}, which FAILED (exit ${code})`)
      } catch (e: any) {
        console.error('jq-deck: report failed:', e?.message || e)
      }
    }
    await tick()
    console.log(`jq-deck: reporting every ${a.intervalS}s (Ctrl-C to stop)`)
    console.log(ctx.sendQuestions.length ? `jq-deck: question text IS sent for sessions under: ${ctx.sendQuestions.join(', ')}` : 'jq-deck: question text is not sent')
    setInterval(tick, a.intervalS * 1000)
    return
  }
  if (a.json) {
    console.log(JSON.stringify(await collectOverview(ctx.deck), null, 2))
    return
  }
  // Only here, where a person has started the page. --watch, --json, join and leave never ask.
  ctx.update = startUpdateCheck('@point-seven-studio/jq-deck', version, { configFile: ctx.configFile, say: (line) => console.log(`jq-deck: ${line}`) })
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
      // The light is an image a team board on another site may show. Nothing else here is.
      ...(reply.type === 'image/svg+xml' ? { 'cross-origin-resource-policy': 'cross-origin' } : {}),
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
    })
    res.end(reply.body)
  }).listen(a.port, '127.0.0.1', () => {
    // Tell the other JQ pages on this machine where this one is, until it stops.
    announce('deck', a.port, ctx.runningDir)
    console.log(`jq-deck: http://127.0.0.1:${a.port} (Ctrl-C to stop)`)
    console.log(ctx.deck.mailbox ? `jq-deck: mailbox ${ctx.deck.mailbox}` : 'jq-deck: no mailbox found (pass --mailbox DIR to show mail)')
  })
}
