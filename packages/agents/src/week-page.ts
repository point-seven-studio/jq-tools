/**
 * The page and the terminal text for "what used my week" (week.ts). One HTML string, no
 * script, no outside request. Folder and model names come from files on disk, so every
 * value is escaped.
 *
 * Every dollar on it is called an estimate, where it is shown. On a subscription nothing is
 * charged per token, so the shares and the percent of the week lead and the dollars follow.
 */
import { PRICES_SOURCE } from './prices.js'
import { TOOLBAR_CSS } from './presence.js'
import type { Share, WeekView } from './week.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`
/** A share of the whole: "93%", "6%", "0.4%", and "under 0.1%" for what would round to nothing. */
export const sharePct = (share: number): string => (share <= 0 ? '0%' : share < 0.001 ? 'under 0.1%' : `${(100 * share).toFixed(share < 0.01 ? 1 : 0)}%`)
/** A percent of the week: one decimal under ten, so a small session does not read as zero. */
export const weekPct = (p: number): string => (p <= 0 ? '0%' : p < 0.1 ? 'under 0.1%' : `${p.toFixed(p < 10 ? 1 : 0)}%`)

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--card:#fff;--fg:#1c1b19;--mut:#66625a;--line:#e3dfd6;--bar:#2f6fb3;--well:#f3f1ec;--link:#1f5fa8}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1e1c;--fg:#f1efe9;--mut:#a8a399;--line:#34322e;--bar:#6aa5e0;--well:#262522;--link:#8dbcf0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding-bottom:64px}
main{max-width:860px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 4px}
a{color:var(--link)}.mut{color:var(--mut);font-size:13px}.big{font-size:34px;font-weight:700;margin:14px 0 0;line-height:1.15}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-top:10px}
table.bars{width:100%;border-collapse:collapse;margin-top:6px}table.bars th{text-align:left;font-weight:600;padding:5px 10px 5px 0;max-width:260px;word-break:break-word;vertical-align:top}
table.bars td{padding:5px 0;vertical-align:top}td.bar{width:38%}td.bar span{display:block;height:12px;margin-top:5px;border-radius:3px;background:var(--bar);min-width:2px}
td.n{text-align:right;font-variant-numeric:tabular-nums;padding-left:12px;white-space:nowrap;font-weight:600}td.s{text-align:right;padding-left:12px;white-space:nowrap}
code{font:13px ui-monospace,Menlo,monospace;background:var(--well);padding:1px 5px;border-radius:4px;word-break:break-all}
ul{padding-left:20px;margin:6px 0}li{margin:3px 0}
@media (max-width:560px){td.bar{display:none}}
`

/** Rows with a bar. The bar repeats the share printed beside it, so nothing is carried by the bar alone. */
function rows(list: (Share & { note?: string })[], v: WeekView, empty: string): string {
  if (!list.length) return `<p class="mut">${esc(empty)}</p>`
  return `<table class="bars">${list
    .map((r) => {
      const second = v.percent ? `${weekPct(r.usd / v.percent.usdPerPercent)} of your week` : `${usd(r.usd)} est.`
      return `<tr><th scope="row">${esc(r.name)}${r.note ? `<div class="mut">${esc(r.note)}</div>` : ''}</th><td class="bar"><span style="width:${Math.max(1, Math.round(100 * r.share))}%"></span></td><td class="n">${esc(sharePct(r.share))}</td><td class="s mut">${esc(second)}</td></tr>`
    })
    .join('')}</table>`
}

const windowWords = (v: WeekView) => (v.window === 'week' ? `since your week reset on ${when(v.since)}` : 'in the last 7 days')

/** The headline: the firmest thing that can be said. */
export function headline(v: WeekView): { big: string; under: string } {
  if (!v.requests) return { big: 'Nothing counted', under: `No reply from a model was found on this machine ${windowWords(v)}.` }
  if (v.percent) return { big: `About ${weekPct(v.percent.ofWeek)} of your week`, under: `Used on this machine ${windowWords(v)}. That is about ${usd(v.usd)} at list price, which is an estimate and not a bill.` }
  return { big: `${usd(v.usd)} at list price`, under: `An estimate of what this machine used ${windowWords(v)}. It is not a bill. On a Claude subscription nothing is charged per token: the shares below are the useful part.` }
}

export function renderWeek(v: WeekView, bar = ''): string {
  const h = headline(v)
  const top = v.folders[0]
  const reading = v.percent
    ? `<p>Checked against your usage page: it showed <b>${esc(v.percent.readingPercent)}%</b> on ${esc(when(v.percent.readingAt))}. This machine had used about ${esc(usd(v.percent.usdPerPercent * v.percent.readingPercent))} at list price by then, so one percent of your week is about <b>${esc(usd(v.percent.usdPerPercent))}</b>.${v.percent.fromEarlierWeek ? ' That reading is from an earlier week. Take a new one if your plan changed.' : ''}</p><p class="mut">To check it: open your usage page now and compare it with the figure at the top. Give a new reading whenever they drift apart.</p>`
    : `<p>${esc(v.percentMissing ?? '')}</p>`
  const setUp = `<p class="mut">Your usage page says when the week resets and how much is used. Tell this tool both, once:</p><p><code>jq-agents --week --week-resets "sun 06:00" --week-reading 12</code></p><p class="mut">Use the day, time and percent your page shows. The reading is taken as of the moment you run the command.</p>`
  const unpriced = v.unpriced.length
    ? `<p class="mut">Not in any figure here: ${esc(v.unpriced.map((u) => `${u.requests} ${u.requests === 1 ? 'reply' : 'replies'} from ${u.model}`).join(', '))}. This version has no price for ${v.unpriced.length === 1 ? 'that model' : 'those models'}.</p>`
    : ''
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>What used my week: JQ Agents</title><style>${CSS}${bar ? TOOLBAR_CSS : ''}</style></head><body><main>` +
    '<h1>What used my week</h1>' +
    `<p class="mut"><a href="/">JQ Agents</a> · <a href="/signals">Signals</a> · counted from the Claude Code session files on this machine · read ${esc(when(v.until))}. Refresh to read again.</p>` +
    `<p class="big">${esc(h.big)}</p><p>${esc(h.under)}</p>` +
    (v.requests && top ? `<p class="mut">${esc(sharePct(top.share))} of it was in ${esc(top.name)}. ${esc(sharePct(v.usd ? v.subagentUsd / v.usd : 0))} was spent by subagents.</p>` : '') +
    `<h2>By repository</h2><p class="mut">The folder a session ran in, named by its repository.</p>${rows(v.folders, v, 'Nothing counted.')}` +
    `<h2>By model</h2>${rows(v.models, v, 'Nothing counted.')}${unpriced}` +
    `<h2>Largest sessions</h2><p class="mut">Up to ten. A session is named by its folder and when it began.</p>${rows(v.sessions.map((s) => ({ ...s, note: s.started ? `began ${when(s.started)}` : '' })), v, 'Nothing counted.')}` +
    `<h2>Percent of your week</h2><div class="card">${reading}${setUp}</div>` +
    '<h2>What this is, and is not</h2><div class="card"><ul>' +
    '<li><b>An estimate.</b> Each reply in a session file carries its token counts. They are priced at list price and added up. It is not what you are billed.</li>' +
    '<li><b>This machine only.</b> Usage on another computer or in the Claude apps is not in these files. The shares here are of this machine\'s use. The percent stays right only while those other places keep the same part of your use that they had when you took your reading.</li>' +
    '<li><b>Shares are the firm part.</b> Which repository or model used the most does not depend on any price being exactly right.</li>' +
    `<li><b>Prices are a copy</b> of the public list (${esc(PRICES_SOURCE)}) as read on ${esc(v.pricesRead)}. An old install shows old prices.</li>` +
    '<li><b>Some calls are missed.</b> Small calls Claude Code makes for itself do not all reach the session files.</li>' +
    '<li><b>Old weeks fade.</b> Claude Code deletes session files after 30 days unless you change that.</li>' +
    '<li><b>Nothing leaves this machine,</b> and no prompt, reply or command is read for this page: only the counts.</li>' +
    `</ul></div></main>${bar}</body></html>\n`
  )
}

/** The same, for a terminal. */
export function weekText(v: WeekView): string {
  const h = headline(v)
  const line = (r: Share, note = '') => `  ${sharePct(r.share).padStart(10)}  ${r.name}${note}${v.percent ? `  (${weekPct(r.usd / v.percent.usdPerPercent)} of your week)` : `  (${usd(r.usd)} est.)`}`
  const out = [h.big, h.under, '']
  if (v.requests) {
    out.push('By repository:', ...v.folders.slice(0, 8).map((r) => line(r)), '', 'By model:', ...v.models.slice(0, 8).map((r) => line(r)), '')
    out.push('Largest sessions:', ...v.sessions.slice(0, 5).map((s) => line(s, s.started ? `, began ${when(s.started)}` : '')), '')
  }
  if (v.unpriced.length) out.push(`No price known for: ${v.unpriced.map((u) => `${u.model} (${u.requests})`).join(', ')}. Not in any figure above.`, '')
  if (v.percent) out.push(`One percent of your week is about ${usd(v.percent.usdPerPercent)} at list price, from your reading of ${v.percent.readingPercent}% on ${when(v.percent.readingAt)}.${v.percent.fromEarlierWeek ? ' That reading is from an earlier week.' : ''}`)
  else if (v.percentMissing) out.push(v.percentMissing, '  jq-agents --week --week-resets "sun 06:00" --week-reading 12')
  out.push('', 'This machine only. An estimate at list price, not a bill.')
  return out.join('\n')
}
