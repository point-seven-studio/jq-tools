/**
 * Is a newer version of this tool on npm?
 *
 * THE SAME FILE IN FOUR PACKAGES: deck, agents, groundcrew and crosstalk. Edit the copy in
 * packages/deck and run `node scripts/check-shared.mjs --write`. jq-deck-server has no
 * copy: that server calls nothing.
 *
 * This is the one outbound call a JQ tool makes without being asked, so the rules are
 * narrow and each build checks them:
 *
 *  - One address, and only one: https://registry.npmjs.org/<package>/latest. The request
 *    carries nothing about the machine, the project or a session. npm sees the package's
 *    name and the caller's network address, as it does on an install.
 *  - At most once a day per tool. The answer is kept in ~/.jq/update-check.json and read
 *    from there the rest of the day.
 *  - Only when a person starts the tool in a terminal to serve its page. Never for --json,
 *    --html or --watch, never from a login job (no terminal), never in CI.
 *  - It waits for nothing. The page is served at once; the check has two seconds, and a
 *    failure of any kind is silent.
 *  - It only tells. It installs nothing and changes nothing but its own small file.
 *
 * To turn it off: --no-update-check, or JQ_NO_UPDATE_CHECK=1, or "updateCheck": false in
 * ~/.jq/config.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

export const REGISTRY = 'https://registry.npmjs.org'
export const CHECK_EVERY_MS = 24 * 3_600_000
export const CHECK_TIMEOUT_MS = 2_000

export interface UpdateNotice {
  installed: string
  latest: string
  /** What to type to get it. */
  command: string
}

const parts = (v: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `latest` is a later release than `installed`. False when either is not a version, such as "dev". */
export function isNewer(latest: string, installed: string): boolean {
  const a = parts(latest)
  const b = parts(installed)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** The command that gets the newest version: through npx when that is how this one was started, else a global install. */
export function updateCommand(pkg: string, script: string | undefined): string {
  return /[\\/]_npx[\\/]/.test(script ?? '') ? `npx ${pkg}@latest` : `npm install -g ${pkg}@latest`
}

export interface CheckSwitches {
  argv: string[]
  env: Record<string, string | undefined>
  /** Whether the tool was started in a terminal. */
  isTTY: boolean
  /** The JQ config file. */
  configFile: string
}

/** Whether this start may ask npm at all. */
export function checkAllowed(s: CheckSwitches): boolean {
  if (s.argv.includes('--no-update-check')) return false
  const off = s.env.JQ_NO_UPDATE_CHECK
  if (off && off !== '0' && off.toLowerCase() !== 'false') return false
  if (s.env.CI) return false
  if (!s.isTTY) return false
  try {
    if (existsSync(s.configFile) && JSON.parse(readFileSync(s.configFile, 'utf-8'))?.updateCheck === false) return false
  } catch {
    /* an unreadable config file does not turn the check off */
  }
  return true
}

interface Kept {
  checked_at: string
  latest: string
}

function readState(file: string): Record<string, Kept> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** What was last learned about a package, and whether that is recent enough to skip asking again. */
export function readKept(pkg: string, stateFile: string, now: number): { latest: string | null; fresh: boolean } {
  const kept = readState(stateFile)[pkg]
  if (!kept || typeof kept.latest !== 'string' || !parts(kept.latest)) return { latest: null, fresh: false }
  const age = now - Date.parse(kept.checked_at)
  return { latest: kept.latest, fresh: Number.isFinite(age) && age >= 0 && age < CHECK_EVERY_MS }
}

function keep(pkg: string, latest: string, stateFile: string, now: number): void {
  try {
    const all = readState(stateFile)
    all[pkg] = { checked_at: new Date(now).toISOString(), latest }
    mkdirSync(path.dirname(stateFile), { recursive: true })
    const temp = `${stateFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, stateFile)
  } catch {
    /* not being able to remember only means asking again next time */
  }
}

/** Ask npm for the latest version of one package. Null on any failure, a slow answer, or an answer that is not a version. */
export async function askRegistry(pkg: string, ask: typeof fetch = fetch, timeoutMs = CHECK_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await ask(`${REGISTRY}/${pkg}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    if (!res.ok) return null
    const version = (await res.json())?.version
    return typeof version === 'string' && parts(version) ? version : null
  } catch {
    return null
  }
}

export interface StartOptions extends Partial<CheckSwitches> {
  stateFile?: string
  now?: number
  ask?: typeof fetch
  /** Called once, when a newer version is found. */
  say?: (line: string) => void
  /** The path this tool was started from, to tell npx from an install. */
  script?: string
}

const home = () => os.homedir()

/**
 * Start the check and return a function that gives the notice, if there is one yet. The
 * function answers at once: from what is kept on file to begin with, and from npm's answer
 * once it arrives. Nothing here waits, and nothing here throws.
 */
export function startUpdateCheck(pkg: string, installed: string, o: StartOptions = {}): () => UpdateNotice | null {
  const env = o.env ?? process.env
  const switches: CheckSwitches = {
    argv: o.argv ?? process.argv.slice(2),
    env,
    isTTY: o.isTTY ?? !!process.stdout.isTTY,
    configFile: o.configFile ?? env.JQ_CONFIG ?? path.join(home(), '.jq', 'config.json'),
  }
  if (!parts(installed) || !checkAllowed(switches)) return () => null
  const stateFile = o.stateFile ?? path.join(home(), '.jq', 'update-check.json')
  const now = o.now ?? Date.now()
  const command = updateCommand(pkg, o.script ?? process.argv[1])
  let said = false
  const noticeFor = (latest: string | null): UpdateNotice | null => {
    if (!latest || !isNewer(latest, installed)) return null
    if (!said) {
      said = true
      o.say?.(`${pkg} ${latest} is out; this is ${installed}. To update: ${command}  (to stop this check: --no-update-check)`)
    }
    return { installed, latest, command }
  }
  const kept = readKept(pkg, stateFile, now)
  let notice = noticeFor(kept.latest)
  if (!kept.fresh) {
    void askRegistry(pkg, o.ask).then((latest) => {
      if (!latest) return
      keep(pkg, latest, stateFile, now)
      notice = noticeFor(latest)
    })
  }
  return () => notice
}
