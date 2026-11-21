/**
 * JQ Agents: the one file this tool writes.
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
