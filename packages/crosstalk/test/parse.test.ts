import { describe, expect, it } from 'vitest'
import { parseMessage } from '../src/parse.js'

const NEW = `---
from: api
to: web
subject: Re: First question
sent: 2026-11-18T22:16:34Z
kind: notice
thread: 20261118-221633
reply_to: 20261118-221633-b-first-question.md
needs_response: no
---

thread: not a header
The body.
`

describe('parseMessage', () => {
  it('reads kind, thread and reply_to from the header only', () => {
    const r = parseMessage('20261118-221634-a-re.md', NEW, 'web', false)
    expect(r).toMatchObject({
      from_session: 'api',
      to_session: 'web',
      subject: 'Re: First question',
      sent_at: '2026-11-18T22:16:34.000Z',
      kind: 'notice',
      thread_id: '20261118-221633',
      reply_to: '20261118-221633-b-first-question.md',
      acked: false,
    })
    expect(r.body).toBe('thread: not a header\nThe body.')
  })

  it('leaves the new fields null on mail written before they existed', () => {
    const r = parseMessage('old.md', '---\nfrom: web\nsubject: Old\nsent: 2026-08-01T00:00:00Z\nneeds_response: yes\n---\n\nHi', 'api', true)
    expect(r).toMatchObject({ kind: null, thread_id: null, reply_to: null, acked: true, subject: 'Old' })
  })

  it('drops a kind the tool does not write, and a date that is not one', () => {
    const r = parseMessage('x.md', '---\nfrom: a\nkind: chat\nsent: soon\n---\nb', 'b', false)
    expect(r.kind).toBeNull()
    expect(r.sent_at).toBeNull()
  })

  it('reads the board fields', () => {
    const post = parseMessage('p.md', '---\nfrom: a\nto: board\nkind: post\ntags: Payments, orders,payments\nexpires: 2026-11-25\n---\nq', 'board', false)
    expect(post).toMatchObject({ kind: 'post', tags: ['payments', 'orders'], expires_on: '2026-11-25' })
    const reply = parseMessage('r.md', '---\nfrom: b\nevidence: verified\n---\na', 'board', false)
    expect(reply.evidence).toBe('verified')
    const close = parseMessage('c.md', '---\nfrom: a\nkind: close\nsettled_by: nobody\n---\nx', 'board', true)
    expect(close).toMatchObject({ kind: 'close', settled_by: 'nobody' })
  })

  it('drops board values the tool would refuse', () => {
    const r = parseMessage('x.md', '---\nfrom: a\nevidence: sure\nsettled_by: vibes\nexpires: next week\ntags: ,\n---\nb', 'board', false)
    expect(r).toMatchObject({ evidence: null, settled_by: null, expires_on: null, tags: null })
  })
})

describe('a file with no sender', () => {
  it('is shown as unknown, never guessed', () => {
    expect(parseMessage('x.md', 'no header at all', 'api', false)).toMatchObject({ from_session: 'unknown', body: 'no header at all', subject: null })
  })
})
