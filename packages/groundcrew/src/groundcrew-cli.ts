/**
 * JQ Groundcrew: the command line.
 *
 * main.ts calls runLocal() here for the page, --html and --json. This file uses the
 * filesystem and a local HTTP server. It imports no database client and makes no
 * outbound call.
 */
import { existsSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import path from 'path'
import { FAIL_ON_LEVELS, failing, layerSummary, runChecks, summarize, type FailOn } from './groundcrew-core.js'
import { canRead, gather, tilde } from './groundcrew-gather.js'
import { renderPage, type Report } from './groundcrew-page.js'
import { announce, readRunning, readTeamUrl, toolbar } from './presence.js'

export const DEFAULT_PORT = 4317

export function report(project: string): Report {
  const { facts, filesRead } = gather(project)
  const checks = runChecks(facts)
  return { project: tilde(project), generatedAt: new Date().toLocaleString('en-US'), filesRead, checks, summary: summarize(checks), layers: layerSummary(checks) }
}

export interface Parsed {
  project: string
  flags: Set<string>
  html: string | null
  port: number
  /** With --json or --html: exit 1 when a check is at this level or worse. */
  failOn: FailOn | null
}

/** Read the arguments. Options that take a value are --html <file>, --port <number> and --fail-on <fail|warn>. */
export function parseArgs(args: string[], defaultProject: string): Parsed {
  const valueAfter = (flag: string) => {
    const at = args.indexOf(flag)
    return at === -1 ? null : { at, value: args[at + 1] }
  }
  const html = valueAfter('--html')
  const port = valueAfter('--port')
  const failOn = valueAfter('--fail-on')
  if (html && (!html.value || html.value.startsWith('--'))) throw new Error('--html needs a file name')
  const portNumber = port ? Number(port.value) : DEFAULT_PORT
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('--port needs a number from 1 to 65535')
  if (failOn && !FAIL_ON_LEVELS.includes(failOn.value as FailOn)) throw new Error('--fail-on needs fail or warn')
  if (failOn && !html && !args.includes('--json')) throw new Error('--fail-on works with --json or --html, not with the page server')
  const taken = new Set([html?.at, port?.at, failOn?.at].filter((at): at is number => at !== undefined).map((at) => at + 1))
  const dir = args.find((arg, i) => !arg.startsWith('--') && !taken.has(i))
  const project = path.resolve(dir || defaultProject)
  if (!existsSync(project) || !canRead(project)) throw new Error(`cannot read the folder: ${project}`)
  return { project, flags: new Set(args.filter((arg) => arg.startsWith('--'))), html: html?.value ?? null, port: portNumber, failOn: (failOn?.value as FailOn) ?? null }
}

/**
 * The exit code for --fail-on, with one line per counted check on stderr, so stdout stays the
 * report alone and a CI log still says what failed.
 */
export function exitCodeFor(checks: Report['checks'], failOn: FailOn | null): number {
  if (!failOn) return 0
  const counted = failing(checks, failOn)
  for (const check of counted) console.error(`groundcrew: ${check.status}: ${check.title}`)
  return counted.length ? 1 : 0
}

/**
 * Print the report, write the page, or serve it on this machine only. Returns the exit code
 * for --json and --html, which is 0 unless --fail-on counts a check.
 */
export function runLocal(parsed: Parsed): number {
  const { project } = parsed
  if (parsed.flags.has('--json')) {
    const result = report(project)
    console.log(JSON.stringify(result, null, 2))
    return exitCodeFor(result.checks, parsed.failOn)
  }
  if (parsed.html) {
    const result = report(project)
    writeFileSync(parsed.html, renderPage(result))
    console.log(`wrote ${parsed.html}`)
    return exitCodeFor(result.checks, parsed.failOn)
  }
  createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end('not found')
      return
    }
    // Every request reads the files again, so a refresh shows a change at once.
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderPage(report(project), toolbar({ here: 'groundcrew', running: readRunning(), team: readTeamUrl() })))
  }).listen(parsed.port, '127.0.0.1', () => {
    // Tell the other JQ pages on this machine where this one is, until it stops.
    announce('groundcrew', parsed.port)
    console.log(`JQ Groundcrew for ${tilde(project)}: http://127.0.0.1:${parsed.port}  (Ctrl+C to stop)`)
  })
  return 0
}
