/**
 * The local board: every session on this machine, grouped by working tree.
 * One HTML string, no script, no outside request. Question text comes from a
 * session's own output, so every value is escaped.
 */
import { deriveAttention, type AgentStatusRow } from './agent-status.js'
import type { Snapshot } from './collect.js'
import { ruleText, type TurnCheckConfig, type TurnEvidence } from './turn-check.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export function ago(iso: string | null, now: number): string {
  if (!iso) return 'unknown'
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Sessions that ended a turn after editing files with no check afterwards, or with a failed one. */
export function unverified(rows: AgentStatusRow[]): AgentStatusRow[] {
  return rows.filter((r) => r.state !== 'dead' && (r.turn_check === 'unchecked' || r.turn_check === 'failed'))
}

export interface Totals {
  sessions: number
  live: number
  needs_you: number
  abandoned: number
  trees: number
}

export function totals(rows: AgentStatusRow[]): Totals {
  const attention = rows.map((r) => deriveAttention(r.state, r.waiting))
  return {
    sessions: rows.length,
    live: rows.filter((r) => r.state === 'live').length,
    // Counted from the derived attention, never the raw waiting flag: a session
    // that asked something days ago and was left is not waiting on you now.
    needs_you: attention.filter((a) => a === 'needs-you').length,
    abandoned: attention.filter((a) => a === 'abandoned').length,
    trees: new Set(rows.map((r) => r.working_tree)).size,
  }
}

/** Trees with a session that needs a person first, then the most recently active. */
export function groupByTree(rows: AgentStatusRow[]): { tree: string; product: string; rows: AgentStatusRow[] }[] {
  const by = new Map<string, AgentStatusRow[]>()
  for (const r of rows) by.set(r.working_tree, [...(by.get(r.working_tree) ?? []), r])
  const needs = (list: AgentStatusRow[]) => list.some((r) => deriveAttention(r.state, r.waiting) === 'needs-you')
  const latest = (list: AgentStatusRow[]) => list.map((r) => r.last_activity_at || '').sort().pop() || ''
  return [...by.entries()]
    .map(([tree, list]) => ({
      tree,
      product: list[0].product,
      rows: list.sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || '')),
    }))
    .sort((a, b) => Number(needs(b.rows)) - Number(needs(a.rows)) || latest(b.rows).localeCompare(latest(a.rows)))
}

/** What the local server passes so the page can offer corrections. Without it the page only shows. */
export interface Manage {
  /** A value this server process made up. A form must send it back. */
  token: string
  config: TurnCheckConfig
}

const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`)
    .join('')
const form = (m: Manage, fields: Record<string, string>, label: string) =>
  `<form method="post" action="/turn-check">${hidden({ token: m.token, ...fields })}<button type="submit">${esc(label)}</button></form>`

/** Why a row is labelled, and the ways to say the label is wrong. Local page only. */
function whyPanel(r: AgentStatusRow, evidence: TurnEvidence, m: Manage): string {
  const how = evidence.via === 'shell' ? `<code>${esc(evidence.edit)}</code>, a shell command` : `the ${esc(evidence.edit)} tool`
  const verdict = r.turn_check === 'failed' ? 'The last check after it failed.' : 'No check ran after it.'
  const after = evidence.after.length
    ? `<p>It ran these afterwards. If one of them is how this project checks its work, say so:</p><ul class="cmds">${evidence.after
        .map((command) => {
          const text = ruleText(command)
          return `<li><code>${esc(command)}</code>${text.length >= 2 ? form(m, { action: 'add-rule', kind: 'check', tree: r.working_tree, text }, `Count "${text}" as a check here`) : ''}</li>`
        })
        .join('')}</ul>`
    : ''
  const notEdit = evidence.via === 'shell' && ruleText(evidence.edit).length >= 2 ? form(m, { action: 'add-rule', kind: 'not-edit', tree: r.working_tree, text: ruleText(evidence.edit) }, `"${ruleText(evidence.edit)}" does not edit code here`) : ''
  return (
    `<details class="why"><summary>Why, and is it wrong?</summary><p>The last edit was ${how}. ${verdict}</p>${after}<div class="acts">${notEdit}` +
    form(m, { action: 'dismiss', session: r.session_id }, 'Dismiss this one') +
    form(m, { action: 'mute', tree: r.working_tree }, 'Never label this tree') +
    '</div></details>'
  )
}

function sessionRow(r: AgentStatusRow, now: number, evidence?: TurnEvidence, manage?: Manage): string {
  const attention = deriveAttention(r.state, r.waiting)
  const badge =
    attention === 'needs-you'
      ? '<span class="b need">waiting on a person</span>'
      : attention === 'abandoned'
        ? '<span class="b old">asked, then left</span>'
        : ''
  // Only the two that need a look are shown. "checked" and "no-edits" would be on most rows,
  // and a label on most rows is a label nobody reads.
  const check =
    r.turn_check === 'unchecked'
      ? '<span class="b need">stopped without running a check</span>'
      : r.turn_check === 'failed'
        ? '<span class="b bad">stopped after a failed check</span>'
        : ''
  const res = r.cpu_pct != null || r.rss_mb != null ? `<span class="mut">${r.cpu_pct ?? '?'}% cpu · ${r.rss_mb ?? '?'} MB</span>` : ''
  // "Off for this tree" and "nothing to show" are different facts; say which.
  const question = r.blocked_question
    ? `<pre>${esc(r.blocked_question)}${r.question_redacted ? '\n[a secret-shaped string was removed]' : ''}</pre>`
    : attention !== 'none' && !r.question_allowed
      ? '<p class="mut q">Question text is off for this tree.</p>'
      : ''
  const why = check && evidence && manage ? whyPanel(r, evidence, manage) : ''
  return `<li><span class="s ${r.state}">${r.state}</span> <span class="mut">${esc(r.branch || 'no branch')} · active ${ago(r.last_activity_at, now)} ago</span> ${[badge, check].filter(Boolean).join('<span class="mut"> · </span>')} ${res}${question}${why}</li>`
}

/** Everything a person has corrected, each with a way to take it back. */
function correctionsPanel(snap: Snapshot, m: Manage): string {
  const { rules, muted, dismissed } = m.config
  const items = [
    ...rules.map((rule, index) => `<li><span>${rule.kind === 'check' ? 'Counts as a check' : 'Does not edit code'}: <code>${esc(rule.text)}</code> <span class="mut">in ${esc(rule.tree === '*' ? 'every tree' : rule.tree)}</span></span>${form(m, { action: 'remove-rule', index: String(index) }, 'Remove')}</li>`),
    ...muted.map((tree) => `<li><span>Never labelled: <span class="mut">${esc(tree)}</span></span>${form(m, { action: 'unmute', tree }, 'Label it again')}</li>`),
    ...Object.keys(dismissed).map((session) => {
      const row = snap.sessions.find((r) => r.session_id === session)
      return `<li><span>Dismissed: <span class="mut">${esc(row ? `${row.product} · ${row.branch || 'no branch'}` : `session ${session.slice(0, 8)}`)}</span></span>${form(m, { action: 'undismiss', session }, 'Undo')}</li>`
    }),
  ]
  return (
    '<section class="card fix"><h2>Your corrections to the check label</h2>' +
    (items.length
      ? `<ul>${items.join('')}</ul>`
      : '<p class="mut pad">None yet. A label you think is wrong has a "Why, and is it wrong?" link under it.</p>') +
    '<p class="mut pad">Saved in <code>~/.jq/config.json</code> on this machine. This is the only file JQ Agents writes.</p></section>'
  )
}

export function renderPage(snap: Snapshot, now = Date.now(), manage?: Manage): string {
  const t = totals(snap.sessions)
  // 'none' renders nothing: a chip that is always present is a chip nobody reads.
  // 'unknown' does render, because no data must never look like no problem.
  const b = snap.bottleneck
  const chip = !b ? '<p class="mut">Host not sampled.</p>' : b.kind === 'none' ? '' : `<p class="chip">${b.kind === 'unknown' ? 'Could not tell what this machine is short of.' : `Bottleneck: ${esc(b.kind)}${b.reason ? ` (${esc(b.reason)})` : ''}`}</p>`
  const trees = groupByTree(snap.sessions)
    .map((g) => `<section class="card"><h2>${esc(g.product)} <span class="mut">${esc(g.tree)}</span></h2><ul>${g.rows.map((r) => sessionRow(r, now, snap.local?.turn_check[r.session_id], manage)).join('')}</ul></section>`)
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JQ Agents</title>
<style>
:root{--bg:#f7f6f2;--card:#fff;--fg:#1d1c19;--mut:#6b675e;--line:#dedbd2;--well:#f1efe9;--need:#a1500a;--ok:#1f6b45;--bad:#a3262b}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--card:#1f1e1a;--fg:#ece9e1;--mut:#a09c91;--line:#35332d;--well:#161512;--need:#e0a25a;--ok:#7ccba0;--bad:#ef8a8e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:24px;margin:0}h2{font-size:15px;margin:0;padding:10px 12px;word-break:break-all}
.mut{color:var(--mut);font-size:12px;font-weight:400}.tot{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
.tot div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}.tot b{display:block;font-size:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:10px 0;overflow:hidden}
ul{list-style:none;margin:0;padding:0}li{border-top:1px solid var(--line);padding:8px 12px}
.s{font-size:11px;font-weight:700;text-transform:uppercase;border-radius:4px;padding:1px 6px;border:1px solid var(--line)}.s.live{color:var(--ok)}.s.dead{color:var(--mut)}
.b{font-size:12px;font-weight:600}.b.need{color:var(--need)}.b.old{color:var(--mut)}.b.bad{color:var(--bad)}
.chip{border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px}
.why{margin:6px 0 2px;font-size:13px}.why summary{cursor:pointer;color:var(--mut);font-size:12px}.why p{margin:6px 0}
code{font:12px ui-monospace,Menlo,monospace;background:var(--well);border-radius:4px;padding:1px 4px;word-break:break-all}
.cmds{border:1px solid var(--line);border-radius:8px}.cmds li,.fix li{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:space-between}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}form{margin:0}
button{font:600 12px system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 10px;min-height:30px;cursor:pointer}
button:hover{border-color:var(--mut)}button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}.pad{margin:0;padding:8px 12px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--well);margin:8px 0 2px;padding:10px;border-radius:8px;font-size:12px}.q{margin:6px 0 0}
</style></head><body><main>
<h1>JQ Agents</h1>
<p class="mut">${esc(snap.machine)} · read ${esc(snap.generated_at)}. Refresh to read again. Read-only: answer a session where it is running.</p>
<div class="tot"><div><b>${t.needs_you}</b><span class="mut">waiting on a person</span></div><div><b>${t.abandoned}</b><span class="mut">asked, then left</span></div><div><b>${t.live}</b><span class="mut">live</span></div><div><b>${t.sessions}</b><span class="mut">sessions in ${t.trees} ${t.trees === 1 ? 'tree' : 'trees'}</span></div></div>
${chip}
${trees || '<p class="mut">No session has been active in the window read.</p>'}
${manage ? correctionsPanel(snap, manage) : ''}
</main></body></html>`
}
