/**
 * The update check: when it may ask npm, what it asks, what it keeps, and what it tells.
 * No test here touches the network: every call goes to a stand-in.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { toolbar } from '../src/presence.js'
import { CHECK_EVERY_MS, REGISTRY, askRegistry, checkAllowed, isNewer, readKept, startUpdateCheck, updateCommand } from '../src/update-check.js'

const PKG = '@point-seven-studio/jq-deck'
const NOW = Date.parse('2026-11-22T12:00:00Z')
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'jq-update-'))
const settle = () => new Promise((r) => setTimeout(r, 20))
const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch

describe('isNewer', () => {
  it('compares releases by their three numbers', () => {
    expect(isNewer('0.4.2', '0.4.1')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.4.1', '0.4.1')).toBe(false)
    expect(isNewer('0.4.0', '0.4.1')).toBe(false)
  })
  it('says no when either side is not a version', () => {
    expect(isNewer('0.4.2', 'dev')).toBe(false)
    expect(isNewer('latest', '0.4.1')).toBe(false)
    expect(isNewer('', '')).toBe(false)
  })
})

describe('checkAllowed', () => {
  const on = { argv: [], env: {}, isTTY: true, configFile: '/nowhere/config.json' }
  it('asks when a person started the tool in a terminal', () => {
    expect(checkAllowed(on)).toBe(true)
  })
  it('never asks from a job, in CI, or when told not to', () => {
    expect(checkAllowed({ ...on, isTTY: false })).toBe(false)
    expect(checkAllowed({ ...on, env: { CI: 'true' } })).toBe(false)
    expect(checkAllowed({ ...on, argv: ['--port', '1', '--no-update-check'] })).toBe(false)
    expect(checkAllowed({ ...on, env: { JQ_NO_UPDATE_CHECK: '1' } })).toBe(false)
    expect(checkAllowed({ ...on, env: { JQ_NO_UPDATE_CHECK: 'true' } })).toBe(false)
    expect(checkAllowed({ ...on, env: { JQ_NO_UPDATE_CHECK: '0' } })).toBe(true)
    expect(checkAllowed({ ...on, env: { JQ_NO_UPDATE_CHECK: '' } })).toBe(true)
  })
  it('reads the off switch in the config file, and is not turned off by a broken one', () => {
    const file = path.join(tmp(), 'config.json')
    writeFileSync(file, JSON.stringify({ updateCheck: false, team: 'https://deck.example.com' }))
    expect(checkAllowed({ ...on, configFile: file })).toBe(false)
    writeFileSync(file, JSON.stringify({ updateCheck: true }))
    expect(checkAllowed({ ...on, configFile: file })).toBe(true)
    writeFileSync(file, '{half')
    expect(checkAllowed({ ...on, configFile: file })).toBe(true)
  })
})

describe('askRegistry', () => {
  it('asks one address, for one package, and sends nothing else', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const ask = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ version: '0.4.2', name: PKG }) }
    }) as unknown as typeof fetch
    expect(await askRegistry(PKG, ask)).toBe('0.4.2')
    expect(seen!.url).toBe(`${REGISTRY}/${PKG}/latest`)
    expect(REGISTRY).toBe('https://registry.npmjs.org')
    expect(seen!.init.method).toBeUndefined()
    expect(seen!.init.body).toBeUndefined()
    expect(seen!.init.headers).toEqual({ accept: 'application/json' })
    expect(seen!.init.redirect).toBe('error')
  })
  it('gives nothing, quietly, when npm is unreachable, slow, refuses, or answers with something else', async () => {
    const fails = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await askRegistry(PKG, fails)).toBeNull()
    expect(await askRegistry(PKG, answer({ version: '0.4.2' }, false))).toBeNull()
    expect(await askRegistry(PKG, answer({ version: '<script>' }))).toBeNull()
    expect(await askRegistry(PKG, answer({ version: 42 }))).toBeNull()
    expect(await askRegistry(PKG, answer(null))).toBeNull()
    const slow = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('timed out'))))) as unknown as typeof fetch
    expect(await askRegistry(PKG, slow, 15)).toBeNull()
  })
})

describe('startUpdateCheck', () => {
  const base = () => ({ argv: [], env: {}, isTTY: true, configFile: '/nowhere/config.json', stateFile: path.join(tmp(), 'nested', 'update-check.json'), now: NOW, script: '/usr/local/lib/node_modules/x/dist/jq-deck.mjs' })

  it('tells of a newer version once npm has answered, and keeps the answer', async () => {
    const o = base()
    const said: string[] = []
    const get = startUpdateCheck(PKG, '0.4.1', { ...o, ask: answer({ version: '0.4.2' }), say: (l) => said.push(l) })
    expect(get()).toBeNull() // nothing is known yet, and nothing waited
    await settle()
    expect(get()).toEqual({ installed: '0.4.1', latest: '0.4.2', command: `npm install -g ${PKG}@latest` })
    expect(said).toEqual([`${PKG} 0.4.2 is out; this is 0.4.1. To update: npm install -g ${PKG}@latest  (to stop this check: --no-update-check)`])
    expect(JSON.parse(readFileSync(o.stateFile, 'utf-8'))).toEqual({ [PKG]: { checked_at: '2026-11-22T12:00:00.000Z', latest: '0.4.2' } })
    expect(readKept(PKG, o.stateFile, NOW + 1000)).toEqual({ latest: '0.4.2', fresh: true })
  })

  it('does not ask again the same day, and answers from what it kept', async () => {
    const o = base()
    startUpdateCheck(PKG, '0.4.1', { ...o, ask: answer({ version: '0.4.2' }) })
    await settle()
    let asked = 0
    const counting = (async () => {
      asked++
      return { ok: true, json: async () => ({ version: '9.9.9' }) }
    }) as unknown as typeof fetch
    const get = startUpdateCheck(PKG, '0.4.1', { ...o, now: NOW + CHECK_EVERY_MS - 1000, ask: counting })
    expect(get()?.latest).toBe('0.4.2') // known at once, from the file
    await settle()
    expect(asked).toBe(0)
    // A day later it asks again.
    startUpdateCheck(PKG, '0.4.1', { ...o, now: NOW + CHECK_EVERY_MS + 1000, ask: counting })
    await settle()
    expect(asked).toBe(1)
  })

  it('keeps one answer per tool in the same file', async () => {
    const o = base()
    startUpdateCheck(PKG, '0.4.1', { ...o, ask: answer({ version: '0.4.2' }) })
    await settle()
    startUpdateCheck('@point-seven-studio/jq-agents', '0.1.7', { ...o, ask: answer({ version: '0.1.7' }) })
    await settle()
    expect(Object.keys(JSON.parse(readFileSync(o.stateFile, 'utf-8'))).sort()).toEqual(['@point-seven-studio/jq-agents', PKG])
  })

  it('says nothing when this is the newest, or when npm did not answer', async () => {
    const said: string[] = []
    const same = startUpdateCheck(PKG, '0.4.2', { ...base(), ask: answer({ version: '0.4.2' }), say: (l) => said.push(l) })
    const offline = startUpdateCheck(PKG, '0.4.1', {
      ...base(),
      ask: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
      say: (l) => said.push(l),
    })
    await settle()
    expect(same()).toBeNull()
    expect(offline()).toBeNull()
    expect(said).toEqual([])
  })

  it('never calls out when it is not allowed to, or when the version is not a release', async () => {
    let asked = 0
    const counting = (async () => {
      asked++
      return { ok: true, json: async () => ({ version: '9.9.9' }) }
    }) as unknown as typeof fetch
    for (const off of [{ isTTY: false }, { env: { CI: '1' } }, { argv: ['--no-update-check'] }, { env: { JQ_NO_UPDATE_CHECK: '1' } }]) {
      expect(startUpdateCheck(PKG, '0.4.1', { ...base(), ...off, ask: counting })()).toBeNull()
    }
    expect(startUpdateCheck(PKG, 'dev', { ...base(), ask: counting })()).toBeNull()
    await settle()
    expect(asked).toBe(0)
  })

  it('gives the npx command to someone who started it through npx', () => {
    expect(updateCommand(PKG, '/Users/dana/.npm/_npx/abc123/node_modules/.bin/jq-deck')).toBe(`npx ${PKG}@latest`)
    expect(updateCommand(PKG, '/usr/local/lib/node_modules/@point-seven-studio/jq-deck/dist/jq-deck.mjs')).toBe(`npm install -g ${PKG}@latest`)
    expect(updateCommand(PKG, undefined)).toBe(`npm install -g ${PKG}@latest`)
  })
})

describe('the bar', () => {
  const running = { deck: 4316, agents: null, groundcrew: null, crosstalk: null }
  it('shows the update, the command, and how to turn the check off', () => {
    const bar = toolbar({ here: 'deck', running, update: { installed: '0.4.1', latest: '0.4.2', command: `npm install -g ${PKG}@latest` } })
    expect(bar).toContain('<summary>Update <small>0.4.2 is out</small></summary>')
    expect(bar).toContain(`<code>npm install -g ${PKG}@latest</code>`)
    expect(bar).toContain('asks npm for the latest version number, and sends nothing else')
    expect(bar).toContain('<code>--no-update-check</code>')
  })
  it('shows nothing about updates when there is none, and escapes what npm said', () => {
    expect(toolbar({ here: 'deck', running })).not.toContain('Update')
    expect(toolbar({ here: 'deck', running, update: null })).not.toContain('Update')
    const odd = toolbar({ here: 'deck', running, update: { installed: '0.4.1', latest: '<b>9</b>', command: 'x' } })
    expect(odd).not.toContain('<b>9</b>')
  })
})
