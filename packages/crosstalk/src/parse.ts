/**
 * The crosstalk message file format, parsed. Pure.
 *
 * A message is a markdown file with a small header block:
 *
 *   ---
 *   from: web
 *   to: api
 *   subject: Does checkout accept guests?
 *   sent: 2026-11-18T22:16:33Z
 *   kind: question
 *   thread: 20261118-221633
 *   needs_response: yes
 *   ---
 *
 *   The body.
 */

/** How a board post can be settled; the tool refuses anything else. */
export const SETTLED_BY = ['source', 'owner', 'fix', 'pushback', 'nobody']

/** Parse one message file. `recipient` is the inbox it was found in; `acked` is true when it was found in the archive. */
export function parseMessage(
  filename: string,
  raw: string,
  recipient: string,
  acked: boolean,
): {
  filename: string
  from_session: string
  to_session: string
  subject: string | null
  body: string
  sent_at: string | null
  acked: boolean
  kind: string | null
  thread_id: string | null
  reply_to: string | null
  tags: string[] | null
  expires_on: string | null
  evidence: string | null
  settled_by: string | null
  /** Who wrote it, when the sender is a role such as `human`. */
  author: string | null
} {
  let tags: string[] | null = null
  let expires: string | null = null
  let evidence: string | null = null
  let settledBy: string | null = null
  let kind: string | null = null
  let thread: string | null = null
  let replyTo: string | null = null
  let author: string | null = null
  let from = ''
  let subject: string | null = null
  let sent: string | null = null
  let body = raw

  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (fm) {
    body = fm[2].trim()
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (!m) continue
      if (m[1] === 'from') from = m[2].trim()
      else if (m[1] === 'subject') subject = m[2].trim()
      else if (m[1] === 'sent') sent = m[2].trim()
      else if (m[1] === 'kind') kind = m[2].trim() || null
      else if (m[1] === 'thread') thread = m[2].trim() || null
      else if (m[1] === 'reply_to') replyTo = m[2].trim() || null
      else if (m[1] === 'tags') {
        const list = m[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        tags = list.length ? [...new Set(list)] : null
      } else if (m[1] === 'expires') expires = /^\d{4}-\d{2}-\d{2}$/.test(m[2].trim()) ? m[2].trim() : null
      else if (m[1] === 'evidence') evidence = m[2].trim() || null
      else if (m[1] === 'settled_by') settledBy = m[2].trim() || null
      else if (m[1] === 'author') author = m[2].trim() || null
    }
  }
  // A file with no sender is still shown, never guessed at.
  if (!from) from = 'unknown'
  return {
    filename,
    from_session: from,
    to_session: recipient,
    subject,
    body,
    sent_at: sent && !Number.isNaN(Date.parse(sent)) ? new Date(sent).toISOString() : null,
    acked,
    // Only the kinds the tool writes; anything else is treated as unset.
    kind: kind && ['brief', 'question', 'notice', 'post', 'close'].includes(kind) ? kind : null,
    thread_id: thread,
    reply_to: replyTo,
    tags,
    expires_on: expires,
    evidence: evidence && ['verified', 'assumed'].includes(evidence) ? evidence : null,
    settled_by: settledBy && SETTLED_BY.includes(settledBy) ? settledBy : null,
    author,
  }
}
