import { describe, expect, it } from 'vitest'
import {
  ageDays,
  boardPosts,
  citedStamps,
  deriveThreads,
  normalizeSubject,
  waitingBoard,
  type Message,
} from '../src/board.js'

const NOW = Date.parse('2026-11-18T12:00:00Z')

let n = 0
function msg(over: Partial<Message> & { filename: string }): Message {
  n += 1
  return {
    id: `id-${n}`,
    from_session: 'web',
    to_session: 'api',
    subject: null,
    body: '',
    sent_at: null,
    acked: true,
    ...over,
  }
}

describe('waitingBoard', () => {
  it('counts unread per inbox and leads with the inbox holding the oldest message', () => {
    const board = waitingBoard(
      [
        msg({ filename: '20260720-100000-a.md', to_session: 'mobile', sent_at: '2026-07-20T10:00:00Z', acked: false }),
        msg({ filename: '20261101-100000-b.md', to_session: 'mobile', sent_at: '2026-11-01T10:00:00Z', acked: false }),
        msg({ filename: '20261117-100000-c.md', to_session: 'api', sent_at: '2026-11-17T10:00:00Z', acked: false }),
        msg({ filename: '20261116-100000-d.md', to_session: 'api', sent_at: '2026-11-16T10:00:00Z', acked: true }),
      ],
      NOW,
    )
    expect(board.total_unread).toBe(3)
    expect(board.inboxes.map((i) => [i.product, i.unread, i.oldest_age_days])).toEqual([
      ['mobile', 2, 121],
      ['api', 1, 1],
    ])
    expect(board.inboxes[0].items[0].filename).toBe('20260720-100000-a.md')
    expect(board.headline).toBe('3 unread messages in 2 inboxes. The oldest is 121 days old, in the mobile inbox.')
  })

  it('says what it counted when nothing is waiting', () => {
    const board = waitingBoard([msg({ filename: '20261116-100000-d.md', acked: true })], NOW)
    expect(board.headline).toBe('Nothing is waiting: 1 message, all acknowledged.')
    expect(board.inboxes).toEqual([])
  })

  it('does not call an undated message old', () => {
    const board = waitingBoard([msg({ filename: 'odd.md', acked: false, sent_at: null })], NOW)
    expect(board.inboxes[0].oldest_age_days).toBeNull()
    expect(board.headline).toBe('1 unread message in 1 inbox.')
  })
})

describe('ageDays', () => {
  it('floors to whole days and never goes negative', () => {
    expect(ageDays('2026-11-17T13:00:00Z', NOW)).toBe(0)
    expect(ageDays('2026-11-19T00:00:00Z', NOW)).toBe(0)
    expect(ageDays('not a date', NOW)).toBeNull()
  })
})

describe('normalizeSubject and citedStamps', () => {
  it('strips reply prefixes and case', () => {
    expect(normalizeSubject('Re: RE: Checkout  flow')).toBe('checkout flow')
    expect(normalizeSubject(null)).toBe('')
  })
  it('finds cited messages by stamp, whatever follows it', () => {
    expect(
      citedStamps('Re `archive/api/20261117-151403-api-checkout.md` and archive/mobile/20260817-195838, see 2026-11-17.'),
    ).toEqual(['20261117-151403', '20260817-195838'])
  })
})

describe('deriveThreads', () => {
  const ask = msg({
    filename: '20261117-151403-api-checkout-print.md',
    subject: 'Checkout flow fails for guests',
    sent_at: '2026-11-17T15:14:03Z',
  })
  const reply = msg({
    filename: '20261117-153255-web-re-checkout.md',
    from_session: 'api',
    to_session: 'web',
    subject: 'Shipped',
    body: 'Answering 20261117-151403-api-checkout-print.md: merged.',
    sent_at: '2026-11-17T15:32:55Z',
    acked: false,
  })
  const sameSubject = msg({
    filename: '20261117-160000-api-follow.md',
    subject: 'RE: checkout flow fails for guests',
    sent_at: '2026-11-17T16:00:00Z',
  })
  const other = msg({
    filename: '20261118-090000-api-release.md',
    subject: 'Release notes',
    sent_at: '2026-11-18T09:00:00Z',
  })

  it('joins by citation and by subject, and keeps unrelated mail apart', () => {
    const threads = deriveThreads([reply, other, sameSubject, ask], NOW)
    expect(threads.map((t) => [t.id, t.count, t.unread])).toEqual([
      ['20261118-090000-api-release.md', 1, 0],
      ['20261117-151403-api-checkout-print.md', 3, 1],
    ])
    expect(threads[1].participants).toEqual(['api', 'web'])
    expect(threads[1].messages.map((m) => m.filename)).toEqual([ask.filename, reply.filename, sameSubject.filename])
  })

  it('links a citation that was cut short, by its timestamp', () => {
    const short = msg({ filename: '20261117-170000-x.md', body: 'see 20261117-151403-api-pap', sent_at: '2026-11-17T17:00:00Z' })
    const threads = deriveThreads([ask, short], NOW)
    expect(threads).toHaveLength(1)
  })

  it('ignores a citation of a file that is not in the set, and blank subjects', () => {
    const a = msg({ filename: '20261001-000000-a.md', body: 'see 20200101-000000-gone', sent_at: '2026-10-01T00:00:00Z' })
    const b = msg({ filename: '20261002-000000-b.md', sent_at: '2026-10-02T00:00:00Z' })
    expect(deriveThreads([a, b], NOW)).toHaveLength(2)
  })

  it('does not join the same subject between different product pairs', () => {
    const a = msg({ filename: '20261001-000000-a.md', subject: 'Status', to_session: 'docs', sent_at: '2026-10-01T00:00:00Z' })
    const b = msg({ filename: '20261002-000000-b.md', subject: 'Status', to_session: 'mobile', sent_at: '2026-10-02T00:00:00Z' })
    expect(deriveThreads([a, b], NOW)).toHaveLength(2)
  })

  it('does not treat a product name as a subject', () => {
    const a = msg({ filename: '20261001-000000-a.md', subject: 'api', sent_at: '2026-10-01T00:00:00Z' })
    const b = msg({ filename: '20261002-000000-b.md', subject: 'api', sent_at: '2026-10-02T00:00:00Z' })
    expect(deriveThreads([a, b], NOW)).toHaveLength(2)
  })

  it('joins by the stamped thread id, with no citation and a different subject', () => {
    const first = msg({ filename: '20261118-221633-b-first-question.md', subject: 'First question', kind: 'question', thread_id: '20261118-221633', sent_at: '2026-11-18T22:16:33Z' })
    const answer = msg({ filename: '20261118-221634-a-answer.md', subject: 'Something else', thread_id: '20261118-221633', sent_at: '2026-11-18T22:16:34Z' })
    const old = msg({ filename: '20261101-000000-old.md', subject: 'Old mail', sent_at: '2026-11-01T00:00:00Z' })
    const replyToOld = msg({ filename: '20261118-230000-re.md', subject: 'Unrelated subject', thread_id: '20261101-000000', sent_at: '2026-11-18T23:00:00Z' })
    const threads = deriveThreads([first, answer, old, replyToOld], NOW)
    expect(threads.map((t) => [t.id, t.count])).toEqual([
      ['20261101-000000-old.md', 2],
      ['20261118-221633-b-first-question.md', 2],
    ])
    expect(threads[1].messages[0].kind).toBe('question')
    expect(threads[0].messages[0].kind).toBeNull()
  })

  it('keeps two deliveries of the same filename to different inboxes apart', () => {
    const a = msg({ filename: '20260801-000000-poll.md', to_session: 'docs', sent_at: '2026-08-01T00:00:00Z' })
    const b = msg({ filename: '20260801-000000-poll.md', to_session: 'mobile', sent_at: '2026-08-01T00:00:00Z' })
    expect(deriveThreads([a, b], NOW)).toHaveLength(2)
  })

  it('does not join two unrelated messages sent in the same second', () => {
    const a = msg({ filename: '20261118-233616-api-does-checkout-accept-guests.md', subject: 'Does checkout accept guests?', thread_id: '20261118-233616', sent_at: '2026-11-18T23:36:16Z' })
    const b = msg({ filename: '20261118-233616-web-release-is-out.md', subject: 'Release is out', thread_id: '20261118-233616', sent_at: '2026-11-18T23:36:16Z' })
    expect(deriveThreads([a, b], NOW)).toHaveLength(2)
  })

  it('joins by a full-name thread id', () => {
    const a = msg({ filename: '20261119-000000-api-first.md', subject: 'First', thread_id: '20261119-000000-api-first', sent_at: '2026-11-19T00:00:00Z' })
    const b = msg({ filename: '20261119-000100-web-other.md', subject: 'Other', thread_id: '20261119-000000-api-first', sent_at: '2026-11-19T00:01:00Z' })
    const c = msg({ filename: '20261119-000000-web-same-second.md', subject: 'Same second', thread_id: '20261119-000000-web-same-second', sent_at: '2026-11-19T00:00:00Z' })
    expect(deriveThreads([a, b, c], NOW).map((t) => t.count).sort()).toEqual([1, 2])
  })

  it('never returns a body', () => {
    const [t] = deriveThreads([reply], NOW)
    expect(Object.keys(t.messages[0])).not.toContain('body')
  })
})

describe('boardPosts', () => {
  const post = (over: Partial<Message> & { filename: string }) =>
    msg({ to_session: 'board', kind: 'post', acked: false, from_session: 'api', thread_id: over.filename.slice(0, 15), ...over })
  const refunds = post({ filename: '20261118-100000-board-refunds.md', subject: 'How do refunds work?', tags: ['payments', 'orders'], expires_on: '2026-11-25', sent_at: '2026-11-18T10:00:00Z' })
  const reply = msg({ filename: '20261118-103000-board-re.md', to_session: 'board', from_session: 'web', thread_id: '20261118-100000', evidence: 'verified', sent_at: '2026-11-18T10:30:00Z', acked: false })
  const stale = post({ filename: '20261101-100000-board-stale.md', subject: 'Anyone used the sandbox?', tags: ['orders'], expires_on: '2026-11-08', sent_at: '2026-11-01T10:00:00Z' })
  const done = post({ filename: '20261110-100000-board-done.md', subject: 'Which queue library?', tags: ['infra'], expires_on: '2026-11-17', sent_at: '2026-11-10T10:00:00Z', acked: true })
  const closing = msg({ filename: '20261111-100000-board-closed.md', to_session: 'board', from_session: 'api', kind: 'close', thread_id: '20261110-100000', settled_by: 'source', sent_at: '2026-11-11T10:00:00Z' })

  it('puts an expired, unanswered post first and counts in one sentence', () => {
    const board = boardPosts([refunds, reply, stale, done, closing], NOW)
    expect(board.open.map((p) => [p.id, p.state, p.replies.length])).toEqual([
      ['20261101-100000-board-stale.md', 'expired', 0],
      ['20261118-100000-board-refunds.md', 'open', 1],
    ])
    expect(board.open[1].replies[0].evidence).toBe('verified')
    expect(board.open[1].tags).toEqual(['payments', 'orders'])
    expect(board.closed.map((p) => [p.id, p.settled_by])).toEqual([['20261110-100000-board-done.md', 'source']])
    expect(board.headline).toBe('2 open posts, 1 with no reply, 1 past its date.')
  })

  it('does not let anyone but the asker close a post', () => {
    const fake = msg({ filename: '20261118-110000-board-closed.md', to_session: 'board', from_session: 'web', kind: 'close', thread_id: '20261118-100000', settled_by: 'fix', sent_at: '2026-11-18T11:00:00Z' })
    const board = boardPosts([refunds, fake], NOW)
    expect(board.open).toHaveLength(1)
    expect(board.closed).toHaveLength(0)
  })

  it('does not treat an archived post as answered', () => {
    const moved = post({ filename: '20261117-100000-board-moved.md', subject: 'Moved by hand', expires_on: '2026-11-24', sent_at: '2026-11-17T10:00:00Z', acked: true })
    expect(boardPosts([moved], NOW).open).toHaveLength(1)
  })

  it('says so when the board is empty or all closed', () => {
    expect(boardPosts([], NOW).headline).toBe('No one has posted to the board yet.')
    expect(boardPosts([done, closing], NOW).headline).toBe('Nothing is open. 1 post has been closed.')
  })

  it('keeps board mail out of the unread count', () => {
    expect(waitingBoard([refunds, reply], NOW).total_unread).toBe(0)
  })
})
