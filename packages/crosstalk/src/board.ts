/**
 * Pure rules over a crosstalk mailbox: what is waiting, which messages belong to
 * one thread, and the state of the board. No I/O; read.ts gathers the messages.
 *
 * Mail sent by a current tool carries a real `thread:` id, which is used when present.
 * Older or hand-written mail has none, so its threads are DERIVED, from two signals a
 * sender already leaves:
 *   1. the body cites another message's timestamp id;
 *   2. the subject is the same once "Re:" is stripped, between the same two names.
 * Both are evidence, not proof, so a derived thread is a grouping for reading,
 * never something to act on.
 */

export interface Message {
  id: string
  filename: string
  from_session: string
  to_session: string
  subject: string | null
  /** Only needed for thread derivation; summaries never return it. */
  body?: string | null
  sent_at: string | null
  acked: boolean
  /** Stamped by the tool; absent on older or hand-written mail. */
  kind?: string | null
  thread_id?: string | null
  reply_to?: string | null
  /** Board fields. */
  tags?: string[] | null
  expires_on?: string | null
  evidence?: string | null
  settled_by?: string | null
  /** Who wrote it, when the sender is a role such as `human`. */
  author?: string | null
  /** Signed mail (sign.ts): the result of the check, when a reader ran one. */
  signature_state?: string | null
}

/** The address that means "anyone". Mail to it is a board post or a reply to one. */
export const BOARD = 'board'

export interface MessageSummary {
  id: string
  filename: string
  from_session: string
  to_session: string
  subject: string | null
  sent_at: string | null
  acked: boolean
  age_days: number | null
  /** null on mail sent before kinds existed. */
  kind: string | null
  /** Who wrote it, when the sender is a role such as `human`; null otherwise. */
  author: string | null
  /** Signed mail: what the reader's check found; null for ordinary mail or when no check ran. */
  signature_state: string | null
}

export interface InboxWaiting {
  product: string
  unread: number
  oldest_sent_at: string | null
  oldest_age_days: number | null
  items: MessageSummary[]
}

export interface WaitingBoard {
  /** One sentence. Always says what was counted, so zero never reads as "failed to load". */
  headline: string
  total_unread: number
  inboxes: InboxWaiting[]
}

const DAY_MS = 86_400_000

export function ageDays(sentAt: string | null, now: number): number | null {
  if (!sentAt) return null
  const t = Date.parse(sentAt)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now - t) / DAY_MS))
}

export function summarize(m: Message, now: number): MessageSummary {
  return {
    id: m.id,
    filename: m.filename,
    from_session: m.from_session,
    to_session: m.to_session,
    subject: m.subject,
    sent_at: m.sent_at,
    acked: m.acked,
    age_days: ageDays(m.sent_at, now),
    kind: m.kind ?? null,
    author: m.author ?? null,
    signature_state: m.signature_state ?? null,
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** Unread mail per inbox, the inbox holding the oldest message first. */
export function waitingBoard(messages: Message[], now: number): WaitingBoard {
  const byInbox = new Map<string, Message[]>()
  for (const m of messages) {
    // Board mail is nobody's unread: it is open until its asker closes it, and the
    // Board tab shows it.
    if (m.acked || m.to_session === BOARD) continue
    const list = byInbox.get(m.to_session) ?? []
    list.push(m)
    byInbox.set(m.to_session, list)
  }
  // A message with no date sorts last: it cannot be called old.
  const time = (m: Message) => (m.sent_at ? Date.parse(m.sent_at) || Infinity : Infinity)
  const inboxes: InboxWaiting[] = [...byInbox.entries()].map(([product, list]) => {
    list.sort((a, b) => time(a) - time(b))
    const oldest = list.find((m) => ageDays(m.sent_at, now) !== null) ?? null
    return {
      product,
      unread: list.length,
      oldest_sent_at: oldest?.sent_at ?? null,
      oldest_age_days: oldest ? ageDays(oldest.sent_at, now) : null,
      items: list.map((m) => summarize(m, now)),
    }
  })
  inboxes.sort(
    (a, b) => (b.oldest_age_days ?? -1) - (a.oldest_age_days ?? -1) || b.unread - a.unread || a.product.localeCompare(b.product),
  )

  const total = inboxes.reduce((n, i) => n + i.unread, 0)
  const counted = messages.length
  let headline: string
  if (total === 0) {
    headline = `Nothing is waiting: ${counted} ${plural(counted, 'message', 'messages')}, all acknowledged.`
  } else {
    const top = inboxes[0]
    const age =
      top.oldest_age_days === null
        ? ''
        : top.oldest_age_days === 0
          ? ` The oldest was sent today, to ${top.product}.`
          : ` The oldest is ${top.oldest_age_days} ${plural(top.oldest_age_days, 'day', 'days')} old, in the ${top.product} inbox.`
    headline = `${total} unread ${plural(total, 'message', 'messages')} in ${inboxes.length} ${plural(inboxes.length, 'inbox', 'inboxes')}.${age}`
  }
  return { headline, total_unread: total, inboxes }
}

/* ── Threads ───────────────────────────────────────────────────────── */

/** "Re: Fwd: Checkout flow  " → "checkout flow". Empty when there is no subject. */
export function normalizeSubject(subject: string | null): string {
  let s = (subject ?? '').trim()
  while (/^(re|fwd?)\s*:\s*/i.test(s)) s = s.replace(/^(re|fwd?)\s*:\s*/i, '')
  return s.replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Mailbox messages a body cites, as timestamp ids (`YYYYMMDD-HHMMSS`). Senders cite
 * the full filename, a shortened one, or the bare stamp (`archive/x/20260817-195838`),
 * and the stamp is the part all three share.
 */
export function citedStamps(body: string | null | undefined): string[] {
  if (!body) return []
  return [...new Set(body.match(/\b\d{8}-\d{6}(?!\d)/g) ?? [])]
}

export interface Thread {
  /** The first message's filename: stable as the thread grows. */
  id: string
  subject: string | null
  participants: string[]
  count: number
  unread: number
  first_at: string | null
  last_at: string | null
  messages: MessageSummary[]
}

/**
 * Group messages into threads, newest activity first.
 *
 * A citation only links when the cited file is in the set: a timestamp-shaped
 * string that names nothing is ignored. A subject only links between the same
 * two products, and never when it is empty, so unrelated blank-subject mail
 * does not collapse into one thread.
 */
export function deriveThreads(messages: Message[], now: number): Thread[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const m of messages) parent.set(m.id, m.id)

  // Two inboxes can share a second, so a stamp naming more than one file is skipped.
  const byStamp = new Map<string, string[]>()
  for (const m of messages) {
    const stamp = m.filename.slice(0, 15)
    byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), m.id])
  }
  for (const m of messages) {
    for (const stamp of citedStamps(m.body)) {
      const hit = byStamp.get(stamp) ?? []
      if (hit.length === 1 && hit[0] !== m.id) union(m.id, hit[0])
    }
  }

  // The stamped thread id is exact: every message naming a thread joins the others
  // naming it, and the first message it names. A thread id is the first message's
  // filename without .md. Early ids were the bare timestamp, which two messages sent
  // in the same second share, so a bare stamp only joins when it names ONE file and
  // never joins two messages to each other on its own.
  const stem = (f: string) => f.replace(/\.md$/, '')
  const byStem = new Map<string, string[]>()
  for (const m of messages) byStem.set(stem(m.filename), [...(byStem.get(stem(m.filename)) ?? []), m.id])
  const byThread = new Map<string, string>()
  for (const m of messages) {
    if (!m.thread_id) continue
    const bare = /^\d{8}-\d{6}$/.test(m.thread_id)
    const first = bare ? (byStamp.get(m.thread_id) ?? []) : (byStem.get(m.thread_id) ?? [])
    if (first.length === 1) union(m.id, first[0])
    if (bare && first.length !== 1) continue
    const seen = byThread.get(m.thread_id)
    if (seen) union(m.id, seen)
    else byThread.set(m.thread_id, m.id)
  }

  const bySubject = new Map<string, string>()
  for (const m of messages) {
    const subject = normalizeSubject(m.subject)
    // A subject that is only a product name is a mistyped send, not a topic.
    if (!subject || subject === m.from_session || subject === m.to_session) continue
    const pair = [m.from_session, m.to_session].sort().join('|')
    const key = `${pair}|${subject}`
    const seen = bySubject.get(key)
    if (seen) union(m.id, seen)
    else bySubject.set(key, m.id)
  }

  const groups = new Map<string, Message[]>()
  for (const m of messages) {
    const root = find(m.id)
    groups.set(root, [...(groups.get(root) ?? []), m])
  }

  const time = (m: Message) => (m.sent_at ? Date.parse(m.sent_at) || 0 : 0)
  const threads: Thread[] = [...groups.values()].map((list) => {
    list.sort((a, b) => time(a) - time(b) || a.filename.localeCompare(b.filename))
    const first = list[0]
    const last = list[list.length - 1]
    return {
      id: first.filename,
      subject: first.subject,
      participants: [...new Set(list.flatMap((m) => [m.from_session, m.to_session]))].sort(),
      count: list.length,
      unread: list.filter((m) => !m.acked).length,
      first_at: first.sent_at,
      last_at: last.sent_at,
      messages: list.map((m) => summarize(m, now)),
    }
  })
  threads.sort((a, b) => (Date.parse(b.last_at ?? '') || 0) - (Date.parse(a.last_at ?? '') || 0) || a.id.localeCompare(b.id))
  return threads
}

/* ── The board ─────────────────────────────────────────────────────── */

export type PostState = 'open' | 'expired' | 'closed'

export interface BoardReply extends MessageSummary {
  /** 'verified' = checked in that session; 'assumed' = recalled. null on a malformed reply. */
  evidence: string | null
}

export interface BoardPost {
  id: string
  title: string | null
  from: string
  tags: string[]
  asked_at: string | null
  expires_on: string | null
  state: PostState
  /** How the asker settled it; null while open. 'nobody' means no one answered. */
  settled_by: string | null
  /** The closing message, whose body is the one-line resolution. */
  closing: MessageSummary | null
  post: MessageSummary
  replies: BoardReply[]
}

export interface Board {
  /** One sentence, saying what was counted. */
  headline: string
  open: BoardPost[]
  closed: BoardPost[]
}

/**
 * Board posts with their replies. Open first: expired-and-unanswered at the top
 * (a question nobody answered is the one most likely to be forgotten), then the
 * post closest to expiring. Closed posts newest first.
 *
 * A post is closed when its thread holds a closing message. Archive state is not
 * used: the tool archives a thread on close, but a hand-moved file must not make
 * a question look answered.
 */
export function boardPosts(messages: Message[], now: number): Board {
  const today = new Date(now).toISOString().slice(0, 10)
  const onBoard = messages.filter((m) => m.to_session === BOARD)
  const time = (m: Message) => (m.sent_at ? Date.parse(m.sent_at) || 0 : 0)

  const posts: BoardPost[] = onBoard
    .filter((m) => m.kind === 'post')
    .map((post) => {
      const thread = post.thread_id ?? post.filename.replace(/\.md$/, '')
      const rest = onBoard
        .filter((m) => m.id !== post.id && m.thread_id === thread)
        .sort((a, b) => time(a) - time(b) || a.filename.localeCompare(b.filename))
      // Only the asker's closing message counts, whatever a file claims.
      const closing = rest.find((m) => m.kind === 'close' && m.from_session === post.from_session) ?? null
      const replies = rest.filter((m) => m.kind !== 'close')
      const expired = !!post.expires_on && post.expires_on < today
      return {
        id: post.filename,
        title: post.subject,
        from: post.from_session,
        tags: post.tags ?? [],
        asked_at: post.sent_at,
        expires_on: post.expires_on ?? null,
        state: closing ? 'closed' : expired ? 'expired' : 'open',
        settled_by: closing ? (closing.settled_by ?? null) : null,
        closing: closing ? summarize(closing, now) : null,
        post: summarize(post, now),
        replies: replies.map((r) => ({ ...summarize(r, now), evidence: r.evidence ?? null })),
      }
    })

  const open = posts.filter((p) => p.state !== 'closed')
  const rank = (p: BoardPost) => (p.state === 'expired' && p.replies.length === 0 ? 0 : p.state === 'expired' ? 1 : 2)
  open.sort((a, b) => rank(a) - rank(b) || (a.expires_on ?? '9999').localeCompare(b.expires_on ?? '9999') || a.id.localeCompare(b.id))
  const closed = posts
    .filter((p) => p.state === 'closed')
    .sort((a, b) => (Date.parse(b.closing?.sent_at ?? '') || 0) - (Date.parse(a.closing?.sent_at ?? '') || 0))

  const unanswered = open.filter((p) => p.replies.length === 0).length
  const expired = open.filter((p) => p.state === 'expired').length
  let headline: string
  if (posts.length === 0) headline = 'No one has posted to the board yet.'
  else if (open.length === 0) headline = `Nothing is open. ${closed.length} ${plural(closed.length, 'post has', 'posts have')} been closed.`
  else {
    headline = `${open.length} open ${plural(open.length, 'post', 'posts')}, ${unanswered} with no reply`
    headline += expired > 0 ? `, ${expired} past ${plural(expired, 'its', 'their')} date.` : '.'
  }
  return { headline, open, closed }
}
