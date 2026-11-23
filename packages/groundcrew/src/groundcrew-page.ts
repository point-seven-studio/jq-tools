/**
 * JQ Groundcrew: the page, as one function from a report to an HTML string.
 *
 * The page loads nothing from the network, so opening it sends nothing anywhere. Its one
 * script is inline and does one thing: a "Copy" button puts a suggested prompt on the
 * clipboard. With scripts off, the prompt is still on the page as text to select.
 *
 * Layout: what needs a fix comes first, as full cards with the prompt to paste. What is
 * already good, and plain facts, are one line each, so they do not bury the fixes. Status is
 * never color alone: each row has an icon and a word. Light and dark follow the system.
 */
import { COPY_CSS, COPY_SCRIPT_TAG, TOOLBAR_CSS } from './presence.js'
import { LAYERS, RISK_NOTE, layerSummary, type Check, type Comparison, type StatusChange, type Group, type LayerSummary, type Status, type Summary } from './groundcrew-core.js'

export interface Report {
  project: string
  generatedAt: string
  filesRead: string[]
  checks: Check[]
  summary: Summary
  /** One row per harness layer. The page works it out from `checks`; it is here for --json. */
  layers?: LayerSummary[]
  /** What changed since an earlier report, when --since named one. */
  since?: Comparison
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STATUS: Record<Status, { icon: string; word: string }> = {
  fail: { icon: '✕', word: 'Fix' },
  warn: { icon: '!', word: 'Look' },
  pass: { icon: '✓', word: 'Good' },
  info: { icon: 'i', word: 'Fact' },
}
const GROUP_TITLE: Record<Group, string> = { setup: 'Setup', guardrails: 'Guardrails', verification: 'Verification' }
const GROUPS: Array<{ key: Group; intro: string }> = [
  { key: 'setup', intro: 'What loads into every session, and what runs without being asked.' },
  { key: 'guardrails', intro: 'What the agent may reach, and what stops it.' },
  { key: 'verification', intro: 'Who checks the work when the agent says it is done.' },
]
const ORDER: Status[] = ['fail', 'warn', 'pass', 'info']
const needsFix = (check: Check) => check.status === 'fail' || check.status === 'warn'
const anchor = (check: Check) => `check-${check.id.replace(/[^a-zA-Z0-9]+/g, '-')}`

const CSS = `
:root{--bg:#faf9f6;--card:#fff;--fg:#1c1b19;--mut:#5f5c55;--line:#dddad1;--well:#f1efe9;--fail:#d03b3b;--warn:#fab219;--pass:#0ca30c;--info:#8f8e86}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--card:#1f1e1a;--fg:#ece9e1;--mut:#a09c91;--line:#35332d;--well:#161512}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 60px}h1{font-size:26px;margin:0}h2{font-size:19px;margin:36px 0 2px}
p{margin:6px 0}.mut{color:var(--mut)}code,pre{font:13px/1.5 ui-monospace,Menlo,monospace}a{color:inherit}[id]{scroll-margin-top:14px}
.score{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 0}.tile{flex:1;min-width:120px;background:var(--card);border:1px solid var(--line);
border-radius:10px;padding:10px 14px}.tile b{display:block;font-size:26px;line-height:1.15}.tile span{font-size:12.5px;color:var(--mut)}
.bar{display:flex;gap:2px;height:8px;margin:14px 0 0}.bar i{display:block;border-radius:999px}
.todo{margin:14px 0 0;padding:0;list-style:none}.todo li{display:flex;gap:8px;align-items:center;padding:3px 0;font-size:14.5px}
.check{background:var(--card);border:1px solid var(--line);border-left-width:5px;border-radius:10px;padding:12px 14px;margin:10px 0 0}
.check h3{font-size:15.5px;margin:0;display:flex;align-items:center;gap:8px}.check p{font-size:14px}
.dot{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:11px;font-weight:700;
color:#fff;flex:none}.word{font-size:11.5px;font-weight:600;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:0 8px;margin-left:auto}
.fix{border-top:1px solid var(--line);margin-top:8px;padding-top:8px}.src{font-size:12.5px}
.prompt{margin-top:10px;border:1px solid var(--line);border-radius:8px;background:var(--well)}
.prompt header{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--mut)}
.prompt pre{margin:0;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg)}
.prompt button{margin-left:auto;font:600 12.5px system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;
padding:3px 12px;cursor:pointer}.prompt button:hover{border-color:var(--mut)}.prompt button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.rows{margin:10px 0 0;padding:0;list-style:none;background:var(--card);border:1px solid var(--line);border-radius:10px}
.rows li{display:grid;grid-template-columns:18px minmax(120px,220px) 1fr;gap:4px 10px;align-items:start;padding:8px 12px;font-size:14px}
.rows li+li{border-top:1px solid var(--line)}.rows .dot{margin-top:2px}.rows b{font-weight:600}.rows .src{grid-column:3}
@media (max-width:600px){.rows li{grid-template-columns:18px 1fr}.rows span.d,.rows .src{grid-column:2}}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:12px;font-size:13px;color:var(--mut)}footer li{margin:2px 0}
${ORDER.map((s) => `.s-${s}{border-left-color:var(--${s})}.s-${s} .dot,.s-${s}.dot,.bar .b-${s}{background:var(--${s})}`).join('')}
.s-warn .dot,.s-warn.dot{color:#0b0b0b}`

/** The only script on the page. It copies the text of a prompt; it reads and sends nothing else. */
const COPY_SCRIPT = `document.addEventListener('click',function(e){var b=e.target.closest('button[data-copy]');if(!b)return;
var t=document.getElementById(b.getAttribute('data-copy')).textContent;
function done(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1600)}
function old(){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();done()}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(done,old)}else{old()}});`

const sinceRow = (c: StatusChange) =>
  `<li>${c.after ? dot(c.after) : ''}${esc(c.title)}<span class="mut">${c.before ? STATUS[c.before].word : 'not there'} → ${c.after ? STATUS[c.after].word : 'not there'}</span></li>`

/** The section for --since: the score then and now, and each check that moved. */
function sinceSection(c: Comparison): string {
  const list = (title: string, rows: StatusChange[]) => (rows.length ? `<h3>${title}</h3><ul class="todo">${rows.map(sinceRow).join('')}</ul>` : '')
  const moved = c.worse.length + c.better.length + c.other.length + c.added.length + c.removed.length
  return (
    `<h2>Since the earlier report</h2><p class="mut">${c.readBefore ? `It was read ${esc(c.readBefore)}. ` : ''}` +
    `Then ${c.scoreBefore}% of checks passed. Now ${c.scoreAfter}% do. ${c.same} ${c.same === 1 ? 'check is' : 'checks are'} the same.</p>` +
    (moved ? '' : '<p class="mut">No check changed.</p>') +
    list('Worse', c.worse) +
    list('Better', c.better) +
    list('Changed', c.other) +
    list('New checks', c.added) +
    list('Checks that are gone', c.removed) +
    '<p class="mut">This compares the setup. It does not show whether sessions now go better.</p>'
  )
}

const dot = (status: Status) => `<span class="dot s-${status}" aria-hidden="true">${STATUS[status].icon}</span>`
const sourceLink = (check: Check) =>
  `<a href="${esc(check.source)}" target="_blank" rel="noopener noreferrer">${esc(check.source.replace(/^https:\/\/code\.claude\.com\/docs\/en\//, 'docs: ').replace(/\.md$/, ''))}</a>`

/** " · bears on OWASP LLM06:2025 Excessive Agency", or nothing. `risks` is absent on a report made by an older version. */
const riskText = (check: Check) => ((check.risks ?? []).length ? ` · bears on OWASP ${(check.risks ?? []).map(esc).join(', ')}` : '')

function fixCard(check: Check): string {
  const status = STATUS[check.status]
  const id = anchor(check)
  const isCommand = check.prompt.startsWith('/')
  const prompt = check.prompt
    ? `<div class="prompt"><header>${isCommand ? 'Type this command in Claude Code' : 'Paste this into Claude Code'}` +
      `<button type="button" data-copy="${id}-prompt">Copy</button></header><pre id="${id}-prompt">${esc(check.prompt)}</pre></div>`
    : ''
  return (
    `<section class="check s-${check.status}" id="${id}"><h3>${dot(check.status)}${esc(check.title)}<span class="word">${status.word}</span></h3>` +
    `<p>${esc(check.detail)}</p>${check.fix ? `<p class="fix"><b>What to change:</b> ${esc(check.fix)}</p>` : ''}${prompt}` +
    `<p class="src mut">Rests on ${sourceLink(check)}${riskText(check)}</p></section>`
  )
}

const row = (check: Check) =>
  `<li>${dot(check.status)}<b>${esc(check.title)}<span class="mut"> · ${STATUS[check.status].word}</span></b><span class="d">${esc(check.detail)}</span>` +
  `<span class="src mut">${sourceLink(check)}${riskText(check)}</span></li>`

const LAYER_DOT: Record<LayerSummary['state'], Status> = { fix: 'fail', look: 'warn', good: 'pass', facts: 'info', none: 'info' }

function layerCount(row: LayerSummary): string {
  const judged = row.pass + row.warn + row.fail
  if (judged) return `${row.pass} of ${judged} good`
  return row.info ? 'facts only' : 'no check ran'
}

/** The harness, one row per layer. Each row also says what Groundcrew does not check there. */
function layerPanel(checks: Check[]): string {
  const rows = layerSummary(checks).map((row) => {
    const about = LAYERS.find((l) => l.key === row.layer)!
    return (
      `<li>${dot(LAYER_DOT[row.state])}<b>${about.title}<span class="mut"> · ${layerCount(row)}</span></b>` +
      `<span class="d">${esc(about.what)} <span class="mut">${esc(about.unchecked)}</span></span></li>`
    )
  })
  return (
    '<h2>Your harness, layer by layer</h2><p class="mut">An agent is a model and what surrounds it. These are six parts of what surrounds it, with what the checks below found in each.</p>' +
    `<ul class="rows">${rows.join('')}</ul>` +
    (checks.some((c) => (c.risks ?? []).length) ? `<p class="mut">${esc(RISK_NOTE)}</p>` : '')
  )
}

/** `toolsBar` is the links to the other tools (presence.ts `toolbar`), or '' for a page with none, such as one shown inside JQ Deck. */
export function renderPage(report: Report, toolsBar = ''): string {
  const { summary } = report
  const judged = summary.pass + summary.warn + summary.fail
  const bar = (['fail', 'warn', 'pass'] as const)
    .filter((s) => summary[s] > 0)
    .map((s) => `<i class="b-${s}" style="flex:${summary[s]}"></i>`)
    .join('')
  const sorted = [...report.checks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const fixes = sorted.filter(needsFix)
  const todo = fixes.length
    ? `<h2>Do these first</h2><ul class="todo">${fixes.map((c) => `<li>${dot(c.status)}<a href="#${anchor(c)}">${esc(c.title)}</a><span class="mut">${GROUP_TITLE[c.group]}</span></li>`).join('')}</ul>`
    : '<h2>Nothing to fix</h2><p class="mut">Every check that can fail passes.</p>'
  const groups = GROUPS.map((group) => {
    const mine = sorted.filter((c) => c.group === group.key)
    const rest = mine.filter((c) => !needsFix(c))
    return (
      `<h2>${GROUP_TITLE[group.key]}</h2><p class="mut">${group.intro}</p>${mine.filter(needsFix).map(fixCard).join('')}` +
      (rest.length ? `<ul class="rows">${rest.map(row).join('')}</ul>` : '')
    )
  }).join('')
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>JQ Groundcrew: ${esc(report.project)}</title><style>${CSS}${toolsBar ? TOOLBAR_CSS + COPY_CSS : ''}</style></head><body><main>` +
    `<h1>JQ Groundcrew</h1><p class="mut">The setup check for Claude Code. How it is set up for <code>${esc(report.project)}</code>. Read ${esc(report.generatedAt)}. Refresh to read again.</p>` +
    '<div class="score">' +
    `<div class="tile"><b>${summary.fail}</b><span>to fix</span></div><div class="tile"><b>${summary.warn}</b><span>to look at</span></div>` +
    `<div class="tile"><b>${summary.pass}</b><span>good</span></div><div class="tile"><b>${summary.score}%</b><span>of ${judged} checks pass</span></div></div>` +
    `<div class="bar" role="img" aria-label="${summary.fail} to fix, ${summary.warn} to look at, ${summary.pass} good">${bar}</div>` +
    (report.since ? sinceSection(report.since) : '') +
    todo +
    layerPanel(report.checks) +
    groups +
    '<footer><p>This page was made on your machine from the files below, and it loads nothing, so nothing left the machine. ' +
    'Its one script copies a prompt to your clipboard when you press Copy. ' +
    'It read settings and your instruction files, and counted the rest. It did not read the contents of any secret file, and it read no session transcript.</p>' +
    '<p>A suggested prompt asks Claude Code to show its plan or its diff first. Read that before you approve it.</p>' +
    `<ul>${report.filesRead.map((file) => `<li><code>${esc(file)}</code></li>`).join('')}</ul>` +
    '<p>Each check names the page of Anthropic’s Claude Code documentation it rests on. The documentation was checked on 2026-11-14 and can change.</p></footer>' +
    `</main>${toolsBar}<script>${COPY_SCRIPT}</script>${toolsBar ? COPY_SCRIPT_TAG : ''}</body></html>\n`
  )
}
