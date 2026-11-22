/**
 * Tests for the turn check: what counts as an edit made through the shell, what a person can
 * correct, and what the page and the server will accept.
 *
 * A false alert costs more than a missed one here, so most of the tables below are lists of
 * things that must NOT be taken as an edit. Each came from a real false alert found by
 * running the rule over local transcripts on 2026-11-21.
 */
import { describe, expect, it } from 'vitest'
import type { TranscriptRecord } from '../src/agent-status.js'
import { buildStatusRow } from '../src/agent-status.js'
import { allowedPost } from '../src/cli.js'
import { renderPage } from '../src/page.js'
import { COPY_SCRIPT_TAG } from '../src/presence.js'
import { EMPTY_CONFIG, applyAction, deriveTurnCheckDetail, isCodePath, parseAction, parseConfig, ruleText, rulesFor, shellEdit, shellSegments, type TurnCheckConfig } from '../src/turn-check.js'

describe('shellEdit: a shell command that changes code', () => {
  it.each([
    ["sed -i '' 's/a/b/' src/app.ts", 'sed -i'],
    ['perl -pi -e "s/a/b/" lib/util.py', 'perl -pi'],
    ['mv src/old.ts src/new.ts', 'mv'],
    ['rm apps/api/routes/users.ts', 'rm'],
    ['git mv src/a.ts src/b.ts', 'git mv'],
    ['echo "export const x = 1" > src/x.ts', 'echo'],
    ['cd apps/web && cat > src/page.tsx <<EOF\nexport default 1\nEOF', 'cat > src/page.tsx'],
    ['npm ls | tee package-list.json', 'tee'],
    ["python3 - <<'EOF'\np='src/app.py'\nopen(p,'w').write('x')\nEOF", 'python3 -'],
    ['node -e "require(\'fs\').writeFileSync(\'config.json\', \'{}\')"', 'node -e'],
  ])('%s', (command, starts) => {
    expect(shellEdit(command).startsWith(starts)).toBe(true)
  })

  it.each([
    'source ~/.nvm/nvm.sh >/dev/null',
    'nvm use >/dev/null 2>&1',
    'gh pr checks 1567 --watch --interval 30 >/dev/null 2>&1',
    'npm test 2>&1 | tail -5',
    'curl -s https://example.com > /tmp/page.html',
    'echo done >> notes.md',
    'cat > _q.mts <<EOF\nconsole.log(1)\nEOF',
    'cat > ./.prev.mjs <<EOF\nx\nEOF',
    'cat >> ~/.claude/projects/x/memory/note.md <<EOF\nx\nEOF',
    'rm -f scripts/_tmp_shot.mjs',
    'rm -rf dist/ node_modules/.cache',
    'cp /tmp/a.png docs/screenshot.png',
    'psql "$DB" -c "select count(*) from t where a > 3 and b < 4"',
    'node -e "const f = (x) => x > 1; console.log(f(2))"',
    'F=/tmp/out.json; echo "{}" > "$F"',
    'git status && git log --oneline -3',
    "python3 - <<'EOF'\nprint(open('src/app.py').read())\nEOF",
    "python3 - <<'EOF'\nopen('/tmp/x.py','w').write('x')\nEOF",
  ])('not an edit: %s', (command) => {
    expect(shellEdit(command)).toBe('')
  })

  it('knows a code path from a note, a picture and scratch space', () => {
    expect(['src/a.ts', 'apps/api/.env.local', 'Dockerfile', 'infra/main.tf', '"lib/x.py"'].map(isCodePath)).toEqual([true, true, true, true, true])
    expect(['README.md', 'out.log', 'a.png', '/tmp/x.ts', '$S/x.ts', '.claude/settings.json', '_scratch.ts', 'dist/index.js'].map(isCodePath)).toEqual([false, false, false, false, false, false, false, false])
  })

  it('does not split a command inside a quoted string', () => {
    expect(shellSegments('echo "a; b | c" && ls')).toEqual(['echo "a; b | c"', 'ls'])
  })

  it('names a rule by the start of the command, without its paths', () => {
    expect(['make verify', './scripts/ci.sh --fast', "sed -i '' s/a/b/ src/x.ts", 'python3 - <<EOF', 'npx nx run api:test'].map(ruleText)).toEqual([
      'make verify',
      './scripts/ci.sh --fast',
      'sed -i',
      'python3 -',
      'npx nx run',
    ])
  })
})

let n = 0
const prompt = (): TranscriptRecord => ({ type: 'user', timestamp: '2026-11-21T10:00:00.000Z', cwd: '/code/shop', sessionId: 's1', message: { role: 'user', content: 'fix it' } })
const bash = (command: string): TranscriptRecord => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${++n}`, name: 'Bash', input: { command } }] } })
const edit = (file_path: string): TranscriptRecord => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${++n}`, name: 'Edit', input: { file_path } }] } })
const done: TranscriptRecord = { type: 'assistant', timestamp: '2026-11-21T10:05:00.000Z', cwd: '/code/shop', sessionId: 's1', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }

describe('deriveTurnCheckDetail with shell edits and corrections', () => {
  const turn = [prompt(), bash("sed -i '' 's/a/b/' src/app.ts"), bash('make verify'), bash('git status'), done]

  it('takes a shell edit as an edit, and says what ran after it', () => {
    const detail = deriveTurnCheckDetail(turn)
    expect(detail.result).toBe('unchecked')
    expect(detail.via).toBe('shell')
    expect(detail.evidence).toEqual({ via: 'shell', edit: "sed -i '' 's/a/b/' src/app.ts", after: ['make verify', 'git status'] })
  })
  it('a "check" correction makes the project\'s own command count', () => {
    expect(deriveTurnCheckDetail(turn, { checks: ['make verify'] }).result).toBe('checked')
  })
  it('a "not-edit" correction stops a command counting as an edit', () => {
    expect(deriveTurnCheckDetail(turn, { notEdits: ['sed -i'] }).result).toBe('no-edits')
  })
  it('shell edits can be turned off whole', () => {
    expect(deriveTurnCheckDetail(turn, { shellEdits: false }).result).toBe('no-edits')
  })
  it('a check that also writes a log is a check, not an edit', () => {
    expect(deriveTurnCheckDetail([prompt(), edit('src/a.ts'), bash('npm run build > build.json'), done]).result).toBe('checked')
  })
  it('an edit to a note is not an edit that needs a check', () => {
    expect(deriveTurnCheckDetail([prompt(), edit('/code/shop/README.md'), done]).result).toBe('no-edits')
    expect(deriveTurnCheckDetail([prompt(), edit('/code/shop/src/a.ts'), done]).result).toBe('unchecked')
  })
  it('gives no evidence for a row that needs no look, and redacts a secret in what it gives', () => {
    expect(deriveTurnCheckDetail([prompt(), edit('src/a.ts'), bash('npm test'), done]).evidence).toBeNull()
    const leaky = deriveTurnCheckDetail([prompt(), bash('echo x > src/a.ts'), bash('psql postgres://admin:hunter2@db.example.com:5432/app -c "select 1"'), done])
    expect(JSON.stringify(leaky.evidence)).not.toContain('hunter2')
  })
})

describe('corrections', () => {
  const add = (config: TurnCheckConfig, text: string) => applyAction(config, { action: 'add-rule', tree: '/code/shop', kind: 'check', text })

  it('adds a rule once, and removes it by its place in the list', () => {
    const one = add(EMPTY_CONFIG, ' make verify ')
    expect(one.rules).toEqual([{ tree: '/code/shop', kind: 'check', text: 'make verify' }])
    expect(add(one, 'make verify')).toBe(one)
    expect(applyAction(one, { action: 'remove-rule', index: 0 }).rules).toEqual([])
    expect(applyAction(one, { action: 'remove-rule', index: 5 })).toBe(one)
  })
  it('refuses a rule too short to mean anything', () => {
    expect(add(EMPTY_CONFIG, 'x')).toBe(EMPTY_CONFIG)
  })
  it('a rule applies to its own tree, and "*" to all', () => {
    const config = parseConfig({ rules: [{ tree: '/code/shop', kind: 'check', text: 'make verify' }, { tree: '*', kind: 'not-edit', text: 'tee' }, { tree: '/code/api', kind: 'check', text: 'just ci' }] })
    expect(rulesFor(config, '/code/shop')).toEqual({ checks: ['make verify'], notEdits: ['tee'] })
    expect(rulesFor(config, '/code/other')).toEqual({ checks: [], notEdits: ['tee'] })
  })
  it('drops anything malformed from a config file', () => {
    expect(parseConfig({ rules: [{ tree: '/a', kind: 'bogus', text: 'x y' }, 'nope', { tree: '', kind: 'check', text: 'make' }], muted: [1, '/a'], dismissed: { s1: 5, s2: 'when' } })).toEqual({
      rules: [],
      muted: ['/a'],
      dismissed: { s2: 'when' },
    })
    expect(parseConfig(null)).toEqual(EMPTY_CONFIG)
  })

  const row = (turnCheck?: Parameters<typeof buildStatusRow>[0]['turnCheck']) =>
    buildStatusRow({ machine: 'm', records: [prompt(), edit('src/a.ts'), done], sessionIdFallback: 's1', alive: true, pid: 1, allowlist: [], now: Date.parse('2026-11-21T10:06:00.000Z'), turnCheck })
  it('a dismissal holds until the session moves again', () => {
    expect(row()?.turn_check).toBe('unchecked')
    expect(row({ dismissedAt: '2026-11-21T10:05:00.000Z' })?.turn_check).toBe('dismissed')
    expect(row({ dismissedAt: '2026-11-21T09:00:00.000Z' })?.turn_check).toBe('unchecked')
  })
  it('a muted tree is never labelled', () => {
    expect(row({ muted: true })?.turn_check).toBe('dismissed')
  })

  const known = { trees: ['/code/shop'], sessions: { s1: '2026-11-21T10:05:00.000Z', s2: null } }
  it('a form may only name what the board showed', () => {
    expect(parseAction({ action: 'mute', tree: '/code/shop' }, known, EMPTY_CONFIG)).toEqual({ action: 'mute', tree: '/code/shop' })
    expect(parseAction({ action: 'mute', tree: '/etc' }, known, EMPTY_CONFIG)).toBeNull()
    expect(parseAction({ action: 'add-rule', tree: '/etc', kind: 'check', text: 'make' }, known, EMPTY_CONFIG)).toBeNull()
    expect(parseAction({ action: 'add-rule', tree: '/code/shop', kind: 'other', text: 'make' }, known, EMPTY_CONFIG)).toBeNull()
    expect(parseAction({ action: 'nonsense' }, known, EMPTY_CONFIG)).toBeNull()
  })
  it('a dismissal takes its time from the board, not from the form', () => {
    expect(parseAction({ action: 'dismiss', session: 's1', at: '1999-01-01' }, known, EMPTY_CONFIG)).toEqual({ action: 'dismiss', session: 's1', at: '2026-11-21T10:05:00.000Z' })
    expect(parseAction({ action: 'dismiss', session: 'unknown' }, known, EMPTY_CONFIG)).toBeNull()
    expect(parseAction({ action: 'dismiss', session: 's2' }, known, EMPTY_CONFIG)).toBeNull()
  })
})

describe('who may save a correction', () => {
  const token = 'a'.repeat(32)
  const ok = { host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' }
  it('accepts the page this process served', () => {
    expect(allowedPost(ok, 4319, token, token)).toBe(true)
    expect(allowedPost({ host: 'localhost:4319', origin: 'http://localhost:4319' }, 4319, token, token)).toBe(true)
    expect(allowedPost({ host: '127.0.0.1:4319' }, 4319, token, token)).toBe(true) // no Origin, as from curl
  })
  it('refuses another site, another name for this machine, and a wrong token', () => {
    expect(allowedPost({ ...ok, origin: 'https://evil.example' }, 4319, token, token)).toBe(false)
    expect(allowedPost({ host: 'evil.example:4319', origin: 'http://evil.example:4319' }, 4319, token, token)).toBe(false)
    expect(allowedPost({ ...ok, origin: 'null' }, 4319, token, token)).toBe(false)
    expect(allowedPost(ok, 4319, token, 'b'.repeat(32))).toBe(false)
    expect(allowedPost(ok, 4319, token, undefined)).toBe(false)
    expect(allowedPost({ host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999' }, 4319, token, token)).toBe(false)
  })
})

describe('the page', () => {
  const session = { machine: 'm', product: 'shop', working_tree: '/code/shop', branch: 'main', session_id: 's1', pid: 1, state: 'idle' as const, last_activity_at: '2026-11-21T10:05:00.000Z', waiting: true, stop_reason: 'end_turn', ends_with_question: false, blocked_question: null, question_redacted: false, question_allowed: false, turn_check: 'unchecked' as const }
  const snap = { machine: 'm', generated_at: '2026-11-21T10:06:00.000Z', sessions: [session], host: null, bottleneck: null, local: { turn_check: { s1: { via: 'shell' as const, edit: 'echo "<b>" > src/a.ts', after: ['make verify'] } } } }
  const config = parseConfig({ rules: [{ tree: '/code/shop', kind: 'check', text: 'just <ci>' }], muted: ['/code/old'], dismissed: { s9: 'x' } })

  it('shows the label and nothing to press when it is not the local server', () => {
    const html = renderPage(snap, Date.parse(snap.generated_at))
    expect(html).toContain('stopped without running a check')
    expect(html).not.toMatch(/<form|Why, and is it wrong/)
    // The only buttons a page without forms may hold are Copy buttons, hidden until its script shows them.
    expect(html.replace(/<button type="button" data-jqcopy hidden aria-label="Copy this command">Copy<\/button>/g, '')).not.toContain('<button')
    expect(html).not.toContain('make verify')
  })
  it('offers each correction, with the token, when it is', () => {
    const html = renderPage(snap, Date.parse(snap.generated_at), { token: 'tok123', config })
    expect(html).toContain('Why, and is it wrong?')
    expect(html).toContain('Count &quot;make verify&quot; as a check here')
    expect(html).toContain('&quot;echo&quot; does not edit code here')
    for (const label of ['Dismiss this one', 'Never label this tree', 'Remove', 'Label it again', 'Undo']) expect(html).toContain(`>${label}</button>`)
    expect(html.match(/name="token" value="tok123"/g)!.length).toBe(html.match(/<form /g)!.length)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain(COPY_SCRIPT_TAG)
  })
  it('escapes command text and rule text', () => {
    const html = renderPage(snap, Date.parse(snap.generated_at), { token: 't', config })
    expect(html).toContain('echo &quot;&lt;b&gt;&quot; &gt; src/a.ts')
    expect(html).toContain('just &lt;ci&gt;')
    expect(html).not.toContain('<b>"')
  })
})
