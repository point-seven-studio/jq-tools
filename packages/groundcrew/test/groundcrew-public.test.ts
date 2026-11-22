/**
 * The `jq-groundcrew` package makes one promise:
 * it runs on their machine and sends nothing anywhere. This test reads the source files that
 * the public bundle is built from and fails if any of them reaches for a database, an env
 * loader or the network. It also checks the argument reader.
 */
import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_PORT, exitCodeFor, parseArgs } from '../src/groundcrew-cli.js'
import { failing, type Check } from '../src/groundcrew-core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (file: string) => readFileSync(path.join(here, file), 'utf-8')

/** Everything the bundle is built from. */
const PUBLIC_SOURCES = ['../src/main.ts', '../src/groundcrew-cli.ts', '../src/groundcrew-core.ts', '../src/groundcrew-gather.ts', '../src/groundcrew-page.ts', '../src/presence.ts']

describe('the public bundle', () => {
  test('is built only from files that import the filesystem, the OS, paths and a local server', () => {
    const allowed = new Set(['fs', 'os', 'path', 'http'])
    for (const file of PUBLIC_SOURCES) {
      const imports = [...read(file).matchAll(/from '([^']+)'/g)].map((m) => m[1])
      for (const name of imports) {
        // presence.ts is the bar of links to the other tools; it is held to the same rule, above.
        // update-check.ts is the one file that calls out. It is held by the test below and by scripts/check-outbound.mjs.
        const ok = name.startsWith('./groundcrew-') || name === './presence.js' || name === './update-check.js' || allowed.has(name)
        expect(`${file} imports ${name}: ${ok ? 'ok' : 'NOT ALLOWED'}`).toBe(`${file} imports ${name}: ok`)
      }
    }
  })
  test('names no database, env loader or outbound call', () => {
    for (const file of PUBLIC_SOURCES) {
      // The page holds one inline script that copies to the clipboard; it makes no request.
      expect(read(file)).not.toMatch(/supabase|dotenv|SERVICE_ROLE|\bfetch\(|https\.request|XMLHttpRequest|WebSocket|sendBeacon|await import\(/)
    }
  })
  test('calls out from one file only, to npm, for a version number', () => {
    const source = read('../src/update-check.ts')
    expect(source).toContain("export const REGISTRY = 'https://registry.npmjs.org'")
    expect(source).toContain('`${REGISTRY}/${pkg}/latest`')
    // It imports the filesystem, the OS and paths, and nothing that could send more.
    expect([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort()).toEqual(['fs', 'os', 'path'])
    // One address is written in it, and the request has no body.
    expect([...new Set(source.match(/https?:\/\/[a-zA-Z0-9./_-]+/g))].sort()).toEqual(['https://registry.npmjs.org', 'https://registry.npmjs.org/'])
    expect(source).not.toMatch(/method:|body:|POST|PUT/)
  })
  test('listens on this machine only', () => {
    expect(read('../src/groundcrew-cli.ts')).toContain(".listen(parsed.port, '127.0.0.1'")
  })
  test('the public entry has no --sync', () => {
    expect(read('../src/main.ts')).not.toMatch(/flags\.has\('--sync'\)|agent_setup_status/)
  })
})

describe('parseArgs', () => {
  const tmp = os.tmpdir()
  test('defaults to the given folder and the default port', () => {
    const parsed = parseArgs([], tmp)
    expect([parsed.project, parsed.port, parsed.html]).toEqual([path.resolve(tmp), DEFAULT_PORT, null])
  })
  test('does not take the value of an option as the folder', () => {
    const parsed = parseArgs(['--html', 'out.html', '--port', '5000', tmp], '/nowhere')
    expect([parsed.project, parsed.html, parsed.port]).toEqual([path.resolve(tmp), 'out.html', 5000])
    expect(parseArgs(['--html', 'out.html'], tmp).project).toBe(path.resolve(tmp))
  })
  test('refuses a missing value, a bad port and a folder it cannot read', () => {
    expect(() => parseArgs(['--html'], tmp)).toThrow('--html needs a file name')
    expect(() => parseArgs(['--html', '--json'], tmp)).toThrow('--html needs a file name')
    expect(() => parseArgs(['--port', 'eighty'], tmp)).toThrow('--port needs a number')
    expect(() => parseArgs(['--port', '70000'], tmp)).toThrow('--port needs a number')
    expect(() => parseArgs([], path.join(tmp, 'no-such-folder-groundcrew'))).toThrow('cannot read the folder')
  })
})

describe('--fail-on, for CI', () => {
  const tmp = os.tmpdir()
  const row = (status: Check['status']): Check => ({ id: status, group: 'setup', layer: 'guides', title: `a ${status} row`, status, detail: '', fix: '', source: '', prompt: '' })
  const rows = (...statuses: Check['status'][]) => statuses.map(row)

  test('reads the level, and does not take it as the folder', () => {
    expect(parseArgs(['--json', '--fail-on', 'fail'], tmp).failOn).toBe('fail')
    expect(parseArgs(['--html', 'out.html', '--fail-on', 'warn', tmp], '/nowhere')).toMatchObject({ failOn: 'warn', project: path.resolve(tmp) })
    expect(parseArgs(['--json'], tmp).failOn).toBeNull()
  })
  test('refuses a bad level, and refuses the page server, which never exits', () => {
    expect(() => parseArgs(['--json', '--fail-on', 'info'], tmp)).toThrow('--fail-on needs fail or warn')
    expect(() => parseArgs(['--json', '--fail-on'], tmp)).toThrow('--fail-on needs fail or warn')
    expect(() => parseArgs(['--fail-on', 'fail'], tmp)).toThrow('--fail-on works with --json or --html')
  })
  test('fail counts fails only; warn counts both; info never counts', () => {
    const all = rows('pass', 'info', 'warn', 'fail')
    expect(failing(all, 'fail').map((c) => c.status)).toEqual(['fail'])
    expect(failing(all, 'warn').map((c) => c.status)).toEqual(['warn', 'fail'])
    expect(failing(rows('pass', 'info'), 'warn')).toEqual([])
  })
  test('the exit code is 0 without the flag, and 1 only when a check is counted', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(exitCodeFor(rows('fail'), null)).toBe(0)
      expect(exitCodeFor(rows('warn', 'pass'), 'fail')).toBe(0)
      expect(exitCodeFor(rows('warn', 'pass'), 'warn')).toBe(1)
      expect(exitCodeFor(rows('fail'), 'fail')).toBe(1)
      expect(quiet).toHaveBeenCalledWith('groundcrew: fail: a fail row')
    } finally {
      quiet.mockRestore()
    }
  })
})
