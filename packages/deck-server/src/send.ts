/**
 * `jq-deck-server send`: read one report on stdin and post it to a team server.
 * This is the only code in the package that calls out, and only to the address
 * you give it.
 */
import { sanitizeReport } from './report.js'

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** The address to post to: the server's address, or a full address that ends in /report. Plain HTTP is refused except to this machine: the token would travel in the clear. */
export function reportUrl(base: string): URL {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`--url is not an address: ${base}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.has(url.hostname))) throw new Error('--url must start with https (plain http is allowed only to this machine)')
  if (url.username || url.password) throw new Error('--url must not hold a user name or password; the token goes in $JQ_DECK_TOKEN')
  // A board mounted inside another server has its report address under a path. Give that
  // whole address, ending in /report, and it is used as written. Anything else is a server's
  // own address, and the report goes to /report at its root.
  if (url.pathname.endsWith('/report')) {
    url.search = ''
    url.hash = ''
    return url
  }
  return new URL('/report', url)
}

export async function send(base: string, token: string | undefined, input: string, post: typeof fetch = fetch): Promise<void> {
  if (!token) throw new Error('set $JQ_DECK_TOKEN to this machine\'s token (from: jq-deck-server add-machine)')
  const url = reportUrl(base)
  // Reduced to the fields a report has before it leaves, whatever was piped in.
  const report = sanitizeReport(JSON.parse(input))
  const res = await post(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  if (res.status !== 204) throw new Error(`the server answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
}
