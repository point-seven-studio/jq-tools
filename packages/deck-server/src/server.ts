/**
 * The HTTP side. handle() is a plain function from a request to a reply, so
 * every rule here is tested without a socket.
 *
 *   POST /report      a machine's report        Bearer machine token
 *   GET  /            the team page             viewer cookie
 *   GET  /api/team    the same, as JSON         viewer cookie or Bearer viewer token
 *   GET  /login, POST /login, POST /logout
 *   GET  /healthz     "ok", for a load balancer
 */
import { createServer, type Server } from 'http'
import { renderLogin, renderTeam } from './page.js'
import { MAX_BODY_BYTES, sanitizeReport } from './report.js'
import { machineFor, readConfig, readReports, saveReport, viewerFor, type Viewer } from './store.js'
import { buildTeam } from './team.js'

export interface Req {
  method: string
  path: string
  authorization?: string
  cookie?: string
  body: string
}

export interface Res {
  status: number
  headers: Record<string, string>
  body: string
}

export interface ServerContext {
  dir: string
  version: string
  /** False only when serving plain HTTP on this machine. */
  secureCookie: boolean
  now?: () => number
}

const COOKIE = 'jq_deck'
const HTML = { 'content-type': 'text/html; charset=utf-8' }
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }

const text = (status: number, body: string, headers: Record<string, string> = {}): Res => ({ status, headers: { ...TEXT, ...headers }, body })
const bearer = (h: string | undefined) => (h && /^Bearer\s+\S+$/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null)

function cookieToken(header: string | undefined): string | null {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return v.join('=') || null
  }
  return null
}

const cookie = (ctx: ServerContext, value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${ctx.secureCookie ? '; Secure' : ''}`

export function handle(req: Req, ctx: ServerContext): Res {
  const now = (ctx.now ?? Date.now)()
  const route = `${req.method} ${req.path}`
  if (route === 'GET /healthz') return text(200, 'ok')

  const config = readConfig(ctx.dir)

  if (route === 'POST /report') {
    const machine = machineFor(config, bearer(req.authorization))
    if (!machine) return text(401, 'unknown machine token')
    let report
    try {
      report = sanitizeReport(JSON.parse(req.body))
    } catch (e: any) {
      return text(400, `not a report: ${e?.message || e}`)
    }
    // Stored under the name the token belongs to. A sender cannot report as another machine.
    saveReport(ctx.dir, machine, report, now)
    return { status: 204, headers: {}, body: '' }
  }

  if (route === 'GET /login') return { status: 200, headers: HTML, body: renderLogin(null) }
  if (route === 'POST /login') {
    const token = new URLSearchParams(req.body).get('token')?.trim()
    if (!viewerFor(config, token)) {
      // The one mistake worth naming: pasting the token a machine reports with.
      const why = machineFor(config, token) ? 'That is a machine token. Sign in with a viewer token, which starts with jqv_.' : 'That token is not known to this server.'
      return { status: 401, headers: HTML, body: renderLogin(why) }
    }
    return { status: 303, headers: { location: '/', 'set-cookie': cookie(ctx, token as string, 30 * 86_400) }, body: '' }
  }
  if (route === 'POST /logout') return { status: 303, headers: { location: '/login', 'set-cookie': cookie(ctx, '', 0) }, body: '' }

  if (route === 'GET /' || route === 'GET /api/team') {
    const api = req.path === '/api/team'
    const viewer: Viewer | null = viewerFor(config, cookieToken(req.cookie)) ?? (api ? viewerFor(config, bearer(req.authorization)) : null)
    if (!viewer) return api ? text(401, 'a viewer token is needed') : { status: 303, headers: { location: '/login' }, body: '' }
    const team = buildTeam(readReports(ctx.dir, config), now, viewer)
    return api ? { status: 200, headers: JSON_TYPE, body: JSON.stringify(team, null, 2) } : { status: 200, headers: HTML, body: renderTeam(team, viewer.name, ctx.version) }
  }

  return text(404, 'not found')
}

/** Headers on every reply: never cached, never framed, and the page may load nothing. */
export const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}

export function startServer(ctx: ServerContext, port: number, host: string, onListen?: (port: number) => void): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) tooBig = true
      else chunks.push(chunk)
    })
    req.on('end', () => {
      let reply: Res
      try {
        reply = tooBig
          ? text(413, 'the body is too large')
          : handle({ method: req.method || 'GET', path: (req.url || '/').split('?')[0], authorization: req.headers.authorization, cookie: req.headers.cookie, body: Buffer.concat(chunks).toString('utf8') }, ctx)
      } catch (e: any) {
        // The reason goes to the server's log, not to whoever asked.
        console.error('jq-deck-server:', e?.message || e)
        reply = text(500, 'server error')
      }
      res.writeHead(reply.status, { ...SECURITY_HEADERS, ...reply.headers })
      res.end(reply.body)
    })
  })
  server.listen(port, host, () => {
    const address = server.address()
    onListen?.(typeof address === 'object' && address ? address.port : port)
  })
  return server
}
