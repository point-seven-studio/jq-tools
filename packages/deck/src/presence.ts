/**
 * The bar at the bottom of every JQ page: a link to each of the other tools.
 *
 * THIS FILE IS THE SAME IN EVERY PACKAGE (scripts/check-shared.mjs fails the build if
 * the copies differ). The tools are published apart and depend on nothing, so they
 * share by copy. Change it in one package, then run `node scripts/check-shared.mjs --write`.
 *
 * How one local page knows whether another tool is running, without a network call:
 * a tool that serves a page leaves a small file in ~/.jq/running/ saying which port it
 * is on, and removes it when it stops. The others read those files. A file left behind
 * by a crash names a process that no longer exists, and is ignored.
 *
 * A page served from somewhere else (a team board) cannot see a person's computer, so
 * there each local tool is a note with its address and how to start it.
 *
 * No script and no request: the bar is links and <details>.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

export type ToolId = 'deck' | 'groundcrew' | 'crosstalk' | 'agents'

export interface ToolInfo {
  id: ToolId
  name: string
  /** What it shows, in a few words. */
  what: string
  /** The port it serves on unless told otherwise. */
  port: number
  /** The command that starts its page. */
  run: string
}

export const TOOLS: readonly ToolInfo[] = [
  { id: 'deck', name: 'JQ Deck', what: 'sessions, setup and mail on one page', port: 4316, run: 'npx @point-seven-studio/jq-deck' },
  { id: 'agents', name: 'JQ Agents', what: 'every session, and which wait on a person', port: 4319, run: 'npx @point-seven-studio/jq-agents' },
  { id: 'groundcrew', name: 'JQ Groundcrew', what: 'the setup check for one project', port: 4317, run: 'npx @point-seven-studio/jq-groundcrew' },
  { id: 'crosstalk', name: 'JQ Crosstalk', what: 'the mailbox between sessions', port: 4318, run: 'npx @point-seven-studio/jq-crosstalk view' },
]

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/* ── Which tools are running on this machine ─────────────────────────── */

export function runningDir(env: Record<string, string | undefined> = process.env): string {
  return env.JQ_RUNNING_DIR || path.join(os.homedir(), '.jq', 'running')
}

const isTool = (id: unknown): id is ToolId => TOOLS.some((t) => t.id === id)
const validPort = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // EPERM: the process exists and belongs to someone else.
    return e?.code === 'EPERM'
  }
}

/** Every tool, with the port of its running page or null. `isAlive` is a parameter so a test can decide. */
export function readRunning(dir = runningDir(), isAlive: (pid: number) => boolean = alive): Record<ToolId, number | null> {
  const found: Record<ToolId, number | null> = { deck: null, groundcrew: null, crosstalk: null, agents: null }
  if (!existsSync(dir)) return found
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return found
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(path.join(dir, file), 'utf-8'))
      if (!isTool(entry?.tool) || !validPort(entry.port) || typeof entry.pid !== 'number' || !isAlive(entry.pid)) continue
      const usual = TOOLS.find((t) => t.id === entry.tool)!.port
      // Two copies of one tool can run on two ports. The one on the usual port wins.
      if (found[entry.tool as ToolId] === null || entry.port === usual) found[entry.tool as ToolId] = entry.port
    } catch {
      // A half-written or foreign file says nothing.
    }
  }
  return found
}

/**
 * Say "this tool is serving on this port" until the process ends. Returns a function
 * that takes the note away. Never throws: a tool that cannot write the note still runs,
 * and the other pages show it as not running.
 */
export function announce(tool: ToolId, port: number, dir = runningDir()): () => void {
  const file = path.join(dir, `${tool}.${process.pid}.json`)
  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    try {
      unlinkSync(file)
    } catch {
      /* already gone */
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    // Clear notes left by processes that are gone, so the folder does not grow.
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try {
        const pid = JSON.parse(readFileSync(path.join(dir, f), 'utf-8'))?.pid
        if (typeof pid !== 'number' || !alive(pid)) unlinkSync(path.join(dir, f))
      } catch {
        /* leave what cannot be read */
      }
    }
    writeFileSync(file, JSON.stringify({ tool, port, pid: process.pid, started_at: new Date().toISOString() }) + '\n', { mode: 0o600 })
  } catch {
    return remove
  }
  process.once('exit', remove)
  // Ctrl-C and a plain kill end the process without running 'exit' handlers unless asked to.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      remove()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  return remove
}

/* ── The team board's address, if this machine has one ───────────────── */

/** `"team": "https://..."` in ~/.jq/config.json. Null when absent, unreadable, or not an http(s) address. */
export function readTeamUrl(file = process.env.JQ_CONFIG || path.join(os.homedir(), '.jq', 'config.json')): string | null {
  try {
    const team = JSON.parse(readFileSync(file, 'utf-8'))?.team
    if (typeof team !== 'string') return null
    const url = new URL(team)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/* ── Copy buttons ────────────────────────────────────────────────────── */

/**
 * The one script a local JQ page runs. It copies the text of a command to the clipboard
 * when its Copy button is pressed, and does nothing else: it reads no other part of the
 * page and makes no request. A page that sets a content policy allows this script by its
 * hash (COPY_SCRIPT_CSP), so no other script can run there.
 *
 * The buttons are written hidden and this script shows them. Where the script cannot run,
 * there is no dead button, and the command can still be selected by hand.
 *
 * The team board (jq-deck-server) does not use it: that page runs no script at all.
 */
export const COPY_SCRIPT = `document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('button[data-jqcopy]'):null;if(!b)return;var c=b.previousElementSibling,t=c?c.textContent:'';function done(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1600)}function old(){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(x){}a.remove();done()}if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(done,old)}else{old()}});for(var n=document.querySelectorAll('button[data-jqcopy]'),i=0;i<n.length;i++)n[i].hidden=false;`

/** SHA-256 of COPY_SCRIPT, base64. A test recomputes it, so the two cannot drift apart. */
export const COPY_SCRIPT_SHA256 = 'T57LzIgV1VkS+ha6PSVZ1odK1HAHl6V3rvrbmRPNs6E='
/** The source to add to a content policy's script-src so that this script, and only it, may run. */
export const COPY_SCRIPT_CSP = `'sha256-${COPY_SCRIPT_SHA256}'`
/** Put this once, just before </body>, on a page that shows a command. */
export const COPY_SCRIPT_TAG = `<script>${COPY_SCRIPT}</script>`

export const COPY_CSS = `
.jqcp{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:100%}
.jqcp code{user-select:all;-webkit-user-select:all}
.jqcp button{font:600 11px system-ui,sans-serif;line-height:1;padding:3px 8px;min-height:22px;border:1px solid var(--line,GrayText);border-radius:5px;background:var(--card,Canvas);color:var(--fg,CanvasText);cursor:pointer}
.jqcp button:hover{border-color:var(--mut,GrayText)}
.jqcp button:focus-visible{outline:2px solid var(--link,LinkText);outline-offset:2px}
`

/** A command with a Copy button beside it. The button is hidden until COPY_SCRIPT shows it. */
export function copyable(text: string): string {
  return `<span class="jqcp"><code>${esc(text)}</code><button type="button" data-jqcopy hidden aria-label="Copy this command">Copy</button></span>`
}

/* ── The bar ─────────────────────────────────────────────────────────── */

/** Works on every JQ page: each defines these colours, and the fallbacks cover one that does not. */
export const TOOLBAR_CSS = `
body{padding-bottom:64px}
.jqbar{position:fixed;left:0;right:0;bottom:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding:8px 16px;font:13px/1.4 system-ui,sans-serif;background:var(--card,Canvas);color:var(--fg,CanvasText);border-top:1px solid var(--line,GrayText)}
.jqbar a{color:var(--link,LinkText)}
.jqbar .here{font-weight:700}
.jqbar details[open]{order:-1;flex-basis:100%}
.jqbar summary{cursor:pointer;color:var(--mut,GrayText);list-style:none;display:inline-block;padding:2px 0}
.jqbar summary::-webkit-details-marker{display:none}
.jqbar summary::after{content:" ▸"}
.jqbar details[open] summary::after{content:" ▾"}
.jqbar summary small,.jqbar a small{font-size:11px;font-weight:400}
.jqbar details>div{margin:4px 0 6px;padding:8px 10px;max-width:640px;border:1px solid var(--line,GrayText);border-radius:8px;background:var(--well,Canvas)}
.jqbar details>div p{margin:0 0 4px}
.jqbar code{font:12px ui-monospace,Menlo,monospace;word-break:break-all}
.jqbar a:focus-visible,.jqbar summary:focus-visible{outline:2px solid var(--link,LinkText);outline-offset:2px}
@media print{.jqbar{display:none}body{padding-bottom:0}}
`

export interface ToolbarOptions {
  /** The page this bar is on: a tool, or 'team' for the team board. */
  here: ToolId | 'team'
  /**
   * What is running on the reader's own machine, when the page can know. Null when it
   * cannot: the page is served from somewhere else.
   */
  running: Record<ToolId, number | null> | null
  /** The team board's address, when this machine knows one. Ignored on the team board itself. */
  team?: string | null
  /** A newer version of the tool serving this page, when one is known (update-check.ts). */
  update?: { installed: string; latest: string; command: string } | null
  /** True on a page that carries COPY_SCRIPT_TAG: each command in the bar then gets a Copy button. */
  copy?: boolean
}

const local = (port: number) => `http://127.0.0.1:${port}`
/** A command in the bar: with a Copy button where the page can run one, plain where it cannot. */
const command = (text: string, o: ToolbarOptions) => (o.copy ? copyable(text) : `<code>${esc(text)}</code>`)

function toolItem(t: ToolInfo, o: ToolbarOptions): string {
  if (o.here === t.id) return `<span class="here" aria-current="page">${esc(t.name)}</span>`
  const start = `<p>To start it: ${command(t.run, o)}</p>`
  if (o.running === null) {
    // Served from elsewhere: the page cannot tell, so it says where the tool would be.
    return `<details><summary>${esc(t.name)} <small>on your computer</small></summary><div><p>${esc(t.name)} shows ${esc(t.what)}. It runs on your own computer, and this page cannot see whether it is running there.</p><p>If it is, it is at <a href="${local(t.port)}">${local(t.port)}</a>.</p>${start}</div></details>`
  }
  const port = o.running[t.id]
  if (port !== null) return `<a href="${local(port)}" title="${esc(t.what)}">${esc(t.name)}</a>`
  return `<details><summary>${esc(t.name)} <small>not running</small></summary><div><p>${esc(t.name)} shows ${esc(t.what)}. It is not running on this machine.</p>${start}<p>Then refresh this page.</p></div></details>`
}

function teamItem(o: ToolbarOptions): string {
  if (o.here === 'team') return '<span class="here" aria-current="page">Team board</span>'
  if (o.team) return `<a href="${esc(o.team)}" title="every machine on the team, on one page">Team board</a>`
  return '<details><summary>Team board <small>not set up</small></summary><div><p>A team board shows every machine on a team on one page. This machine has no address for one.</p><p>If your team has one, add a <code>"team"</code> line holding its address to <code>~/.jq/config.json</code>.</p><p>To host one: ' + command('npx @point-seven-studio/jq-deck-server', o) + '</p></div></details>'
}

function updateItem(o: ToolbarOptions): string {
  if (!o.update) return ''
  const u = o.update
  return `<details><summary>Update <small>${esc(u.latest)} is out</small></summary><div><p>This is ${esc(u.installed)}. Version ${esc(u.latest)} is on npm.</p><p>To update: ${command(u.command, o)}</p><p>Once a day this tool asks npm for the latest version number, and sends nothing else. To turn that off, start it with <code>--no-update-check</code>.</p></div></details>`
}

/** The bar's HTML. Put TOOLBAR_CSS in the page's style, and this just before </body>. */
export function toolbar(o: ToolbarOptions): string {
  return `<nav class="jqbar" aria-label="JQ tools">${TOOLS.map((t) => toolItem(t, o)).join('')}${teamItem(o)}${updateItem(o)}</nav>`
}
