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
 * 2026-11-14. A check that is only our opinion says "our suggestion" in its text. One check,
 * `rule-record`, rests on a research paper and not on the docs, and says so.
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

/** How the notes in an auto memory folder line up with its index. */
export interface MemoryFolder {
  /** Note files in the folder, not counting the index. */
  files: number
  /** Notes the index does not link to. A session reads the index, so it never learns these exist. */
  unlisted: number
  /** Links in the index to a note that is not there. */
  missing: number
}

/**
 * Compare an index with the folder it describes. `index` is the text of MEMORY.md, or null
 * when there is none; `names` is the folder's markdown files. Pure.
 */
export function memoryFolder(index: string | null, names: string[]): MemoryFolder {
  const notes = names.filter((n) => n.toLowerCase().endsWith('.md') && n !== 'MEMORY.md')
  const linked = new Set<string>()
  for (const m of (index ?? '').matchAll(/\]\(\s*(?:\.\/)?([^)\s#]+\.md)(?:#[^)]*)?\s*\)/g)) linked.add(m[1])
  const have = new Set(notes)
  return {
    files: notes.length,
    unlisted: notes.filter((n) => !linked.has(n)).length,
    // A link with a folder in it, or to a web address, is not a note in this folder.
    missing: [...linked].filter((n) => !n.includes('/') && !have.has(n)).length,
  }
}

export interface SetupFacts {
  platform: string
  memory: MemoryFile[]
  /** Files under .claude/rules/ and ~/.claude/rules/. */
  ruleFiles: number
  /** The auto memory index, when the project has one. */
  autoMemoryIndex: MemoryFile | null
  /** The auto memory folder beside the index: counts only, never a file's name. Absent when a caller did not look. */
  autoMemoryFolder?: MemoryFolder
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
  /**
   * A file that records why each rule in the instructions exists. Null when none was found,
   * absent when a caller did not look.
   */
  ruleRecord?: RuleRecord | null
}

export interface RuleRecord {
  /** Path from the project root, such as "docs/ai/RULE_LEDGER.md". */
  label: string
  /** Rows, sections or list items in it: see recordEntries. */
  entries: number
  /** The first instruction file that names it, or null when none does. */
  linkedFrom: string | null
}

/** File names taken to be a record of why rules exist: RULE_LEDGER.md, decision-log.md, rule-history.md. */
const RECORD_NAME = /(^|[-_ .])(ledger|decision[-_ ]?(log|record)s?|rules?[-_ ]?(log|history))\.md$/i
export const looksLikeRuleRecord = (name: string): boolean => RECORD_NAME.test(name)

/**
 * How many entries a record holds: the rows of its tables when it has any, or else its
 * sections below the title, or else its list items. A count, never the text. Pure.
 */
export function recordEntries(text: string): number {
  const lines = text.split('\n').map((l) => l.trim())
  const divider = (l: string) => /^\|?\s*:?-{2,}/.test(l) && /^[|\s:-]+$/.test(l)
  let rows = 0
  lines.forEach((l, i) => {
    if (l.startsWith('|') && !divider(l) && !divider(lines[i + 1] ?? '')) rows++
  })
  if (rows) return rows
  const sections = lines.filter((l) => /^#{2,6}\s/.test(l)).length
  return sections || lines.filter((l) => /^([-*]|\d+\.)\s/.test(l)).length
}

/** Our own line, not the docs': under this many lines of project instructions, no record is only a fact. */
export const RECORD_WORTH_LINES = 60
/** Self-Improvement Memory, Google Cloud AI and Google DeepMind, submitted 2026-11-13. */
const SIM_PAPER = 'https://arxiv.org/abs/2611.18856'

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

/** Programs that send to, or fetch from, any address. The docs name curl and wget; the rest are our own list. */
const NETWORK_PROGRAMS = ['curl', 'wget', 'nc', 'ncat', 'netcat', 'scp', 'sftp', 'ftp', 'telnet']

/**
 * An allow rule that lets the agent reach any address without asking: a shell rule for a
 * network program, such as `Bash(curl *)` or the older `Bash(curl:*)`, or a web fetch rule
 * for every domain. A fetch rule for one named domain is not one, and neither is a shell rule
 * with no wildcard: that approves one exact command, such as a health check someone answered
 * "don't ask again" to. Returns what the rule opens, or null. A blanket shell rule is
 * `allowsEveryCommand`'s to report, not this one's.
 */
export function allowsNetwork(rule: string): string | null {
  const r = rule.trim()
  if (/^WebFetch(\(\s*(domain:\s*\*)?\s*\))?$/.test(r)) return 'any address'
  const shell = r.match(/^Bash\(\s*([^\s:()]+)/)
  if (!shell || !r.includes('*')) return null
  const program = shell[1].split('/').pop() as string
  return NETWORK_PROGRAMS.includes(program) ? program : null
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
  const folder = facts.autoMemoryFolder
  if (folder && folder.files) {
    const base = { id: 'auto-memory-folder', group: 'setup' as const, title: 'Auto memory notes are in the index', source }
    if (!index) {
      checks.push({
        ...base,
        status: 'warn',
        detail: `The memory folder holds ${plural(folder.files, 'note')} and no MEMORY.md. A session loads the index, not the folder, so nothing tells it these notes exist.`,
        fix: 'Add a MEMORY.md with one line per note: a link to the file and a few words on when it matters.',
      })
    } else if (folder.unlisted || folder.missing) {
      const parts = [
        folder.unlisted ? `${plural(folder.unlisted, 'note')} of ${folder.files} ${folder.unlisted === 1 ? 'is' : 'are'} not linked from MEMORY.md, so a session never learns ${folder.unlisted === 1 ? 'it exists' : 'they exist'}` : '',
        folder.missing ? `${plural(folder.missing, 'link')} in MEMORY.md ${folder.missing === 1 ? 'points' : 'point'} to a note that is not there` : '',
      ].filter(Boolean)
      checks.push({
        ...base,
        status: 'warn',
        detail: `${parts.join(', and ')}.`,
        fix: 'Compare the folder with the links in MEMORY.md. Add a line for each note worth keeping, delete the notes that are not, and remove links to notes that are gone.',
      })
    } else {
      checks.push({ ...base, status: 'pass', detail: `All ${plural(folder.files, 'note')} are linked from MEMORY.md.`, fix: '' })
    }
  }
  if (facts.ruleRecord !== undefined) checks.push(ruleRecordCheck(facts, facts.ruleRecord))
  return checks
}

/**
 * Whether the project keeps a record of why its rules exist, and whether a session is told
 * about it. This is our suggestion: the Claude Code docs do not ask for one.
 */
function ruleRecordCheck(facts: SetupFacts, record: RuleRecord | null): Unprompted {
  const base = { id: 'rule-record', group: 'setup' as const, title: 'A record of why each rule exists', source: SIM_PAPER }
  const lines = facts.memory.filter((m) => !m.label.startsWith('~')).reduce((sum, m) => sum + m.lines, 0)
  const entries = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`
  const row = 'one row for each rule: when it was added, what went wrong, what the rule was expected to fix, what happened after, and what would make it safe to delete'
  if (record && record.entries && record.linkedFrom) {
    return { ...base, status: 'pass', detail: `${record.label} holds ${entries(record.entries)}, and ${record.linkedFrom} names it.`, fix: '' }
  }
  if (record && record.entries) {
    return {
      ...base,
      status: 'warn',
      detail: `${record.label} holds ${entries(record.entries)}, and no instruction file names it. A session that changes a rule is never told the record is there.`,
      fix: `Add a line to the instructions: before adding, changing or removing a rule, read ${record.label}, and add a row for a new rule.`,
    }
  }
  const found = record ? `${record.label} was found and holds no entry` : 'No record of why each rule is there was found'
  const looked = 'Groundcrew looks in the project root, docs/, docs/ai/ and .claude/ for a file named like RULE_LEDGER.md or decision-log.md, and for a link to one from the instructions.'
  if (lines < RECORD_WORTH_LINES) {
    return { ...base, status: 'info', detail: `${found}. The project's instruction files hold ${plural(lines, 'line')}, which is few enough to reread. ${looked}`, fix: '' }
  }
  return {
    ...base,
    status: 'warn',
    detail: `${found}. The project's instruction files hold ${plural(lines, 'line')}. When the model changes, nothing says which of them still earn their place. ${looked}`,
    fix:
      `Our suggestion, not the docs': keep ${row}. ` +
      'A 2026 paper from Google found that an automated optimiser moving an agent\'s setup to a new model or a new set of tasks finished higher when it carried such a record than when it carried the setup alone. ' +
      'That tested a program rewriting a setup, not a person editing CLAUDE.md, so read it as a reason to try this and not as proof.',
  }
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
  const network = all(files, (f) => f.allow.filter((rule) => allowsNetwork(rule)).map((rule) => `${rule} in ${f.label}`))
  const networkShown = network.slice(0, 5).join('; ') + (network.length > 5 ? `; and ${network.length - 5} more` : '')
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
      id: 'network-ask',
      group: 'guardrails',
      title: 'Network commands still ask',
      status: network.length ? 'warn' : 'pass',
      detail: network.length
        ? `These rules let the agent reach any address without asking: ${networkShown}. Text the agent reads, such as a web page or an issue, can carry an instruction. With ${network.length === 1 ? 'this rule' : 'these rules'}, such an instruction could send data out and nothing would ask you.`
        : 'No allow rule approves a network command or a web request to any address, so those ask first in the standard mode.',
      fix: network.length
        ? `Remove ${network.length === 1 ? 'the rule' : 'these rules'}, or replace ${network.length === 1 ? 'it' : 'them'} with a rule for each site you need, such as "WebFetch(domain:docs.example.com)". A shell rule cannot limit which address a command reaches.`
        : '',
      source: `${DOCS}/security.md`,
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
        ? 'Add --max-turns with a number, or --max-budget-usd with an amount, to each. In the GitHub action they go in claude_args. The docs say the spending limit is checked against Claude Code\'s own estimate and that "Spend can pass the cap", so set it below what you can afford.'
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
    case 'auto-memory-folder':
      return 'The notes in this project\'s auto memory folder do not line up with its index, MEMORY.md. List the markdown files in the folder and the links in MEMORY.md. Tell me which notes have no line in the index and which links point to a note that is gone. For each note with no line, read it and say whether to add a line for it or delete it, and why. Show me the new MEMORY.md before you save it, and delete nothing until I approve.'
    case 'rule-record': {
      const record = facts.ruleRecord
      if (record && record.entries)
        return (
          `${record.label} records why this project's rules exist, and no instruction file names it. ` +
          'Propose one line for CLAUDE.md that says: before adding, changing or removing a rule, read that file, and add a row for a new rule. Show me the diff before you save it.'
        )
      return (
        'My instruction files (CLAUDE.md, AGENTS.md and the files under .claude/rules/) have no record of why each rule is there. ' +
        'For each rule, use git log and git blame to find the commit that added it. Draft a table with one row for each rule: the rule in a few words, the date it was added, ' +
        'the model in use then if the history says, what went wrong that led to it, what it was expected to fix, what happened after, and what would make it safe to delete. ' +
        'Write "unknown" wherever the history does not say. Do not guess a reason. Show me the table, and where you would save it, before you write any file.'
      )
    }
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
    case 'network-ask':
      return (
        'My Claude Code settings hold allow rules that let you reach any address without asking, such as a rule for curl or a WebFetch rule for every domain. ' +
        'Find them in the settings files and tell me what each one was added for. Where a rule is for reading a few known sites, propose a WebFetch(domain:...) rule for each site to replace it. ' +
        'Where it is not needed, propose removing it. Show me the diff before you save it.'
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
  'auto-memory-folder': 'memory',
  'rule-record': 'memory',
  'allow-rules': 'permissions',
  'subagents-and-mcp': 'permissions',
  'deny-secrets': 'permissions',
  'broad-allow': 'permissions',
  'default-mode': 'permissions',
  sandbox: 'permissions',
  'network-ask': 'permissions',
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
 * the list: a widely shared graphic had seven of its nine numbers wrong.
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
  'network-ask': ['LLM01', 'LLM06'],
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
    unchecked: 'It does not look for handoff notes. It finds a record of why rules exist by its file name, and does not judge what the record says.',
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

/** One check whose status is not what it was in the earlier report. */
export interface StatusChange {
  id: string
  title: string
  /** Null when the earlier report did not have this check. */
  before: Status | null
  /** Null when this report does not have it. */
  after: Status | null
}

/** What changed between an earlier report and this one. */
export interface Comparison {
  /** When the earlier report says it was read, as it wrote it. Empty when it does not say. */
  readBefore: string
  scoreBefore: number
  scoreAfter: number
  /** Pass to warn, pass to fail, or warn to fail. */
  worse: StatusChange[]
  /** Fail to warn, fail to pass, or warn to pass. */
  better: StatusChange[]
  /** A change to or from a plain fact, which is neither better nor worse. */
  other: StatusChange[]
  /** Checks this report has and the earlier one did not: a newer Groundcrew, or a file that now exists. */
  added: StatusChange[]
  /** Checks the earlier report had and this one does not. */
  removed: StatusChange[]
  /** Checks in both with the same status. */
  same: number
}

/** An earlier report, as much of it as a comparison needs. */
export interface Baseline {
  readBefore: string
  score: number
  checks: { id: string; title: string; status: Status }[]
}

const STATUSES: readonly Status[] = ['pass', 'warn', 'fail', 'info']
const RANK: Record<Status, number> = { pass: 0, warn: 1, fail: 2, info: -1 }

/**
 * Read an earlier report: the output of `--json`, or of boardSummary(). Throws a sentence a
 * person can act on when the text is something else. Pure.
 */
export function parseBaseline(text: string): Baseline {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('the earlier report is not JSON. Make one with: jq-groundcrew --json > before.json')
  }
  if (!data || !Array.isArray(data.checks)) throw new Error('the earlier report has no list of checks. Make one with: jq-groundcrew --json > before.json')
  const checks = data.checks
    .filter((c: any) => c && typeof c.id === 'string' && STATUSES.includes(c.status))
    .map((c: any) => ({ id: c.id as string, title: typeof c.title === 'string' ? c.title : c.id, status: c.status as Status }))
  if (!checks.length) throw new Error('the earlier report has no check this version can read')
  const score = typeof data.summary?.score === 'number' ? data.summary.score : typeof data.score === 'number' ? data.score : summarize(checks as Check[]).score
  return { readBefore: typeof data.generatedAt === 'string' ? data.generatedAt : '', score, checks }
}

/**
 * Compare this report's checks with an earlier report's. Pure.
 *
 * It says whether the SETUP changed. It cannot say whether the agent now works better: a rule
 * can pass every check and still be ignored.
 */
export function compareChecks(before: Baseline, after: Check[]): Comparison {
  const was = new Map(before.checks.map((c) => [c.id, c]))
  const now = new Map(after.map((c) => [c.id, c]))
  const result: Comparison = { readBefore: before.readBefore, scoreBefore: before.score, scoreAfter: summarize(after).score, worse: [], better: [], other: [], added: [], removed: [], same: 0 }
  for (const c of after) {
    const old = was.get(c.id)
    if (!old) result.added.push({ id: c.id, title: c.title, before: null, after: c.status })
    else if (old.status === c.status) result.same++
    else {
      const change = { id: c.id, title: c.title, before: old.status, after: c.status }
      if (RANK[old.status] < 0 || RANK[c.status] < 0) result.other.push(change)
      else if (RANK[c.status] > RANK[old.status]) result.worse.push(change)
      else result.better.push(change)
    }
  }
  for (const c of before.checks) if (!now.has(c.id)) result.removed.push({ id: c.id, title: c.title, before: c.status, after: null })
  return result
}

/** One line for a terminal or a CI log. Pure. */
export function comparisonLine(c: Comparison): string {
  const count = (n: number, word: string) => `${n} ${word}`
  return `score ${c.scoreBefore} to ${c.scoreAfter}; ${count(c.better.length, 'better')}, ${count(c.worse.length, 'worse')}, ${count(c.same, 'the same')}` + (c.added.length ? `, ${count(c.added.length, 'new')}` : '') + (c.removed.length ? `, ${count(c.removed.length, 'gone')}` : '')
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
