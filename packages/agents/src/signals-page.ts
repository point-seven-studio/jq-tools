/**
 * The signals page: eight areas, each showing what a transcript records and naming what it
 * does not. One HTML string, no script, no outside request. Names of tools, models and
 * folders come from files on disk, so every value is escaped.
 */
import { TOOLBAR_CSS } from './presence.js'
import { NOT_MEASURED, type Signals, type Spread } from './signals.js'
import type { SignalsResult } from './signals-read.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export const WINDOWS = [1, 7, 30]

/** 1234 → "1,234", 1234567 → "1.23M". Whole numbers stay exact below ten thousand. */
export function count(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString('en-US')
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 100_000_000 ? 2 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(part / whole < 0.1 ? 1 : 0)}%` : 'none')
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

const tile = (value: string, label: string, note = '') => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span>${note ? `<i>${esc(note)}</i>` : ''}</div>`
const spreadTile = (s: Spread | null, label: string) => (s ? tile(duration(s.medianMs), `${label}, median`, `95 in 100 under ${duration(s.p95Ms)} · ${count(s.n)} measured`) : tile('none', label, 'none recorded'))

/** Rows with a bar. The bar repeats the number beside it, so nothing is carried by the bar alone. */
function bars(rows: { name: string; value: number; shown: string; note?: string }[], empty: string): string {
  if (!rows.length) return `<p class="mut">${esc(empty)}</p>`
  const max = Math.max(...rows.map((r) => r.value), 1)
  return `<table class="bars">${rows
    .map((r) => `<tr><th scope="row">${esc(r.name)}</th><td class="bar"><span style="width:${Math.max(1, Math.round((100 * r.value) / max))}%"></span></td><td class="n">${esc(r.shown)}</td><td class="mut">${esc(r.note ?? '')}</td></tr>`)
    .join('')}</table>`
}

/** One column a day. Each has its figure as a tooltip, and the table under it holds them all. */
function daily(s: Signals): string {
  if (s.byDay.length < 2) return ''
  const moved = (d: Signals['byDay'][number]) => d.tokens.input + d.tokens.output + d.tokens.cacheRead + d.tokens.cacheWrite
  const max = Math.max(...s.byDay.map(moved), 1)
  const cols = s.byDay.map((d) => `<div class="col" title="${esc(d.day)}: ${esc(count(moved(d)))} tokens, ${esc(count(d.requests))} requests"><span style="height:${moved(d) ? Math.max(2, Math.round((100 * moved(d)) / max)) : 0}%"></span></div>`).join('')
  const rows = s.byDay.map((d) => `<tr><th scope="row">${esc(d.day)}</th><td>${esc(count(d.requests))}</td><td>${esc(count(moved(d)))}</td><td>${esc(count(d.tokens.output))}</td><td>${d.errors}</td><td>${esc(usd(d.costUsd))}</td></tr>`).join('')
  return `<figure><figcaption>Tokens a day, all kinds. Tallest: ${esc(count(max))}.</figcaption><div class="cols" role="img" aria-label="Tokens a day; the table below has each figure">${cols}</div><div class="axis"><span>${esc(s.byDay[0].day)}</span><span>${esc(s.byDay[s.byDay.length - 1].day)}</span></div>
<details><summary>Each day as a table</summary><table class="grid"><tr><th>Day</th><th>Requests</th><th>Tokens</th><th>Output</th><th>API errors</th><th>Cost recorded</th></tr>${rows}</table></details></figure>`
}

function area(n: number, key: string, title: string, lead: string, body: string): string {
  const not = NOT_MEASURED[key] ?? []
  return `<section class="card" id="${key}"><h2><span class="num">${n}</span>${esc(title)}</h2><p class="lead">${esc(lead)}</p>${body}${not.length ? `<p class="not"><b>Not in a transcript:</b> ${esc(not.join('; '))}.</p>` : ''}</section>`
}

/** `bar` is the links to the other tools (presence.ts `toolbar`), or ''. */
export function renderSignals(result: SignalsResult, now = Date.now(), bar = ''): string {
  const s = result.signals
  const t = s.tokens
  const input = t.input + t.cacheRead + t.cacheWrite
  const apiErrors = s.apiErrors.reduce((a, e) => a + e.count, 0)
  const denials = s.denials.reduce((a, d) => a + d.count, 0)
  const span = s.days === 1 ? 'today' : `the last ${s.days} days`
  const windows = WINDOWS.map((d) => (d === s.days ? `<b>${d === 1 ? 'Today' : `${d} days`}</b>` : `<a href="/signals?days=${d}">${d === 1 ? 'Today' : `${d} days`}</a>`)).join(' · ')
  const seenOn = (model: string) => {
    const on = s.byDay.filter((d) => d.models[model]).map((d) => d.day)
    return on.length ? (on[0] === on[on.length - 1] ? `on ${on[0]}` : `${on[0]} to ${on[on.length - 1]}`) : ''
  }

  const sections = [
    area(
      1,
      'traces',
      'Traces',
      'What the sessions did: requests to the model, the tools they called, and work handed to subagents.',
      `<div class="tiles">${tile(count(s.requests), 'requests to the model', s.subagentRequests ? `${count(s.subagentRequests)} by subagents` : '')}${tile(count(s.prompts), 'messages from a person')}${tile(count(s.toolCalls), 'tool calls', s.prompts ? `${(s.toolCalls / s.prompts).toFixed(1)} for each message` : '')}</div>
<h3>Tools called most</h3>${bars(s.tools.slice(0, 10).map((x) => ({ name: x.name, value: x.calls, shown: count(x.calls) })), 'No tool call recorded.')}`,
    ),
    area(
      2,
      'tokens',
      'Token usage',
      'Counted from the usage each reply reports. A reply written as several records is counted once.',
      `<div class="tiles">${tile(count(t.input), 'input, not cached')}${tile(count(t.cacheRead), 'input, read from cache')}${tile(count(t.cacheWrite), 'input, written to cache')}${tile(count(t.output), 'output', t.thinking ? `${count(t.thinking)} of it thinking` : '')}</div>
${daily(s)}
<h3>Context carried by sessions active in the last day</h3>${bars(s.contexts.map((c) => ({ name: c.name, value: c.tokens, shown: `${count(c.tokens)} tokens` })), 'No session made a request in the last day.')}
<p class="mut">${plural(s.compactions, 'time')} a session ran out of room and was summarized in ${span}.</p>
<h3>By folder</h3>${bars(s.folders.slice(0, 10).map((f) => ({ name: f.name, value: f.tokens, shown: `${count(f.tokens)} tokens`, note: `${count(f.requests)} requests` })), 'Nothing recorded.')}`,
    ),
    area(
      3,
      'latency',
      'Latency',
      'Measured between records in the transcript. A turn runs from a person sending a message to the session ending its turn. A tool call runs from the model asking for it to its result landing. Both include any time spent waiting for a permission answer.',
      `<div class="tiles">${spreadTile(s.turn, 'a whole turn')}${spreadTile(s.thinking, 'thinking, per reply')}</div>
<h3>Slowest tools, by median</h3>${bars(
        s.tools
          .filter((x) => x.time && x.time.n >= 5)
          .sort((a, b) => (b.time as Spread).medianMs - (a.time as Spread).medianMs)
          .slice(0, 8)
          .map((x) => ({ name: x.name, value: (x.time as Spread).medianMs, shown: duration((x.time as Spread).medianMs), note: `95 in 100 under ${duration((x.time as Spread).p95Ms)} · ${count((x.time as Spread).n)} measured` })),
        'No tool reported its time at least five times.',
      )}`,
    ),
    area(
      4,
      'drift',
      'Quality drift',
      'A transcript cannot score an answer. It can show the two changes that most often explain a shift in quality: which model answered, and which version of Claude Code ran. Whether a finished turn was checked is on the board.',
      `<h3>Models that answered</h3>${bars(s.models.map((m) => ({ name: m.name, value: m.requests, shown: `${count(m.requests)} requests`, note: seenOn(m.name) })), 'No reply recorded.')}
<h3>Claude Code versions</h3>${bars(s.versions.map((v) => ({ name: v.name, value: v.requests, shown: `${count(v.requests)} requests` })), 'No version recorded.')}
<p class="mut"><a href="/">Sessions that said they were done without a check are on the board.</a></p>`,
    ),
    area(
      5,
      'errors',
      'Errors',
      'An API error is a request that ended in an error shown to the person. A retry is a request that failed and was sent again without anyone seeing it.',
      `<div class="tiles">${tile(count(apiErrors), 'API errors', s.requests ? `beside ${count(s.requests)} requests that answered` : '')}${tile(count(s.retries), 'retries')}${tile(count(s.toolFailures), 'tool calls that failed', s.toolCalls ? `${pct(s.toolFailures, s.toolCalls)} of tool calls` : '')}${tile(count(s.timeouts), 'tool calls that timed out')}${tile(count(s.fallbacks), 'replies from a model other than the one asked for')}</div>
<h3>API errors by kind</h3>${bars(s.apiErrors.map((e) => ({ name: e.kind, value: e.count, shown: count(e.count) })), 'None recorded.')}
<h3>Tools that fail most</h3>${bars(
        s.tools
          .filter((x) => x.failed)
          .sort((a, b) => b.failed - a.failed)
          .slice(0, 8)
          .map((x) => ({ name: x.name, value: x.failed, shown: count(x.failed), note: `${pct(x.failed, x.calls)} of its ${count(x.calls)} calls` })),
        'No tool call failed.',
      )}
<p class="mut">A failed tool call is often ordinary: a test that fails, a search that finds nothing. Read the share, not the count.</p>`,
    ),
    area(
      6,
      'cost',
      'Cost',
      'The figure is the estimate Claude Code writes into the transcript itself. On a subscription it is not what you pay. It is written now and then, not after every request, so the newest spending may be missing and a day can hold another day’s share.',
      `<div class="tiles">${tile(usd(s.costUsd), `estimate recorded in ${span}`)}${tile(s.cacheShare === null ? 'none' : `${Math.round(s.cacheShare * 100)}%`, 'of input read from cache', input ? `${count(t.cacheRead)} of ${count(input)} tokens` : '')}</div>
<h3>By folder</h3>${bars(s.folders.filter((f) => f.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd).slice(0, 10).map((f) => ({ name: f.name, value: f.costUsd, shown: usd(f.costUsd) })), 'No estimate recorded.')}
<h3>Model mix, by output</h3>${bars([...s.models].sort((a, b) => b.output - a.output).map((m) => ({ name: m.name, value: m.output, shown: `${count(m.output)} tokens`, note: `${pct(m.output, t.output)} of output` })), 'No reply recorded.')}`,
    ),
    area(
      7,
      'feedback',
      'User feedback',
      'A coding session has no thumbs. What it does record is a person stopping it, and a person saying no to something it wanted to do.',
      `<div class="tiles">${tile(count(s.interruptions), 'times a person interrupted', s.prompts ? `beside ${count(s.prompts)} messages` : '')}${tile(count(s.denials.find((d) => d.kind === 'user-rejected')?.count ?? 0), 'actions a person refused')}</div>
<p class="mut"><a href="/">Sessions waiting on a person right now are on the board.</a></p>`,
    ),
    area(
      8,
      'safety',
      'Safety signals',
      'Times something stood between a session and an action. These are the guards working, not a finding about what was asked.',
      `<div class="tiles">${tile(count(denials), 'actions not allowed')}${tile(count(s.refusals), 'replies the model refused')}${tile(count(s.hookBlocks), 'times a hook stopped a turn from ending')}${tile(count(s.sandboxOff), 'commands run outside the sandbox')}</div>
<h3>Why an action was not allowed</h3>${bars(s.denials.map((d) => ({ name: d.kind, value: d.count, shown: count(d.count) })), 'None recorded.')}`,
    ),
  ].join('')

  const nav = ['Traces', 'Tokens', 'Latency', 'Drift', 'Errors', 'Cost', 'Feedback', 'Safety'].map((label, i) => `<a href="#${['traces', 'tokens', 'latency', 'drift', 'errors', 'cost', 'feedback', 'safety'][i]}">${label}</a>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JQ Agents: signals</title>
<style>
:root{--bg:#f7f6f2;--card:#fff;--fg:#1d1c19;--mut:#6b675e;--line:#dedbd2;--well:#f1efe9;--bar:#4a6b8a}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--card:#1f1e1a;--fg:#ece9e1;--mut:#a09c91;--line:#35332d;--well:#161512;--bar:#8fb0cf}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:24px 16px 60px}
a{color:inherit}h1{font-size:24px;margin:0}
h2{font-size:17px;margin:0 0 4px;display:flex;align-items:center;gap:8px}h3{font-size:13px;margin:16px 0 6px}
.num{font-size:12px;border:1px solid var(--line);border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;color:var(--mut)}
.mut{color:var(--mut);font-size:12px}.lead{margin:0 0 12px;color:var(--mut);font-size:13px}
.nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:12px 0;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:12px 0;padding:14px 14px 12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.tile{border:1px solid var(--line);border-radius:10px;padding:10px;min-width:0}.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.tile span{display:block;font-size:12px;color:var(--mut)}.tile i{display:block;font-style:normal;font-size:11px;color:var(--mut);margin-top:2px}
table{border-collapse:collapse;width:100%;font-size:13px}th{font-weight:400;text-align:left}
.bars th{width:34%;padding:3px 8px 3px 0;word-break:break-all}.bars .bar{width:30%}.bars .n{padding:0 8px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bar span{display:block;height:8px;border-radius:0 4px 4px 0;background:var(--bar)}
figure{margin:14px 0 0}figcaption{font-size:12px;color:var(--mut);margin-bottom:6px}
.cols{display:flex;align-items:flex-end;gap:2px;height:90px;border-bottom:1px solid var(--line)}
.col{flex:1;height:100%;display:flex;align-items:flex-end}.col span{display:block;width:100%;background:var(--bar);border-radius:4px 4px 0 0}
.axis{display:flex;justify-content:space-between;font-size:11px;color:var(--mut)}
details{margin-top:6px}summary{cursor:pointer;font-size:12px;color:var(--mut)}
.grid{margin-top:6px}.grid th,.grid td{padding:3px 8px 3px 0;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
.not{margin:14px 0 0;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--mut)}
@media (max-width:520px){.bars th{width:44%}.bars .bar{width:18%}.bars td.mut{display:none}}
${bar ? TOOLBAR_CSS : ''}</style></head><body><main>
<h1>Signals</h1>
<p class="mut"><a href="/">JQ Agents</a> · counted from the Claude Code transcripts on this machine · ${windows}</p>
<p class="mut">${count(result.files)} transcript ${result.files === 1 ? 'file' : 'files'} read, as of ${esc(new Date(now).toISOString())}. Counts only: no prompt, reply or command text is kept, and nothing on this page leaves the machine. Reload to count again.</p>
<nav class="nav" aria-label="Areas">${nav}</nav>
${s.requests || s.prompts ? '' : `<p class="card">No session activity recorded in ${span}.</p>`}
${sections}
<p class="mut">The transcript format belongs to Claude Code and can change in any release. A count that falls to nothing after an update may mean the format moved, not that the thing stopped happening.</p>
</main>${bar}</body></html>`
}
