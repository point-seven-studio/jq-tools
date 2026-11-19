/**
 * The team page and the sign-in page. One HTML string each, no script, no
 * outside request. Every value is escaped: names come from other machines.
 */
import { duration, type Team, type TeamRow } from './team.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const STYLE = `
:root{--bg:#f7f6f2;--card:#fff;--fg:#1d1c19;--mut:#6b675e;--line:#dedbd2;--well:#f1efe9;--warn:#a1500a;--ok:#1f6b45;--bad:#a3262b;--link:#1d4f91}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--card:#1f1e1a;--fg:#ece9e1;--mut:#a09c91;--line:#35332d;--well:#161512;--warn:#e0a25a;--ok:#7ccba0;--bad:#ef8a8e;--link:#8fb8ee}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 8px}.head{margin:4px 0 0;font-weight:600}
.mut{color:var(--mut);font-size:12px}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.ok,.warn,.bad{font-size:12px;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin:10px 0}
.card h3{font-size:15px;margin:0;padding:10px 12px;word-break:break-word}.card h3 .mut{font-weight:400}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 12px;border-top:1px solid var(--line);vertical-align:top;font-weight:400}
thead th{font-size:12px;color:var(--mut);font-weight:600}tbody th{font-weight:600}
tr.quiet td,tr.quiet th{color:var(--mut)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
button{white-space:nowrap;font:inherit;font-size:12px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:4px 10px;cursor:pointer}
input{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
label{display:block;font-weight:600;margin-bottom:6px}.pad{padding:16px}
ul{margin:0;padding:0;list-style:none}li{padding:6px 12px;border-top:1px solid var(--line)}li:first-child{border-top:0}
@media (max-width:640px){thead{display:none}tr{display:block;border-top:1px solid var(--line);padding:6px 0}th,td{display:block;border:0;padding:2px 12px}td::before{content:attr(data-l) ": ";color:var(--mut);font-size:12px}}
`

const heard = (minutes: number) => (minutes < 1 ? 'just now' : `${duration(minutes)} ago`)

function row(r: TeamRow): string {
  const quiet = r.freshness !== 'fresh'
  const waiting = quiet
    ? '<span class="mut">not current</span>'
    : r.needs_you > 0
      ? `<span class="warn">${r.needs_you} waiting${r.waiting_minutes !== null ? `, ${esc(duration(r.waiting_minutes))}` : ''}</span>`
      : '<span class="mut">none</span>'
  const setup = !r.setup
    ? '<span class="mut">not checked</span>'
    : `${r.setup.score}% ${r.setup.fail > 0 ? `<span class="bad">${r.setup.fail} to fix</span>` : r.setup.warn > 0 ? `<span class="warn">${r.setup.warn} to look at</span>` : '<span class="ok">all good</span>'}`
  const mail = r.unread === null ? '<span class="mut">no inbox</span>' : r.unread === 0 ? '<span class="mut">none unread</span>' : `${r.unread} unread`
  return `<tr${quiet ? ' class="quiet"' : ''}><th scope="row">${esc(r.who)} <span class="mut">${esc(r.machine)}</span></th><td data-l="Sessions">${r.sessions} <span class="mut">(${r.live} live)</span></td><td data-l="Waiting on a person">${waiting}</td><td data-l="Setup">${setup}</td><td data-l="Mail">${mail}</td><td data-l="Last heard"><span class="mut">${esc(heard(r.minutes_ago))}</span></td></tr>`
}

export function renderTeam(team: Team, viewerName: string, version: string): string {
  const groups = team.groups
    .map(
      (g) =>
        `<section class="card"><h3>${esc(g.name)}${g.remote ? ` <span class="mut">${esc(g.remote)}</span>` : ''}</h3><table><thead><tr><th scope="col">Who</th><th scope="col">Sessions</th><th scope="col">Waiting on a person</th><th scope="col">Setup</th><th scope="col">Mail</th><th scope="col">Last heard</th></tr></thead><tbody>${g.rows.map(row).join('')}</tbody></table></section>`,
    )
    .join('')
  const machines = team.machines
    .map((m) => `<li>${esc(m.who)} <span class="mut">${esc(m.machine)} · last heard ${esc(heard(m.minutes_ago))}</span>${m.freshness === 'fresh' ? '' : ` <span class="warn">${m.freshness === 'quiet' ? 'quiet, not counted' : 'silent for over a day, rows hidden'}</span>`}</li>`)
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>JQ Deck: team</title><style>${STYLE}</style></head><body><main>
<div class="top"><div><h1>JQ Deck: team</h1><p class="head">${esc(team.headline)}</p></div><form method="post" action="/logout"><button>Sign out</button></form></div>
<p class="mut">Read ${esc(team.generated_at)} for ${esc(viewerName)}${team.scoped ? ', who sees some repositories only' : ''}. Reloads every minute. Read-only: answer a session where it is running.</p>
${groups || '<p class="card pad mut">No repository to show.</p>'}
<h2>Machines</h2>
<div class="card"><ul>${machines || '<li class="mut">None yet. On each machine: <code>jq-deck --watch --exec "jq-deck-server send --url THIS-ADDRESS"</code></li>'}</ul></div>
<p class="mut">A machine sends counts and scores only: no folder path, no question text, no message. JQ Deck Server ${esc(version)}.</p>
</main></body></html>`
}

export function renderLogin(message: string | null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JQ Deck: sign in</title><style>${STYLE}</style></head><body><main style="max-width:420px">
<h1>JQ Deck: team</h1>
<form class="card pad" method="post" action="/login">
${message ? `<p class="bad" role="alert">${esc(message)}</p>` : ''}
<label for="token">Viewer token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
<p class="mut">Whoever runs this server gives you one (<code>jq-deck-server add-viewer</code>).</p>
<button>Sign in</button>
</form></main></body></html>`
}
