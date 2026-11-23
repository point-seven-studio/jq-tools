/**
 * The local page: what is waiting, the board, and threads. One HTML string, no
 * script, no outside request. Every value from a message is escaped: message text
 * is written by other sessions and must never run as markup.
 */
import { COPY_CSS, COPY_SCRIPT_TAG, TOOLBAR_CSS } from './presence.js'
import type { Board, BoardPost, MessageSummary, Thread, WaitingBoard } from './board.js'
import { ENDINGS, type RunSummary } from './worker.js'

export interface Report {
  mailbox: string
  generated_at: string
  total: number
  waiting: WaitingBoard
  board: Board
  threads: Thread[]
  /** Message id → body, for the messages shown. */
  bodies: Record<string, string>
  /** Timers waiting to be delivered (timers.ts). Absent from a report made by an older version. */
  timers?: { subject: string; from: string; to: string; due: string; every: string }[]
  /** One entry per name a worker has run for (worker.ts). */
  workers?: WorkerReport[]
}

export interface WorkerReport {
  name: string
  waiting: { thread: string; tool: string; request: string; approver: string; asked_at: string }[]
  runs: RunSummary
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const age = (d: number | null) => (d === null ? 'no date' : d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`)

const SETTLED: Record<string, string> = {
  source: 'settled by checking the source',
  owner: 'settled by the owner',
  fix: 'settled by a fix',
  pushback: 'settled after pushback',
  nobody: 'no one answered',
}

function row(m: MessageSummary, bodies: Record<string, string>, note: string, showTo = false): string {
  const kind = m.kind && m.kind !== 'brief' ? `<span class="kind">${esc(m.kind)}</span> ` : ''
  const to = showTo ? ` <span class="mut">to</span> <span class="chip">${esc(m.to_session)}</span>` : ''
  // Signed mail: say what the check found, in words. Ordinary mail says nothing.
  const who = m.author ? ` <span class="mut">${esc(m.author)}</span>` : ''
  const signed =
    m.signature_state === 'verified'
      ? ' <span class="kind">signed</span>'
      : m.signature_state
        ? ` <span class="kind">${m.signature_state === 'unknown-signer' ? 'signature not checked' : 'NOT VERIFIED'}</span>`
        : ''
  return `<details><summary><span class="chip">${esc(m.from_session)}</span>${who}${signed}${to} ${kind}<span class="subj">${esc(m.subject || '(no subject)')}</span> <span class="note">${esc(note)}</span></summary><p class="file">${esc(m.filename)}</p><pre>${esc(bodies[m.id] ?? '')}</pre></details>`
}

function post(p: BoardPost, bodies: Record<string, string>): string {
  const state = p.state === 'closed' ? (SETTLED[p.settled_by ?? ''] ?? 'closed') : p.state === 'expired' ? `past its date (${p.expires_on})` : `open until ${p.expires_on ?? 'closed'}`
  const replies = p.replies
    .map((r) => row(r, bodies, r.evidence === 'verified' ? 'checked' : r.evidence === 'assumed' ? 'from memory, not checked' : 'did not say how they know'))
    .join('')
  return `<section class="card"><h3>${esc(p.title || '(no title)')} ${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')} <span class="state ${p.state}">${esc(state)}</span></h3>${row(p.post, bodies, p.post.age_days ? `asked ${age(p.post.age_days)} ago` : 'asked today')}${replies}${p.closing ? row(p.closing, bodies, 'closing note') : ''}${p.replies.length === 0 && p.state !== 'closed' ? '<p class="mut">No replies yet.</p>' : ''}</section>`
}

const ENDED: Record<string, string> = { message: 'sent mail', nothing: 'nothing to send', asked: 'asked a person', failed: 'failed', dropped: 'not run' }

/** Timers and the worker. Empty when the mailbox uses neither, so a mailbox without them looks as it did. */
function later(r: Report): string {
  const timers = r.timers ?? []
  const workers = r.workers ?? []
  if (!timers.length && !workers.length) return ''
  const waiting = workers.reduce((n, w) => n + w.waiting.length, 0)
  const lead = waiting ? `${waiting} ${waiting === 1 ? 'run is' : 'runs are'} waiting for a person.` : workers.length ? 'No run is waiting for a person.' : `${timers.length} ${timers.length === 1 ? 'timer' : 'timers'} waiting.`
  const cards = workers
    .map((w) => {
      const asks = w.waiting.map((a) => `<p class="mut">Waiting for <span class="chip">${esc(a.approver)}</span> since ${esc(a.asked_at)}: a ${esc(a.tool)} call. The request is inbox/${esc(a.approver)}/${esc(a.request)}</p>`).join('')
      const counts = ENDINGS.map((e) => `${w.runs.by_ending[e]} ${ENDED[e]}`).join(' · ')
      return `<section class="card"><h3>${esc(w.name)} worker <span class="note">last ${w.runs.days} days: ${counts}${w.runs.cost_usd ? ` · $${w.runs.cost_usd.toFixed(2)}` : ''}</span></h3>${asks}</section>`
    })
    .join('')
  const list = timers.length
    ? `<section class="card"><h3>Timers <span class="note">${timers.length} waiting</span></h3>${timers.map((t) => `<p class="mut"><span class="chip">${esc(t.from)}</span> to <span class="chip">${esc(t.to)}</span> ${esc(t.subject)} · due ${esc(t.due)}${t.every ? ` · every ${esc(t.every)}` : ''}</p>`).join('')}</section>`
    : ''
  return `<h2>Worker and timers</h2><p class="lead">${esc(lead)}</p>${cards}${list}`
}

/** `bar` is the links to the other tools (presence.ts `toolbar`), or '' for a page with none, such as one shown inside JQ Deck. */
export function renderPage(r: Report, bar = ''): string {
  const waiting = r.waiting.inboxes
    .map(
      (i) =>
        `<section class="card"><h3>${esc(i.product)} inbox <span class="note">${i.unread} unread, oldest ${age(i.oldest_age_days)}</span></h3>${i.items.map((m) => row(m, r.bodies, `unread, ${age(m.age_days)}`)).join('')}</section>`,
    )
    .join('')
  const threads = r.threads
    .map(
      (t) =>
        `<section class="card"><h3>${esc(t.subject || '(no subject)')} <span class="note">${t.count} ${t.count === 1 ? 'message' : 'messages'}${t.unread ? `, ${t.unread} unread` : ''} · ${t.participants.map(esc).join(', ')}</span></h3>${t.messages.map((m) => row(m, r.bodies, m.acked ? age(m.age_days) : `unread, ${age(m.age_days)}`, true)).join('')}</section>`,
    )
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crosstalk</title>
<style>
:root{--bg:#f7f6f2;--card:#fff;--fg:#1d1c19;--mut:#6b675e;--line:#dedbd2;--well:#f1efe9;--warn:#a1500a;--bad:#a3262b;--ok:#1f6b45}
@media (prefers-color-scheme:dark){:root{--bg:#161512;--card:#1f1e1a;--fg:#ece9e1;--mut:#a09c91;--line:#35332d;--well:#161512;--warn:#e0a25a;--bad:#ef8a8e;--ok:#7ccba0}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:24px;margin:0}h2{font-size:17px;margin:28px 0 8px}h3{font-size:14px;margin:0;padding:10px 12px}
.lead{font-size:16px;font-weight:600;margin:6px 0}.mut,.note,.file{color:var(--mut);font-size:12px}.mut{padding:0 12px 10px;margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:10px 0;overflow:hidden}
details{border-top:1px solid var(--line)}summary{cursor:pointer;padding:8px 12px}
.chip,.tag,.kind{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 7px}.tag{border-radius:4px;background:var(--well)}.kind{text-transform:uppercase;border-radius:4px}
.subj{font-weight:500}.file{font-family:ui-monospace,monospace;margin:0;padding:0 12px;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-word;background:var(--well);margin:8px 12px 12px;padding:10px;border-radius:8px;font-size:12px;max-height:420px;overflow:auto}
.state{font-size:12px}.state.open{color:var(--ok)}.state.expired{color:var(--bad)}.state.closed{color:var(--mut)}
${bar ? TOOLBAR_CSS + COPY_CSS : ''}</style></head><body><main>
<h1>Crosstalk</h1>
<p class="note">${esc(r.mailbox)} · ${r.total} messages · read ${esc(r.generated_at)}. Refresh to read again. This page is read-only.</p>
<h2>Waiting</h2><p class="lead">${esc(r.waiting.headline)}</p>${waiting}
${later(r)}
<h2>Board</h2><p class="lead">${esc(r.board.headline)}</p>${r.board.open.map((p) => post(p, r.bodies)).join('')}
${r.board.closed.length ? `<details class="card"><summary>${r.board.closed.length} closed</summary>${r.board.closed.map((p) => post(p, r.bodies)).join('')}</details>` : ''}
<h2>Threads</h2><p class="note">The ${r.threads.length} with the newest activity. Where a message carries no thread id, threads are worked out from replies that cite a message or reuse its subject, so some related mail shows as separate.</p>${threads}
</main>${bar}${bar ? COPY_SCRIPT_TAG : ''}</body></html>`
}
