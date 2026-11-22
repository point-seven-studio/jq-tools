/** The bar of links at the foot of every JQ page, and how a page knows what is running. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TOOLS, TOOLBAR_CSS, announce, readRunning, readTeamUrl, toolbar } from '../src/presence.js'
import { COPY_SCRIPT, COPY_SCRIPT_CSP, COPY_SCRIPT_SHA256, COPY_SCRIPT_TAG, copyable } from '../src/presence.js'
import { LAMP_IMG_SOURCES, LAMP_PATH, LAMP_SVG, lampReply } from '../src/presence.js'
import { createHash } from 'crypto'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'jq-running-'))
})
const note = (name: string, value: unknown) => writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
const everyoneAlive = () => true

describe('readRunning', () => {
  it('finds nothing in a folder that does not exist, or is empty', () => {
    expect(readRunning(path.join(dir, 'none'))).toEqual({ deck: null, groundcrew: null, crosstalk: null, agents: null })
    expect(readRunning(dir)).toEqual({ deck: null, groundcrew: null, crosstalk: null, agents: null })
  })

  it('reports the port a tool says it is on, which need not be its usual one', () => {
    note('agents.1.json', { tool: 'agents', port: 5000, pid: 1 })
    expect(readRunning(dir, everyoneAlive).agents).toBe(5000)
  })

  it('ignores a note whose process is gone', () => {
    note('agents.1.json', { tool: 'agents', port: 4319, pid: 1 })
    note('deck.2.json', { tool: 'deck', port: 4316, pid: 2 })
    const running = readRunning(dir, (pid) => pid === 2)
    expect(running.agents).toBeNull()
    expect(running.deck).toBe(4316)
  })

  it('ignores a broken note, an unknown tool and a port that is not a port', () => {
    note('a.json', '{ not json')
    note('b.json', { tool: 'something-else', port: 4319, pid: 1 })
    note('c.json', { tool: 'agents', port: 'javascript:alert(1)', pid: 1 })
    note('d.json', { tool: 'deck', port: 70000, pid: 1 })
    note('e.txt', { tool: 'crosstalk', port: 4318, pid: 1 })
    expect(readRunning(dir, everyoneAlive)).toEqual({ deck: null, groundcrew: null, crosstalk: null, agents: null })
  })

  it('prefers the copy on the usual port when one tool runs twice', () => {
    note('groundcrew.1.json', { tool: 'groundcrew', port: 4317, pid: 1 })
    note('groundcrew.2.json', { tool: 'groundcrew', port: 5001, pid: 2 })
    expect(readRunning(dir, everyoneAlive).groundcrew).toBe(4317)
  })
})

describe('announce', () => {
  it('leaves a note this process can be found by, and takes it away', () => {
    const remove = announce('crosstalk', 4318, dir)
    expect(readRunning(dir).crosstalk).toBe(4318)
    expect(JSON.parse(readFileSync(path.join(dir, `crosstalk.${process.pid}.json`), 'utf-8'))).toMatchObject({ tool: 'crosstalk', port: 4318, pid: process.pid })
    remove()
    expect(readRunning(dir).crosstalk).toBeNull()
    expect(readdirSync(dir)).toEqual([])
    remove() // twice is harmless
  })

  it('clears notes left by processes that are gone, and keeps what it cannot read', () => {
    note('agents.999999999.json', { tool: 'agents', port: 4319, pid: 999999999 })
    note('keep.json', '{ not json')
    const remove = announce('deck', 4316, dir)
    expect(readdirSync(dir).sort()).toEqual([`deck.${process.pid}.json`, 'keep.json'])
    remove()
  })

  it('does not throw when the folder cannot be made', () => {
    const blocked = path.join(dir, 'file')
    writeFileSync(blocked, 'x')
    expect(() => announce('deck', 4316, path.join(blocked, 'under'))()).not.toThrow()
  })
})

describe('readTeamUrl', () => {
  const config = (value: unknown) => {
    const file = path.join(dir, 'config.json')
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }
  it('reads an https or http address', () => {
    expect(readTeamUrl(config({ team: 'https://board.example.com' }))).toBe('https://board.example.com/')
    expect(readTeamUrl(config({ team: 'http://127.0.0.1:4320' }))).toBe('http://127.0.0.1:4320/')
  })
  it('gives nothing for a missing file, a broken one, another scheme, or an address holding a password', () => {
    expect(readTeamUrl(path.join(dir, 'none.json'))).toBeNull()
    expect(readTeamUrl(config('{ nope'))).toBeNull()
    expect(readTeamUrl(config({ team: 'javascript:alert(1)' }))).toBeNull()
    expect(readTeamUrl(config({ team: 'https://user:secret@board.example.com' }))).toBeNull()
    expect(readTeamUrl(config({ team: 42 }))).toBeNull()
    expect(readTeamUrl(config({}))).toBeNull()
  })
})

describe('toolbar', () => {
  const none = { deck: null, groundcrew: null, crosstalk: null, agents: null }

  it('marks the page it is on and links a running tool at the port it is really on', () => {
    const html = toolbar({ here: 'agents', running: { ...none, deck: 5002 }, team: null })
    expect(html).toContain('<span class="here" aria-current="page">JQ Agents</span>')
    expect(html).toContain('<a href="http://127.0.0.1:5002"')
    expect(html).not.toContain('http://127.0.0.1:4319')
  })

  it('says a tool is not running, in words, with the command that starts it', () => {
    const html = toolbar({ here: 'deck', running: none, team: null })
    for (const t of TOOLS.filter((x) => x.id !== 'deck')) {
      expect(html).toContain(`${t.name} <small>not running</small>`)
      expect(html).toContain(`<code>${t.run}</code>`)
    }
    expect(html).not.toContain('href="http://127.0.0.1')
  })

  it('links the team board when this machine has its address, and says how to set one when it has not', () => {
    expect(toolbar({ here: 'deck', running: none, team: 'https://board.example.com/' })).toContain('<a href="https://board.example.com/"')
    const unset = toolbar({ here: 'deck', running: none, team: null })
    expect(unset).toContain('Team board <small>not set up</small>')
    expect(unset).toContain('~/.jq/config.json')
  })

  it('escapes a team address', () => {
    expect(toolbar({ here: 'deck', running: none, team: 'https://x.example/?a="><script>' })).not.toContain('<script>')
  })

  it('on a page served from elsewhere, says it cannot see the computer and gives the address and the command', () => {
    const html = toolbar({ here: 'team', running: null })
    expect(html).toContain('<span class="here" aria-current="page">Team board</span>')
    for (const t of TOOLS) {
      expect(html).toContain(`${t.name} <small>on your computer</small>`)
      expect(html).toContain(`href="http://127.0.0.1:${t.port}"`)
      expect(html).toContain(`<code>${t.run}</code>`)
    }
    expect(html).toContain('cannot see whether it is running')
  })

  it('is links and details only: no script, no image, nothing fetched', () => {
    const all = toolbar({ here: 'team', running: null }) + toolbar({ here: 'deck', running: none, team: null }) + TOOLBAR_CSS
    expect(all).not.toMatch(/<script|<img|<link|src=|url\(|@import|fetch\(/)
  })

  it('names every tool once, in one order, on every page', () => {
    const names = (html: string) => [...html.matchAll(/JQ (Deck|Agents|Groundcrew|Crosstalk)\b(?! shows)/g)].map((m) => m[1])
    expect(names(toolbar({ here: 'deck', running: { deck: 4316, agents: 4319, groundcrew: 4317, crosstalk: 4318 }, team: null }))).toEqual(['Deck', 'Agents', 'Groundcrew', 'Crosstalk'])
  })
})

describe('the ports', () => {
  // scripts/check-shared.mjs checks all four against each tool's own DEFAULT_PORT.
  it('for JQ Deck is the one it serves on by default', async () => {
    const { DEFAULT_PORT } = await import('../src/cli.js')
    expect(TOOLS.find((t) => t.id === 'deck')!.port).toBe(DEFAULT_PORT)
  })
})

describe('copy buttons', () => {
  const none = { deck: null, agents: null, groundcrew: null, crosstalk: null }
  it('names the script by a hash that is really its own', () => {
    expect(createHash('sha256').update(COPY_SCRIPT).digest('base64')).toBe(COPY_SCRIPT_SHA256)
    expect(COPY_SCRIPT_CSP).toBe(`'sha256-${COPY_SCRIPT_SHA256}'`)
    expect(COPY_SCRIPT_TAG).toBe(`<script>${COPY_SCRIPT}</script>`)
  })
  it('has a script that copies and does nothing else', () => {
    // It reads the text beside the pressed button and writes to the clipboard. It makes no request.
    expect(COPY_SCRIPT).toContain('navigator.clipboard.writeText')
    expect(COPY_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|WebSocket|sendBeacon|import\(|eval\(|innerHTML|location|cookie|localStorage|src\s*=|https?:/)
  })
  it('writes each button hidden, so there is no dead control where the script cannot run', () => {
    expect(copyable('npx some-tool --flag "a b"')).toBe('<span class="jqcp"><code>npx some-tool --flag &quot;a b&quot;</code><button type="button" data-jqcopy hidden aria-label="Copy this command">Copy</button></span>')
    expect(copyable('<img src=x>')).not.toContain('<img')
    expect(COPY_SCRIPT).toContain('hidden=false')
  })
  it('puts a button on each command in the bar only when the page says it can', () => {
    const update = { installed: '0.4.1', latest: '0.4.2', command: 'npm install -g some-tool@latest' }
    const withCopy = toolbar({ here: 'deck', running: none, update, copy: true })
    // Three tools not running, the team board not set up, and the update: five commands.
    expect(withCopy.match(/data-jqcopy/g)).toHaveLength(5)
    expect(withCopy).toContain('<code>npm install -g some-tool@latest</code><button type="button" data-jqcopy hidden')
    const plain = toolbar({ here: 'deck', running: none, update })
    expect(plain).not.toContain('data-jqcopy')
    expect(plain).not.toContain('<button')
    // The team board is served from elsewhere and runs no script: its bar never has one.
    expect(toolbar({ here: 'team', running: null })).not.toMatch(/data-jqcopy|<button|<script/)
  })
})

describe('lights', () => {
  const dir = () => mkdtempSync(path.join(os.tmpdir(), 'jq-lamp-'))
  it('answers the image only on a machine that has a team board', () => {
    const file = path.join(dir(), 'config.json')
    expect(lampReply(file)).toMatchObject({ status: 404, body: 'not found' })
    writeFileSync(file, JSON.stringify({ questions: ['/code/shop'] }))
    expect(lampReply(file).status).toBe(404)
    writeFileSync(file, JSON.stringify({ team: 'https://deck.example.com' }))
    const up = lampReply(file)
    expect(up.status).toBe(200)
    expect(up.headers).toEqual({ 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'cross-origin', 'x-content-type-options': 'nosniff' })
    expect(up.body).toBe(LAMP_SVG)
  })
  it('is an image that says nothing about the machine', () => {
    expect(LAMP_PATH).toBe('/jq-up.svg')
    expect(LAMP_SVG.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(LAMP_SVG).not.toMatch(/<script|<text|<title|href|on[a-z]+=/)
    expect(LAMP_IMG_SOURCES).toBe('http://127.0.0.1:4316 http://127.0.0.1:4319 http://127.0.0.1:4317 http://127.0.0.1:4318')
  })
  it('puts a light beside each tool only on a page served from elsewhere that asks for them', () => {
    const bar = toolbar({ here: 'team', running: null, lamps: true })
    expect(bar.match(/class="lamp"/g)).toHaveLength(4)
    expect(bar).toContain('<span class="lamp" aria-hidden="true"><img src="http://127.0.0.1:4316/jq-up.svg" alt="" width="10" height="10"></span>JQ Deck')
    expect(bar).toContain('A red ring means no answer')
    // It never says a tool is not running: the browser may simply have refused to look.
    expect(bar).not.toMatch(/<script|<small>not running<\/small>/)
    // A local page knows what is running: it shows no light, with or without the option.
    const none = { deck: null, agents: null, groundcrew: null, crosstalk: null }
    expect(toolbar({ here: 'deck', running: none, lamps: true })).not.toContain('class="lamp"')
    expect(toolbar({ here: 'team', running: null })).not.toContain('class="lamp"')
  })
})
