/**
 * JQ Agents: the one file this tool writes.
 *
 * Two keys are this tool's: `turnCheck` and, from the page's own button, `questions`.
 *
 * Corrections to the turn check (see turn-check.ts) are kept under the `turnCheck` key of
 * ~/.jq/config.json, the file JQ Deck also reads. Every other key in the file is left as it
 * was. The write goes to a temporary file first and is then renamed, so a crash cannot leave
 * half a file behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { parseConfig, type TurnCheckConfig } from './turn-check.js'

export function defaultConfigFile(): string {
  return process.env.JQ_CONFIG || path.join(os.homedir(), '.jq', 'config.json')
}

function readAll(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  const parsed = JSON.parse(readFileSync(file, 'utf-8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object`)
  return parsed as Record<string, unknown>
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p)

/**
 * Folders whose question text the page may show, saved from the page (see questions.ts).
 * The `questions` key, which JQ Deck reads too. A missing or unreadable file is none.
 */
export function readQuestionTrees(file = defaultConfigFile()): string[] {
  try {
    const list = readAll(file).questions
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string' && !!t).map((t) => path.resolve(expandHome(t))) : []
  } catch {
    return []
  }
}

/** Save the folders. Every other key is left as it was. Throws if the file is not valid JSON, as writeTurnCheckConfig does. */
export function writeQuestionTrees(trees: string[], file = defaultConfigFile()): void {
  const all = readAll(file)
  all.questions = [...new Set(trees)]
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
}

/** The corrections on file. A missing file is no corrections; an unreadable one is too, and is left alone. */
export function readTurnCheckConfig(file = defaultConfigFile()): TurnCheckConfig {
  try {
    return parseConfig(readAll(file).turnCheck)
  } catch {
    return parseConfig(null)
  }
}

/**
 * Save the corrections. Throws if the file exists and is not valid JSON: overwriting it would
 * lose whatever a person had in it.
 */
export function writeTurnCheckConfig(config: TurnCheckConfig, file = defaultConfigFile()): void {
  const all = readAll(file)
  all.turnCheck = config
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
}
