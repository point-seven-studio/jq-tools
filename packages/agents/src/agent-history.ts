/**
 * JQ Agents: turning a log of attention changes into "how long were sessions
 * blocked on a person".
 *
 * A snapshot answers "what is happening now". This answers the question that
 * decides whether a board is worth keeping: how much time do sessions spend
 * waiting on a human, and which repo is worst? That cannot be reconstructed from
 * current-state rows, so a host that wants it must keep the events itself (for
 * example from `jq-agents --watch --exec`). This package stores nothing.
 *
 * Pure — the caller supplies the events and the clock, so it's golden-tested.
 */

export interface AttentionEvent {
  session_id: string
  product: string
  to_attention: string
  occurred_at: string
}

export interface BlockedEpisode {
  session_id: string
  product: string
  startedAt: string
  /** null while the session is STILL blocked — an open episode. */
  endedAt: string | null
  minutes: number
  open: boolean
}

/**
 * Pair each `needs-you` transition with the next transition away from it.
 *
 * Two decisions worth stating, because both change the numbers:
 *
 *  1. An episode with no closing event is **open**, not dropped. Dropping it
 *     would under-report exactly the case that matters most — a session
 *     blocked right now, which is the one you'd want the board to shout about.
 *     Its `minutes` is measured to `now`.
 *  2. A repeated `needs-you` for an already-open session does NOT start a
 *     second episode. Attention tiers can re-fire (live → idle while still
 *     waiting is a state change but not a new block), and counting those as
 *     fresh episodes would inflate the count while shrinking every duration.
 */
export function computeBlockedEpisodes(events: AttentionEvent[], now: number): BlockedEpisode[] {
  const ordered = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  const open = new Map<string, { product: string; startedAt: string }>()
  const episodes: BlockedEpisode[] = []

  for (const e of ordered) {
    if (e.to_attention === 'needs-you') {
      if (!open.has(e.session_id)) {
        open.set(e.session_id, { product: e.product, startedAt: e.occurred_at })
      }
      continue
    }
    const started = open.get(e.session_id)
    if (!started) continue
    open.delete(e.session_id)
    episodes.push({
      session_id: e.session_id,
      product: started.product,
      startedAt: started.startedAt,
      endedAt: e.occurred_at,
      minutes: (Date.parse(e.occurred_at) - Date.parse(started.startedAt)) / 60000,
      open: false,
    })
  }

  // Still-open episodes, measured to now.
  for (const [session_id, s] of open) {
    episodes.push({
      session_id,
      product: s.product,
      startedAt: s.startedAt,
      endedAt: null,
      minutes: (now - Date.parse(s.startedAt)) / 60000,
      open: true,
    })
  }

  return episodes.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export interface HistorySummary {
  episodes: number
  openEpisodes: number
  /** Median rather than mean: one forgotten overnight session would drag a mean
   *  to uselessness, and the typical wait is the actionable number. */
  medianMinutes: number
  longestMinutes: number
  longestProduct: string | null
  /** Cumulative session-blocked time. NOT wall-clock — sessions overlap, so
   *  this can exceed the window and legitimately does. Labelled accordingly in
   *  the UI, because "6.2h blocked in a 10h day" invites the wrong reading. */
  totalBlockedHours: number
  byProduct: Array<{ product: string; episodes: number; totalMinutes: number }>
}

export function summarizeHistory(episodes: BlockedEpisode[]): HistorySummary {
  if (episodes.length === 0) {
    return {
      episodes: 0,
      openEpisodes: 0,
      medianMinutes: 0,
      longestMinutes: 0,
      longestProduct: null,
      totalBlockedHours: 0,
      byProduct: [],
    }
  }

  const sorted = [...episodes].sort((a, b) => a.minutes - b.minutes)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? sorted[mid].minutes : (sorted[mid - 1].minutes + sorted[mid].minutes) / 2
  const longest = sorted[sorted.length - 1]

  const byProductMap = new Map<string, { episodes: number; totalMinutes: number }>()
  for (const e of episodes) {
    const cur = byProductMap.get(e.product) || { episodes: 0, totalMinutes: 0 }
    cur.episodes += 1
    cur.totalMinutes += e.minutes
    byProductMap.set(e.product, cur)
  }

  return {
    episodes: episodes.length,
    openEpisodes: episodes.filter((e) => e.open).length,
    medianMinutes: Math.round(median * 10) / 10,
    longestMinutes: Math.round(longest.minutes * 10) / 10,
    longestProduct: longest.product,
    totalBlockedHours: Math.round((episodes.reduce((s, e) => s + e.minutes, 0) / 60) * 10) / 10,
    byProduct: [...byProductMap.entries()]
      .map(([product, v]) => ({ product, episodes: v.episodes, totalMinutes: Math.round(v.totalMinutes) }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes),
  }
}
