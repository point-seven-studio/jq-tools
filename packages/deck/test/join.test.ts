/** The parts of `join` that decide what is written. Every folder is made here; no job is started. */
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/cli.js'
import { JOB_LABEL, findOnPath, joinPaths, launchdPlist, mergeConfig, parseJoin, protectedFolder, reportScript, safeForScript, systemdUnit, unmatched } from '../src/join.js'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'jq-deck-join-'))
const parts = { node: '/opt/node/bin/node', deck: '/opt/lib/jq-deck.mjs', server: '/opt/lib/jq-deck-server.mjs', url: 'https://api.example.com/api/jq-deck/report', tokenFile: '/home/dana/.jq/deck-token', configFile: '/home/dana/.jq/config.json', intervalS: 60 }

describe('parseJoin', () => {
  it('reads its options', () => {
    expect(parseJoin(['--url', 'https://deck.example.com', '--repos', 'shop, api', '--board', 'https://deck.example.com', '--interval', '30', '--no-service'], {})).toMatchObject({ url: 'https://deck.example.com', repos: ['shop', 'api'], board: 'https://deck.example.com', intervalS: 30, service: false, sendQuestions: null })
  })
  it('refuses what would report more than was named, or an address that is not one', () => {
    expect(() => parseJoin([], {})).toThrow('--url')
    expect(() => parseJoin(['--url', 'https://x.example', '--all-repos'], {})).toThrow('name the repositories')
    expect(() => parseJoin(['--url', 'deck'], {})).toThrow('not an address')
    expect(() => parseJoin(['--url', 'ftp://x.example'], {})).toThrow('http or https')
    expect(() => parseJoin(['--url', 'https://user:pw@x.example'], {})).toThrow('user name')
    expect(() => parseJoin(['--url', 'https://x.example', '--board', 'javascript:alert(1)'], {})).toThrow('http or https')
    expect(() => parseJoin(['--url', 'https://x.example', '--interval', '5'], {})).toThrow('15 seconds')
    expect(() => parseJoin(['--url', 'https://x.example', '--wat'], {})).toThrow('unknown option')
    expect(() => parseJoin(['--url'], {})).toThrow('needs a value')
  })
})

describe('the report script', () => {
  it('runs the reporter with the token read from its file, never written into the script', () => {
    const script = reportScript(parts)
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(`JQ_DECK_TOKEN="$(cat '/home/dana/.jq/deck-token')"`)
    expect(script).toContain(`exec '/opt/node/bin/node' '/opt/lib/jq-deck.mjs' --watch --quiet --interval 60 --config '/home/dana/.jq/config.json' --exec "'/opt/node/bin/node' '/opt/lib/jq-deck-server.mjs' send --url 'https://api.example.com/api/jq-deck/report'"`)
    expect(script).toContain('export PATH="/opt/node/bin:')
    expect(script).not.toMatch(/jqm_|--all-repos|--send-questions/)
    expect(script).toContain('jq-deck leave')
  })
  it('refuses a path or address that could break out of its quotes', () => {
    for (const bad of ["/opt/it's/node", '/opt/"x"/node', '/opt/$HOME/node', '/opt/`id`/node', '/opt/a\\b', '/opt/a\nb']) {
      expect(() => safeForScript('the path', bad)).toThrow('cannot go in the report script')
      expect(() => reportScript({ ...parts, node: bad })).toThrow()
    }
    expect(() => reportScript({ ...parts, url: "https://x.example/report'; rm -rf ~ #" })).toThrow()
    expect(() => reportScript({ ...parts, url: 'https://x.example/$(id)/report' })).toThrow()
    expect(safeForScript('the path', '/Users/dana/My Code/node')).toBe('/Users/dana/My Code/node')
  })
})

describe('the login job', () => {
  it('is a launchd job that runs the script at login and again if it stops', () => {
    const plist = launchdPlist({ script: '/Users/dana/.jq/deck-report.sh', log: '/Users/dana/.jq/deck-report.log', home: '/Users/dana' })
    expect(plist).toContain(`<key>Label</key><string>${JOB_LABEL}</string>`)
    expect(plist).toContain('<array><string>/bin/sh</string><string>/Users/dana/.jq/deck-report.sh</string></array>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(launchdPlist({ script: '/Users/a&b/<x>.sh', log: '/l', home: '/h' })).toContain('/Users/a&amp;b/&lt;x&gt;.sh')
  })
  it('is a systemd user unit on Linux', () => {
    const unit = systemdUnit({ script: '/home/dana/.jq/deck-report.sh', log: '/home/dana/.jq/deck-report.log', home: '/home/dana' })
    expect(unit).toContain('ExecStart=/bin/sh "/home/dana/.jq/deck-report.sh"')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
  })
  it('knows where each file goes, and that some systems have no login job', () => {
    expect(joinPaths('/Users/dana', 'darwin')).toMatchObject({ token: '/Users/dana/.jq/deck-token', script: '/Users/dana/.jq/deck-report.sh', job: `/Users/dana/Library/LaunchAgents/${JOB_LABEL}.plist` })
    expect(joinPaths('/home/dana', 'linux').job).toBe('/home/dana/.config/systemd/user/jq-deck-report.service')
    expect(joinPaths('/home/dana', 'win32').job).toBeNull()
  })
})

describe('what join warns about', () => {
  it('names a folder macOS keeps from a login job, on macOS only', () => {
    expect(protectedFolder('/Users/dana/Desktop/code/shop', '/Users/dana', 'darwin')).toBe('Desktop')
    expect(protectedFolder('/Users/dana/Documents', '/Users/dana', 'darwin')).toBe('Documents')
    expect(protectedFolder('/Users/dana/Downloads/x', '/Users/dana', 'darwin')).toBe('Downloads')
    expect(protectedFolder('/Users/dana/code/shop', '/Users/dana', 'darwin')).toBeNull()
    expect(protectedFolder('/Users/dana/Desktop-old/shop', '/Users/dana', 'darwin')).toBeNull()
    expect(protectedFolder('/home/dana/Desktop/shop', '/home/dana', 'linux')).toBeNull()
  })
  it('lists a named repository that has no session, so a spelling slip shows', () => {
    const repos = [{ name: 'shop', remote: 'github.com/acme/shop', tree: '/code/shop' }]
    expect(unmatched(['shop', 'shpo'], repos)).toEqual(['shpo'])
    expect(unmatched(['github.com/acme/shop'], repos)).toEqual([])
  })
})

describe('files join writes', () => {
  it('sets its keys in the config file and keeps every other key', () => {
    const file = path.join(tmp(), 'nested', 'config.json')
    mergeConfig(file, { report: ['shop'] })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ report: ['shop'] })
    writeFileSync(file, JSON.stringify({ mailbox: '~/crosstalk', team: 'https://old.example', turnCheck: { extra: ['make verify'] }, report: ['old'] }))
    mergeConfig(file, { report: ['shop', 'api'], team: 'https://deck.example.com' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mailbox: '~/crosstalk', team: 'https://deck.example.com', turnCheck: { extra: ['make verify'] }, report: ['shop', 'api'] })
    expect(statSync(file).mode & 0o077).toBe(0)
    writeFileSync(file, '[1]')
    expect(() => mergeConfig(file, { report: [] })).toThrow('JSON object')
  })
  it('finds a command on PATH by reading folders, following a link to the real file', () => {
    const dir = tmp()
    mkdirSync(path.join(dir, 'lib'))
    mkdirSync(path.join(dir, 'bin'))
    writeFileSync(path.join(dir, 'lib', 'server.mjs'), '')
    symlinkSync(path.join(dir, 'lib', 'server.mjs'), path.join(dir, 'bin', 'jq-deck-server'))
    expect(findOnPath('jq-deck-server', `/nowhere:${path.join(dir, 'bin')}`)).toMatch(/lib\/server\.mjs$/)
    expect(findOnPath('jq-deck-server', '/nowhere')).toBeNull()
    expect(findOnPath('jq-deck-server', undefined)).toBeNull()
  })
})

describe('--quiet', () => {
  it('is a flag of --watch', () => {
    expect(parseArgs(['--watch', '--quiet', '--exec', 'cat', '--repos', 'shop'], {}).quiet).toBe(true)
    expect(parseArgs(['--watch', '--exec', 'cat', '--repos', 'shop'], {}).quiet).toBe(false)
  })
})
