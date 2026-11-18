/**
 * JQ Groundcrew: the checks, as pure functions.
 *
 * Groundcrew is a local, read-only page that tells a developer how their Claude Code setup
 * looks: what loads into every session, what runs automatically, and which guardrails are on.
 * groundcrew-gather.ts reads the files and groundcrew-cli.ts serves the page. This file decides what the
 * page says. It reads nothing and imports nothing, so it is unit-tested with plain objects.
 *
 * Every check rests on a statement in Anthropic's Claude Code documentation, and carries the
 * link, so a reader can verify the advice. The facts were checked against the docs on
 * 2026-11-14. A check that is only our opinion says "our suggestion" in its text.
 *
 * Nothing here judges a transcript. The docs say the transcript format "is internal to Claude
 * Code and changes between versions", so session checks are a separate, later piece.
 */

export type Status = 'pass' | 'warn' | 'fail' | 'info'
export type Group = 'setup' | 'guardrails' | 'verification'

export interface MemoryFile {
  /** A label a person can read, such as "CLAUDE.md" or "~/.claude/CLAUDE.md". */
  label: string
  lines: number
  bytes: number
}

export interface SettingsFile {
  /** "user", "project", "local" or "managed". */
  scope: 'user' | 'project' | 'local' | 'managed'
  label: string
  allow: string[]
  ask: string[]
  deny: string[]
  defaultMode: string | null
  additionalDirectories: number
  /** Hook event names that have at least one handler. */
  hookEvents: string[]
  /** The command of each command hook, with the event it runs on. Used on this machine only. */
  hookCommands: Array<{ event: string; command: string }>
  sandboxEnabled: boolean | null
  cleanupPeriodDays: number | null
}

export interface SetupFacts {
  platform: string
  memory: MemoryFile[]
  /** Files under .claude/rules/ and ~/.claude/rules/. */
  ruleFiles: number
  /** The auto memory index, when the project has one. */
  autoMemoryIndex: MemoryFile | null
  settings: SettingsFile[]
  skills: { project: number; user: number }
  subagents: { project: number; user: number }
  /** Each subagent file, and whether its frontmatter limits its tools (`tools` or `disallowedTools`). */
  subagentFiles: Array<{ name: string; limitsTools: boolean }>
  /** .claude/commands/*.md, the older form that the docs merge into skills. */
  legacyCommands: number
  mcpServers: { project: number; user: number }
  /** Paths, from the project root, of files that usually hold secrets, such as "apps/api/.env". Names only, never contents. */
  secretFiles: string[]
}

export interface Check {
  id: string
  group: Group
  title: string
  status: Status
  /** What was found. */
  detail: string
  /** What to change. Empty for a pass or a plain fact. */
  fix: string
  /** The documentation page the check rests on. */
  source: string
  /**
   * Text to paste into Claude Code to make the fix: a prompt, or a slash command. Empty when
   * nothing needs fixing. A prompt always asks to see the change before it is saved.
   */
  prompt: string
}

const DOCS = 'https://code.claude.com/docs/en'
/** "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." */
export const MEMORY_LINE_TARGET = 200
/** Twice the target. Our own line for "this is far over", not the docs'. */
export const MEMORY_LINE_FAIL = 400

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const all = <T>(files: SettingsFile[], pick: (file: SettingsFile) => T[]): T[] => files.flatMap(pick)

/** A deny rule that keeps the agent from reading a secrets file. */
export function deniesSecrets(rule: string): boolean {
  return /^Read\(/.test(rule) && /\.env|secret|credential|\.pem|\.key\b|id_rsa/i.test(rule)
}

/** An allow rule that approves every shell command. */
export function allowsEveryCommand(rule: string): boolean {
  return /^Bash(\(\s*(\*|:\*|\*\*)?\s*\))?$/.test(rule.trim())
}

function memoryChecks(facts: SetupFacts): Unprompted[] {
  const source = `${DOCS}/memory.md`
  if (!facts.memory.length) {
    return [
      {
        id: 'memory-exists',
        group: 'setup',
        title: 'Project instructions',
        status: 'warn',
        detail: 'No CLAUDE.md or AGENTS.md was found for this project.',
        fix: 'Run /init to create one, then cut it down to the lines that prevent a mistake.',
        source,
      },
    ]
  }
  const checks: Unprompted[] = facts.memory.map((file) => {
    const status: Status = file.lines > MEMORY_LINE_FAIL ? 'fail' : file.lines > MEMORY_LINE_TARGET ? 'warn' : 'pass'
    return {
      id: `memory-length:${file.label}`,
      group: 'setup' as const,
      title: `${file.label} length`,
      status,
      detail:
        status === 'pass'
          ? `${plural(file.lines, 'line')}, under the ${MEMORY_LINE_TARGET}-line target.`
          : `${plural(file.lines, 'line')}. The docs say to target under ${MEMORY_LINE_TARGET} lines per file, because a longer file uses more context and is followed less well. Every session loads all of it.`,
      fix:
        status === 'pass'
          ? ''
          : `For each line, ask whether removing it would cause a mistake. Move what only some tasks need into a skill or into ${facts.ruleFiles ? 'the existing' : 'a'} .claude/rules/ file, and turn a rule that must happen every time into a hook.`,
      source,
    }
  })
  const index = facts.autoMemoryIndex
  if (index) {
    const over = index.lines > 200 || index.bytes > 25_000
    checks.push({
      id: 'auto-memory-index',
      group: 'setup',
      title: 'Auto memory index',
      status: over ? 'warn' : 'pass',
      detail: over
        ? `MEMORY.md is ${plural(index.lines, 'line')} and ${Math.round(index.bytes / 1000)} KB. Only the first 200 lines or 25 KB are loaded, so the rest is never read.`
        : `MEMORY.md is ${plural(index.lines, 'line')}, inside what is loaded.`,
      fix: over ? 'Shorten the index, or merge entries, so the ones that matter are in the part that loads.' : '',
      source,
    })
  }
  return checks
}

function automationChecks(facts: SetupFacts): Unprompted[] {
  const events = [...new Set(all(facts.settings, (f) => f.hookEvents))].sort()
  const allow = all(facts.settings, (f) => f.allow)
  const skills = facts.skills.project + facts.skills.user
  const checks: Unprompted[] = [
    {
      id: 'hooks',
      group: 'setup',
      title: 'Hooks',
      status: events.length ? 'pass' : 'warn',
      detail: events.length ? `Hooks run on: ${events.join(', ')}.` : 'No hook is configured, so nothing runs automatically.',
      fix: events.length ? '' : 'Our suggestion: a rule that must happen every time, such as formatting or a lint run after an edit, belongs in a hook. A line in CLAUDE.md is advice that can be skipped.',
      source: `${DOCS}/hooks.md`,
    },
    {
      id: 'allow-rules',
      group: 'setup',
      title: 'Pre-approved commands',
      status: allow.length ? 'pass' : 'warn',
      detail: allow.length ? `${plural(allow.length, 'allow rule')} across ${plural(facts.settings.filter((f) => f.allow.length).length, 'settings file')}.` : 'No allow rule is set, so every command asks for approval.',
      fix: allow.length ? '' : 'Use /permissions to allow the commands you trust, such as your test and lint commands.',
      source: `${DOCS}/permissions.md`,
    },
    {
      id: 'skills',
      group: 'setup',
      title: 'Skills',
      status: 'info',
      detail: skills
        ? `${plural(facts.skills.project, 'project skill')} and ${plural(facts.skills.user, 'user skill')}.`
        : 'No skill is defined. A skill holds knowledge that only some tasks need, so it stays out of every other session.',
      fix: '',
      source: `${DOCS}/skills.md`,
    },
  ]
  if (facts.legacyCommands) {
    checks.push({
      id: 'legacy-commands',
      group: 'setup',
      title: 'Custom commands',
      status: 'info',
      detail: `${plural(facts.legacyCommands, 'file')} in .claude/commands/. They still work. The docs merge commands into skills and prefer a skill for new work.`,
      fix: '',
      source: `${DOCS}/skills.md`,
    })
  }
  checks.push({
    id: 'subagents-and-mcp',
    group: 'setup',
    title: 'Subagents and connected tools',
    status: 'info',
    detail: `${plural(facts.subagents.project + facts.subagents.user, 'subagent')}. ${plural(facts.mcpServers.project, 'project MCP server')} and ${plural(facts.mcpServers.user, 'user MCP server')}.`,
    fix: '',
    source: `${DOCS}/mcp.md`,
  })
  return checks
}

function guardrailChecks(facts: SetupFacts): Unprompted[] {
  const files = facts.settings
  const deny = all(files, (f) => f.deny)
  const secretRules = deny.filter(deniesSecrets)
  const broad = all(files, (f) => f.allow.filter(allowsEveryCommand).map((rule) => `${rule} in ${f.label}`))
  const modes = files.filter((f) => f.defaultMode).map((f) => ({ mode: f.defaultMode as string, label: f.label }))
  const bypass = modes.find((m) => m.mode === 'bypassPermissions')
  const loose = modes.find((m) => m.mode === 'dontAsk' || m.mode === 'auto')
  const sandboxOn = files.some((f) => f.sandboxEnabled === true)
  const windows = facts.platform === 'win32'
  const reach = files.reduce((sum, f) => sum + f.additionalDirectories, 0)
  const retention = files.map((f) => f.cleanupPeriodDays).find((d) => d !== null) ?? null

  const checks: Unprompted[] = [
    {
      id: 'deny-secrets',
      group: 'guardrails',
      title: 'Secrets are off limits',
      status: secretRules.length ? 'pass' : facts.secretFiles.length ? 'fail' : 'warn',
      detail: secretRules.length
        ? `${plural(secretRules.length, 'deny rule')} cover secret files: ${secretRules.join(', ')}.`
        : facts.secretFiles.length
          ? `No deny rule covers secret files, and this project has ${facts.secretFiles.join(', ')}. The agent can read ${facts.secretFiles.length === 1 ? 'it' : 'them'}.`
          : 'No deny rule covers secret files. None was found in the project, so nothing is exposed today.',
      fix: secretRules.length
        ? ''
        : `Add deny rules to .claude/settings.json: ${
            facts.secretFiles.length ? facts.secretFiles.map((file) => `"Read(./${file})"`).join(', ') : '"Read(./.env)" and "Read(./secrets/**)", for example'
          }. A deny rule is checked before any allow rule.`,
      source: `${DOCS}/permissions.md`,
    },
    {
      id: 'broad-allow',
      group: 'guardrails',
      title: 'No blanket approval of shell commands',
      status: broad.length ? 'fail' : 'pass',
      detail: broad.length ? `These rules approve every shell command: ${broad.join('; ')}.` : 'No allow rule approves every shell command.',
      fix: broad.length ? 'Replace the blanket rule with rules for the commands you trust.' : '',
      source: `${DOCS}/permissions.md`,
    },
    {
      id: 'default-mode',
      group: 'guardrails',
      title: 'Permission mode',
      status: bypass ? 'fail' : loose ? 'warn' : 'pass',
      detail: bypass
        ? `${bypass.label} sets the default mode to bypassPermissions, so nothing asks for approval.`
        : loose
          ? `${loose.label} sets the default mode to ${loose.mode}, which approves actions without asking.`
          : modes.length
            ? `Default mode: ${modes.map((m) => `${m.mode} (${m.label})`).join(', ')}.`
            : 'No default mode is set, so the standard mode applies and actions ask for approval.',
      fix: bypass ? 'Use this mode only inside a container or a virtual machine that holds nothing you care about.' : loose ? 'Check that this is what you intend on a machine with real credentials.' : '',
      source: `${DOCS}/permissions.md`,
    },
    {
      id: 'sandbox',
      group: 'guardrails',
      title: 'Sandbox',
      status: sandboxOn ? 'pass' : windows ? 'info' : 'warn',
      detail: sandboxOn
        ? 'The sandbox is enabled, so commands run inside OS-level limits.'
        : windows
          ? 'The sandbox is off. It is not supported on native Windows.'
          : 'The sandbox is off, which is the default. Commands run with your full access to files and the network.',
      fix: sandboxOn || windows ? '' : 'Turn it on with /sandbox, or set "sandbox": { "enabled": true } in settings.',
      source: `${DOCS}/sandboxing.md`,
    },
    {
      id: 'reach',
      group: 'guardrails',
      title: 'Reach outside the project',
      status: 'info',
      detail: reach ? `${reach} additional ${reach === 1 ? 'directory' : 'directories'} outside the project can be reached.` : 'No additional directory is granted, so the agent works inside the project.',
      fix: '',
      source: `${DOCS}/permissions.md`,
    },
    {
      id: 'retention',
      group: 'guardrails',
      title: 'Session records',
      status: 'info',
      detail: `Session transcripts are kept for ${retention ?? 30} days${retention === null ? ', the default' : ''}. They are the record of what the agent did.`,
      fix: '',
      source: `${DOCS}/sessions.md`,
    },
  ]
  if (files.some((f) => f.scope === 'managed')) {
    checks.push({
      id: 'managed',
      group: 'guardrails',
      title: 'Managed settings',
      status: 'info',
      detail: 'A managed settings file is present. Its rules come first and a project cannot override them.',
      fix: '',
      source: `${DOCS}/managed-settings.md`,
    })
  }
  return checks
}

type Unprompted = Omit<Check, 'prompt'>

/** A command that tests, lints, type-checks or builds: something the agent can run to check a change. */
export function looksLikeACheck(command: string): boolean {
  return /\b(test|tests|jest|vitest|pytest|mocha|lint|eslint|ruff|tsc|typecheck|type-check|mypy|pyright|check|build|cargo (test|check|clippy)|go (test|vet))\b/i.test(command)
}

/**
 * Verification: who checks the agent's work. Guardrails limit what the agent may reach. These
 * ask a different question: when the agent says it is done, does anything but the developer
 * find out whether that is true?
 */
function verificationChecks(facts: SetupFacts): Unprompted[] {
  const files = facts.settings
  const allowed = all(files, (f) => f.allow.filter((rule) => /^Bash\(/.test(rule) && looksLikeACheck(rule)))
  const hooked = all(files, (f) => f.hookCommands.filter((h) => looksLikeACheck(h.command)))
  const stopEvents = [...new Set(all(files, (f) => f.hookEvents.filter((event) => event === 'Stop' || event === 'SubagentStop')))].sort()
  const unscoped = facts.subagentFiles.filter((agent) => !agent.limitsTools).map((agent) => agent.name)
  const checks: Unprompted[] = [
    {
      id: 'verify-command',
      group: 'verification',
      title: 'The agent can run your checks',
      status: allowed.length || hooked.length ? 'pass' : 'warn',
      detail:
        allowed.length || hooked.length
          ? `${plural(allowed.length, 'allow rule')} and ${plural(hooked.length, 'hook')} name a test, lint, type-check or build command.`
          : 'No allow rule and no hook names a test, lint, type-check or build command. Without a check it can run, the agent only has "looks done" to go on.',
      fix: allowed.length || hooked.length ? '' : 'Our suggestion: pre-approve the commands that check a change, so the agent can run them without asking each time.',
      source: `${DOCS}/permissions.md`,
    },
    {
      id: 'stop-check',
      group: 'verification',
      title: 'Something checks the work before the agent stops',
      status: stopEvents.length ? 'pass' : 'warn',
      detail: stopEvents.length
        ? `A hook runs on ${stopEvents.join(' and ')}. A Stop hook can send the agent back to keep working.`
        : 'No hook runs when the agent finishes. The agent decides on its own that it is done, and you find out whether it was.',
      fix: stopEvents.length
        ? ''
        : 'Our suggestion: a Stop hook that runs a fast check and exits with code 2 when it fails. The docs say that sends Claude back to keep working, and they cap consecutive continuations at eight, so it cannot loop forever.',
      source: `${DOCS}/hooks.md`,
    },
  ]
  if (facts.subagentFiles.length) {
    checks.push({
      id: 'subagent-scope',
      group: 'verification',
      title: 'Each subagent is limited to the tools its job needs',
      status: unscoped.length ? 'warn' : 'pass',
      detail: unscoped.length
        ? `${plural(unscoped.length, 'subagent')} set no tools line: ${unscoped.join(', ')}. The docs say a subagent then "inherits every tool available to subagents".`
        : `All ${plural(facts.subagentFiles.length, 'subagent')} limit their tools.`,
      fix: unscoped.length ? 'Add a tools line to the frontmatter that lists only what the subagent needs, or a disallowedTools line that removes what it must not use.' : '',
      source: `${DOCS}/sub-agents.md`,
    })
  } else {
    checks.push({
      id: 'subagent-scope',
      group: 'verification',
      title: 'Subagents',
      status: 'info',
      detail: 'No subagent is defined. A subagent with a narrow job, such as a reviewer that sees only the diff, checks work in a fresh context.',
      fix: '',
      source: `${DOCS}/sub-agents.md`,
    })
  }
  return checks
}

/**
 * The text to paste into Claude Code for a check that needs a fix. Each prompt names the goal,
 * the constraint from the docs, and asks for the plan or the diff first, so pasting one never
 * changes a file unseen.
 */
export function promptFor(check: Unprompted, facts: SetupFacts): string {
  if (check.status !== 'fail' && check.status !== 'warn') return ''
  const [id, label] = check.id.split(':')
  switch (id) {
    case 'memory-exists':
      return '/init'
    case 'memory-length': {
      const file = facts.memory.find((m) => m.label === label)
      return (
        `${label} is ${file?.lines ?? 'many'} lines. The Claude Code docs say to target under ${MEMORY_LINE_TARGET} lines per file, because a longer file uses more context and is followed less well. ` +
        'Read it and give me a plan before you edit anything. For each section, say one of: keep; delete, because the code or the README already says it; ' +
        'move to a skill, because only some tasks need it; move to a file under .claude/rules/; or turn into a hook, because it must happen every time. ' +
        'Give the line count the file would have after the plan. Change nothing until I approve it.'
      )
    }
    case 'auto-memory-index':
      return 'The auto memory index MEMORY.md is longer than what loads (the first 200 lines or 25 KB). Read it and propose which entries to merge, shorten or remove so that the ones that matter load. Show me the new index before you save it.'
    case 'hooks':
      return (
        'This project has no Claude Code hooks. Look at how it formats, lints and tests code. Propose at most two hooks for .claude/settings.json that run after an edit ' +
        '(the PostToolUse event, with the matcher "Edit|Write"), for example the formatter on the changed file. For each one, show me the JSON, the command it runs and how long that command takes. ' +
        'Do not change the settings file until I approve.'
      )
    case 'allow-rules':
      return '/permissions'
    case 'deny-secrets': {
      const rules = facts.secretFiles.length ? facts.secretFiles.map((file) => `Read(./${file})`).join(', ') : 'Read(./.env), Read(./secrets/**)'
      return (
        `Add deny rules to the permissions.deny array in .claude/settings.json so that Claude Code cannot read secret files: ${rules}. ` +
        'Keep every rule that is already in the file. Show me the diff before you save it, and tell me how to confirm afterwards that a read of one of these files is refused.'
      )
    }
    case 'broad-allow':
      return (
        'My Claude Code settings hold an allow rule that approves every shell command. Find it in the settings files, then list the shell commands this project really needs, ' +
        'such as its test, lint and build commands. Propose scoped allow rules for those to replace the blanket rule. Show me the diff before you save it.'
      )
    case 'sandbox':
      return '/sandbox'
    case 'verify-command':
      return '/permissions'
    case 'stop-check':
      return (
        'Nothing checks your work before you stop. Look at how this project tests and lints, and find the fastest check that catches a broken change, such as the type check. ' +
        'Propose a Stop hook for .claude/settings.json that runs it and exits with code 2 when it fails, so that you are sent back to keep working. ' +
        'Show me the JSON, the command and how long the command takes. Do not change the settings file until I approve.'
      )
    case 'subagent-scope':
      return (
        'Some of my subagents inherit every tool. For each subagent file under .claude/agents/, read what it is for and propose a tools line in its frontmatter that lists only the tools that job needs. ' +
        'Show me the proposed line for each file before you edit any of them.'
      )
    default:
      return ''
  }
}

export function runChecks(facts: SetupFacts): Check[] {
  const checks: Unprompted[] = [...memoryChecks(facts), ...automationChecks(facts), ...guardrailChecks(facts), ...verificationChecks(facts)]
  return checks.map((check) => ({ ...check, prompt: promptFor(check, facts) }))
}

export interface Summary {
  pass: number
  warn: number
  fail: number
  info: number
  /** Passes as a share of the checks that can pass or fail, 0 to 100. Plain facts are not counted. */
  score: number
}

export function summarize(checks: Check[]): Summary {
  const count = (status: Status) => checks.filter((c) => c.status === status).length
  const [pass, warn, fail, info] = [count('pass'), count('warn'), count('fail'), count('info')]
  const judged = pass + warn + fail
  return { pass, warn, fail, info, score: judged ? Math.round((pass / judged) * 100) : 0 }
}

/** The levels --fail-on takes. "warn" also counts a fail; an info row never counts. */
export type FailOn = 'fail' | 'warn'
export const FAIL_ON_LEVELS: readonly FailOn[] = ['fail', 'warn']

/** The checks at the given level or worse. Empty means a CI step should pass. */
export function failing(checks: Check[], level: FailOn): Check[] {
  return checks.filter((c) => c.status === 'fail' || (level === 'warn' && c.status === 'warn'))
}

export interface BoardCheck {
  id: string
  group: Group
  title: string
  status: Status
}
export interface BoardSummary {
  score: number
  pass: number
  warn: number
  fail: number
  checks: BoardCheck[]
}

/**
 * A summary that is safe to send to a team board, if you build one: the score, the counts, and each check's
 * id, group, title and status. It is built field by field, so a field added to Check later is
 * not sent by accident. What was found, the fix and the prompt name the developer's files, and
 * they are never part of this.
 */
export function boardSummary(checks: Check[]): BoardSummary {
  const { score, pass, warn, fail } = summarize(checks)
  return { score, pass, warn, fail, checks: checks.map((c) => ({ id: c.id, group: c.group, title: c.title, status: c.status })) }
}
