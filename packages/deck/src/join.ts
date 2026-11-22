/**
 * `jq-deck join` and `jq-deck leave`: set a machine up to report to a board, and undo it.
 *
 * `--watch --exec` reports only while its terminal stays open. `join` does the rest:
 * it sends one report to prove the address and the token work, keeps the token in a
 * file only this user can read, and installs a login job that keeps reporting.
 *
 * Everything it writes is under ~/.jq, plus one job file where the system looks for
 * them. `leave` removes all of it. The repositories reported are the ones you name;
 * nothing is added to that list for you.
 *
 * The job runs a short script you can read: ~/.jq/deck-report.sh. This file still
 * makes no outbound call of its own. The report is sent by `jq-deck-server send`.
 */
import { spawn } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { createInterface } from 'readline'
import { collectOverview } from './collect.js'
import { defaultConfigFile, expandHome, findMailbox, loadConfig, reportable, teamReport, type TeamReport } from './deck.js'

export const JOB_LABEL = 'studio.pointseven.jq-deck-report'
export const UNIT_NAME = 'jq-deck-report.service'

export interface JoinArgs {
  url: string
  repos: string[] | null
  sendQuestions: string[] | null
  intervalS: number
  /** The board's own page, saved as "team" so the local pages can link to it. */
  board: string | null
  service: boolean
  config: string
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

export function parseJoin(argv: string[], env: Record<string, string | undefined> = {}): JoinArgs {
  const a: JoinArgs = { url: '', repos: null, sendQuestions: null, intervalS: 60, board: null, service: true, config: env.JQ_DECK_CONFIG || defaultConfigFile() }
  const value = (i: number, flag: string) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]
    if (f === '--url') a.url = value(i++, f)
    else if (f === '--repos') a.repos = list(value(i++, f))
    else if (f === '--send-questions') a.sendQuestions = list(value(i++, f))
    else if (f === '--interval') a.intervalS = Number(value(i++, f))
    else if (f === '--board') a.board = value(i++, f)
    else if (f === '--no-service') a.service = false
    else if (f === '--config') a.config = value(i++, f)
    else if (f === '--all-repos') throw new Error('join does not take --all-repos: name the repositories this machine may report, with --repos')
    else throw new Error(`unknown option: ${f}`)
  }
  if (!a.url) throw new Error('join needs --url: the address the board gave you for reports')
  if (!(a.intervalS >= 15)) throw new Error('--interval needs 15 seconds or more')
  for (const [flag, v] of [['--url', a.url], ['--board', a.board]] as const) {
    if (v === null) continue
    let u: URL
    try {
      u = new URL(v)
    } catch {
      throw new Error(`${flag} is not an address: ${v}`)
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${flag} must be an http or https address`)
    if (u.username || u.password) throw new Error(`${flag} must not hold a user name or password`)
  }
  return a
}

/** Where everything join writes lives. `home` is passed in so tests use a folder of their own. */
export function joinPaths(home: string, platform: NodeJS.Platform = process.platform) {
  const jq = path.join(home, '.jq')
  return {
    dir: jq,
    token: path.join(jq, 'deck-token'),
    script: path.join(jq, 'deck-report.sh'),
    log: path.join(jq, 'deck-report.log'),
    job: platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', `${JOB_LABEL}.plist`) : platform === 'linux' ? path.join(home, '.config', 'systemd', 'user', UNIT_NAME) : null,
  }
}

/**
 * The script is built by putting paths inside quotes. A path holding a quote, a dollar
 * sign, a backtick, a backslash or a line break could end the quotes early, so such a
 * path is refused. It is never escaped and hoped for.
 */
export function safeForScript(what: string, value: string): string {
  if (/['"$`\\\r\n]/.test(value)) throw new Error(`${what} holds a character that cannot go in the report script (a quote, $, backtick, backslash or line break): ${value}`)
  return value
}

export interface ScriptParts {
  node: string
  deck: string
  server: string
  url: string
  tokenFile: string
  configFile: string
  intervalS: number
}

export function reportScript(p: ScriptParts): string {
  const q = (what: string, v: string) => `'${safeForScript(what, v)}'`
  const send = `${q('the path to node', p.node)} ${q('the path to jq-deck-server', p.server)} send --url ${q('--url', p.url)}`
  return `#!/bin/sh
# Written by \`jq-deck join\`. Reports this machine's listed repositories to the address below.
# The repositories are the "report" list in ${safeForScript('the config file path', p.configFile)}.
# To stop and remove this: jq-deck leave
export PATH="${safeForScript('the path to node', path.dirname(p.node))}:/usr/local/bin:/usr/bin:/bin"
JQ_DECK_TOKEN="$(cat ${q('the token file path', p.tokenFile)})"
export JQ_DECK_TOKEN
exec ${q('the path to node', p.node)} ${q('the path to jq-deck', p.deck)} --watch --quiet --interval ${Math.floor(p.intervalS)} --config ${q('the config file path', p.configFile)} --exec "${send}"
`
}

const xml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)

/** A launchd job (macOS): started at login, restarted if it stops. */
export function launchdPlist(o: { script: string; log: string; home: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${JOB_LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(o.script)}</string></array>
  <key>WorkingDirectory</key><string>${xml(o.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict></plist>
`
}

/** A systemd user unit (Linux). */
export function systemdUnit(o: { script: string; log: string; home: string }): string {
  return `[Unit]
Description=JQ Deck: report this machine's listed repositories to a board
After=network-online.target

[Service]
ExecStart=/bin/sh "${o.script}"
WorkingDirectory=${o.home}
Restart=always
RestartSec=60
StandardOutput=append:${o.log}
StandardError=append:${o.log}

[Install]
WantedBy=default.target
`
}

/**
 * On macOS a job started by the system may not read Desktop, Documents or Downloads
 * unless the program is given Full Disk Access. Returns the folder's name when `tree`
 * is inside one of them.
 */
export function protectedFolder(tree: string, home: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'darwin') return null
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const dir = path.join(home, name)
    if (tree === dir || tree.startsWith(dir + path.sep)) return name
  }
  return null
}

/** Listed names that matched no repository with a session: usually a spelling slip. */
export function unmatched(listed: string[], repos: { name: string; remote: string | null; tree: string }[]): string[] {
  return listed.filter((name) => !repos.some((r) => reportable(r, [name])))
}

/** Sets keys in the config file and keeps every other key as it was. */
export function mergeConfig(file: string, set: Record<string, unknown>): void {
  let current: Record<string, unknown> = {}
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`)
    current = raw
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...current, ...set }, null, 2) + '\n', { mode: 0o600 })
}

/** The first file of this name on PATH, with links followed. Looked up by reading folders: nothing is run. */
export function findOnPath(name: string, envPath: string | undefined): string | null {
  for (const dir of (envPath || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name)
    try {
      if (statSync(file).isFile()) return realpathSync(file)
    } catch {
      /* not here */
    }
  }
  return null
}

/* ── What follows touches the machine ────────────────────────────────── */

function runQuiet(cmd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], env: env ?? process.env })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ code: 127, err: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, err: err.trim() }))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer.trim()))))
}

async function startJob(platform: NodeJS.Platform, job: string): Promise<string | null> {
  if (platform === 'darwin') {
    const domain = `gui/${process.getuid?.() ?? 501}`
    await runQuiet('launchctl', ['bootout', `${domain}/${JOB_LABEL}`]) // an older copy, if any; failing is fine
    const r = await runQuiet('launchctl', ['bootstrap', domain, job])
    return r.code === 0 ? null : `launchctl could not start the job (${r.err || `exit ${r.code}`})`
  }
  await runQuiet('systemctl', ['--user', 'daemon-reload'])
  const r = await runQuiet('systemctl', ['--user', 'enable', '--now', UNIT_NAME])
  return r.code === 0 ? null : `systemctl could not start the job (${r.err || `exit ${r.code}`})`
}

async function stopJob(platform: NodeJS.Platform): Promise<void> {
  if (platform === 'darwin') await runQuiet('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${JOB_LABEL}`])
  else if (platform === 'linux') await runQuiet('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
}

export async function join(argv: string[], env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<void> {
  const a = parseJoin(argv, env)
  const platform = process.platform
  const paths = joinPaths(home, platform)
  const configFile = path.resolve(expandHome(a.config))
  const config = loadConfig(configFile)
  const repos = a.repos ?? config.report ?? []
  if (repos.length === 0) throw new Error('join needs to know which repositories this machine may report: --repos name,name')
  const sendQuestions = (a.sendQuestions ?? config.sendQuestions ?? []).map((t) => path.resolve(expandHome(t)))

  const node = process.execPath
  const deck = realpathSync(process.argv[1])
  if (/[\\/]_npx[\\/]/.test(deck)) throw new Error('join needs jq-deck installed, not run through npx: the login job must find it after a restart.\n  npm install -g @point-seven-studio/jq-deck @point-seven-studio/jq-deck-server')
  const server = findOnPath('jq-deck-server', env.PATH)
  if (!server) throw new Error('join sends reports with jq-deck-server, which is not installed:\n  npm install -g @point-seven-studio/jq-deck-server')

  const token = env.JQ_DECK_TOKEN || (process.stdin.isTTY ? await ask("This machine's token (it starts with jqm_): ") : '')
  if (!token) throw new Error('join needs this machine\'s token: set $JQ_DECK_TOKEN, or run join in a terminal and paste it when asked')
  if (/\s/.test(token)) throw new Error('that does not look like a token: it has a space in it')

  // One real report first. Nothing is written until the board has accepted it.
  const overview = await collectOverview({ mailbox: findMailbox({ config: config.mailbox, env: env.CROSSTALK_DIR, cwd: home }), names: config.names, questionTrees: sendQuestions, maxAgeDays: 3, cwd: home })
  const report: TeamReport = teamReport(overview, repos, sendQuestions)
  const sent = await runQuiet(node, [server, 'send', '--url', a.url], JSON.stringify(report), { ...env, JQ_DECK_TOKEN: token })
  if (sent.code !== 0) throw new Error(`the board did not accept a report, so nothing was set up.\n  ${sent.err || `jq-deck-server send exited ${sent.code}`}`)
  console.log(`jq-deck: the board accepted a report of ${report.repos.length} ${report.repos.length === 1 ? 'repository' : 'repositories'}`)
  const missing = unmatched(repos, overview.repos)
  if (missing.length) console.log(`jq-deck: no Claude Code session was found for: ${missing.join(', ')}. A repository is reported once it has a session; check the spelling if you expected one.`)

  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  writeFileSync(paths.token, token + '\n', { mode: 0o600 })
  chmodSync(paths.token, 0o600)
  mergeConfig(configFile, { report: repos, ...(a.sendQuestions ? { sendQuestions: a.sendQuestions } : {}), ...(a.board ? { team: a.board } : {}) })
  writeFileSync(paths.script, reportScript({ node, deck, server, url: a.url, tokenFile: paths.token, configFile, intervalS: a.intervalS }), { mode: 0o700 })
  chmodSync(paths.script, 0o700)
  console.log(`jq-deck: token saved to ${paths.token} (readable by you only)`)
  console.log(`jq-deck: reporting ${repos.join(', ')}; question text ${sendQuestions.length ? `IS sent for sessions under ${sendQuestions.join(', ')}` : 'is not sent'}`)

  const byHand = `  sh ${paths.script}`
  if (!a.service || !paths.job) {
    console.log(a.service ? `jq-deck: no login job is set up on this system. To report, keep this running:\n${byHand}` : `jq-deck: no login job installed (--no-service). To report, keep this running:\n${byHand}`)
    return
  }
  mkdirSync(path.dirname(paths.job), { recursive: true })
  const jobParts = { script: paths.script, log: paths.log, home }
  writeFileSync(paths.job, platform === 'darwin' ? launchdPlist(jobParts) : systemdUnit(jobParts))
  const failed = await startJob(platform, paths.job)
  if (failed) {
    console.log(`jq-deck: ${failed}. The job file is at ${paths.job}. Until that is sorted, keep this running:\n${byHand}`)
    return
  }
  console.log(`jq-deck: a login job now reports every ${a.intervalS}s and starts again after a restart. Its log: ${paths.log}`)
  console.log('jq-deck: to stop and remove all of this: jq-deck leave')

  const blocked = [...new Set(overview.repos.filter((r) => reportable(r, repos)).map((r) => protectedFolder(r.tree, home, platform)).filter(Boolean))]
  if (blocked.length) {
    console.log(`\njq-deck: NOTE. Some of these repositories are under ${blocked.join(' and ')}. macOS does not let a login job read those folders,`)
    console.log('so their rows may show no git remote and no setup score. Either:')
    console.log(`  - give this program Full Disk Access (System Settings, Privacy & Security, Full Disk Access, add ${node}), then run: jq-deck join again`)
    console.log(`  - or run: jq-deck leave, and keep the reporter in a terminal instead:\n  ${byHand}`)
  }
}

export async function leave(home = os.homedir()): Promise<void> {
  const platform = process.platform
  const paths = joinPaths(home, platform)
  await stopJob(platform)
  const removed: string[] = []
  for (const file of [paths.job, paths.script, paths.token]) {
    if (file && existsSync(file)) {
      rmSync(file)
      removed.push(file)
    }
  }
  console.log(removed.length ? `jq-deck: stopped reporting and removed:\n${removed.map((f) => `  ${f}`).join('\n')}` : 'jq-deck: nothing to remove; this machine was not set up with join')
  console.log(`jq-deck: the log (${paths.log}) and your config file are left as they are. The token still works until you remove this machine on the board.`)
}
