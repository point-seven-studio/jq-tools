/**
 * The data folder: who may report, who may look, and the latest report from
 * each machine. Plain files, so there is nothing to install and a backup is a
 * copy. Tokens are kept as SHA-256 hashes: the folder alone lets nobody in.
 *
 *   <dir>/config.json            machines and viewers
 *   <dir>/reports/<machine>.json the latest report from that machine
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import type { TeamReport } from './report.js'

export interface Machine {
  name: string
  /** The person at that machine, as the board should show them. */
  who: string
  token_sha256: string
}

export interface Viewer {
  name: string
  token_sha256: string
  /** When set, this viewer sees only these repositories (by name or remote). */
  repos?: string[]
}

export interface Config {
  machines: Machine[]
  viewers: Viewer[]
}

export interface StoredReport {
  machine: string
  who: string
  /** The server's clock, never the sender's: it decides what is stale. */
  received_at: string
  report: TeamReport
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/
export function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error('a name is 1 to 63 of: a-z 0-9 . _ - (starting with a letter or digit)')
  return name
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const configFile = (dir: string) => path.join(dir, 'config.json')
const reportFile = (dir: string, machine: string) => path.join(dir, 'reports', `${checkName(machine)}.json`)

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

export function initStore(dir: string): void {
  if (existsSync(configFile(dir))) throw new Error(`${dir} is already a jq-deck-server folder`)
  mkdirSync(path.join(dir, 'reports'), { recursive: true })
  chmodSync(dir, 0o700)
  writeAtomic(configFile(dir), JSON.stringify({ machines: [], viewers: [] }, null, 2) + '\n')
}

export function readConfig(dir: string): Config {
  if (!existsSync(configFile(dir))) throw new Error(`not a jq-deck-server folder (run: jq-deck-server init ${dir})`)
  const raw = JSON.parse(readFileSync(configFile(dir), 'utf8'))
  return { machines: Array.isArray(raw?.machines) ? raw.machines : [], viewers: Array.isArray(raw?.viewers) ? raw.viewers : [] }
}

function writeConfig(dir: string, config: Config): void {
  writeAtomic(configFile(dir), JSON.stringify(config, null, 2) + '\n')
}

function taken(config: Config, name: string): boolean {
  return config.machines.some((m) => m.name === name) || config.viewers.some((v) => v.name === name)
}

/** Returns the token. It is shown once and not kept. */
export function addMachine(dir: string, name: string, who: string): string {
  const config = readConfig(dir)
  if (taken(config, checkName(name))) throw new Error(`the name ${name} is in use`)
  const label = who.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60)
  if (!label) throw new Error('--who needs a name to show on the board')
  const token = `jqm_${randomBytes(32).toString('base64url')}`
  config.machines.push({ name, who: label, token_sha256: sha(token) })
  writeConfig(dir, config)
  return token
}

export function addViewer(dir: string, name: string, repos?: string[]): string {
  const config = readConfig(dir)
  if (taken(config, checkName(name))) throw new Error(`the name ${name} is in use`)
  const token = `jqv_${randomBytes(32).toString('base64url')}`
  config.viewers.push({ name, token_sha256: sha(token), ...(repos && repos.length ? { repos } : {}) })
  writeConfig(dir, config)
  return token
}

/** Removes a machine (and its report) or a viewer. False when the name is unknown. */
export function remove(dir: string, name: string): boolean {
  const config = readConfig(dir)
  if (!taken(config, checkName(name))) return false
  config.machines = config.machines.filter((m) => m.name !== name)
  config.viewers = config.viewers.filter((v) => v.name !== name)
  writeConfig(dir, config)
  rmSync(reportFile(dir, name), { force: true })
  return true
}

/** Every entry is compared, so the time taken does not say which one matched. */
function match<T extends { token_sha256: string }>(list: T[], token: string | null | undefined): T | null {
  if (!token || token.length > 200) return null
  const given = Buffer.from(sha(token), 'hex')
  let found: T | null = null
  for (const item of list) {
    const want = Buffer.from(String(item.token_sha256), 'hex')
    if (want.length === given.length && timingSafeEqual(want, given)) found = item
  }
  return found
}

export const machineFor = (config: Config, token: string | null | undefined) => match(config.machines, token)
export const viewerFor = (config: Config, token: string | null | undefined) => match(config.viewers, token)

export function saveReport(dir: string, machine: Machine, report: TeamReport, now: number): void {
  const stored: StoredReport = { machine: machine.name, who: machine.who, received_at: new Date(now).toISOString(), report }
  writeAtomic(reportFile(dir, machine.name), JSON.stringify(stored))
}

/** Reports from machines still in the config. A file that cannot be read is skipped. */
export function readReports(dir: string, config: Config): StoredReport[] {
  const known = new Map(config.machines.map((m) => [m.name, m]))
  const out: StoredReport[] = []
  const folder = path.join(dir, 'reports')
  if (!existsSync(folder)) return out
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.json'))) {
    const machine = known.get(file.slice(0, -5))
    if (!machine) continue
    try {
      const stored = JSON.parse(readFileSync(path.join(folder, file), 'utf8')) as StoredReport
      // The name to show comes from the config, so renaming a person takes effect at once.
      out.push({ ...stored, machine: machine.name, who: machine.who })
    } catch {
      /* half-written or damaged: the next report replaces it */
    }
  }
  return out
}
