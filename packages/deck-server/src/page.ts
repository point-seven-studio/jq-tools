/**
 * The team page and the sign-in page. One HTML string each, no script, no
 * outside request. Every value is escaped: names come from other machines.
 *
 * The page shows only what buildTeam() returns. The few sums made here (live
 * sessions, setup items to fix) add up numbers the machines reported, over the
 * rows that are current; nothing is estimated.
 */
import { TOOLBAR_CSS, toolbar } from './presence.js'
import { duration, type MachineState, type Team, type TeamRow } from './team.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/* Amber (--warn) marks what needs a person and nothing else. Teal (--ok) marks a machine
 * heard from recently. Violet (--acc) is the product colour and the setup score. Every
 * coloured mark also says what it means in words. */
const STYLE = `
:root{color-scheme:light dark;--bg:#f5f6f9;--rail:#eceff4;--card:#fff;--well:#f1f3f8;--line:#d3d9e2;--soft:#e3e7ee;--fg:#141922;--sub:#3f4b5d;--mut:#5a6678;--warn:#8a4b00;--warn-bg:#fdf3e3;--warn-line:#dcae6a;--ok:#0d6455;--ok-bg:#e5f4f0;--ok-line:#9ccfc3;--acc:#5140b5;--acc-bg:#eeebfb;--acc-line:#c3baee;--bad:#a3262b;--link:#1d4f91;--track:#dde2ea}
@media (prefers-color-scheme:dark){:root{--bg:#090c12;--rail:#0d1119;--card:#111722;--well:#161d2a;--line:#27303c;--soft:#1d2530;--fg:#f0f3f8;--sub:#a1adbf;--mut:#8794a8;--warn:#f5b55f;--warn-bg:#231c17;--warn-line:#57402c;--ok:#5bcbb8;--ok-bg:#192a27;--ok-line:#305047;--acc:#a99af5;--acc-bg:#242238;--acc-line:#49415e;--bad:#ef8a8e;--link:#9db8f2;--track:#303745}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1,h2,h3,p,dl,dd,ul{margin:0;padding:0}ul{list-style:none}
a{color:var(--link)}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}code{font-size:12px;word-break:break-all}
.mut{color:var(--mut);font-size:12px}.bad{color:var(--bad);font-size:12px;font-weight:600}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--ok);outline-offset:3px}
.skip{position:absolute;left:-999px;top:8px;background:var(--card);color:var(--fg);padding:10px 14px;border:1px solid var(--line);border-radius:8px;z-index:9}.skip:focus{left:8px}
button{white-space:nowrap;font:inherit;font-size:13px;min-height:44px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:9px;padding:6px 14px;cursor:pointer}
button:hover{background:var(--well)}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}

.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{background:var(--rail);border-right:1px solid var(--soft);padding:24px 14px 84px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:12px;margin:2px 10px 34px}
.mark{width:36px;height:36px;flex-shrink:0;display:grid;place-items:center;background:var(--acc-bg);border:1px solid var(--acc-line);border-radius:11px;color:var(--acc);font-size:13px;font-weight:800}
.brand b{display:block;font-size:17px;letter-spacing:-.03em;line-height:1.15}
.brand small,.kick,.side h2,dt{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
.brand small{display:block;margin-top:4px}
.side h2{padding:0 12px;margin-bottom:8px}
.side nav{display:grid;gap:4px}
.side nav a{display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 12px;border-radius:9px;border:1px solid transparent;color:var(--sub);text-decoration:none;font-weight:600}
.side nav a:hover{background:var(--well);color:var(--fg)}
.count{margin-left:auto;background:var(--well);border:1px solid var(--line);color:var(--sub);font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 7px;border-radius:6px}
.side-end{margin-top:auto;padding-top:20px}
.side-note{margin:0 4px 12px;padding:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:11px;line-height:1.6;color:var(--sub)}
.side-note b{display:block;color:var(--fg);font-size:12px;margin-bottom:4px}
.ver{padding:0 12px;font-size:11px;color:var(--mut)}

.col{min-width:0}
.bar{min-height:68px;border-bottom:1px solid var(--soft);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 18px;padding:10px 36px}
.crumbs{font-size:12px;font-weight:600;color:var(--mut)}.crumbs b{color:var(--fg)}
.bar-end{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:650;color:var(--sub)}
.dot{width:7px;height:7px;flex-shrink:0;border-radius:50%;border:1px solid var(--mut)}
.dot.on{background:var(--ok);border-color:var(--ok)}
.user{font-size:12px;color:var(--sub)}.user b{color:var(--fg)}

main{max-width:1380px;margin:0 auto;padding:34px 36px 56px}
.kick{color:var(--acc);font-size:11px}
.headline{display:flex;justify-content:space-between;align-items:flex-end;gap:22px;margin:8px 0 26px}
h1{font-size:33px;letter-spacing:-.045em;line-height:1.15;font-weight:760;margin-bottom:8px}
.lead{color:var(--sub);font-size:14px;max-width:70ch}
.stamp{text-align:right;color:var(--mut);font-size:12px;line-height:1.7;flex-shrink:0}.stamp b{color:var(--fg);font-weight:600}

.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:22px}
.metric{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;min-height:112px}
.metric dt{font-size:12px;letter-spacing:0;text-transform:none;font-weight:640;color:var(--sub)}
.metric dd b{display:block;font-size:33px;line-height:1.2;letter-spacing:-.045em;font-weight:770;margin-top:8px}
.metric dd b small{font-size:16px;font-weight:600;letter-spacing:0;color:var(--mut)}
.metric dd span{display:block;font-size:11px;color:var(--mut);margin-top:2px}
.metric.hot{background:var(--warn-bg);border-color:var(--warn-line)}.metric.hot dd b{color:var(--warn)}

.strip{border:1px solid var(--line);border-left-width:3px;border-radius:12px;background:var(--card);display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 22px;margin-bottom:34px}
.strip h2{font-size:18px;letter-spacing:-.02em;line-height:1.35;margin:4px 0}
.strip p{font-size:12px;color:var(--sub)}
.strip.hot{background:var(--warn-bg);border-color:var(--warn-line);border-left-color:var(--warn)}
.strip.hot .kick{color:var(--warn)}
.wait{text-align:right;white-space:nowrap;flex-shrink:0}
.wait b{display:block;font:750 16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--warn)}
.wait span{font-size:11px;color:var(--sub)}

section{scroll-margin-top:16px}
.sec{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}
.sec h2,.panel h2{font-size:18px;letter-spacing:-.03em;font-weight:740}
.sec h2 span{color:var(--mut);font-weight:500}
.sec p,.panel-top p{font-size:12px;color:var(--mut);margin-top:3px}
.sec .mono{font-size:12px;color:var(--mut);margin:0}

.card{background:var(--card);border:1px solid var(--line);border-radius:13px;overflow:hidden;margin-bottom:14px}
.pad{padding:16px}
.repo-top{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 20px}
.repo-id{display:flex;align-items:flex-start;gap:12px;min-width:0}
.sym{display:grid;place-items:center;flex-shrink:0;width:38px;height:38px;background:var(--well);border:1px solid var(--line);border-radius:10px;color:var(--sub);font:800 13px ui-monospace,SFMono-Regular,Menlo,monospace}
h3{font-size:16px;font-weight:740;letter-spacing:-.02em;word-break:break-word}
.remote{font-size:11px;color:var(--mut);overflow-wrap:anywhere}
.chip{border:1px solid var(--line);background:var(--well);color:var(--sub);font-size:11px;font-weight:700;padding:5px 10px;border-radius:7px;white-space:nowrap}
.chip.hot{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)}
.rows>li{border-top:1px solid var(--line)}
.grid{display:grid;grid-template-columns:1.35fr 1fr 1.1fr 1.1fr .8fr 1.1fr}
.cell{padding:16px 18px;min-width:0;border-right:1px solid var(--soft)}.cell:last-child{border-right:0}
dt{margin-bottom:8px}
.cell dd{font-size:13px;font-weight:700;overflow-wrap:anywhere}
.cell dd small{display:block;font-size:11px;font-weight:400;color:var(--mut);margin-top:2px}
.who{display:flex;align-items:center;gap:9px}
.av{display:grid;place-items:center;width:28px;height:28px;flex-shrink:0;background:var(--acc-bg);border:1px solid var(--acc-line);color:var(--acc);font-weight:800;border-radius:8px;font-size:10px}
.num{font-size:16px}
.amber{color:var(--warn)}.none{color:var(--mut);font-weight:500}
.fix{color:var(--acc);font-weight:700}
.meter{display:block;height:5px;border-radius:9px;background:var(--track);margin:8px 0 4px;overflow:hidden}.meter i{display:block;height:100%;background:var(--acc);border-radius:9px}
.heard{display:flex;align-items:center;gap:7px}
li.quiet dd,li.quiet .amber,li.quiet .fix{color:var(--mut)}li.quiet .meter i{background:var(--mut)}
.q{background:var(--well);margin:0 18px 14px;padding:10px 12px;border-radius:8px;border-left:3px solid var(--warn)}
.q p{white-space:pre-wrap;word-break:break-word;font-size:14px;margin-top:2px}

.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0 26px;align-items:start}
.panel{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:20px 22px}
.panel-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:8px}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--well);border-radius:99px;padding:5px 10px;color:var(--sub);font-size:11px;font-weight:700;white-space:nowrap}
.pill.on{border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)}
.tally{font-size:12px;font-weight:700;color:var(--acc);white-space:nowrap}
.list>li{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-top:1px solid var(--soft)}.list>li:first-child{border-top:0}
.list b{display:block;font-size:14px;font-weight:700;overflow-wrap:anywhere}
.list small{display:block;font-size:11px;color:var(--mut);margin-top:2px}
.list .end{text-align:right;flex-shrink:0;font-size:12px;color:var(--sub)}
.list .end b{font-size:13px}
.list .score{min-width:120px}.list .score b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.list li.quiet b,.list li.quiet .fix{color:var(--mut)}
.empty{font-size:12px;color:var(--mut);padding:8px 0}

.privacy{padding:14px 18px;border:1px solid var(--line);border-radius:11px;color:var(--sub);background:var(--card);font-size:12px;line-height:1.65}
.privacy b{color:var(--fg)}
.foot{display:none;margin-top:18px;color:var(--mut);font-size:11px}

input{font:inherit;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--well);color:var(--fg);margin-bottom:8px}
label{display:block;font-weight:600;margin-bottom:6px}
.login{max-width:440px;padding-top:56px}.login h1{font-size:26px}.login form{margin-top:16px}.login form .mut{margin-bottom:12px}

@media (max-width:1320px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}.cell{border-bottom:1px solid var(--soft)}.cell:nth-child(3n){border-right:0}.cell:nth-child(n+4){border-bottom:0}}
@media (max-width:1199px){.app{grid-template-columns:200px minmax(0,1fr)}.bar{padding:10px 26px}main{padding:30px 26px 48px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:919px){.app{display:block}.side{position:static;height:auto;overflow:visible;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:12px 20px;border-right:0;border-bottom:1px solid var(--line)}.brand{margin:0}.side h2,.side-end{display:none}.side nav{display:flex;flex-wrap:wrap;gap:4px}.side nav a{padding:8px 10px}.count{margin-left:0}.two{grid-template-columns:1fr}.foot{display:block}}
@media (max-width:599px){.bar{padding:10px 16px}main{padding:24px 16px 40px}.headline{display:block}h1{font-size:28px}.stamp{text-align:left;margin-top:12px}.metrics{gap:9px}.metric{padding:14px;min-height:104px}.metric dd b{font-size:28px}.strip{flex-direction:column;align-items:flex-start;gap:12px;padding:16px}.wait{text-align:left}.repo-top{padding:16px;align-items:flex-start}.grid{grid-template-columns:1fr 1fr}.cell{padding:14px 16px}.cell:nth-child(3n){border-right:1px solid var(--soft)}.cell:nth-child(2n){border-right:0}.cell:nth-child(n+4){border-bottom:1px solid var(--soft)}.cell:nth-child(n+5){border-bottom:0}.q{margin:0 16px 14px}.sec .mono{display:none}.list>li{align-items:flex-start}}
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

const cell = (label: string, value: string, note = '') => `<div class="cell"><dt>${label}</dt><dd>${value}${note ? `<small>${note}</small>` : ''}</dd></div>`

/** Unknown is a dash with its reason beside it. It is never written as a zero. */
const DASH = '<span class="none" aria-hidden="true">—</span>'

const meter = (score: number) => `<span class="meter" aria-hidden="true"><i style="width:${score}%"></i></span>`

function setupWords(s: NonNullable<TeamRow['setup']>): string {
  if (s.fail > 0) return `<span class="fix">${s.fail} to fix</span>`
  if (s.warn > 0) return `<span class="fix">${s.warn} to look at</span>`
  return 'all good'
}

const freshnessWords = (f: MachineState['freshness']) => (f === 'fresh' ? 'reporting' : f === 'quiet' ? 'quiet, not counted' : 'silent for over a day, rows hidden')

function row(r: TeamRow, now: number): string {
  const quiet = r.freshness !== 'fresh'
  const waiting = quiet
    ? cell('Waiting on a person', DASH, 'not current')
    : r.needs_you > 0
      ? r.waiting_minutes !== null
        ? cell('Waiting on a person', `<span class="amber">${esc(duration(r.waiting_minutes))}</span>`, `${r.needs_you} waiting`)
        : cell('Waiting on a person', `<span class="amber">${r.needs_you} waiting</span>`, 'how long was not reported')
      : cell('Waiting on a person', '<span class="none">none</span>')
  const setup = !r.setup ? cell('Setup', DASH, 'not checked') : cell('Setup', `<span class="mono">${r.setup.score}%</span>${meter(r.setup.score)}`, setupWords(r.setup))
  const mail = r.unread === null ? cell('Mail', DASH, 'no inbox') : r.unread === 0 ? cell('Mail', '<span class="none">none unread</span>') : cell('Mail', `${r.unread}`, 'unread')
  // An old question may have been answered since: shown only while the machine is current.
  const asked = (r.questions ?? [])
    .map((q) => `<div class="q"><span class="mut">${esc(r.who)}'s session asked${q.asked_at ? ` ${esc(heard(minutesSince(q.asked_at, now)))}` : ''}</span><p>${esc(q.text)}</p></div>`)
    .join('')
  const who = cell('Who and machine', `<span class="who"><span class="av" aria-hidden="true">${esc(initials(r.who))}</span><span>${esc(r.who)}<small class="mono">${esc(r.machine)}</small></span></span>`)
  const sessions = cell('Sessions', `<span class="num">${r.sessions}</span>`, `${r.live} live`)
  const last = cell('Last heard', `<span class="heard"><span class="dot${quiet ? '' : ' on'}" aria-hidden="true"></span>${esc(heard(r.minutes_ago))}</span>`, freshnessWords(r.freshness))
  return `<li${quiet ? ' class="quiet"' : ''}><dl class="grid">${who}${sessions}${waiting}${setup}${mail}${last}</dl>${asked}</li>`
}

export function renderTeam(team: Team, viewerName: string, version: string): string {
  const now = Date.parse(team.generated_at)
  const t = team.totals
  const known = t.machines_fresh + t.machines_quiet + t.machines_silent
  const rows = team.groups.flatMap((g) => g.rows)
  const current = rows.filter((r) => r.freshness === 'fresh')
  const live = current.reduce((n, r) => n + r.live, 0)
  const checked = current.filter((r) => r.setup)
  const toFix = checked.reduce((n, r) => n + (r.setup?.fail ?? 0), 0)
  const withFix = checked.filter((r) => (r.setup?.fail ?? 0) > 0).length
  const waitingRepos = team.groups.filter((g) => g.needs_you > 0).length
  const top = current.filter((r) => r.waiting_minutes !== null).sort((a, b) => (b.waiting_minutes as number) - (a.waiting_minutes as number))[0]

  const late = [t.machines_quiet > 0 ? `${t.machines_quiet} quiet` : '', t.machines_silent > 0 ? `${t.machines_silent} silent` : ''].filter(Boolean).join(', ')
  // With no machine reporting there is no current count: a dash, not a zero.
  const anyFresh = t.machines_fresh > 0
  const metric = (label: string, value: string, note: string, hot = false) => `<div class="metric${hot ? ' hot' : ''}"><dt>${label}</dt><dd><b>${value}</b><span>${note}</span></dd></div>`
  const metrics = `<dl class="metrics" aria-label="Totals from the machines reporting now">${anyFresh ? metric('Waiting on a person', `${t.needs_you}`, t.needs_you > 0 ? `in ${plural(waitingRepos, 'repository', 'repositories')}` : 'nothing waiting', t.needs_you > 0) : metric('Waiting on a person', '—', 'no current report')}${anyFresh ? metric('Sessions', `${t.sessions}`, `${live} live`) : metric('Sessions', '—', 'no current report')}${metric('Machines reporting', `${t.machines_fresh}<small> of ${known}</small>`, late ? `${late}: not counted` : `last heard ${esc(heard(team.machines[0]?.minutes_ago ?? 0))}`)}${checked.length > 0 ? metric('Setup items to fix', `${toFix}`, toFix > 0 ? `in ${withFix} of ${plural(checked.length, 'setup check', 'setup checks')}` : `across ${plural(checked.length, 'setup check', 'setup checks')}`) : metric('Setup items to fix', '—', 'no setup check reported')}</dl>`

  let strip = ''
  if (t.needs_you > 0) {
    const more = top ? t.needs_you - top.needs_you : 0
    strip = `<section class="strip hot" aria-labelledby="attn"><div><p class="kick">Needs attention · ${plural(t.needs_you, 'waiting session', 'waiting sessions')}</p><h2 id="attn">${top ? `${esc(top.name)} is waiting on a person` : `${plural(t.needs_you, 'session is', 'sessions are')} waiting on a person`}</h2><p>${top ? `${esc(top.who)} on ${esc(top.machine)}. Answer in the session on that machine.${more > 0 ? ` ${more} more waiting, listed below.` : ''}` : 'Answer each one in the session where it is running.'}</p></div>${top ? `<div class="wait"><b>${esc(duration(top.waiting_minutes as number))}</b><span>longest wait</span></div>` : ''}</section>`
  } else if (known > 0 && t.machines_fresh === 0) {
    strip = `<section class="strip" aria-labelledby="attn"><div><p class="kick">Not current</p><h2 id="attn">No machine has reported in the last 5 minutes</h2><p>What is below is each machine's last report. None of it is counted, and a session may have been answered or closed since.</p></div></section>`
  }

  const groups = team.groups
    .map(
      (g) =>
        `<article class="card"><div class="repo-top"><div class="repo-id"><span class="sym" aria-hidden="true">&lt;/&gt;</span><div><h3>${esc(g.name)}</h3>${g.remote ? `<p class="remote mono">${esc(g.remote)}</p>` : ''}</div></div>${g.needs_you > 0 ? `<span class="chip hot">${g.needs_you} waiting</span>` : '<span class="chip">none waiting</span>'}</div><ul class="rows">${g.rows.map((r) => row(r, now)).join('')}</ul></article>`,
    )
    .join('')

  const shown = (m: MachineState) => rows.filter((r) => r.machine === m.machine).length
  const machines = team.machines
    .map(
      (m) =>
        `<li${m.freshness === 'fresh' ? '' : ' class="quiet"'}><div><b class="mono">${esc(m.machine)}</b><small>${esc(m.who)} · ${m.freshness === 'silent' ? 'rows hidden' : plural(shown(m), 'repository shown', 'repositories shown')}</small></div><div class="end">last heard <b>${esc(heard(m.minutes_ago))}</b><small>${freshnessWords(m.freshness)}</small></div></li>`,
    )
    .join('')

  const setupRows = rows
    .filter((r) => r.setup)
    .map((r) => {
      const s = r.setup as NonNullable<TeamRow['setup']>
      const quiet = r.freshness !== 'fresh'
      return `<li${quiet ? ' class="quiet"' : ''}><div><b>${esc(r.name)}</b><small>${esc(r.who)} · <span class="mono">${esc(r.machine)}</span>${quiet ? ' · not current' : ''}</small></div><div class="end score"><b>${s.score}%</b>${meter(s.score)}<small>${setupWords(s)}</small></div></li>`
    })
    .join('')

  const nav = `<nav aria-label="Sections of this page"><a href="#top">Overview</a><a href="#repositories">Repositories<span class="count">${team.groups.length}</span></a><a href="#machines">Machines<span class="count">${team.machines.length}</span></a><a href="#setup">Setup<span class="count">${checked.length > 0 ? toFix : '—'}</span></a></nav>`

  const policy = 'A machine sends counts and scores: no folder path and no message. What a session asked is sent only where that machine opted the folder in.'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>${t.needs_you > 0 ? `(${t.needs_you}) ` : ''}JQ Deck: team</title><link rel="icon" href="data:,"><style>${STYLE}${TOOLBAR_CSS}</style></head><body id="top">
<a class="skip" href="#main">Skip to the board</a>
<div class="app">
<aside class="side" aria-label="JQ Deck team board"><div class="brand"><span class="mark" aria-hidden="true">JQ</span><div><b>JQ Deck</b><small>Team board</small></div></div><h2>This page</h2>${nav}<div class="side-end"><p class="side-note"><b>Read-only</b>A machine sends counts and scores: no folder path and no message.</p><p class="ver mono">JQ Deck Server ${esc(version)}</p></div></aside>
<div class="col">
<header class="bar"><p class="crumbs">Team / <b>Overview</b></p><div class="bar-end"><span class="badge"><span class="dot${t.machines_fresh > 0 ? ' on' : ''}" aria-hidden="true"></span>${known > 0 ? `${t.machines_fresh} of ${known} ${known === 1 ? 'machine' : 'machines'} reporting` : 'no machine reporting'}</span><span class="user">Signed in as <b>${esc(viewerName)}</b></span><form method="post" action="/logout"><button>Sign out</button></form></div></header>
<main id="main">
<p class="kick">Team · read-only</p>
<div class="headline"><div><h1>Team overview</h1><p class="lead">${esc(team.headline)}</p></div><p class="stamp">Read at <b class="mono">${esc(clock(team.generated_at))}</b><br>Reloads every minute${team.scoped ? '<br>You see some repositories only' : ''}</p></div>
${known > 0 ? metrics : ''}
${strip}
<section id="repositories" aria-labelledby="h-repos"><div class="sec"><div><h2 id="h-repos">Repositories <span>(${team.groups.length})</span></h2><p>Sessions, setup and mail, one card per repository and one row per machine.</p></div>${team.groups.length > 1 ? '<p class="mono">longest wait first</p>' : ''}</div>
${groups || '<p class="card pad mut">No repository to show.</p>'}</section>
<div class="two">
<section class="panel" id="machines" aria-labelledby="h-machines"><div class="panel-top"><div><h2 id="h-machines">Machines</h2><p>When the server last heard from each one.</p></div>${known > 0 ? `<span class="pill${t.machines_fresh > 0 ? ' on' : ''}"><span class="dot${t.machines_fresh > 0 ? ' on' : ''}" aria-hidden="true"></span>${t.machines_fresh} of ${known} reporting</span>` : ''}</div><ul class="list">${machines || '<li class="mut"><span>None yet. On each machine: <code>jq-deck --watch --exec "jq-deck-server send --url THIS-ADDRESS"</code></span></li>'}</ul></section>
<section class="panel" id="setup" aria-labelledby="h-setup"><div class="panel-top"><div><h2 id="h-setup">Setup</h2><p>The setup check each machine ran, per repository.</p></div>${checked.length > 0 ? `<span class="tally">${toFix > 0 ? `${toFix} to fix` : 'nothing to fix'}</span>` : ''}</div>${setupRows ? `<ul class="list">${setupRows}</ul>` : '<p class="empty">No setup check reported.</p>'}</section>
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
