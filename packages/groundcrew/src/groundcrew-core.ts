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
/**
 * The part of an agent's harness a check is about. A harness is everything around the model:
 * what steers it before it works (guides), what checks it afterwards (sensors), what sends it
 * back to try again (loop), what it remembers between sessions (memory), what it may do
 * (permissions), and what a person can see of it (observability).
 */
export type Layer = 'guides' | 'sensors' | 'loop' | 'memory' | 'permissions' | 'observability'

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
  /** Commands the instruction files say never to run, or to ask about first. Absent when a caller did not look. */
  restricted?: RestrictedCommand[]
  /**
   * MCP servers that are fetched by a package runner each time they start. Only the server's
   * name and the package it names: no other argument and no environment value is kept, because
   * those can hold a key. Absent when a caller did not look.
   */
  mcpPackages?: McpPackage[]
  /**
   * Places a run with no person present is started: `claude -p` in a workflow, a package
   * script or a shell script, or the GitHub action. File and line only. Absent when a caller
   * did not look.
   */
  unattendedRuns?: UnattendedRun[]
}

export interface UnattendedRun {
  /** Path from the project root. */
  file: string
  line: number
  kind: 'cli' | 'action'
  /** True when the run sets --max-turns or --max-budget-usd. */
  limited: boolean
}

export interface McpPackage {
  name: string
  scope: 'project' | 'user'
  /** The package as written, such as "some-mcp", "some-mcp@latest" or "@acme/tools@1.4.2". */
  spec: string
  /** True when `spec` names one exact version. */
  pinned: boolean
}

export interface RestrictedCommand {
  /** The instruction file, as a label a person can read. */
  file: string
  line: number
  /** "never": the text forbids the command. "ask": the text says to ask a person first. */
  kind: 'never' | 'ask'
  /** The start of the command as written, such as "git push" or "rm -rf". */
  command: string
}

export interface Check {
  id: string
  group: Group
  /** Which layer of the harness the check is about. Set by runChecks from LAYER_OF. */
  layer: Layer
  /**
   * Entries on the OWASP Top 10 for LLM Applications 2025 that the check bears on, written as
   * OWASP writes them, such as "LLM06:2025 Excessive Agency". Empty for most checks. Set by
   * runChecks from RISK_OF. A pass is not protection from the risk: see RISK_NOTE. Optional so
   * a Check built by a caller, or read from an older report, still fits.
   */
  risks?: string[]
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

/**
 * Programs whose name at the start of a code span marks the span as a command. A span such as
 * `main` or `CLAUDE.md` is not one, and without this list "never push to `main`" would be read
 * as a rule about a command called main.
 */
const COMMAND_HEADS = new Set(
  (
    'git gh npm npx pnpm yarn bun node deno python python3 pip pip3 uv poetry cargo go make docker kubectl helm terraform aws gcloud az ' +
    'psql mysql sqlite3 redis-cli curl wget ssh scp rsync rm mv cp chmod chown sudo kill pkill brew apt railway vercel netlify fly ' +
    'heroku firebase wrangler tsc eslint ruff prettier dprint jest vitest pytest nx turbo gradle mvn dotnet rails rake bundle composer php launchctl systemctl'
  ).split(' '),
)
const NEVER_WORDS = /\b(never|do not|don['’]t|must not|mustn['’]t|not allowed|forbidden|prohibited)\b/i
const ASK_WORDS =
  /\bask\b[^.]{0,40}\b(first|before)\b|\bgo-ahead\b|\bwithout (asking|approval|permission|confirmation)\b|\b(needs?|requires?|get|wait for) [^.]{0,30}\b(approval|confirmation|sign-off|say-so)\b|\bconfirm (first|before)\b/i
/** Commands people name without code marks. Kept short on purpose: each one is unambiguous. */
const BARE_COMMANDS = /\b(git (?:push|reset --hard|reset|rebase|merge|commit|clean|stash)|gh (?:pr|issue|release|repo) [a-z]+|npm publish|rm -rf)\b/g

const restrictionKind = (text: string): RestrictedCommand['kind'] | null => (ASK_WORDS.test(text) ? 'ask' : NEVER_WORDS.test(text) ? 'never' : null)

/** The start of a command: its program and up to two more plain words or flags. "" when the text is not a command. */
export function commandStart(span: string): string {
  const words = span.trim().replace(/^\$\s+/, '').split(/\s+/)
  if (!COMMAND_HEADS.has(words[0])) return ''
  const kept = [words[0]]
  for (const word of words.slice(1, 3)) {
    if (!/^(--?[a-z][a-z-]*|[a-z0-9][a-z0-9:_-]*)$/i.test(word)) break
    kept.push(word)
  }
  return kept.join(' ')
}

/**
 * Find the commands an instruction file restricts. It reads a paragraph or a list item at a
 * time. Within one, a command counts when it comes after the restricting words in the same
 * sentence ("never run `git push`"), or anywhere in a list item under a heading that restricts
 * ("## Ask first" followed by a list). A plain paragraph under such a heading is not taken: it
 * usually explains, and names the commands to use instead. Fenced code is skipped too.
 *
 * This reads words, not meaning. It misses a rule with no command in it ("never push to
 * main"), and it can pick up a command that a sentence only mentions. The check that uses it
 * is therefore a "look", never a "fix".
 */
export function findRestrictedCommands(text: string, file: string): RestrictedCommand[] {
  const found: RestrictedCommand[] = []
  const seen = new Set<string>()
  const add = (kind: RestrictedCommand['kind'], command: string, line: number) => {
    if (!command || seen.has(command)) return
    seen.add(command)
    found.push({ file, line, kind, command })
  }
  const commandsIn = (part: string): string[] => {
    const spans = [...part.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].split('/').map(commandStart))
    const bare = [...part.replace(/`[^`]*`/g, ' ').matchAll(BARE_COMMANDS)].map((m) => m[1])
    return [...spans, ...bare].filter(Boolean)
  }
  const readBlock = (block: string, line: number, inherited: RestrictedCommand['kind'] | null) => {
    let matched = false
    for (const sentence of block.split(/(?<=[.!?:])\s+|\s[—–]\s|;\s/)) {
      const kind = restrictionKind(sentence)
      if (!kind) continue
      matched = true
      const at = sentence.search(kind === 'ask' ? ASK_WORDS : NEVER_WORDS)
      // "ask first" often follows the command ("`git push`: ask first"), so an ask sentence is read whole.
      for (const command of commandsIn(kind === 'ask' ? sentence : sentence.slice(at))) add(kind, command, line)
    }
    if (!matched && inherited) for (const command of commandsIn(block)) add(inherited, command, line)
  }

  let headingKind: RestrictedCommand['kind'] | null = null
  let block = ''
  let blockLine = 0
  let blockIsItem = false
  let fenced = false
  const flush = () => {
    if (block) readBlock(block, blockLine, blockIsItem ? headingKind : null)
    block = ''
  }
  text.split('\n').forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      flush()
      fenced = !fenced
      return
    }
    if (fenced) return
    if (/^#{1,6}\s/.test(raw)) {
      flush()
      headingKind = restrictionKind(raw)
      return
    }
    if (!raw.trim()) return flush()
    const startsItem = /^\s*([-*+]|\d+[.)])\s/.test(raw) || /^\s*\|/.test(raw)
    if (startsItem) flush()
    if (!block) {
      blockLine = index + 1
      blockIsItem = startsItem
    }
    block += (block ? ' ' : '') + raw.trim()
  })
  flush()
  return found
}

/**
 * Whether a permission rule applies to a command that starts this way. Bare `Bash` and
 * `Bash(*)` cover everything. A `*` matches any text and a trailing `:*` is the same as ` *`,
 * as the docs say.
 */
export function ruleCovers(rule: string, command: string): boolean {
  const trimmed = rule.trim()
  if (allowsEveryCommand(trimmed)) return true
  const inner = /^Bash\((.*)\)$/.exec(trimmed)?.[1]
  if (inner === undefined) return false
  const pattern = inner.replace(/:\*$/, ' *').trim()
  const regex = new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return regex.test(command) || regex.test(`${command} x`)
}

/** Modes in which a command that no rule names runs without a prompt. */
const NO_PROMPT_MODES = new Set(['bypassPermissions', 'auto'])

export interface ProseFinding extends RestrictedCommand {
  /**
   * "enforced": a deny rule covers it, or an ask rule for an ask line. "allowed": nothing
   * enforces it and an allow rule or the permission mode lets it run unasked. "prompt": an ask
   * line that only the default prompt holds. "open": a never line with no deny rule.
   */
  state: 'enforced' | 'allowed' | 'prompt' | 'open'
}

export function proseFindings(facts: SetupFacts): ProseFinding[] {
  const files = facts.settings
  const covers = (rules: string[], command: string) => rules.some((rule) => ruleCovers(rule, command))
  const [deny, ask, allow] = [all(files, (f) => f.deny), all(files, (f) => f.ask), all(files, (f) => f.allow)]
  const noPrompt = files.some((f) => f.defaultMode !== null && NO_PROMPT_MODES.has(f.defaultMode))
  return (facts.restricted ?? []).map((r) => {
    const enforced = covers(deny, r.command) || (r.kind === 'ask' && covers(ask, r.command))
    const state = enforced ? 'enforced' : covers(allow, r.command) || noPrompt ? 'allowed' : r.kind === 'ask' ? 'prompt' : 'open'
    return { ...r, state }
  })
}

const nameFinding = (f: ProseFinding) => `"${f.command}" (${f.kind === 'ask' ? 'ask first' : 'never'}, ${f.file} line ${f.line})`
const listFindings = (findings: ProseFinding[], limit = 4) =>
  findings.slice(0, limit).map(nameFinding).join('; ') + (findings.length > limit ? `; and ${findings.length - limit} more` : '')

function proseChecks(facts: SetupFacts): Unprompted[] {
  const source = `${DOCS}/permissions.md`
  const base = { id: 'prose-rules', group: 'guardrails' as const, title: 'Rules in the instructions have a permission rule behind them', source }
  const findings = proseFindings(facts)
  if (!findings.length) {
    return [
      {
        ...base,
        status: 'info',
        detail: 'No instruction file names a command to never run, or to ask about first. Only a command written out, such as "git push", is found.',
        fix: '',
      },
    ]
  }
  const allowed = findings.filter((f) => f.state === 'allowed')
  const open = findings.filter((f) => f.state === 'open')
  const prompt = findings.filter((f) => f.state === 'prompt')
  const enforced = findings.filter((f) => f.state === 'enforced')
  const parts: string[] = []
  if (allowed.length) parts.push(`The instructions restrict ${plural(allowed.length, 'command')} that an allow rule or the permission mode lets run without asking: ${listFindings(allowed)}.`)
  if (open.length) parts.push(`${plural(open.length, 'command')} the instructions say never to run ${open.length === 1 ? 'has' : 'have'} no deny rule: ${listFindings(open)}.`)
  if (prompt.length) parts.push(`${plural(prompt.length, 'ask-first command')} ${prompt.length === 1 ? 'is' : 'are'} held only by the default prompt, which one "don't ask again" removes: ${listFindings(prompt, 3)}.`)
  if (enforced.length) parts.push(`${plural(enforced.length, 'restricted command')} ${enforced.length === 1 ? 'has' : 'have'} a rule behind ${enforced.length === 1 ? 'it' : 'them'}.`)
  const needsLook = allowed.length > 0 || open.length > 0
  return [
    {
      ...base,
      status: needsLook ? 'warn' : 'pass',
      detail: parts.join(' ') + (needsLook ? ' This check reads words, so confirm each line means what it found.' : ''),
      fix: needsLook
        ? 'The docs say "Permission rules are enforced by Claude Code, not by the model", and that instructions "shape what Claude tries to do, but they don\'t change these rules". Add a deny rule for a command the instructions forbid and an ask rule for one they say to ask about, and remove an allow rule that contradicts them.'
        : '',
    },
  ]
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

type Unprompted = Omit<Check, 'prompt' | 'layer' | 'risks'>

const LIMIT_FLAG = /--max-turns\b|--max-budget-usd\b/
const HEADLESS = /(^|[\s;&|("'`$])claude(\s+[^\n|;&]*?)?\s(-p|--print)(\s|=|$)/
const ACTION = /\buses:\s*['"]?anthropics\/claude-code-action\b/

/**
 * Runs with no person present in one file's text, and whether each sets a limit. A shell
 * command continued with a backslash is read as one line. For the GitHub action, the limit is
 * looked for in the lines of the same step, where `claude_args` carries it.
 */
export function findUnattendedRuns(file: string, text: string): UnattendedRun[] {
  const lines = text.split('\n')
  const out: UnattendedRun[] = []
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i]
    if (/^\s*(#|\/\/)/.test(first)) continue
    if (ACTION.test(first)) {
      // The step ends at the next list item at the same or a shallower indent.
      const indent = first.search(/\S/)
      let step = ''
      for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
        if (/^\s*-\s/.test(lines[j]) && lines[j].search(/\S/) <= indent) break
        step += lines[j] + '\n'
      }
      out.push({ file, line: i + 1, kind: 'action', limited: LIMIT_FLAG.test(step) })
      continue
    }
    let command = first
    let end = i
    while (/\\\s*$/.test(lines[end]) && end + 1 < lines.length) command += ' ' + lines[++end]
    if (HEADLESS.test(command)) out.push({ file, line: i + 1, kind: 'cli', limited: LIMIT_FLAG.test(command) })
    i = end
  }
  return out
}

/** Runners that fetch a package and run it. The value is how many words name the runner. */
const RUNNERS: Array<{ words: string[]; python: boolean }> = [
  { words: ['npx'], python: false },
  { words: ['bunx'], python: false },
  { words: ['pnpm', 'dlx'], python: false },
  { words: ['yarn', 'dlx'], python: false },
  { words: ['uvx'], python: true },
  { words: ['pipx', 'run'], python: true },
  { words: ['uv', 'tool', 'run'], python: true },
]
/** Flags of those runners that take the next word as their value. */
const VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--from', '--with', '--python', '--registry', '--cache'])

/**
 * The package a server is fetched as, and whether it names one exact version. Null when the
 * server is not started through a package runner, or runs a local path or a git address:
 * those are not fetched fresh from a registry. Looks at the command's words only, and returns
 * nothing but the package.
 */
export function packageOf(command: string, args: string[]): { spec: string; pinned: boolean } | null {
  const words = [command.split(/[\\/]/).pop() ?? command, ...args]
  const runner = RUNNERS.find((r) => r.words.every((w, i) => words[i] === w))
  if (!runner) return null
  let spec: string | null = null
  for (let i = runner.words.length; i < words.length; i++) {
    const w = words[i]
    const named = /^(--package|--from)=(.+)$/.exec(w)
    if (named) {
      spec = named[2]
      break
    }
    if (w === '-p' || w === '--package' || w === '--from') {
      spec = words[i + 1] ?? null
      break
    }
    if (VALUE_FLAGS.has(w)) i++
    else if (!w.startsWith('-')) {
      spec = w
      break
    }
  }
  if (!spec || /^(\.|\/|~|file:|git\+|https?:|github:)/.test(spec)) return null
  const pinned = runner.python ? /^[A-Za-z0-9._-]+(\[[^\]]*\])?(==|@)\d+(\.\d+)*([a-z0-9.+-]*)$/i.test(spec) : /^(@[^/@]+\/)?[^@]+@\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]*)?$/.test(spec)
  return { spec, pinned }
}

/**
 * A server started as `npx some-mcp` is whatever that name points at when the session starts.
 * A new release, or a taken-over name, then runs on the machine with the reach the agent has.
 */
function mcpChecks(facts: SetupFacts): Unprompted[] {
  const packages = facts.mcpPackages ?? []
  if (packages.length === 0) return []
  const loose = packages.filter((p) => !p.pinned)
  const source = `${DOCS}/mcp.md`
  const name = (p: McpPackage) => `${p.name} (${p.spec}, ${p.scope})`
  return [
    {
      id: 'mcp-pinned',
      group: 'guardrails',
      title: 'Connected tools fetched at start name an exact version',
      status: loose.length ? 'warn' : 'pass',
      detail: loose.length
        ? `${plural(loose.length, 'MCP server')} of ${packages.length} fetched by a package runner ${loose.length === 1 ? 'names' : 'name'} no exact version: ${loose.map(name).join('; ')}. Each start runs whatever that name points to that day, with the reach your agent has.`
        : `All ${plural(packages.length, 'MCP server')} fetched by a package runner name an exact version.`,
      fix: loose.length ? 'Our suggestion: write the exact version, as in some-mcp@1.4.2 (or some-mcp==1.4.2 for a Python tool), and change it on purpose when you want a newer one. The docs do not ask for this.' : '',
      source,
    },
  ]
}

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
  const runs = facts.unattendedRuns
  if (runs) {
    const open = runs.filter((r) => !r.limited)
    const where = (r: UnattendedRun) => `${r.file}:${r.line}`
    checks.push({
      id: 'run-limits',
      group: 'verification',
      title: 'A run with no person present has a limit',
      status: runs.length === 0 ? 'info' : open.length ? 'warn' : 'pass',
      detail:
        runs.length === 0
          ? 'No run with no person present was found. This looked for claude -p and the GitHub action in workflows, package scripts and shell scripts.'
          : open.length
            ? `${open.length} of ${plural(runs.length, 'run')} with no person present ${open.length === 1 ? 'sets' : 'set'} no turn or spending limit: ${open.slice(0, 8).map(where).join(', ')}${open.length > 8 ? `, and ${open.length - 8} more` : ''}. The docs say of --max-turns: "No limit by default." Nobody is there to stop a run that goes round in circles.`
            : `All ${plural(runs.length, 'run')} with no person present set a turn or spending limit.`,
      fix: open.length
        ? 'Add --max-turns with a number, or --max-budget-usd with an amount, to each. In the GitHub action they go in claude_args. The docs say the spending limit uses Claude Code\'s own estimate and the response that crosses it still completes, so set it below what you can afford.'
        : '',
      source: `${DOCS}/cli-reference.md`,
    })
  }
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
    case 'run-limits': {
      const open = (facts.unattendedRuns ?? []).filter((r) => !r.limited)
      return (
        `These start Claude Code with no person present and set no limit: ${open.slice(0, 12).map((r) => `${r.file}:${r.line}`).join(', ')}. ` +
        'The Claude Code docs say --max-turns has no limit by default, and that --max-budget-usd stops a run once estimated spend reaches an amount. ' +
        'For each one, read what the run is for and propose a --max-turns value, and a --max-budget-usd value where money is the worry. In the GitHub action they go in claude_args. ' +
        'Tell me the numbers and why before you edit anything, then show me the diff.'
      )
    }
    case 'mcp-pinned': {
      const loose = (facts.mcpPackages ?? []).filter((p) => !p.pinned)
      return (
        `These MCP servers are started through a package runner with no exact version: ${loose.map((p) => `${p.name} (${p.spec}, ${p.scope} scope)`).join('; ')}. ` +
        'For each one, find which file defines it (.mcp.json for project scope, ~/.claude.json for user scope) and which version of the package is in use now. ' +
        'Then show me the change that writes that exact version into the server entry. Do not change any other argument, and do not print any environment value. Show me the diff before you save anything.'
      )
    }
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
    case 'prose-rules': {
      const findings = proseFindings(facts).filter((f) => f.state === 'allowed' || f.state === 'open')
      return (
        `My instruction files restrict these commands, and no permission rule enforces it: ${findings.map(nameFinding).join('; ')}. ` +
        'First read each line and tell me if it really restricts that command. For each one that does, propose a rule for the permissions in .claude/settings.json: ' +
        'a deny rule where the instructions say never, an ask rule where they say to ask first. If an allow rule in any settings file approves one of these commands, show me that rule and say whether to remove it. ' +
        'Keep every other rule. Show me the diff before you save it, and tell me how to confirm afterwards that each rule works.'
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

/**
 * The layer each check belongs to, by the part of its id before any colon. A check added
 * without a line here fails the test "every check has a layer".
 */
export const LAYER_OF: Readonly<Record<string, Layer>> = {
  'memory-exists': 'guides',
  'memory-length': 'guides',
  skills: 'guides',
  'legacy-commands': 'guides',
  hooks: 'sensors',
  'verify-command': 'sensors',
  'stop-check': 'loop',
  'run-limits': 'loop',
  'auto-memory-index': 'memory',
  'allow-rules': 'permissions',
  'subagents-and-mcp': 'permissions',
  'deny-secrets': 'permissions',
  'broad-allow': 'permissions',
  'default-mode': 'permissions',
  sandbox: 'permissions',
  reach: 'permissions',
  managed: 'permissions',
  'prose-rules': 'permissions',
  'subagent-scope': 'permissions',
  retention: 'observability',
  'mcp-pinned': 'permissions',
}

/**
 * The OWASP Top 10 for LLM Applications 2025, by number. Names are copied from the project's
 * own files (github.com/OWASP/www-project-top-10-for-large-language-model-applications,
 * folder 2_0_vulns), read 2026-11-22. Do not add an entry from memory or from a summary of
 * the list: a widely shared graphic had seven of the ten numbers wrong.
 */
export const OWASP_LLM_2025 = {
  LLM01: 'Prompt Injection',
  LLM02: 'Sensitive Information Disclosure',
  LLM03: 'Supply Chain',
  LLM04: 'Data and Model Poisoning',
  LLM05: 'Improper Output Handling',
  LLM06: 'Excessive Agency',
  LLM07: 'System Prompt Leakage',
  LLM08: 'Vector and Embedding Weaknesses',
  LLM09: 'Misinformation',
  LLM10: 'Unbounded Consumption',
} as const
export type OwaspLlmId = keyof typeof OWASP_LLM_2025

/** "LLM06:2025 Excessive Agency": the form OWASP itself uses. */
export const owaspLabel = (id: OwaspLlmId): string => `${id}:2025 ${OWASP_LLM_2025[id]}`

/** Said wherever a risk is named, so a tag is not read as a claim of coverage. */
export const RISK_NOTE =
  'A tag names an entry on the OWASP Top 10 for LLM Applications 2025 that the check bears on. It is our own reading, not OWASP\'s. A pass means this one setting is in place. It does not mean the project is protected from that risk.'

/**
 * Which entries a check bears on, by the part of its id before any colon. Only where the link
 * is plain: a check with no line here carries no tag.
 */
export const RISK_OF: Readonly<Record<string, readonly OwaspLlmId[]>> = {
  'deny-secrets': ['LLM02'],
  'broad-allow': ['LLM06'],
  'default-mode': ['LLM06'],
  sandbox: ['LLM06'],
  reach: ['LLM06'],
  'prose-rules': ['LLM06'],
  'subagent-scope': ['LLM06'],
  'mcp-pinned': ['LLM03'],
  'run-limits': ['LLM10'],
}

export function risksOf(id: string): string[] {
  return (RISK_OF[id.split(':')[0]] ?? []).map(owaspLabel)
}

export function layerOf(id: string): Layer {
  return LAYER_OF[id.split(':')[0]] ?? 'guides'
}

/**
 * The six layers in reading order. `unchecked` names what Groundcrew does NOT look at in that
 * layer, so a row of passes is not read as "this layer is covered". Shorten a line only when
 * a check for it ships.
 */
export const LAYERS: ReadonlyArray<{ key: Layer; title: string; what: string; unchecked: string }> = [
  {
    key: 'guides',
    title: 'Guides',
    what: 'What steers the agent before it works: instructions, rules and skills.',
    unchecked: 'It does not judge what the instructions say, only how long they are.',
  },
  {
    key: 'sensors',
    title: 'Sensors',
    what: 'What checks the work: tests, linters and hooks the agent can run.',
    unchecked: 'It does not see your CI, so it cannot tell a check that always fails from one that works.',
  },
  {
    key: 'loop',
    title: 'Loop',
    what: 'What sends the agent back when the work is not done.',
    unchecked: 'It finds a run with no person present only as claude -p or the GitHub action, in a workflow, a package script or a shell script. It does not see one started by another tool or by a program built on the SDK.',
  },
  {
    key: 'memory',
    title: 'Memory',
    what: 'What carries over from one session to the next.',
    unchecked: 'It does not look for handoff notes or a record of decisions.',
  },
  {
    key: 'permissions',
    title: 'Permissions',
    what: 'What the agent may do without asking, and what it may never do.',
    unchecked: 'It finds a restricted command only when the instructions write it out, as in git push. It does not understand a rule in plain words.',
  },
  {
    key: 'observability',
    title: 'Observability',
    what: 'What a person can see of what the agent did.',
    unchecked: 'It does not look for cost tracking or alerts.',
  },
]

export function runChecks(facts: SetupFacts): Check[] {
  const checks: Unprompted[] = [...memoryChecks(facts), ...automationChecks(facts), ...guardrailChecks(facts), ...mcpChecks(facts), ...proseChecks(facts), ...verificationChecks(facts)]
  return checks.map((check) => ({ ...check, layer: layerOf(check.id), risks: risksOf(check.id), prompt: promptFor(check, facts) }))
}

export interface LayerSummary {
  layer: Layer
  title: string
  pass: number
  warn: number
  fail: number
  info: number
  /**
   * The worst status among the layer's checks. "facts" means the layer has rows but none that
   * can pass or fail; "none" means no check ran for it in this project.
   */
  state: 'fix' | 'look' | 'good' | 'facts' | 'none'
}

/** One row per layer, in the order of LAYERS, including layers with no check. */
export function layerSummary(checks: Check[]): LayerSummary[] {
  return LAYERS.map(({ key, title }) => {
    const mine = checks.filter((c) => c.layer === key)
    const count = (status: Status) => mine.filter((c) => c.status === status).length
    const [pass, warn, fail, info] = [count('pass'), count('warn'), count('fail'), count('info')]
    const state = fail ? 'fix' : warn ? 'look' : pass ? 'good' : info ? 'facts' : 'none'
    return { layer: key, title, pass, warn, fail, info, state }
  })
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
