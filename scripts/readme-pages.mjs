#!/usr/bin/env node
/**
 * Writes the pages pictured in each package's README, from made-up data.
 *
 *   npm run build && node scripts/readme-pages.mjs OUT_DIR
 *
 * Then open each OUT_DIR/<package>.html in a browser at 1000 x 700 and save a
 * picture to packages/<package>/docs/screenshot.png.
 *
 * Nothing here reads your own machine: the home folder is replaced by a made-up
 * one before any tool runs, so no real project, session or message can end up
 * in a picture.
 */
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const out = path.resolve(process.argv[2] || 'readme-pages')
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = path.join(mkdtempSync(path.join(os.tmpdir(), 'jq-readme-')), 'dana')
mkdirSync(home, { recursive: true })
process.env.HOME = home
delete process.env.CLAUDE_CONFIG_DIR
mkdirSync(out, { recursive: true })

const lib = (name) => import(path.join(root, 'packages', name, 'dist', 'index.mjs'))
const file = (p, text) => (mkdirSync(path.dirname(p), { recursive: true }), writeFileSync(p, text))
const now = Date.now()
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()

/* ── jq-groundcrew: a real run over a made-up project ───────────────── */
const shop = path.join(home, 'code', 'shop')
file(path.join(shop, 'CLAUDE.md'), '# Shop\n' + 'A line of project instructions.\n'.repeat(260))
file(path.join(shop, '.env'), 'API_KEY=made-up\n')
file(path.join(shop, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Bash(npm run lint:*)'] } }, null, 2))
file(path.join(shop, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews a diff.\ntools: Read, Grep\n---\nReview the diff.\n')
file(path.join(shop, '.claude', 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: Cut a release.\n---\nSteps.\n')
const groundcrew = await lib('groundcrew')
writeFileSync(path.join(out, 'groundcrew.html'), groundcrew.renderPage(groundcrew.report(shop)))

/* ── jq-agents: a made-up snapshot ──────────────────────────────────── */
const session = (over) => ({ machine: 'dana-laptop', product: 'shop', working_tree: '/Users/dana/code/shop', branch: 'main', session_id: Math.random().toString(36).slice(2), pid: 1, state: 'live', last_activity_at: ago(1), waiting: false, stop_reason: null, ends_with_question: false, blocked_question: null, question_redacted: false, question_allowed: false, cpu_pct: 4.2, rss_mb: 412.5, ...over })
const sessions = [
  session({ branch: 'orders-not-null', state: 'idle', waiting: true, last_activity_at: ago(42), question_allowed: true, blocked_question: 'The migration adds a NOT NULL column to orders. Should I backfill existing rows with 0, or make it nullable and backfill in a later change?', cpu_pct: 0.1, rss_mb: 388.0 }),
  session({ branch: 'checkout-copy', cpu_pct: 31.5, rss_mb: 640.2 }),
  session({ product: 'api', working_tree: '/Users/dana/code/api', branch: 'rate-limits', state: 'idle', waiting: true, last_activity_at: ago(9), cpu_pct: 0.0, rss_mb: 301.7 }),
  session({ product: 'docs', working_tree: '/Users/dana/code/docs', branch: 'main', state: 'stale', waiting: true, last_activity_at: ago(60 * 26), pid: null, cpu_pct: null, rss_mb: null }),
  session({ product: 'docs', working_tree: '/Users/dana/code/docs', branch: 'install-guide', cpu_pct: 12.0, rss_mb: 455.1 }),
]
const snapshot = { machine: 'dana-laptop', generated_at: new Date(now).toISOString(), sessions, host: null, bottleneck: { kind: 'memory', reason: '91% of memory in use, 2,140 MB of swap' } }
const agents = await lib('agents')
writeFileSync(path.join(out, 'agents.html'), agents.renderPage(snapshot, now))

/* ── jq-crosstalk: a real mailbox, written with the real tool ───────── */
const mailbox = path.join(home, 'crosstalk')
const tool = path.join(root, 'packages', 'crosstalk', 'bin', 'crosstalk')
const ct = (from, args, body) => execFileSync(tool, [...args, '--from', from], { env: { ...process.env, CROSSTALK_DIR: mailbox }, input: body, encoding: 'utf8' })
execFileSync(tool, ['init', mailbox, 'api', 'web', 'mobile'], { encoding: 'utf8' })
ct('web', ['send', 'api', 'Does checkout accept guests?', '--kind', 'question'], 'The new cart page needs to know before Friday. If it does not, I will hide the guest button.\n')
ct('mobile', ['send', 'api', 'Push tokens: rotate on sign-out', '--kind', 'brief'], 'Please clear the device token when a user signs out. The contract is in contracts/push.md.\n')
ct('api', ['send', 'web', 'Rate limits go live on Monday', '--kind', 'notice'], 'Sixty requests a minute per key. Nothing for you to do unless you batch.\n')
ct('web', ['post', 'How do refunds work for cancelled orders?', '--tags', 'payments,orders'], 'A cancelled order still shows as paid in the admin. Who owns the refund step?\n')
const posted = execFileSync('ls', [path.join(mailbox, 'inbox', 'board')], { encoding: 'utf8' }).trim().split('\n')[0]
ct('api', ['reply', path.join(mailbox, 'inbox', 'board', posted), '--evidence', 'verified'], 'The payments worker refunds on the order.cancelled event. I read the handler: it skips orders paid by gift card.\n')
ct('mobile', ['reply', path.join(mailbox, 'inbox', 'board', posted), '--evidence', 'assumed'], 'I think gift cards were excluded on purpose last spring. Not checked.\n')
const crosstalk = await lib('crosstalk')
writeFileSync(path.join(out, 'crosstalk.html'), crosstalk.renderPage({ ...crosstalk.buildReport(mailbox, now), mailbox: '~/crosstalk' }))

/* ── jq-deck: the overview, joined from the same made-up data ───────── */
const deck = await lib('deck')
const setups = new Map([
  ['/Users/dana/code/shop', { summary: groundcrew.summarize(groundcrew.runChecks(groundcrew.gather(shop).facts)) }],
  ['/Users/dana/code/api', { summary: { pass: 9, warn: 1, fail: 0, info: 4, score: 90 } }],
  ['/Users/dana/code/docs', { summary: { pass: 10, warn: 0, fail: 0, info: 4, score: 100 } }],
])
const overview = deck.buildOverview({
  snapshot,
  trees: [...setups.keys()],
  setups,
  waiting: crosstalk.waitingBoard(crosstalk.readMailbox(mailbox), now),
  inboxes: ['api', 'web', 'mobile'],
  mailbox: '~/crosstalk',
  names: { web: '/Users/dana/code/shop' },
})
writeFileSync(path.join(out, 'deck.html'), deck.renderShell(overview, 'overview', null, '0.3.0'))

/* ── jq-deck-server: a made-up team ─────────────────────────────────── */
const server = await lib('deck-server')
const repo = (over) => ({ name: 'shop', remote: 'github.com/acme/shop', sessions: 1, live: 1, needs_you: 0, abandoned: 0, waiting_since: null, last_activity_at: ago(1), setup: { score: 100, fail: 0, warn: 0 }, unread: 0, ...over })
const stored = (machine, who, minutesAgo, repos) => ({ machine, who, received_at: ago(minutesAgo), report: { v: 1, generated_at: ago(minutesAgo), repos } })
const team = server.buildTeam(
  [
    stored('dana-laptop', 'Dana', 0, [
      repo({ sessions: 2, needs_you: 1, waiting_since: ago(42), setup: { score: 60, fail: 2, warn: 1 }, unread: 2, questions: [{ asked_at: ago(42), text: sessions[0].blocked_question }] }),
      repo({ name: 'docs', remote: 'github.com/acme/docs', sessions: 2 }),
    ]),
    stored('lee-desktop', 'Lee', 1, [repo({ needs_you: 1, live: 0, waiting_since: ago(133), setup: { score: 80, fail: 0, warn: 2 }, unread: null }), repo({ name: 'api', remote: 'github.com/acme/api', sessions: 3, live: 2, setup: { score: 90, fail: 0, warn: 1 }, unread: 1 })]),
    stored('build-box', 'Sam', 140, [repo({ name: 'api', remote: 'github.com/acme/api', live: 0, needs_you: 1, waiting_since: ago(300) })]),
  ],
  now,
)
writeFileSync(path.join(out, 'deck-server.html'), server.renderTeam(team, 'dana', '0.2.1'))

console.log(`wrote 5 pages to ${out}`)
