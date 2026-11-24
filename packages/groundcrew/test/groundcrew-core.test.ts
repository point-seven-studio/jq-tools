/**
 * Tests for JQ Groundcrew's checks (groundcrew-core.ts) and page (groundcrew-page.ts). Groundcrew tells a developer whether their Claude Code
 * setup is safe and lean. A regression here either misses an exposed secrets file or a
 * blanket shell approval, or cries wolf on a sound setup. Both modules are pure, so this is a
 * plain static-import test.
 */
import { describe, expect, it, test } from 'vitest'
import { commandStart, findRestrictedCommands, proseFindings, ruleCovers } from '../src/groundcrew-core.js'
import { findUnattendedRuns, OWASP_LLM_2025, owaspLabel, packageOf, RISK_NOTE, RISK_OF, risksOf } from '../src/groundcrew-core.js'
import { allowsEveryCommand, allowsNetwork, boardSummary, deniesSecrets, LAYER_OF, LAYERS, layerSummary, looksLikeACheck, runChecks, summarize, type SettingsFile, type SetupFacts } from '../src/groundcrew-core.js'
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
  test('a rule that approves a network command, or a fetch of any address, is found', () => {
    for (const rule of ['Bash(curl *)', 'Bash(curl:*)', 'Bash(curl -s https://example.com/ *)', 'Bash(/usr/bin/wget *)', 'Bash(nc *)', 'Bash(scp:*)', 'WebFetch', 'WebFetch(domain:*)']) expect(allowsNetwork(rule), rule).not.toBeNull()
    for (const rule of ['WebFetch(domain:docs.example.com)', 'WebFetch(domain:*.example.com)', 'Bash(npm test *)', 'Bash(curlew *)', 'Bash(curl -s "https://example.com/health")', 'Bash(git push *)', 'Bash', 'Read(./curl)', 'WebSearch']) expect(allowsNetwork(rule), rule).toBeNull()
  })
  test('network commands that are approved in advance warn, name the file, and carry both tags', () => {
    const open = runChecks(facts({ settings: [settings({ allow: ['Bash(curl *)', 'WebFetch(domain:docs.example.com)'] })] })).find((c) => c.id === 'network-ask')!
    expect(open.status).toBe('warn')
    expect(open.detail).toContain('Bash(curl *) in .claude/settings.json')
    expect(open.detail).not.toContain('docs.example.com')
    expect(open.prompt).toMatch(/before you save/)
    expect(open.risks).toEqual(['LLM01:2025 Prompt Injection', 'LLM06:2025 Excessive Agency'])
    expect(open.layer).toBe('permissions')
    const many = runChecks(facts({ settings: [settings({ allow: Array.from({ length: 8 }, (_, i) => `Bash(curl https://example.com/${i}/*)`) })] })).find((c) => c.id === 'network-ask')!
    expect(many.detail).toContain('and 3 more')
    const shut = runChecks(facts()).find((c) => c.id === 'network-ask')!
    expect([shut.status, shut.fix, shut.prompt]).toEqual(['pass', '', ''])
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

describe('rules written in the instructions', () => {
  const found = (text: string) => findRestrictedCommands(text, 'CLAUDE.md').map((r) => `${r.kind}:${r.command}@${r.line}`)
  test('reads the start of a command and nothing that is not one', () => {
    expect(['git push origin main', 'gh pr merge <#> --squash', 'git reset --hard origin/main', '$ rm -rf build/', 'npm run check'].map(commandStart)).toEqual([
      'git push origin',
      'gh pr merge',
      'git reset --hard',
      'rm -rf',
      'npm run check',
    ])
    expect(['main', 'CLAUDE.md', '--unsafe-fixes', 'print', 'apps/backend'].map(commandStart)).toEqual(['', '', '', '', ''])
  })
  test('finds a forbidden command after the forbidding words, in the same sentence', () => {
    expect(found('All tasks run through `npx nx`. Never call `uv run` or `tsc`/`eslint` directly.')).toEqual(['never:uv run@1', 'never:tsc@1', 'never:eslint@1'])
    expect(found('Use `npm run check` before a PR.')).toEqual([])
    expect(found('Never push to `main` directly.')).toEqual([])
  })
  test('finds a command named without code marks', () => {
    expect(found('Do not git push without asking.')).toEqual(['ask:git push@1'])
    expect(found('- never rm -rf anything outside the project')).toEqual(['never:rm -rf@1'])
  })
  test('a list under a heading that restricts takes the kind of the heading', () => {
    const text = ['## Ask first, every time', '', '- **Any `git push`**, on any branch.', '- **Opening a PR**: `gh pr create` or a merge.', '', '## Tooling', '', '- `git status` is fine.'].join('\n')
    expect(found(text)).toEqual(['ask:git push@3', 'ask:gh pr create@4'])
  })
  test('a paragraph under such a heading is not taken, because it names what to use instead', () => {
    const text = ['## Never push to main directly', '', 'Open a pull request, then `gh pr merge --squash` lands it.', '', '- `git push origin main`'].join('\n')
    expect(found(text)).toEqual(['never:git push origin@5'])
  })
  test('joins a wrapped list item, and skips fenced code', () => {
    const text = ['- Before any destructive reset, stash first. Never run', '  `git reset --hard` with uncommitted work.', '', '```bash', 'git push origin main  # never do this', '```'].join('\n')
    expect(found(text)).toEqual(['never:git reset --hard@1'])
  })
  test('lists a command once, at its first line', () => {
    expect(found('Never `git push`.\n\nReally, never `git push`.')).toEqual(['never:git push@1'])
  })
  test('a rule covers a command by prefix, in both documented spellings', () => {
    const rules = ['Bash(git push *)', 'Bash(git push:*)', 'Bash(git push)', 'Bash(git *)', 'Bash', 'Bash(*)', 'Bash(git push --force *)']
    expect(rules.map((r) => ruleCovers(r, 'git push'))).toEqual([true, true, true, true, true, true, false])
    expect(['Bash(git pull *)', 'Read(git push)', 'Bash(gitx *)'].map((r) => ruleCovers(r, 'git push'))).toEqual([false, false, false])
    expect(ruleCovers('Bash(ls *)', 'lsof')).toBe(false)
  })

  const restricted = [
    { file: 'CLAUDE.md', line: 4, kind: 'ask' as const, command: 'git push' },
    { file: 'CLAUDE.md', line: 9, kind: 'never' as const, command: 'rm -rf' },
  ]
  const states = (s: Partial<SettingsFile>) => proseFindings(facts({ restricted, settings: [settings(s)] })).map((f) => f.state)
  test('an ask line is held by the default prompt; a never line needs a deny rule', () => {
    expect(states({})).toEqual(['prompt', 'open'])
    expect(states({ ask: ['Bash(git push *)'], deny: ['Bash(rm -rf *)'] })).toEqual(['enforced', 'enforced'])
    expect(states({ ask: ['Bash(rm -rf *)'] })).toEqual(['prompt', 'open']) // asking is not never
  })
  test('an allow rule or a no-prompt mode contradicts the instructions', () => {
    expect(states({ allow: ['Bash(git:*)'] })).toEqual(['allowed', 'open'])
    expect(states({ defaultMode: 'bypassPermissions' })).toEqual(['allowed', 'allowed'])
    expect(states({ allow: ['Bash(git:*)'], deny: ['Bash(git push *)'] })).toEqual(['enforced', 'open']) // deny is checked first
  })
  const only = (s: Partial<SettingsFile>, r = restricted) => runChecks(facts({ restricted: r, settings: [settings(s)] })).find((c) => c.id === 'prose-rules')!
  test('the check says look, names the lines, and gives a prompt that asks to confirm them', () => {
    const check = only({ allow: ['Bash(git:*)'] })
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('"git push" (ask first, CLAUDE.md line 4)')
    expect(check.detail).toContain('"rm -rf" (never, CLAUDE.md line 9)')
    expect(check.prompt).toContain('tell me if it really restricts that command')
    expect(check.prompt).toContain('Show me the diff before you save it')
  })
  test('passes when every restricted command is enforced or only waits on the default prompt', () => {
    expect(only({ deny: ['Bash(rm -rf *)'] }).status).toBe('pass')
    expect(only({ deny: ['Bash(rm -rf *)'] }).prompt).toBe('')
    expect(only({}, []).status).toBe('info')
  })
  test('sends none of what it found to a team board', () => {
    expect(JSON.stringify(boardSummary(runChecks(facts({ restricted, settings: [settings({})] }))))).not.toContain('git push')
  })
})

describe('harness layers', () => {
  const empty = facts({ memory: [], settings: [], subagentFiles: [], secretFiles: ['.env'] })
  const full = facts({ legacyCommands: 3, autoMemoryIndex: { label: 'MEMORY.md', lines: 1, bytes: 1 }, subagentFiles: [{ name: 'reviewer', limitsTools: false }] })
  test('every check has a layer', () => {
    for (const f of [facts(), empty, full]) {
      for (const check of runChecks(f)) {
        expect(Object.keys(LAYER_OF)).toContain(check.id.split(':')[0])
        expect(check.layer).toBe(LAYER_OF[check.id.split(':')[0]])
      }
    }
  })
  test('gives one row per layer, in order, and counts every check once', () => {
    const checks = runChecks(full)
    const rows = layerSummary(checks)
    expect(rows.map((r) => r.layer)).toEqual(LAYERS.map((l) => l.key))
    expect(rows.reduce((n, r) => n + r.pass + r.warn + r.fail + r.info, 0)).toBe(checks.length)
  })
  test('a layer takes the worst status of its checks', () => {
    const rows = layerSummary(runChecks(empty))
    const state = (layer: string) => rows.find((r) => r.layer === layer)?.state
    expect(state('permissions')).toBe('fix') // a secrets file with no deny rule
    expect(state('loop')).toBe('look') // no Stop hook
    expect(state('observability')).toBe('facts') // session records is a plain fact
  })
  test('a layer with no check says so and is not counted as good', () => {
    const rows = layerSummary(runChecks(facts()).filter((c) => c.layer !== 'memory'))
    expect(rows.find((r) => r.layer === 'memory')).toMatchObject({ pass: 0, warn: 0, fail: 0, info: 0, state: 'none' })
  })
  test('the page shows all six, and what is not checked in each', () => {
    const checks = runChecks(empty)
    const html = renderPage({ project: 'p', generatedAt: 'now', filesRead: [], checks, summary: summarize(checks) })
    expect(html).toContain('Your harness, layer by layer')
    for (const layer of LAYERS) {
      expect(html).toContain(`<b>${layer.title}<span class="mut">`)
      expect(html).toContain(layer.unchecked)
    }
    expect(html.indexOf('Your harness, layer by layer')).toBeLessThan(html.indexOf('<h2>Setup</h2>'))
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

describe('OWASP tags', () => {
  test('every tag is one of the ten entries, under a check that exists', () => {
    const known = Object.keys(LAYER_OF)
    for (const [id, tags] of Object.entries(RISK_OF)) {
      expect(known).toContain(id)
      for (const tag of tags) expect(Object.keys(OWASP_LLM_2025)).toContain(tag)
    }
    expect(Object.keys(OWASP_LLM_2025)).toHaveLength(10)
    expect(owaspLabel('LLM06')).toBe('LLM06:2025 Excessive Agency')
    expect(owaspLabel('LLM10')).toBe('LLM10:2025 Unbounded Consumption')
    expect(owaspLabel('LLM03')).toBe('LLM03:2025 Supply Chain')
  })
  test('a check carries its tags, and a check with no plain link carries none', () => {
    const checks = runChecks(facts({ unattendedRuns: [], mcpPackages: [{ name: 'x', scope: 'project', spec: 'x-mcp', pinned: false }] }))
    expect(checks.find((c) => c.id === 'deny-secrets')!.risks).toEqual(['LLM02:2025 Sensitive Information Disclosure'])
    expect(checks.find((c) => c.id === 'mcp-pinned')!.risks).toEqual(['LLM03:2025 Supply Chain'])
    expect(checks.find((c) => c.id === 'run-limits')!.risks).toEqual(['LLM10:2025 Unbounded Consumption'])
    expect(checks.find((c) => c.id === 'stop-check')!.risks).toEqual([])
    expect(risksOf('memory-length:CLAUDE.md')).toEqual([])
    expect(RISK_NOTE).toContain('does not mean the project is protected')
  })
})

describe('packageOf', () => {
  test('finds the package a runner fetches, and whether it names one exact version', () => {
    expect(packageOf('npx', ['-y', '@example/mcp-server'])).toEqual({ spec: '@example/mcp-server', pinned: false })
    expect(packageOf('npx', ['-y', '@example/mcp-server@1.4.2'])).toEqual({ spec: '@example/mcp-server@1.4.2', pinned: true })
    expect(packageOf('npx', ['some-mcp@latest', '--port', '1'])).toEqual({ spec: 'some-mcp@latest', pinned: false })
    expect(packageOf('npx', ['some-mcp@^1.2.0'])).toEqual({ spec: 'some-mcp@^1.2.0', pinned: false })
    expect(packageOf('npx', ['some-mcp@1.2.3-beta.1'])).toEqual({ spec: 'some-mcp@1.2.3-beta.1', pinned: true })
    expect(packageOf('/usr/local/bin/npx', ['--yes', '--package', 'tool@2.0.0', 'tool-bin'])).toEqual({ spec: 'tool@2.0.0', pinned: true })
    expect(packageOf('npx', ['--package=tool', 'tool-bin'])).toEqual({ spec: 'tool', pinned: false })
    expect(packageOf('pnpm', ['dlx', 'some-mcp'])).toEqual({ spec: 'some-mcp', pinned: false })
    expect(packageOf('bunx', ['some-mcp@3.0.1'])).toEqual({ spec: 'some-mcp@3.0.1', pinned: true })
    expect(packageOf('uvx', ['mcp-server-git'])).toEqual({ spec: 'mcp-server-git', pinned: false })
    expect(packageOf('uvx', ['mcp-server-git==2025.1.14'])).toEqual({ spec: 'mcp-server-git==2025.1.14', pinned: true })
    expect(packageOf('uvx', ['--from', 'mcp-server-git@0.6.2', 'mcp-server-git'])).toEqual({ spec: 'mcp-server-git@0.6.2', pinned: true })
    expect(packageOf('pipx', ['run', 'some-tool'])).toEqual({ spec: 'some-tool', pinned: false })
  })
  test('says nothing of a server that is not fetched from a registry', () => {
    expect(packageOf('node', ['./server.js'])).toBeNull()
    expect(packageOf('npx', ['./local-server'])).toBeNull()
    expect(packageOf('npx', ['-y', 'github:acme/tools'])).toBeNull()
    expect(packageOf('uvx', ['--from', 'git+https://example.com/x.git', 'x'])).toBeNull()
    expect(packageOf('docker', ['run', 'acme/server'])).toBeNull()
    expect(packageOf('pnpm', ['install'])).toBeNull()
    expect(packageOf('npx', ['-y'])).toBeNull()
  })
  test('warns about a server with no exact version, and names no argument but the package', () => {
    const checks = runChecks(facts({ mcpPackages: [{ name: 'files', scope: 'project', spec: 'files-mcp', pinned: false }, { name: 'git', scope: 'user', spec: 'git-mcp@1.0.0', pinned: true }] }))
    const check = checks.find((c) => c.id === 'mcp-pinned')!
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('1 MCP server of 2 fetched by a package runner names no exact version: files (files-mcp, project).')
    expect(check.fix).toContain('The docs do not ask for this.')
    expect(check.prompt).toContain('files (files-mcp, project scope)')
    expect(check.prompt).toContain('do not print any environment value')
    expect(check.layer).toBe('permissions')
    expect(runChecks(facts({ mcpPackages: [{ name: 'git', scope: 'user', spec: 'git-mcp@1.0.0', pinned: true }] })).find((c) => c.id === 'mcp-pinned')!.status).toBe('pass')
    expect(runChecks(facts({ mcpPackages: [] })).find((c) => c.id === 'mcp-pinned')).toBeUndefined()
    expect(runChecks(facts()).find((c) => c.id === 'mcp-pinned')).toBeUndefined()
  })
})

describe('findUnattendedRuns', () => {
  test('finds claude -p in a script, reading a continued command as one line', () => {
    const text = ['#!/bin/sh', '# claude -p "a comment is not a run"', 'claude -p "summarise the diff"', 'claude --print --max-turns 5 "x"', 'cat notes | claude -p \\', '  --max-budget-usd 2 \\', '  "review"', 'claude --version', 'echo "claude is here"', 'npm run claude-plugin -p 3'].join('\n')
    expect(findUnattendedRuns('scripts/review.sh', text)).toEqual([
      { file: 'scripts/review.sh', line: 3, kind: 'cli', limited: false },
      { file: 'scripts/review.sh', line: 4, kind: 'cli', limited: true },
      { file: 'scripts/review.sh', line: 5, kind: 'cli', limited: true },
    ])
  })
  test('finds a package script, and the GitHub action with its limit in claude_args', () => {
    expect(findUnattendedRuns('package.json', '{\n  "scripts": {\n    "triage": "claude -p \\"triage\\" --max-turns 3",\n    "notes": "claude -p notes"\n  }\n}')).toEqual([
      { file: 'package.json', line: 3, kind: 'cli', limited: true },
      { file: 'package.json', line: 4, kind: 'cli', limited: false },
    ])
    const workflow = ['jobs:', '  a:', '    steps:', '      - uses: actions/checkout@v4', '      - uses: anthropics/claude-code-action@v1', '        with:', '          prompt: "review"', '          claude_args: "--max-turns 5"', '      - uses: anthropics/claude-code-action@v1', '        with:', '          prompt: "no limit here"', '      - name: later', '        run: echo --max-turns 9'].join('\n')
    expect(findUnattendedRuns('.github/workflows/review.yml', workflow)).toEqual([
      { file: '.github/workflows/review.yml', line: 5, kind: 'action', limited: true },
      { file: '.github/workflows/review.yml', line: 9, kind: 'action', limited: false },
    ])
  })
  test('warns about a run with no limit, passes when all have one, and only states a fact when there is none', () => {
    const open = runChecks(facts({ unattendedRuns: [{ file: 'a.sh', line: 3, kind: 'cli', limited: false }, { file: 'b.yml', line: 9, kind: 'action', limited: true }] })).find((c) => c.id === 'run-limits')!
    expect(open.status).toBe('warn')
    expect(open.detail).toContain('1 of 2 runs with no person present sets no turn or spending limit: a.sh:3.')
    expect(open.detail).toContain('"No limit by default."')
    expect(open.layer).toBe('loop')
    expect(open.prompt).toContain('a.sh:3')
    expect(open.prompt).toContain('before you edit anything')
    expect(runChecks(facts({ unattendedRuns: [{ file: 'b.yml', line: 9, kind: 'action', limited: true }] })).find((c) => c.id === 'run-limits')!.status).toBe('pass')
    const none = runChecks(facts({ unattendedRuns: [] })).find((c) => c.id === 'run-limits')!
    expect(none.status).toBe('info')
    expect(none.prompt).toBe('')
    expect(runChecks(facts()).find((c) => c.id === 'run-limits')).toBeUndefined()
  })
})

describe('the auto memory folder', () => {
  const index = '- [Deploys](deploys.md) — how\n- [Old](./gone.md) — removed\n- [Docs](https://example.com/a.md)\n- [Deep](sub/x.md)\n'
  it('counts notes the index does not link to, and links to notes that are gone', async () => {
    const { memoryFolder } = await import('../src/groundcrew-core.js')
    expect(memoryFolder(index, ['MEMORY.md', 'deploys.md', 'stray.md', 'notes.txt'])).toEqual({ files: 2, unlisted: 1, missing: 1 })
    expect(memoryFolder(null, ['a.md', 'b.md'])).toEqual({ files: 2, unlisted: 2, missing: 0 })
    expect(memoryFolder('- [A](a.md#part)', ['a.md'])).toEqual({ files: 1, unlisted: 0, missing: 0 })
  })
  it('warns about notes with no index, and about notes or links that do not line up', () => {
    const idx = { label: 'MEMORY.md', lines: 3, bytes: 90 }
    expect(status(facts({ autoMemoryFolder: { files: 4, unlisted: 4, missing: 0 } }), 'auto-memory-folder')).toBe('warn')
    expect(status(facts({ autoMemoryIndex: idx, autoMemoryFolder: { files: 4, unlisted: 1, missing: 0 } }), 'auto-memory-folder')).toBe('warn')
    expect(status(facts({ autoMemoryIndex: idx, autoMemoryFolder: { files: 4, unlisted: 0, missing: 2 } }), 'auto-memory-folder')).toBe('warn')
    expect(status(facts({ autoMemoryIndex: idx, autoMemoryFolder: { files: 4, unlisted: 0, missing: 0 } }), 'auto-memory-folder')).toBe('pass')
  })
  it('says nothing when there is no folder, an empty one, or a caller that did not look', () => {
    expect(runChecks(facts({})).some((c) => c.id === 'auto-memory-folder')).toBe(false)
    expect(runChecks(facts({ autoMemoryFolder: { files: 0, unlisted: 0, missing: 0 } })).some((c) => c.id === 'auto-memory-folder')).toBe(false)
  })
  it('names no file', () => {
    const text = JSON.stringify(runChecks(facts({ autoMemoryIndex: { label: 'MEMORY.md', lines: 3, bytes: 90 }, autoMemoryFolder: { files: 4, unlisted: 1, missing: 1 } })).filter((c) => c.id === 'auto-memory-folder'))
    expect(text).toContain('1 note of 4 is not linked')
    expect(text).toContain('1 link in MEMORY.md points to a note that is not there')
  })
})

describe('comparing with an earlier report (--since)', () => {
  const check = (id: string, status: 'pass' | 'warn' | 'fail' | 'info') => ({ id, title: `Title of ${id}`, status })
  const before = { generatedAt: '11/20/2026, 9:00:00 AM', summary: { score: 50 }, checks: [check('a', 'pass'), check('b', 'warn'), check('c', 'fail'), check('d', 'pass'), check('e', 'info'), check('gone', 'pass')] }
  const after = [check('a', 'fail'), check('b', 'pass'), check('c', 'warn'), check('d', 'pass'), check('e', 'warn'), check('new', 'fail')] as any

  it('reads a --json report, and a board summary', async () => {
    const { parseBaseline } = await import('../src/groundcrew-core.js')
    expect(parseBaseline(JSON.stringify(before))).toMatchObject({ readBefore: '11/20/2026, 9:00:00 AM', score: 50 })
    expect(parseBaseline(JSON.stringify({ score: 80, checks: [check('a', 'pass')] }))).toMatchObject({ readBefore: '', score: 80 })
  })
  it('works out the score when the earlier report does not carry one', async () => {
    const { parseBaseline } = await import('../src/groundcrew-core.js')
    expect(parseBaseline(JSON.stringify({ checks: [check('a', 'pass'), check('b', 'fail')] })).score).toBe(50)
  })
  it('says what to do about a file that is not a report', async () => {
    const { parseBaseline } = await import('../src/groundcrew-core.js')
    expect(() => parseBaseline('<html>')).toThrow('is not JSON')
    expect(() => parseBaseline('{"a":1}')).toThrow('no list of checks')
    expect(() => parseBaseline('{"checks":[{"id":"a","status":"splendid"}]}')).toThrow('no check this version can read')
  })
  it('sorts each check into worse, better, changed, new, gone or the same', async () => {
    const { compareChecks, parseBaseline } = await import('../src/groundcrew-core.js')
    const c = compareChecks(parseBaseline(JSON.stringify(before)), after)
    expect(c.worse.map((x) => x.id)).toEqual(['a'])
    expect(c.better.map((x) => x.id)).toEqual(['b', 'c'])
    expect(c.other.map((x) => x.id)).toEqual(['e'])
    expect(c.added).toEqual([{ id: 'new', title: 'Title of new', before: null, after: 'fail' }])
    expect(c.removed).toEqual([{ id: 'gone', title: 'Title of gone', before: 'pass', after: null }])
    expect(c.same).toBe(1)
    expect(c.scoreBefore).toBe(50)
    expect(c.scoreAfter).toBe(summarize(after).score)
  })
  it('sums it up in one line', async () => {
    const { compareChecks, comparisonLine, parseBaseline } = await import('../src/groundcrew-core.js')
    const c = compareChecks(parseBaseline(JSON.stringify(before)), after)
    expect(comparisonLine(c)).toBe(`score 50 to ${c.scoreAfter}; 2 better, 1 worse, 1 the same, 1 new, 1 gone`)
  })
  it('shows the section on the page only when asked, and says what it cannot show', async () => {
    const { compareChecks, parseBaseline } = await import('../src/groundcrew-core.js')
    const checks = runChecks(facts({}))
    const base = { project: '~/p', generatedAt: 'now', filesRead: [], checks, summary: summarize(checks) }
    expect(renderPage(base)).not.toContain('Since the earlier report')
    const same = renderPage({ ...base, since: compareChecks(parseBaseline(JSON.stringify({ checks })), checks) })
    expect(same).toContain('Since the earlier report')
    expect(same).toContain('No check changed.')
    expect(same).toContain('It does not show whether sessions now go better.')
    const moved = renderPage({ ...base, since: compareChecks(parseBaseline(JSON.stringify(before)), after) })
    expect(moved).toContain('<h3>Worse</h3>')
    expect(moved).toContain('Title of a')
  })
})
