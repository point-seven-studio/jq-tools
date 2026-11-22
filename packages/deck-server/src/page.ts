/**
 * The team page and the sign-in page. One HTML string each, no script, no
 * outside request. Every value is escaped: names come from other machines.
 *
 * The page shows only what buildTeam() returns. The few sums made here (live
 * sessions, setup items to fix and to look at) add up numbers the machines
 * reported, over the rows that are current; nothing is estimated.
 *
 * Grouping, search, filter and sort are links and one GET form: the choice is
 * in the address (view.ts), so there is still no script to run.
 */
import { TOOLBAR_CSS, toolbar } from './presence.js'
import { duration, type MachineState, type Team, type TeamRow } from './team.js'
import { allRows, DEFAULT_VIEW, MAX_SEARCH_CHARS, select, viewHref, waitingRows, type Filter, type ReportRow, type Sort, type View } from './view.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/* Amber (--warn) marks what needs a person and nothing else. Teal (--ok) marks a machine
 * heard from recently. Violet (--acc) is the product colour, the setup score and a setup
 * item to fix. Every coloured mark also says what it means in words. */
const STYLE = `
:root{color-scheme:light dark;--bg:#f5f6f9;--rail:#eceff4;--card:#fff;--well:#f1f3f8;--head:#eef1f6;--line:#d3d9e2;--soft:#e3e7ee;--fg:#141922;--sub:#3f4b5d;--mut:#5a6678;--warn:#8a4b00;--warn-bg:#fdf3e3;--warn-line:#dcae6a;--ok:#0d6455;--ok-bg:#e5f4f0;--ok-line:#9ccfc3;--acc:#5140b5;--acc-bg:#eeebfb;--acc-line:#c3baee;--bad:#a3262b;--link:#1d4f91;--track:#dde2ea}
@media (prefers-color-scheme:dark){:root{--bg:#090d13;--rail:#0d121b;--card:#111924;--well:#151f2c;--head:#182331;--line:#263342;--soft:#1c2936;--fg:#eaf0f6;--sub:#a6b3c2;--mut:#8996aa;--warn:#f5bb6d;--warn-bg:#241c17;--warn-line:#675038;--ok:#72d7b6;--ok-bg:#16282a;--ok-line:#2f5650;--acc:#baa9f8;--acc-bg:#27243a;--acc-line:#4b4367;--bad:#ef8a8e;--link:#9db8f2;--track:#354256}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1,h2,h3,p,ul,ol{margin:0;padding:0}ul,ol{list-style:none}
a{color:var(--link)}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}code{font-size:12px;word-break:break-all}
main small,.brand small{display:block;font-size:12px;font-weight:400;color:var(--mut);margin-top:2px}
.mut{color:var(--mut);font-size:12px}.bad{color:var(--bad);font-size:12px;font-weight:600}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--ok);outline-offset:3px}
.skip{position:absolute;left:-999px;top:8px;background:var(--card);color:var(--fg);padding:10px 14px;border:1px solid var(--line);border-radius:8px;z-index:9}.skip:focus{left:8px}
button{white-space:nowrap;font:inherit;font-size:13px;min-height:44px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:9px;padding:6px 14px;cursor:pointer}
button:hover{background:var(--well)}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}
input,select{font:inherit;font-size:13px;min-height:44px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}

.app{display:grid;grid-template-columns:228px minmax(0,1fr);min-height:100vh}
.side{background:var(--rail);border-right:1px solid var(--soft);padding:24px 14px 84px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:12px;margin:2px 10px 34px}
.mark{width:36px;height:36px;flex-shrink:0;display:grid;place-items:center;background:var(--acc-bg);border:1px solid var(--acc-line);border-radius:11px;color:var(--acc);font-size:13px;font-weight:800}
.brand b{display:block;font-size:17px;letter-spacing:-.03em;line-height:1.15}
.brand small,.kick,.side h2,.lab{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
.brand small{margin-top:4px}
.side h2{padding:0 12px;margin-bottom:8px}
.side nav{display:grid;gap:4px}
.side nav a{display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 12px;border-radius:9px;color:var(--sub);text-decoration:none;font-weight:600}
.side nav a:hover{background:var(--well);color:var(--fg)}
.count{margin-left:auto;background:var(--well);border:1px solid var(--line);color:var(--sub);font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 7px;border-radius:6px}
.count.hot{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn)}
.side-end{margin-top:auto;padding-top:20px}
.side-note{margin:0 4px 12px;padding:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:12px;line-height:1.55;color:var(--sub)}
.side-note b{display:block;color:var(--fg);margin-bottom:4px}
.ver{padding:0 12px;font-size:11px;color:var(--mut)}

.col{min-width:0}
.bar{min-height:64px;border-bottom:1px solid var(--soft);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 18px;padding:10px clamp(16px,3vw,48px)}
.crumbs{font-size:12px;font-weight:600;color:var(--mut)}.crumbs b{color:var(--fg)}
.bar-end{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:650;color:var(--sub)}
.dot{display:inline-block;width:7px;height:7px;flex-shrink:0;border-radius:50%;border:1px solid var(--mut)}
.dot.on{background:var(--ok);border-color:var(--ok)}
.user{font-size:12px;color:var(--sub)}.user b{color:var(--fg)}

main{max-width:1480px;margin:0 auto;padding:32px clamp(16px,3vw,48px) 56px}
.kick{color:var(--acc)}
.headline{display:flex;justify-content:space-between;align-items:flex-end;gap:22px;margin:6px 0 24px}
h1{font-size:30px;letter-spacing:-.045em;line-height:1.15;font-weight:770;margin-bottom:8px}
.lead{color:var(--sub);max-width:80ch}
.stamp{text-align:right;color:var(--mut);font-size:12px;line-height:1.7;flex-shrink:0}.stamp b{color:var(--fg);font-weight:600}

.metrics{display:grid;grid-template-columns:1.25fr 1fr 1fr 1fr;gap:12px;margin:0 0 28px}
.metric{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 19px;min-height:104px}
.metric dt{font-size:12px;font-weight:640;color:var(--sub)}
.metric dd{margin:0}
.metric dd b{display:block;font-size:30px;line-height:1.2;letter-spacing:-.045em;font-weight:770;margin-top:8px}
.metric dd b i{font-style:normal;font-size:15px;font-weight:600;letter-spacing:0;color:var(--mut)}
.metric dd span{display:block;font-size:12px;color:var(--mut);margin-top:2px}
.metric.hot{background:var(--warn-bg);border-color:var(--warn-line)}.metric.hot dd b{color:var(--warn)}

section{scroll-margin-top:16px}
.sec{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:12px 18px;margin-bottom:12px}
.sec h2,.panel h2{font-size:17px;letter-spacing:-.03em;font-weight:745}
.sec h2 span,.panel h2 span{color:var(--mut);font-weight:500;font-size:13px}
.sec p,.panel-top p{font-size:12px;color:var(--mut);margin-top:3px}
.attn{margin-bottom:30px}.attn .kick{color:var(--warn)}
.queue{border:1px solid var(--warn-line);border-radius:11px;overflow:hidden;background:var(--warn-bg)}
.queue li{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) auto;align-items:center;gap:8px 18px;padding:14px 20px;border-top:1px solid var(--warn-line)}.queue li:first-child{border-top:0}
.q-main{display:flex;align-items:flex-start;gap:12px;min-width:0}
.bang{width:30px;height:30px;flex-shrink:0;display:grid;place-items:center;border-radius:9px;border:1px solid var(--warn-line);color:var(--warn);font-weight:800}
.queue b{font-size:14px;font-weight:730;overflow-wrap:anywhere}
.queue small{color:var(--sub);overflow-wrap:anywhere}
.q-age{text-align:right;white-space:nowrap}.q-age b{display:block;font:780 19px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--warn)}
.note{font-size:12px;color:var(--mut);margin-top:8px}
.calm,.strip{border:1px solid var(--line);border-radius:11px;background:var(--card);padding:14px 20px;margin-bottom:30px;color:var(--sub)}
.strip{border-left-width:3px}.strip .kick{color:var(--mut)}.strip h2{font-size:17px;margin:4px 0}.strip p{font-size:12px}

.tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.seg{display:flex;background:var(--card);padding:3px;gap:2px;border:1px solid var(--line);border-radius:9px}
.seg a,.pills a{display:inline-flex;align-items:center;min-height:36px;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:650;color:var(--sub);text-decoration:none;white-space:nowrap}
.seg a:hover,.pills a:hover{color:var(--fg);background:var(--well)}
.seg a[aria-current]{background:var(--head);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line)}
.find{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.find input{min-width:230px}.find label{display:inline;margin:0;font-weight:400;font-size:12px;color:var(--mut)}
.pillbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;margin-bottom:10px}
.pills{display:flex;flex-wrap:wrap;gap:6px}.pills a{border:1px solid var(--line)}.pills a i{font-style:normal;margin-left:6px;color:var(--mut);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pills a[aria-current]{background:var(--head);color:var(--fg);border-color:var(--mut)}

.board{border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--card)}
table{width:100%;border-collapse:collapse;table-layout:fixed}
col.c1{width:29%}col.c2{width:15%}col.c3{width:14%}col.c4{width:17%}col.c5{width:10%}col.c6{width:15%}
thead th{background:var(--head);color:var(--mut);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-align:left;padding:11px 12px}
th,td{text-align:left;vertical-align:top;padding:12px;font-weight:400;overflow-wrap:anywhere}
thead th:first-child,tbody th:first-child,tbody td:first-child{padding-left:20px}
tr.group th{background:var(--well);border-top:1px solid var(--line);padding-top:10px;padding-bottom:10px}
.g{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:2px 16px}
.g b{font-size:14px;font-weight:740}.g span.mono{font-size:12px;color:var(--mut);margin-left:10px;font-weight:400}.g i{font-style:normal;font-size:12px;color:var(--sub);white-space:nowrap}
.g i.hot{color:var(--warn);font-weight:700}
tr.r>*{border-top:1px solid var(--soft)}
tr.r th b,tr.r td b{font-size:13px;font-weight:700}
.lab{display:none;margin-bottom:4px}
.who{display:flex;align-items:center;gap:9px}
.av{display:grid;place-items:center;width:27px;height:27px;flex-shrink:0;background:var(--acc-bg);border:1px solid var(--acc-line);color:var(--acc);font-weight:800;border-radius:7px;font-size:10px}
.amber{color:var(--warn)}.none{color:var(--mut);font-weight:400}
.fix{color:var(--acc);font-weight:700}.look{color:var(--sub);font-weight:600}
.meter{display:block;height:4px;border-radius:8px;background:var(--track);margin:6px 0 3px;overflow:hidden;max-width:130px}.meter i{display:block;height:100%;background:var(--acc);border-radius:8px}
tr.quiet b,tr.quiet .amber,tr.quiet .fix,tr.quiet .look,li.quiet b,li.quiet .fix,li.quiet .look{color:var(--mut)}tr.quiet .meter i,li.quiet .meter i{background:var(--mut)}
tr.asked td{padding-top:0}
.q{background:var(--well);padding:10px 12px;border-radius:8px;border-left:3px solid var(--warn)}
.q p{white-space:pre-wrap;word-break:break-word;font-size:14px;margin-top:2px}
.empty{font-size:13px;color:var(--mut);padding:22px 20px}

.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:28px 0 24px;align-items:start}
.panel{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:18px 20px}
.panel-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:6px}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--well);border-radius:99px;padding:5px 10px;color:var(--sub);font-size:11px;font-weight:700;white-space:nowrap}
.pill.on{border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)}
.tally{font-size:12px;font-weight:700;color:var(--acc);white-space:nowrap;text-align:right}.tally small{color:var(--sub)}
.list>li{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-top:1px solid var(--soft)}.list>li:first-child{border-top:0}
.list b{font-size:13px;font-weight:700;overflow-wrap:anywhere}
.list .end{text-align:right;flex-shrink:0;font-size:12px;color:var(--sub)}
.list .score{min-width:130px}.list .score .meter{margin-left:auto}

.privacy{padding:14px 18px;border:1px solid var(--line);border-radius:10px;color:var(--sub);background:var(--card);font-size:12px;line-height:1.65}
.privacy b{color:var(--fg)}
.foot{display:none;margin-top:18px;color:var(--mut);font-size:11px}

.card{background:var(--card);border:1px solid var(--line);border-radius:13px}.pad{padding:16px}
label{display:block;font-weight:600;margin-bottom:6px}
.login{max-width:440px;padding-top:56px}.login h1{font-size:26px}.login form{margin-top:16px}.login input{width:100%;margin-bottom:8px;background:var(--well)}.login form .mut{margin-bottom:12px}

@media (max-width:1199px){.app{grid-template-columns:200px minmax(0,1fr)}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:1069px){.app{display:block}.side{position:static;height:auto;overflow:visible;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:12px 20px;border-right:0;border-bottom:1px solid var(--line)}.brand{margin:0}.side h2,.side-end{display:none}.side nav{display:flex;flex-wrap:wrap;gap:4px}.side nav a{padding:8px 10px}.count{margin-left:0}.foot{display:block}}
@media (max-width:859px){.two{grid-template-columns:1fr}table,tbody,tr,th,td{display:block}thead,colgroup{display:none}.lab{display:block}tr.r{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--line);padding:6px 8px}tr.r>*{border-top:0;padding:8px 12px}tr.r>th{grid-column:1/-1}thead th:first-child,tbody th:first-child,tbody td:first-child{padding-left:12px}tr.group th{padding-left:20px}tr.asked td{padding:0 20px 14px}.queue li{grid-template-columns:minmax(0,1fr) auto}.q-where{grid-column:1;grid-row:2;padding-left:42px}.q-age{grid-column:2;grid-row:1/3}}
@media (max-width:599px){.headline{display:block}h1{font-size:27px}.stamp{text-align:left;margin-top:12px}.metrics{gap:8px}.metric{padding:13px 14px;min-height:98px}.metric dd b{font-size:26px}tr.r{grid-template-columns:repeat(2,minmax(0,1fr))}.queue li{padding:13px 14px}.q-age b{font-size:17px}.tools,.find,.seg{width:100%}.seg a{flex:1;justify-content:center}.find input{flex:1 1 100%;min-width:0}.find select{flex:1}.list>li{align-items:flex-start}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`

const heard = (minutes: number) => (minutes < 1 ? 'just now' : `${duration(minutes)} ago`)

const minutesSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))

/** "23:34 UTC": the page has no script, so it cannot show the reader's own time zone. */
export const clock = (iso: string) => `${iso.slice(11, 16)} UTC`

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Two letters for the small square beside a name. Decoration only: the name is always written out. */
function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase()
}

/** Unknown is a dash with its reason beside it. It is never written as a zero. */
const DASH = '<span class="none" aria-hidden="true">—</span>'

const meter = (score: number) => `<span class="meter" aria-hidden="true"><i style="width:${score}%"></i></span>`

/** "To fix" and "to look at" are two counts a machine reports. Both are shown; they are never added together. */
function setupWords(s: NonNullable<TeamRow['setup']>): string {
  const parts = [s.fail > 0 ? `<span class="fix">${s.fail} to fix</span>` : '', s.warn > 0 ? `<span class="look">${s.warn} to look at</span>` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'all good'
}

const freshnessWords = (f: MachineState['freshness']) => (f === 'fresh' ? 'reporting' : f === 'quiet' ? 'quiet, not counted' : 'silent for over a day, rows hidden')

const td = (label: string, value: string, note = '') => `<td><span class="lab">${label}</span>${value}${note ? `<small>${note}</small>` : ''}</td>`

const COLUMNS = ['Waiting on a person', 'Sessions', 'Setup', 'Mail', 'Last heard']

function row(r: ReportRow, now: number, view: View): string {
  const quiet = r.freshness !== 'fresh'
  const waiting = quiet
    ? td(COLUMNS[0], DASH, 'not current')
    : r.needs_you > 0
      ? r.waiting_minutes !== null
        ? td(COLUMNS[0], `<b class="amber">${esc(duration(r.waiting_minutes))}</b>`, `${r.needs_you} waiting`)
        : td(COLUMNS[0], `<b class="amber">${r.needs_you} waiting</b>`, 'how long was not reported')
      : td(COLUMNS[0], '<span class="none">none</span>')
  const sessions = td(COLUMNS[1], `<b>${r.sessions}</b>`, `${r.live} live${r.abandoned > 0 ? ` · ${r.abandoned} abandoned` : ''}`)
  const setup = !r.setup ? td(COLUMNS[2], DASH, 'not checked') : td(COLUMNS[2], `<b class="mono">${r.setup.score}%</b>${meter(r.setup.score)}`, setupWords(r.setup))
  const mail = r.unread === null ? td(COLUMNS[3], DASH, 'no inbox') : r.unread === 0 ? td(COLUMNS[3], '<span class="none">none unread</span>') : td(COLUMNS[3], `<b>${r.unread}</b>`, 'unread')
  const last = td(COLUMNS[4], `<b><span class="dot${quiet ? '' : ' on'}" aria-hidden="true"></span> ${esc(heard(r.minutes_ago))}</b>`, freshnessWords(r.freshness))
  // One row is one folder on one machine. Grouped by repository, the row names the machine
  // and its folder; grouped by machine, it names the folder and its repository.
  const first =
    view.group === 'repo'
      ? `<span class="who"><span class="av" aria-hidden="true">${esc(initials(r.who))}</span><span><b>${esc(r.who)} · <span class="mono">${esc(r.machine)}</span></b><small>folder <span class="mono">${esc(r.name)}</span></small></span></span>`
      : `<b>${esc(r.name)}</b>${r.remote ? `<small class="mono">${esc(r.remote)}</small>` : ''}`
  // An old question may have been answered since: shown only while the machine is current.
  const asked = (r.questions ?? [])
    .map((q) => `<div class="q"><span class="mut">${esc(r.who)}'s session asked${q.asked_at ? ` ${esc(heard(minutesSince(q.asked_at, now)))}` : ''}</span><p>${esc(q.text)}</p></div>`)
    .join('')
  return `<tr class="r${quiet ? ' quiet' : ''}"><th scope="row">${first}</th>${waiting}${sessions}${setup}${mail}${last}</tr>${asked ? `<tr class="asked"><td colspan="6">${asked}</td></tr>` : ''}`
}

const FILTER_NAMES: Record<Filter, string> = { all: 'All reports', waiting: 'Waiting', live: 'Live', fix: 'Setup to fix' }
const SORT_NAMES: Record<Sort, string> = { waiting: 'Longest wait', repository: 'Repository name', machine: 'Machine name', setup: 'Lowest setup score' }

export function renderTeam(team: Team, viewerName: string, version: string, view: View = DEFAULT_VIEW): string {
  const now = Date.parse(team.generated_at)
  const t = team.totals
  const known = t.machines_fresh + t.machines_quiet + t.machines_silent
  const rows = allRows(team)
  const current = rows.filter((r) => r.freshness === 'fresh')
  const live = current.reduce((n, r) => n + r.live, 0)
  const checked = current.filter((r) => r.setup)
  const toFix = checked.reduce((n, r) => n + (r.setup?.fail ?? 0), 0)
  const toLook = checked.reduce((n, r) => n + (r.setup?.warn ?? 0), 0)
  const waitingRepos = team.groups.filter((g) => g.needs_you > 0).length
  const queue = waitingRows(team)
  const picked = select(team, view)
  const narrowed = view.filter !== 'all' || view.q !== ''

  const late = [t.machines_quiet > 0 ? `${t.machines_quiet} quiet` : '', t.machines_silent > 0 ? `${t.machines_silent} silent` : ''].filter(Boolean).join(', ')
  // With no machine reporting there is no current count: a dash, not a zero.
  const anyFresh = t.machines_fresh > 0
  const metric = (label: string, value: string, note: string, hot = false) => `<div class="metric${hot ? ' hot' : ''}"><dt>${label}</dt><dd><b>${value}</b><span>${note}</span></dd></div>`
  const metrics = `<dl class="metrics" aria-label="Totals from the machines reporting now">${anyFresh ? metric('Waiting on a person', `${t.needs_you}`, t.needs_you > 0 ? `in ${plural(waitingRepos, 'repository', 'repositories')}` : 'nothing waiting', t.needs_you > 0) : metric('Waiting on a person', '—', 'no current report')}${anyFresh ? metric('Sessions', `${t.sessions}<i> · ${live} live</i>`, `in ${plural(current.length, 'report', 'reports')}`) : metric('Sessions', '—', 'no current report')}${metric('Machines reporting', `${t.machines_fresh}<i> of ${known}</i>`, late ? `${late}: not counted` : `last heard ${esc(heard(team.machines[0]?.minutes_ago ?? 0))}`)}${checked.length > 0 ? metric('Setup items to fix', `${toFix}`, `${toLook > 0 ? `plus ${toLook} to look at, ` : ''}in ${plural(checked.length, 'setup check', 'setup checks')}`) : metric('Setup items to fix', '—', 'no setup check reported')}</dl>`

  let attention = ''
  if (queue.length > 0) {
    const items = queue
      .map(
        (r) =>
          `<li><div class="q-main"><span class="bang" aria-hidden="true">!</span><div><b>${esc(r.name)}</b>${r.remote ? `<small class="mono">${esc(r.remote)}</small>` : ''}<small>${plural(r.needs_you, 'waiting session', 'waiting sessions')}</small></div></div><div class="q-where"><b>${esc(r.who)} · <span class="mono">${esc(r.machine)}</span></b><small>Answer on this machine</small></div><div class="q-age">${r.waiting_minutes !== null ? `<b>${esc(duration(r.waiting_minutes))}</b><small>waiting</small>` : `<b aria-hidden="true">—</b><small>how long was not reported</small>`}</div></li>`,
      )
      .join('')
    attention = `<section class="attn" id="attention" aria-labelledby="h-attn"><div class="sec"><div><p class="kick">Needs attention</p><h2 id="h-attn">Waiting on a person <span>(${t.needs_you})</span></h2><p>Longest wait first. One line per folder a machine reported, with how many of its sessions wait.</p></div></div><ol class="queue">${items}</ol><p class="note">This board cannot answer a session. Answer each one in the session on its own machine.</p></section>`
  } else if (known > 0 && !anyFresh) {
    attention = `<section class="strip" id="attention" aria-labelledby="h-attn"><p class="kick">Not current</p><h2 id="h-attn">No machine has reported in the last 5 minutes</h2><p>What is below is each machine's last report. None of it is counted, and a session may have been answered or closed since.</p></section>`
  } else if (known > 0) {
    attention = `<p class="calm" id="attention">No session is reported waiting on a person.</p>`
  }

  const machineOf = new Map(team.machines.map((m) => [m.machine, m]))
  const sections = picked.sections
    .map((s) => {
      const r = s.rows[0]
      const m = machineOf.get(r.machine)
      const title = view.group === 'repo' ? `<b>${esc(r.repo_name)}</b>${r.remote ? `<span class="mono">${esc(r.remote)}</span>` : ''}` : `<b class="mono">${esc(r.machine)}</b><span class="mono">${esc(r.who)}${m ? ` · ${freshnessWords(m.freshness)}` : ''}</span>`
      return `<tbody><tr class="group"><th colspan="6" scope="rowgroup"><span class="g"><span>${title}</span><i${s.waiting > 0 ? ' class="hot"' : ''}>${plural(s.rows.length, 'report', 'reports')} · ${s.waiting > 0 ? `${s.waiting} waiting` : 'none waiting'}</i></span></th></tr>${s.rows.map((x) => row(x, now, view)).join('')}</tbody>`
    })
    .join('')
  const table = sections
    ? `<div class="board"><table><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c6"></colgroup><thead><tr><th scope="col">${view.group === 'repo' ? 'Person, machine and folder' : 'Folder and repository'}</th>${COLUMNS.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead>${sections}</table></div>`
    : picked.total === 0
      ? '<p class="board empty">No repository to show.</p>'
      : `<p class="board empty">No report matches. <a href="${esc(viewHref(DEFAULT_VIEW, { group: view.group }))}">Show all reports</a></p>`

  const tab = (label: string, group: View['group']) => `<a href="${esc(viewHref(view, { group }))}"${view.group === group ? ' aria-current="true"' : ''}>${label}</a>`
  const pill = (f: Filter) => `<a href="${esc(viewHref(view, { filter: f }))}"${view.filter === f ? ' aria-current="true"' : ''}>${FILTER_NAMES[f]}<i>${picked.counts[f]}</i></a>`
  const hidden = `${view.group !== DEFAULT_VIEW.group ? `<input type="hidden" name="group" value="${view.group}">` : ''}${view.filter !== DEFAULT_VIEW.filter ? `<input type="hidden" name="filter" value="${view.filter}">` : ''}`
  const controls =
    picked.total > 0
      ? `<div class="tools"><div class="seg" role="group" aria-label="Group reports">${tab('By repository', 'repo')}${tab('By machine', 'machine')}</div><form class="find" method="get" action="/#reports" role="search">${hidden}<label class="sr" for="q">Search repositories, folders, machines and people</label><input id="q" name="q" type="search" value="${esc(view.q)}" maxlength="${MAX_SEARCH_CHARS}" placeholder="Search repositories or machines"><label for="sort">Sort</label><select id="sort" name="sort">${(Object.keys(SORT_NAMES) as Sort[]).map((s) => `<option value="${s}"${view.sort === s ? ' selected' : ''}>${SORT_NAMES[s]}</option>`).join('')}</select><button>Apply</button></form></div>`
      : ''
  const pills =
    picked.total > 0
      ? `<div class="pillbar"><div class="pills" role="group" aria-label="Show">${(['all', 'waiting', 'live', 'fix'] as Filter[]).map(pill).join('')}</div>${narrowed ? `<p class="mut">Showing ${picked.rows.length} of ${plural(picked.total, 'report', 'reports')}. The totals and the waiting list above cover all of them. <a href="${esc(viewHref(DEFAULT_VIEW, { group: view.group }))}">Show all</a></p>` : ''}</div>`
      : ''

  const reposOf = (m: MachineState) => new Set(rows.filter((r) => r.machine === m.machine).map((r) => r.repo_key)).size
  const reportsOf = (m: MachineState) => rows.filter((r) => r.machine === m.machine).length
  const machines = team.machines
    .map(
      (m) =>
        `<li${m.freshness === 'fresh' ? '' : ' class="quiet"'}><div><b class="mono">${esc(m.machine)}</b><small>${esc(m.who)} · ${m.freshness === 'silent' ? 'rows hidden' : `${plural(reportsOf(m), 'report', 'reports')} · ${plural(reposOf(m), 'repository', 'repositories')}`}</small></div><div class="end">last heard <b>${esc(heard(m.minutes_ago))}</b><small>${freshnessWords(m.freshness)}</small></div></li>`,
    )
    .join('')

  // The table has every score. This panel is the follow-up list: only the checks with something to do.
  const allChecks = rows.filter((r) => r.setup)
  const clean = allChecks.filter((r) => r.setup?.fail === 0 && r.setup?.warn === 0).length
  const setupRows = allChecks
    .filter((r) => (r.setup?.fail ?? 0) > 0 || (r.setup?.warn ?? 0) > 0)
    .map((r) => {
      const s = r.setup as NonNullable<TeamRow['setup']>
      const quiet = r.freshness !== 'fresh'
      return `<li${quiet ? ' class="quiet"' : ''}><div><b>${esc(r.name)}</b><small>${esc(r.who)} · <span class="mono">${esc(r.machine)}</span>${quiet ? ' · not current' : ''}</small></div><div class="end score"><b class="mono">${s.score}%</b>${meter(s.score)}<small>${setupWords(s)}</small></div></li>`
    })
    .join('')

  const nav = `<nav aria-label="Sections of this page"><a href="#top">Overview</a><a href="#attention">Attention<span class="count${t.needs_you > 0 ? ' hot' : ''}">${anyFresh ? t.needs_you : '—'}</span></a><a href="#reports">Reports<span class="count">${picked.total}</span></a><a href="#machines">Machines<span class="count">${team.machines.length}</span></a><a href="#setup">Setup<span class="count">${checked.length > 0 ? toFix : '—'}</span></a></nav>`

  const policy = 'A machine sends counts and scores: no folder path and no message. What a session asked is sent only where that machine opted the folder in.'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>${t.needs_you > 0 ? `(${t.needs_you}) ` : ''}JQ Deck: team</title><link rel="icon" href="data:,"><style>${STYLE}${TOOLBAR_CSS}</style></head><body id="top">
<a class="skip" href="#main">Skip to the board</a>
<div class="app">
<aside class="side" aria-label="JQ Deck team board"><div class="brand"><span class="mark" aria-hidden="true">JQ</span><div><b>JQ Deck</b><small>Team board</small></div></div><h2>This page</h2>${nav}<div class="side-end"><p class="side-note"><b>Read-only</b>A machine sends counts and scores: no folder path and no message.</p><p class="ver mono">JQ Deck Server ${esc(version)}</p></div></aside>
<div class="col">
<header class="bar"><p class="crumbs">Team / <b>Overview</b></p><div class="bar-end"><span class="badge"><span class="dot${anyFresh ? ' on' : ''}" aria-hidden="true"></span>${known > 0 ? `${t.machines_fresh} of ${known} ${known === 1 ? 'machine' : 'machines'} reporting` : 'no machine reporting'}</span><span class="user">Signed in as <b>${esc(viewerName)}</b></span><form method="post" action="/logout"><button>Sign out</button></form></div></header>
<main id="main">
<p class="kick">Team · read-only</p>
<div class="headline"><div><h1>Team overview</h1><p class="lead">${esc(team.headline)}</p></div><p class="stamp">Read at <b class="mono">${esc(clock(team.generated_at))}</b><br>Reloads every minute${team.scoped ? '<br>You see some repositories only' : ''}</p></div>
${known > 0 ? metrics : ''}
${attention}
<section id="reports" aria-labelledby="h-reports"><div class="sec"><div><h2 id="h-reports">Reports <span>(${narrowed ? `${picked.rows.length} of ${picked.total}` : picked.total})</span></h2><p>One row per folder a machine reported. Two folders of one repository on one machine are two rows.</p></div>${controls}</div>
${pills}${table}</section>
<div class="two">
<section class="panel" id="machines" aria-labelledby="h-machines"><div class="panel-top"><div><h2 id="h-machines">Machines <span>(${team.machines.length})</span></h2><p>Each machine once, however many folders it reports.</p></div>${known > 0 ? `<span class="pill${anyFresh ? ' on' : ''}"><span class="dot${anyFresh ? ' on' : ''}" aria-hidden="true"></span>${t.machines_fresh} of ${known} reporting</span>` : ''}</div><ul class="list">${machines || '<li class="mut"><span>None yet. On each machine: <code>jq-deck --watch --exec "jq-deck-server send --url THIS-ADDRESS"</code></span></li>'}</ul></section>
<section class="panel" id="setup" aria-labelledby="h-setup"><div class="panel-top"><div><h2 id="h-setup">Setup checks <span>(${allChecks.length})</span></h2><p>The checks with something to do. "To fix" and "to look at" are counted apart.</p></div>${checked.length > 0 ? `<span class="tally">${toFix > 0 ? `${toFix} to fix` : 'nothing to fix'}${toLook > 0 ? `<small>${toLook} to look at</small>` : ''}</span>` : ''}</div>${setupRows ? `<ul class="list">${setupRows}</ul>` : ''}${allChecks.length === 0 ? '<p class="empty" style="padding:8px 0">No setup check reported.</p>' : clean > 0 ? `<p class="empty" style="padding:8px 0">${plural(clean, 'check has', 'checks have')} nothing to fix or look at.</p>` : ''}</section>
</div>
<p class="privacy"><b>Read-only.</b> Answer a session where it is running. ${policy}</p>
<p class="foot mono">JQ Deck Server ${esc(version)}</p>
</main></div></div>${toolbar({ here: 'team', running: null })}</body></html>`
}

export function renderLogin(message: string | null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JQ Deck: sign in</title><link rel="icon" href="data:,"><style>${STYLE}</style></head><body><main class="login">
<div class="brand" style="margin:0 0 22px"><span class="mark" aria-hidden="true">JQ</span><div><b>JQ Deck</b><small>Team board</small></div></div>
<h1>Sign in</h1>
<p class="lead">Which Claude Code sessions are waiting on a person, across this team's machines.</p>
<form class="card pad" method="post" action="/login">
${message ? `<p class="bad" role="alert" style="margin-bottom:10px">${esc(message)}</p>` : ''}
<label for="token">Viewer token</label>
<input id="token" name="token" type="password" autocomplete="current-password" placeholder="jqv_..." aria-describedby="token-help" required autofocus>
<p class="mut" id="token-help">It starts with <code>jqv_</code>. Whoever runs this server gives you one. A machine token (<code>jqm_</code>) does not sign in.</p>
<button class="primary">Sign in</button>
</form></main></body></html>`
}
