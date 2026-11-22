/**
 * JQ Deck: the shell page. A header, four tabs, and under them either the
 * overview table or one tool's own page in a frame. One HTML string, no script,
 * no outside request. Every value is escaped: names and paths come from disk.
 */
import type { Overview, RepoRow } from './deck.js'
import { TOOLBAR_CSS } from './presence.js'

export const TABS = ['overview', 'sessions', 'setup', 'mail'] as const
export type Tab = (typeof TABS)[number]
const TAB_TITLE: Record<Tab, string> = { overview: 'Overview', sessions: 'Sessions', setup: 'Setup', mail: 'Mail' }

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** The repository the Setup tab opens on: the asked one, else the first with something to fix. */
export function pickRepo(repos: RepoRow[], asked: string | null): RepoRow | null {
  const checked = repos.filter((r) => r.setup)
  return checked.find((r) => r.id === asked) ?? checked.find((r) => r.setup!.fail > 0) ?? checked[0] ?? null
}

function setupCell(r: RepoRow): string {
  if (!r.setup) return `<span class="mut">${esc(r.setup_note || 'not checked')}</span>`
  const s = r.setup
  const word = s.fail > 0 ? `<span class="bad">${s.fail} to fix</span>` : s.warn > 0 ? `<span class="warn">${s.warn} to look at</span>` : '<span class="ok">all good</span>'
  return `<a href="/?tab=setup&amp;repo=${r.id}">${s.score}%</a> ${word}`
}

function mailCell(r: RepoRow): string {
  if (r.unread === null) return '<span class="mut">no inbox</span>'
  if (r.unread === 0) return '<span class="mut">none unread</span>'
  const age = r.oldest_unread_days ? `, oldest ${r.oldest_unread_days}d` : ''
  return `<a href="/?tab=mail">${r.unread} unread</a><span class="mut">${age}</span>`
}

function sessionsCell(r: RepoRow): string {
  if (r.sessions === 0) return '<span class="mut">none</span>'
  const need = r.needs_you > 0 ? ` <span class="warn">${r.needs_you} waiting on you</span>` : ''
  const left = r.abandoned > 0 ? ` <span class="mut">${r.abandoned} asked, then left</span>` : ''
  return `<a href="/?tab=sessions">${r.sessions}</a> <span class="mut">(${r.live} live)</span>${need}${left}`
}

function overview(o: Overview): string {
  if (o.repos.length === 0) {
    return '<p class="card pad">No Claude Code session has been active in the window read, and this folder is not a project. Start a session, or run <code>jq-deck</code> inside a repository.</p>'
  }
  const rows = o.repos
    .map(
      (r) =>
        `<tr><th scope="row">${esc(r.name)}<span class="path">${esc(r.tree)}</span></th><td data-l="Sessions">${sessionsCell(r)}</td><td data-l="Setup">${setupCell(r)}</td><td data-l="Mail">${mailCell(r)}</td></tr>`,
    )
    .join('')
  const unmatched = o.mail?.unmatched.length
    ? `<p class="mut note">Unread mail for an inbox with no repository on this page: ${o.mail.unmatched.map((u) => `${esc(u.inbox)} (${u.unread})`).join(', ')}. <a href="/?tab=mail">Open Mail</a>. To tie an inbox to a folder, add it under <code>names</code> in the config file.</p>`
    : ''
  return `<div class="card"><table><thead><tr><th scope="col">Repository</th><th scope="col">Sessions</th><th scope="col">Setup</th><th scope="col">Mail</th></tr></thead><tbody>${rows}</tbody></table></div>${unmatched}`
}

function setupTab(o: Overview, asked: string | null): string {
  const chosen = pickRepo(o.repos, asked)
  if (!chosen) return '<p class="card pad">No repository to check yet. A repository appears here once a session has run in it.</p>'
  const chips = o.repos
    .filter((r) => r.setup)
    .map((r) => `<a class="chip${r.id === chosen.id ? ' on' : ''}" href="/?tab=setup&amp;repo=${r.id}"${r.id === chosen.id ? ' aria-current="true"' : ''}>${esc(r.name)} <b>${r.setup!.score}%</b></a>`)
    .join('')
  return `<nav class="chips" aria-label="Repository">${chips}</nav><iframe title="Setup check for ${esc(chosen.name)}" src="/raw/setup?repo=${chosen.id}"></iframe>`
}

function mailTab(o: Overview): string {
  if (o.mail_note) return `<p class="card pad">The mailbox at <code>${esc(o.mailbox)}</code> could not be read: ${esc(o.mail_note)}</p>`
  if (!o.mailbox) {
    return `<div class="card pad"><p>No mailbox found. A mailbox lets sessions send each other briefs and questions.</p><p>To make one, with one name per session:</p><pre>npx @point-seven-studio/jq-crosstalk init ~/crosstalk api web</pre><p>Then start this page with <code>--mailbox ~/crosstalk</code>, or set <code>$CROSSTALK_DIR</code>.</p></div>`
  }
  return '<iframe title="Mailbox" src="/raw/mail"></iframe>'
}

/** `bar` is the links to the other tools (presence.ts `toolbar`), or '' for a page with none. */
export function renderShell(o: Overview, tab: Tab, repo: string | null, version: string, bar = ''): string {
  const body =
    tab === 'overview' ? overview(o) : tab === 'sessions' ? '<iframe title="Sessions" src="/raw/sessions"></iframe>' : tab === 'setup' ? setupTab(o, repo) : mailTab(o)
  const needs = o.repos.reduce((n, r) => n + r.needs_you, 0)
  const failing = o.repos.filter((r) => r.setup && r.setup.fail > 0).length
  const count: Record<Tab, number> = { overview: 0, sessions: needs, setup: failing, mail: o.mail?.total_unread ?? 0 }
  const tabs = TABS.map(
    (t) => `<a href="/?tab=${t}"${t === tab ? ' class="on" aria-current="page"' : ''}>${TAB_TITLE[t]}${count[t] > 0 ? ` <b>${count[t]}</b>` : ''}</a>`,
  ).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JQ Deck</title>
<style>
:root{--bg:#f7f6f2;--card:#fff;--fg:#1d1c19;--mut:#6b675e;--line:#dedbd2;--well:#f1efe9;--warn:#a1500a;--ok:#1f6b45;--bad:#a3262b;--link:#1d4f91}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--card:#1f1e1a;--fg:#ece9e1;--mut:#a09c91;--line:#35332d;--well:#161512;--warn:#e0a25a;--ok:#7ccba0;--bad:#ef8a8e;--link:#8fb8ee}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;min-height:100vh}
header{padding:16px 16px 0;max-width:1000px;width:100%;margin:0 auto}
h1{font-size:22px;margin:0}.head{margin:4px 0 0;font-weight:600}
.mut{color:var(--mut);font-size:12px}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.ok,.warn,.bad{font-size:12px;font-weight:600}
a{color:var(--link)}
nav.tabs{display:flex;gap:4px;margin-top:14px;border-bottom:1px solid var(--line);overflow-x:auto}
nav.tabs a{padding:8px 12px;text-decoration:none;color:var(--mut);border-bottom:2px solid transparent;white-space:nowrap}
nav.tabs a.on{color:var(--fg);border-color:var(--fg);font-weight:600}
nav.tabs b{font-size:11px;border:1px solid var(--line);border-radius:9px;padding:0 6px;margin-left:2px}
main{flex:1;display:flex;flex-direction:column;max-width:1000px;width:100%;margin:0 auto;padding:14px 16px 24px}
iframe{flex:1;width:100%;min-height:70vh;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}.pad{padding:14px 16px;margin:0}
.pad p{margin:0 0 8px}.note{margin:10px 2px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 12px;border-top:1px solid var(--line);vertical-align:top}
thead th{border-top:0;font-size:12px;color:var(--mut);font-weight:600}
tbody th{font-weight:600}.path{display:block;font-weight:400;font-size:12px;color:var(--mut);word-break:break-all}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.chip{border:1px solid var(--line);border-radius:14px;padding:2px 10px;font-size:13px;text-decoration:none;color:var(--fg);background:var(--card)}
.chip.on{border-color:var(--fg);font-weight:600}
code,pre{font:12px ui-monospace,monospace;background:var(--well);border-radius:4px;padding:1px 4px}pre{padding:10px;overflow-x:auto}
@media (max-width:640px){thead{display:none}tr{display:block;border-top:1px solid var(--line);padding:8px 0}th,td{display:block;border:0;padding:3px 12px}td::before{content:attr(data-l) ": ";color:var(--mut);font-size:12px}}
${bar ? TOOLBAR_CSS : ''}</style></head><body>
<header>
<h1>JQ Deck</h1>
<p class="head">${esc(o.headline)}</p>
<p class="mut">${esc(o.machine)} · read ${esc(o.generated_at)}. Refresh to read again. Read-only: nothing on this page writes to a session or a mailbox.</p>
<nav class="tabs" aria-label="Views">${tabs}</nav>
</header>
<main>${body}</main>
<footer class="mut" style="max-width:1000px;width:100%;margin:0 auto;padding:0 16px 16px">JQ Deck ${esc(version)} · this machine only</footer>
${bar}</body></html>`
}
