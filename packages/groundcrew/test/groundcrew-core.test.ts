/**
 * Tests for JQ Groundcrew's checks (groundcrew-core.ts) and page (groundcrew-page.ts). Groundcrew tells a developer whether their Claude Code
 * setup is safe and lean. A regression here either misses an exposed secrets file or a
 * blanket shell approval, or cries wolf on a sound setup. Both modules are pure, so this is a
 * plain static-import test.
 */
import { describe, expect, it, test } from 'vitest'
import { allowsEveryCommand, boardSummary, deniesSecrets, looksLikeACheck, runChecks, summarize, type SettingsFile, type SetupFacts } from '../src/groundcrew-core.js'
import { renderPage } from '../src/groundcrew-page.js'

const settings = (extra: Partial<SettingsFile> = {}): SettingsFile => ({
  scope: 'project',
  label: '.claude/settings.json',
  allow: [],
  ask: [],
  deny: [],
  defaultMode: null,
  additionalDirectories: 0,
  hookEvents: [],
  hookCommands: [],
  sandboxEnabled: null,
  cleanupPeriodDays: null,
  ...extra,
})

const facts = (extra: Partial<SetupFacts> = {}): SetupFacts => ({
  platform: 'darwin',
  memory: [{ label: 'CLAUDE.md', lines: 120, bytes: 6000 }],
  ruleFiles: 0,
  autoMemoryIndex: null,
  settings: [settings({ allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'], hookEvents: ['PostToolUse', 'Stop'], sandboxEnabled: true })],
  skills: { project: 2, user: 0 },
  subagents: { project: 0, user: 0 },
  subagentFiles: [],
  legacyCommands: 0,
  mcpServers: { project: 0, user: 0 },
  secretFiles: ['.env'],
  ...extra,
})

const status = (f: SetupFacts, id: string) => runChecks(f).find((c) => c.id === id)?.status

describe('rule readers', () => {
  test('a deny rule covers secrets only when it denies reading a secrets path', () => {
    expect(['Read(./.env)', 'Read(./secrets/**)', 'Read(~/.ssh/id_rsa)', 'Read(./config/credentials.json)'].map(deniesSecrets)).toEqual([true, true, true, true])
    expect(['Read(./src/**)', 'Bash(cat .env)', 'Edit(./.env)'].map(deniesSecrets)).toEqual([false, false, false])
  })
  test('a blanket shell approval is told from a scoped one', () => {
    expect(['Bash', 'Bash(*)', 'Bash(:*)', ' Bash() '].map(allowsEveryCommand)).toEqual([true, true, true, true])
    expect(['Bash(npm test:*)', 'Bash(git status)', 'Read(*)'].map(allowsEveryCommand)).toEqual([false, false, false])
  })
})

describe('a sound setup', () => {
  test('passes every check that can fail', () => {
    const summary = summarize(runChecks(facts()))
    expect([summary.fail, summary.warn, summary.score]).toEqual([0, 0, 100])
  })
})

describe('memory files', () => {
  test('are judged against the 200-line target in the docs', () => {
    expect(status(facts({ memory: [{ label: 'CLAUDE.md', lines: 200, bytes: 1 }] }), 'memory-length:CLAUDE.md')).toBe('pass')
    expect(status(facts({ memory: [{ label: 'CLAUDE.md', lines: 201, bytes: 1 }] }), 'memory-length:CLAUDE.md')).toBe('warn')
    expect(status(facts({ memory: [{ label: 'CLAUDE.md', lines: 452, bytes: 1 }] }), 'memory-length:CLAUDE.md')).toBe('fail')
  })
  test('each file gets its own check, and a project with none is told so', () => {
    const two = facts({ memory: [{ label: 'CLAUDE.md', lines: 10, bytes: 1 }, { label: '~/.claude/CLAUDE.md', lines: 500, bytes: 1 }] })
    expect([status(two, 'memory-length:CLAUDE.md'), status(two, 'memory-length:~/.claude/CLAUDE.md')]).toEqual(['pass', 'fail'])
    expect(status(facts({ memory: [] }), 'memory-exists')).toBe('warn')
  })
  test('an auto memory index past what loads is flagged', () => {
    expect(status(facts({ autoMemoryIndex: { label: 'MEMORY.md', lines: 90, bytes: 9000 } }), 'auto-memory-index')).toBe('pass')
    expect(status(facts({ autoMemoryIndex: { label: 'MEMORY.md', lines: 90, bytes: 30000 } }), 'auto-memory-index')).toBe('warn')
    expect(status(facts({ autoMemoryIndex: { label: 'MEMORY.md', lines: 240, bytes: 9000 } }), 'auto-memory-index')).toBe('warn')
  })
})

describe('guardrails', () => {
  test('an exposed secrets file with no deny rule is the one that fails', () => {
    const none = [settings()]
    expect(status(facts({ settings: none, secretFiles: ['.env', '.env.local'] }), 'deny-secrets')).toBe('fail')
    expect(status(facts({ settings: none, secretFiles: [] }), 'deny-secrets')).toBe('warn')
    expect(status(facts({ secretFiles: ['.env'] }), 'deny-secrets')).toBe('pass')
  })
  test('a deny rule in any settings file counts', () => {
    const split = [settings(), settings({ scope: 'user', label: '~/.claude/settings.json', deny: ['Read(./.env)'] })]
    expect(status(facts({ settings: split }), 'deny-secrets')).toBe('pass')
  })
  test('a blanket shell approval fails and names the file', () => {
    const check = runChecks(facts({ settings: [settings({ allow: ['Bash(*)'] })] })).find((c) => c.id === 'broad-allow')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('Bash(*) in .claude/settings.json')
  })
  test('the permission mode is graded', () => {
    const mode = (defaultMode: string | null) => status(facts({ settings: [settings({ defaultMode })] }), 'default-mode')
    expect([mode(null), mode('plan'), mode('acceptEdits'), mode('auto'), mode('dontAsk'), mode('bypassPermissions')]).toEqual(['pass', 'pass', 'pass', 'warn', 'warn', 'fail'])
  })
  test('the sandbox is asked for where it can run', () => {
    const off = [settings()]
    expect(status(facts({ settings: off }), 'sandbox')).toBe('warn')
    expect(status(facts({ settings: off, platform: 'win32' }), 'sandbox')).toBe('info')
    expect(status(facts(), 'sandbox')).toBe('pass')
  })
  test('retention falls back to the documented default', () => {
    const detail = (days: number | null) => runChecks(facts({ settings: [settings({ cleanupPeriodDays: days })] })).find((c) => c.id === 'retention')?.detail
    expect(detail(null)).toContain('30 days, the default')
    expect(detail(7)).toContain('7 days.')
  })
})

describe('suggested prompts', () => {
  const broken = facts({
    memory: [{ label: 'CLAUDE.md', lines: 452, bytes: 1 }],
    settings: [settings({ allow: ['Bash(*)'] })],
    secretFiles: ['apps/api/.env', '.env.local'],
  })
  const prompt = (id: string) => runChecks(broken).find((c) => c.id === id)?.prompt ?? ''

  test('a check that passes, or only states a fact, has none', () => {
    for (const check of runChecks(facts())) expect(check.prompt).toBe('')
  })
  test('every check that needs a fix has one, except the permission mode', () => {
    const wanting = runChecks(broken).filter((c) => c.status === 'fail' || c.status === 'warn')
    expect(wanting.map((c) => c.id).sort()).toEqual(['broad-allow', 'deny-secrets', 'hooks', 'memory-length:CLAUDE.md', 'sandbox', 'stop-check', 'verify-command'])
    for (const check of wanting) expect(check.prompt.length).toBeGreaterThan(0)
  })
  test('a prompt that edits a file asks to see the change first', () => {
    for (const id of ['memory-length:CLAUDE.md', 'hooks', 'deny-secrets', 'broad-allow', 'stop-check']) expect(prompt(id)).toMatch(/until I approve|before you save|before you edit/)
  })
  test('the secrets prompt names the files that were found', () => {
    expect(prompt('deny-secrets')).toContain('Read(./apps/api/.env), Read(./.env.local)')
  })
  test('the memory prompt carries the real line count and the target', () => {
    expect(prompt('memory-length:CLAUDE.md')).toContain('CLAUDE.md is 452 lines')
    expect(prompt('memory-length:CLAUDE.md')).toContain('under 200 lines')
  })
  test('a fix that is one command is given as the command', () => {
    expect(prompt('sandbox')).toBe('/sandbox')
    expect(runChecks(facts({ memory: [] })).find((c) => c.id === 'memory-exists')?.prompt).toBe('/init')
  })
})

describe('verification', () => {
  test('tells a command that checks a change from one that does not', () => {
    expect(['Bash(npm test:*)', 'Bash(npx tsc --noEmit)', 'pytest -q', 'npm run lint', 'cargo clippy', 'go vet ./...'].map(looksLikeACheck)).toEqual([true, true, true, true, true, true])
    expect(['Bash(git status)', 'Bash(ls:*)', 'prettier --write', 'echo latest'].map(looksLikeACheck)).toEqual([false, false, false, false])
  })
  test('the agent can run a check when an allow rule or a hook names one', () => {
    expect(status(facts(), 'verify-command')).toBe('pass')
    expect(status(facts({ settings: [settings({ allow: ['Bash(git status)'] })] }), 'verify-command')).toBe('warn')
    expect(status(facts({ settings: [settings({ hookCommands: [{ event: 'PostToolUse', command: 'npm run lint' }] })] }), 'verify-command')).toBe('pass')
    // An allow rule for another tool does not count, even if its path says "test".
    expect(status(facts({ settings: [settings({ allow: ['Read(./test/**)'] })] }), 'verify-command')).toBe('warn')
  })
  test('a hook on Stop or SubagentStop is what checks the work before the agent stops', () => {
    expect(status(facts(), 'stop-check')).toBe('pass')
    expect(status(facts({ settings: [settings({ hookEvents: ['PostToolUse'] })] }), 'stop-check')).toBe('warn')
    expect(status(facts({ settings: [settings({ hookEvents: ['SubagentStop'] })] }), 'stop-check')).toBe('pass')
  })
  test('a subagent with no tools line is named, and no subagent at all is a plain fact', () => {
    expect(status(facts(), 'subagent-scope')).toBe('info')
    const mixed = facts({ subagentFiles: [{ name: 'reviewer', limitsTools: true }, { name: 'helper', limitsTools: false }] })
    const check = runChecks(mixed).find((c) => c.id === 'subagent-scope')
    expect(check?.status).toBe('warn')
    expect(check?.detail).toContain('1 subagent set no tools line: helper')
    expect(check?.prompt).toContain('before you edit any of them')
    expect(status(facts({ subagentFiles: [{ name: 'reviewer', limitsTools: true }] }), 'subagent-scope')).toBe('pass')
  })
})

describe('the summary for the board', () => {
  const broken = facts({ memory: [{ label: 'CLAUDE.md', lines: 452, bytes: 1 }], settings: [settings({ allow: ['Bash(*)'] })], secretFiles: ['apps/api/.env'] })
  const sent = boardSummary(runChecks(broken))

  test('carries the counts and one row per check', () => {
    const summary = summarize(runChecks(broken))
    expect([sent.score, sent.pass, sent.warn, sent.fail]).toEqual([summary.score, summary.pass, summary.warn, summary.fail])
    expect(sent.checks).toHaveLength(runChecks(broken).length)
  })
  test('each row holds an id, a group, a title and a status, and nothing else', () => {
    for (const row of sent.checks) expect(Object.keys(row).sort()).toEqual(['group', 'id', 'status', 'title'])
  })
  test('sends no finding, fix, prompt, rule or secret path', () => {
    const wire = JSON.stringify(sent)
    for (const leak of ['apps/api/.env', 'Bash(*)', '452', 'Read(', 'until I approve', 'What to change']) expect(wire).not.toContain(leak)
  })
})

describe('summary', () => {
  test('does not count plain facts in the score', () => {
    const checks = runChecks(facts({ settings: [settings()], memory: [{ label: 'CLAUDE.md', lines: 452, bytes: 1 }] }))
    const summary = summarize(checks)
    expect(summary.pass + summary.warn + summary.fail + summary.info).toBe(checks.length)
    expect(summary.score).toBe(Math.round((summary.pass / (summary.pass + summary.warn + summary.fail)) * 100))
  })
  test('every check names a documentation page', () => {
    for (const check of runChecks(facts({ legacyCommands: 3, autoMemoryIndex: { label: 'MEMORY.md', lines: 1, bytes: 1 } }))) {
      expect(check.source).toMatch(/^https:\/\/code\.claude\.com\/docs\/en\/[a-z-]+\.md$/)
    }
  })
})

describe('the page', () => {
  const checks = runChecks(facts({ settings: [settings({ allow: ['Bash(echo "<b>hi</b>")'] })], secretFiles: ['<x>.env'] }))
  const html = renderPage({ project: '~/code/<shop>', generatedAt: 'now', filesRead: ['CLAUDE.md'], checks, summary: summarize(checks) })
  test('loads nothing, and its one script only copies', () => {
    expect(html).not.toMatch(/<link|<img|src=|fetch\(|XMLHttpRequest|sendBeacon|import\(/)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain('navigator.clipboard')
  })
  test('gives each check that needs a fix a prompt with a copy button, and no other check one', () => {
    const wanting = checks.filter((c) => c.status === 'fail' || c.status === 'warn')
    expect(wanting.length).toBeGreaterThan(0)
    expect(html.match(/<button type="button" data-copy="/g)).toHaveLength(wanting.length)
    for (const id of html.match(/data-copy="([^"]+)"/g) || []) expect(html).toContain(`<pre id="${id.slice(11, -1)}">`)
  })
  test('lists what needs a fix first, each linked to its card', () => {
    const first = html.indexOf('Do these first')
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(html.indexOf('<h2>Setup</h2>'))
    for (const href of html.slice(first, html.indexOf('<h2>Setup</h2>')).match(/href="#([^"]+)"/g) || []) expect(html).toContain(`id="${href.slice(7, -1)}"`)
  })
  test('escapes text that came from files', () => {
    expect(html).toContain('~/code/&lt;shop&gt;')
    expect(html).not.toContain('<shop>')
    expect(html).not.toContain('<x>.env')
    expect(html).toContain('Read(./&lt;x&gt;.env)')
  })
  test('gives every status a word beside its color', () => {
    for (const word of ['Fix', 'Look']) expect(html).toContain(`<span class="word">${word}</span>`)
    for (const word of ['Good', 'Fact']) expect(html).toContain(`<span class="mut"> · ${word}</span>`)
  })
})
