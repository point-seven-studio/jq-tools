/**
 * `jq-deck-server send` and `jq-deck-server approvals`: read stdin and post it to a
 * board. This is the only code in the package that calls out, and only to the address
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

/** The one place this package calls out. Written once, so the build can count it. */
const outbound: typeof fetch = (...args) => fetch(...args)

/** A POST to the address the user passed, with their machine's token. */
function call(url: URL, token: string, body: unknown, post: typeof fetch): Promise<Response> {
  return post(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
}

const NO_TOKEN = 'set $JQ_DECK_TOKEN to this machine\'s token (from: jq-deck-server add-machine)'

export async function send(base: string, token: string | undefined, input: string, post: typeof fetch = outbound): Promise<void> {
  if (!token) throw new Error(NO_TOKEN)
  const url = reportUrl(base)
  // Reduced to the fields a report has before it leaves, whatever was piped in.
  const report = sanitizeReport(JSON.parse(input))
  const res = await call(url, token, report, post)
  if (res.status !== 204) throw new Error(`the server answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

/** Where approval requests go: beside the report address, at /approvals. */
export function approvalsUrl(base: string): URL {
  const url = reportUrl(base)
  url.pathname = url.pathname.replace(/\/report$/, '/approvals')
  return url
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/**
 * What `jq-deck approvals` piped in, reduced to the fields a request has. Anything else
 * that was piped in does not leave. Throws when it is not a list of requests.
 */
export function sanitizeApprovals(input: unknown): { v: 1; generated_at: string; pending: Record<string, string>[] } {
  const data = input as any
  if (!data || data.v !== 1 || !Array.isArray(data.pending)) throw new Error('not a list of approval requests (pipe it from: jq-deck approvals --exec ...)')
  return {
    v: 1,
    generated_at: text(data.generated_at, 40),
    pending: data.pending.slice(0, 20).map((p: any) => ({
      request: text(p?.request, 160),
      worker: text(p?.worker, 64),
      approver: text(p?.approver, 64),
      thread: text(p?.thread, 200),
      subject: text(p?.subject, 200),
      tool: text(p?.tool, 64),
      asked_at: text(p?.asked_at, 40),
      text: text(p?.text, 8000),
      digest: text(p?.digest, 64),
    })),
  }
}

/**
 * `jq-deck-server approvals`: post the waiting approval requests read on stdin, and return
 * what the board answered, for `jq-deck approvals` to check and put in the mailbox. The
 * requests quote the commands that are waiting, so this sends text, not counts.
 */
export async function sendApprovals(base: string, token: string | undefined, input: string, post: typeof fetch = outbound): Promise<string> {
  if (!token) throw new Error(NO_TOKEN)
  const res = await call(approvalsUrl(base), token, sanitizeApprovals(JSON.parse(input)), post)
  const body = await res.text()
  if (res.status === 404) throw new Error('this board does not take approval requests (the server answered 404)')
  if (res.status !== 200) throw new Error(`the server answered ${res.status}: ${body.slice(0, 200)}`)
  return body
}
