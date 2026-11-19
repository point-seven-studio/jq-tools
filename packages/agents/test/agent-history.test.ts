/**
 * Golden tests for JQ Agents' blocked-time history.
 *
 * This is the arithmetic that answers "is the board worth keeping", so it gets
 * read as fact. The two ways it silently lies: dropping still-open episodes
 * (under-reports the session blocking you RIGHT NOW, the one that matters most)
 * and double-counting re-fired needs-you transitions (inflates the count while
 * shrinking every duration). Both are pinned below.
 *
 * agent-history.ts is pure and imports nothing, so no module mocking is needed.
 */
import { describe, expect, it, test } from 'vitest'
import {
  computeBlockedEpisodes,
  summarizeHistory,
  type AttentionEvent,
} from '../src/agent-history.js'

const T0 = Date.parse('2026-08-19T10:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60000).toISOString()
const NOW = T0 + 120 * 60000

const ev = (session_id: string, to_attention: string, minutes: number, product = 'proj'): AttentionEvent => ({
  session_id,
  product,
  to_attention,
  occurred_at: at(minutes),
})

describe('computeBlockedEpisodes', () => {
  it('pairs a block with the transition that ends it', () => {
    const eps = computeBlockedEpisodes([ev('s1', 'needs-you', 0), ev('s1', 'none', 30)], NOW)
    expect(eps).toHaveLength(1)
    expect(eps[0].minutes).toBe(30)
    expect(eps[0].open).toBe(false)
  })

  it('keeps a still-open episode and measures it to now', () => {
    // Dropping this would under-report the session blocking you right now.
    const eps = computeBlockedEpisodes([ev('s1', 'needs-you', 60)], NOW)
    expect(eps).toHaveLength(1)
    expect(eps[0].open).toBe(true)
    expect(eps[0].endedAt).toBeNull()
    expect(eps[0].minutes).toBe(60)
  })

  it('does NOT start a second episode when needs-you re-fires', () => {
    // live → idle while still waiting is a state change, not a new block.
    const eps = computeBlockedEpisodes(
      [ev('s1', 'needs-you', 0), ev('s1', 'needs-you', 10), ev('s1', 'none', 30)],
      NOW,
    )
    expect(eps).toHaveLength(1)
    expect(eps[0].minutes).toBe(30) // measured from the FIRST block, not the second
  })

  it('ignores a closing event for a session that was never blocked', () => {
    expect(computeBlockedEpisodes([ev('s1', 'none', 10)], NOW)).toHaveLength(0)
  })

  it('tracks sessions independently', () => {
    const eps = computeBlockedEpisodes(
      [ev('s1', 'needs-you', 0), ev('s2', 'needs-you', 5), ev('s1', 'none', 10), ev('s2', 'none', 45)],
      NOW,
    )
    expect(eps.map((e) => e.minutes).sort((a, b) => a - b)).toEqual([10, 40])
  })

  it('treats abandoned as ending the episode — stale is not still asking', () => {
    const eps = computeBlockedEpisodes([ev('s1', 'needs-you', 0), ev('s1', 'abandoned', 90)], NOW)
    expect(eps).toHaveLength(1)
    expect(eps[0].minutes).toBe(90)
  })

  it('is order-independent — events may arrive unsorted', () => {
    const eps = computeBlockedEpisodes([ev('s1', 'none', 30), ev('s1', 'needs-you', 0)], NOW)
    expect(eps).toHaveLength(1)
    expect(eps[0].minutes).toBe(30)
  })
})

describe('summarizeHistory', () => {
  it('is all zeros with no episodes, rather than NaN', () => {
    const s = summarizeHistory([])
    expect(s.episodes).toBe(0)
    expect(s.medianMinutes).toBe(0)
    expect(s.longestProduct).toBeNull()
  })

  it('uses the MEDIAN, so one forgotten overnight session cannot distort it', () => {
    const eps = computeBlockedEpisodes(
      [
        ev('a', 'needs-you', 0), ev('a', 'none', 5),
        ev('b', 'needs-you', 0), ev('b', 'none', 6),
        ev('c', 'needs-you', 0), ev('c', 'none', 600), // the outlier
      ],
      NOW,
    )
    const s = summarizeHistory(eps)
    expect(s.medianMinutes).toBe(6)
    expect(s.longestMinutes).toBe(600)
  })

  it('averages the two middle values on an even count', () => {
    const eps = computeBlockedEpisodes(
      [
        ev('a', 'needs-you', 0), ev('a', 'none', 10),
        ev('b', 'needs-you', 0), ev('b', 'none', 20),
      ],
      NOW,
    )
    expect(summarizeHistory(eps).medianMinutes).toBe(15)
  })

  it('reports cumulative blocked time, which may exceed the window', () => {
    // Sessions overlap, so 3 sessions blocked for an hour each inside one hour
    // is legitimately 3h. The UI must not present this as wall-clock.
    const eps = computeBlockedEpisodes(
      [
        ev('a', 'needs-you', 0), ev('a', 'none', 60),
        ev('b', 'needs-you', 0), ev('b', 'none', 60),
        ev('c', 'needs-you', 0), ev('c', 'none', 60),
      ],
      NOW,
    )
    expect(summarizeHistory(eps).totalBlockedHours).toBe(3)
  })

  it('ranks products by total blocked time, not episode count', () => {
    const eps = computeBlockedEpisodes(
      [
        ev('a', 'needs-you', 0, 'noisy'), ev('a', 'none', 2, 'noisy'),
        ev('b', 'needs-you', 0, 'noisy'), ev('b', 'none', 2, 'noisy'),
        ev('c', 'needs-you', 0, 'slow'), ev('c', 'none', 90, 'slow'),
      ],
      NOW,
    )
    const s = summarizeHistory(eps)
    expect(s.byProduct[0].product).toBe('slow') // 90 min beats 2 episodes of 2 min
    expect(s.byProduct[0].totalMinutes).toBe(90)
  })
})
