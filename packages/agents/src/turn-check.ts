/**
 * JQ Agents: what stands behind "done".
 *
 * A session that ends its turn has decided on its own that the work is finished. The rules
 * here say whether anything but the session looked: did a check run after the last edit?
 *
 * Everything in this file is PURE. It reads tool names, the text of shell commands and the
 * error flag of a result. One word comes out for the board. The evidence (which command was
 * taken as the edit) is kept apart from the row, so it is never sent anywhere by accident:
 * only the local page asks for it.
 *
 * Two kinds of mistake are possible, and they are not equal. Missing an edit leaves a row
 * unlabelled. Seeing an edit that was not one puts a false alert on the board, and a board
 * that cries wolf gets ignored. So every guess here leans toward "not an edit", and the
 * person at the board can correct the rest: see TurnCheckConfig.
 */
import { redactSecrets, type TranscriptRecord } from './agent-status.js'

/**
 *   checked    a test, lint, type-check or build command ran after the last file edit
 *   failed     the last such command after the last edit reported an error
 *   unchecked  files were edited and no such command ran afterwards
 *   no-edits   the turn edited no file, so there was nothing to check
 *   unknown    the start of the turn is further back than the tail that was read
 *   dismissed  it would be "unchecked" or "failed", and a person said to stop showing it
 */
export type TurnCheck = 'checked' | 'failed' | 'unchecked' | 'no-edits' | 'unknown' | 'dismissed'

/** Tools that change a file. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** A shell command that tests, lints, type-checks or builds. The same rule as JQ Groundcrew's. */
export function looksLikeACheck(command: string): boolean {
  return /\b(test|tests|jest|vitest|pytest|mocha|lint|eslint|ruff|tsc|typecheck|type-check|mypy|pyright|check|build|cargo (test|check|clippy)|go (test|vet))\b/i.test(command)
}

/**
 * File endings that mark code or configuration. A shell command counts as an edit only when
 * it writes a file with one of these, so a note, a log or a picture never raises a label.
 */
const CODE_FILE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sql|sh|bash|zsh|json|ya?ml|toml|css|scss|less|html?|vue|svelte|tf|proto|gradle|xml|ini|cfg|conf|lock)$|(^|\/)(Dockerfile|Makefile|\.env[\w.]*)$/i

/** Places and names that are scratch space or an agent's own notes. A write there is not an edit to the project. */
const NOT_PROJECT = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/dev\/|\$)|(^|\/)\.claude\/|(^|\/)(node_modules|dist|build|out|coverage)\/|(^|\/)[._]?(tmp|temp|scratch)[\w.-]*(\/|$)|_tmp_|\.tmp\b/i

/** Whether a path names a project file whose change deserves a check. */
export function isCodePath(file: string): boolean {
  const clean = file.trim().replace(/^['"]|['"]$/g, '')
  // A name that starts with "_" or "." is a throwaway by convention: `_q.mts`, `.prev.mjs`. `.env` is not.
  const name = clean.split('/').pop() || ''
  if (/^[_.]/.test(name) && !/^\.env/.test(name)) return false
  return CODE_FILE.test(clean) && !NOT_PROJECT.test(clean)
}

/** The code paths named anywhere in a piece of text, quoted or not. */
function codePaths(text: string): string[] {
  return (text.match(/[~$\w@.{}\/-]+/g) || []).filter(isCodePath)
}

/** The same text with what is inside quotes blanked out, so an operator inside a string is not read as one. */
function maskQuotes(text: string): string {
  return text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) => quoted[0] + 'x'.repeat(Math.max(0, quoted.length - 2)) + quoted[0])
}

/** Take the bodies out of here-documents, keeping the line that opens each one. */
function splitHeredocs(command: string): { shell: string; bodies: string[] } {
  const bodies: string[] = []
  const lines = command.split('\n')
  const shell: string[] = []
  for (let i = 0; i < lines.length; i++) {
    shell.push(lines[i])
    const tag = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i])?.[2]
    if (!tag) continue
    const body: string[] = []
    i += 1
    while (i < lines.length && lines[i].trim() !== tag) body.push(lines[i++])
    bodies.push(body.join('\n'))
  }
  return { shell: shell.join('\n'), bodies }
}

/** The parts of a command that run one after another, each as written and with its quotes blanked. */
function segments(shell: string): Array<{ text: string; bare: string }> {
  const masked = maskQuotes(shell)
  const parts: Array<{ text: string; bare: string }> = []
  let from = 0
  for (const cut of [...masked.matchAll(/&&|\|\||;|\||\n/g), null]) {
    const to = cut ? cut.index! : masked.length
    const text = shell.slice(from, to).trim()
    if (text) parts.push({ text, bare: masked.slice(from, to).trim() })
    from = cut ? to + cut[0].length : to
  }
  return parts
}

/** The parts of a command line that run one after another: split on && || ; | and new lines. */
export function shellSegments(command: string): string[] {
  return segments(splitHeredocs(command).shell).map((part) => part.text)
}

/** Code handed to an interpreter that writes a file: `open(p, 'w')`, `writeFileSync(`, `write_text(`. */
const WRITES_A_FILE = /\bopen\([^)]*,\s*['"][wax]b?\+?['"]|\.write_text\(|\.write_bytes\(|\bwriteFile(Sync)?\(|\bappendFile(Sync)?\(|\bfs\.(rename|unlink|rm|cp|copyFile)(Sync)?\(|\bshutil\.(copy|move|rmtree)/

/**
 * The part of a shell command that changes a project's code, or "" when none is found.
 *
 * A part counts when it is a way of writing (an in-place `sed` or `perl`, `mv`, `cp`, `rm`,
 * `patch`, `tee`, `git apply|mv|rm`, a redirect into a file, or an interpreter given code
 * that writes a file) AND it names a code or configuration file outside scratch space.
 *
 * Measured 2026-11-21 on 2,762 ended turns in local transcripts. A first version without the
 * second condition labelled 710 turns, and most were wrong: 326 were `source x >/dev/null`,
 * and the rest were mostly notes, logs and temporary scripts. Hence the rule that the file
 * must be named and must be code. What it misses: a write whose target is in a variable, and
 * a formatter or a generator, which change files without naming them.
 */
export function shellEdit(command: string): string {
  const { shell, bodies } = splitHeredocs(command)
  const written = bodies.filter((body) => WRITES_A_FILE.test(body)).join('\n')
  for (const { text, bare } of segments(shell)) {
    const writer = /^(sudo\s+)?(sed|perl)\b.*\s-[a-zA-Z]*i/.test(bare) || /^(sudo\s+)?(mv|cp|rm|patch|tee)\s/.test(bare) || /^git\s+(apply|mv|rm)\b/.test(bare)
    if (writer && codePaths(text).length) return text
    // A redirect into a named file. `2>&1`, `>&2`, `=>` and `->` are not one.
    for (const hit of bare.matchAll(/(^|[^0-9&>=-])>>?\s*/g)) {
      const target = /^\S+/.exec(text.slice(hit.index! + hit[0].length))?.[0] ?? ''
      if (isCodePath(target)) return text
    }
    // An interpreter given code inline or by here-document, where that code writes a code file.
    if (/^(python3?|node|ruby|perl|deno|bun)\b/.test(bare) && (written || WRITES_A_FILE.test(text)) && codePaths(`${written}\n${text}`).length) return text
  }
  return ''
}

/** The start of a command, as the text of a rule: its first three words, without arguments that look like paths. */
export function ruleText(command: string): string {
  const words = (shellSegments(command)[0] || command).trim().split(/\s+/)
  const kept: string[] = []
  for (const word of words.slice(0, 3)) {
    if (kept.length && /[\/$<>'"=]|^\d/.test(word)) break
    kept.push(word)
  }
  return kept.join(' ').slice(0, 60)
}

/* ── What a person can correct ─────────────────────────────────────────── */

export interface TurnCheckRule {
  /** A working tree, or "*" for every tree. */
  tree: string
  /** "check": a command holding this text is a check. "not-edit": one holding it does not edit files. */
  kind: 'check' | 'not-edit'
  text: string
}

/** The `turnCheck` key of ~/.jq/config.json. Every field is optional in the file. */
export interface TurnCheckConfig {
  rules: TurnCheckRule[]
  /** Working trees whose sessions are never labelled. */
  muted: string[]
  /** Session id to the `last_activity_at` it had when dismissed. New activity ends the dismissal. */
  dismissed: Record<string, string>
}

export const EMPTY_CONFIG: TurnCheckConfig = { rules: [], muted: [], dismissed: {} }

const MAX_RULES = 200
const MAX_TEXT = 80

/** Read a config from untrusted JSON. Anything malformed is dropped, never guessed at. */
export function parseConfig(raw: unknown): TurnCheckConfig {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rules = (Array.isArray(o.rules) ? o.rules : [])
    .filter((r): r is TurnCheckRule => !!r && typeof r === 'object' && typeof r.tree === 'string' && typeof r.text === 'string' && (r.kind === 'check' || r.kind === 'not-edit'))
    .map((r) => ({ tree: r.tree, kind: r.kind, text: r.text.trim().slice(0, MAX_TEXT) }))
    .filter((r) => r.text.length >= 2 && r.tree)
    .slice(0, MAX_RULES)
  const muted = (Array.isArray(o.muted) ? o.muted : []).filter((t): t is string => typeof t === 'string' && !!t).slice(0, MAX_RULES)
  const dismissed: Record<string, string> = {}
  if (o.dismissed && typeof o.dismissed === 'object') {
    for (const [id, at] of Object.entries(o.dismissed as Record<string, unknown>).slice(0, 500)) if (typeof at === 'string') dismissed[id] = at
  }
  return { rules, muted, dismissed }
}

export type TurnCheckAction =
  | { action: 'add-rule'; tree: string; kind: TurnCheckRule['kind']; text: string }
  | { action: 'remove-rule'; index: number }
  | { action: 'mute'; tree: string }
  | { action: 'unmute'; tree: string }
  | { action: 'dismiss'; session: string; at: string }
  | { action: 'undismiss'; session: string }

/** The config after one action. Returns the same config when the action changes nothing. */
export function applyAction(config: TurnCheckConfig, a: TurnCheckAction): TurnCheckConfig {
  switch (a.action) {
    case 'add-rule': {
      const text = a.text.trim().slice(0, MAX_TEXT)
      if (text.length < 2 || !a.tree || config.rules.length >= MAX_RULES) return config
      if (config.rules.some((r) => r.tree === a.tree && r.kind === a.kind && r.text === text)) return config
      return { ...config, rules: [...config.rules, { tree: a.tree, kind: a.kind, text }] }
    }
    case 'remove-rule':
      return Number.isInteger(a.index) && a.index >= 0 && a.index < config.rules.length ? { ...config, rules: config.rules.filter((_, i) => i !== a.index) } : config
    case 'mute':
      return !a.tree || config.muted.includes(a.tree) ? config : { ...config, muted: [...config.muted, a.tree] }
    case 'unmute':
      return { ...config, muted: config.muted.filter((t) => t !== a.tree) }
    case 'dismiss':
      return a.session && a.at ? { ...config, dismissed: { ...config.dismissed, [a.session]: a.at } } : config
    case 'undismiss': {
      const { [a.session]: _gone, ...rest } = config.dismissed
      return { ...config, dismissed: rest }
    }
  }
}

/**
 * Turn a posted form into an action, or null when it is not one this board offered. A tree
 * must be one the board is showing, and a dismissal takes its time from the board's own row,
 * not from the form, so a form cannot name what it likes.
 */
export function parseAction(form: Record<string, string>, known: { trees: string[]; sessions: Record<string, string | null> }, config: TurnCheckConfig): TurnCheckAction | null {
  const tree = form.tree || ''
  const shown = known.trees.includes(tree)
  switch (form.action) {
    case 'add-rule':
      return shown && (form.kind === 'check' || form.kind === 'not-edit') && (form.text || '').trim().length >= 2 ? { action: 'add-rule', tree, kind: form.kind, text: form.text } : null
    case 'remove-rule': {
      const index = Number(form.index)
      return Number.isInteger(index) && index >= 0 && index < config.rules.length ? { action: 'remove-rule', index } : null
    }
    case 'mute':
      return shown ? { action: 'mute', tree } : null
    case 'unmute':
      return config.muted.includes(tree) ? { action: 'unmute', tree } : null
    case 'dismiss': {
      const at = known.sessions[form.session || '']
      return at ? { action: 'dismiss', session: form.session, at } : null
    }
    case 'undismiss':
      return form.session && form.session in config.dismissed ? { action: 'undismiss', session: form.session } : null
    default:
      return null
  }
}

/** The rule texts that apply to one working tree. */
export function rulesFor(config: TurnCheckConfig, tree: string): { checks: string[]; notEdits: string[] } {
  const mine = config.rules.filter((r) => r.tree === '*' || r.tree === tree)
  return { checks: mine.filter((r) => r.kind === 'check').map((r) => r.text), notEdits: mine.filter((r) => r.kind === 'not-edit').map((r) => r.text) }
}

/* ── The rule itself ───────────────────────────────────────────────────── */

/** Why a row got its word. Shown on the local page only; it holds command text. */
export interface TurnEvidence {
  /** How the last edit was made. */
  via: 'tool' | 'shell'
  /** The edit: a tool name, or the part of the shell command that was taken as an edit. */
  edit: string
  /** Shell commands that ran after the last edit, oldest first. None of them counted as a check. */
  after: string[]
}

export interface TurnCheckDetail {
  result: TurnCheck
  via: 'tool' | 'shell' | null
  evidence: TurnEvidence | null
}

type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean; input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown } }
const blocks = (rec: TranscriptRecord): Block[] => (Array.isArray(rec.message?.content) ? (rec.message!.content as Block[]).filter((b) => !!b && typeof b === 'object') : [])

/** A record in which a person typed: a user record that is not only tool results. */
function isPrompt(rec: TranscriptRecord): boolean {
  if (rec.type !== 'user' || rec.isSidechain) return false
  const content = rec.message?.content
  return typeof content === 'string' ? content.trim() !== '' : blocks(rec).some((b) => b.type === 'text' || b.type === 'image')
}

const short = (command: string, max = 120) => {
  const one = redactSecrets(command.replace(/\s+/g, ' ').trim()).text
  return one.length > max ? one.slice(0, max).trimEnd() + '…' : one
}

/**
 * Whether a check ran after the last file edit of the current turn. `records` is the
 * transcript tail, newest last.
 *
 * Measured 2026-11-21 on 9 local transcripts: of 781 results of a check-shaped shell command,
 * 14 carried `is_error: true`. The flag follows the command's exit status, so a check whose
 * output is piped into another program can fail and still read as passed. "checked" therefore
 * means a check ran, not that the work is right.
 *
 * Not seen: a check a subagent ran, and a file changed by a formatter or a generator.
 */
export function deriveTurnCheckDetail(records: TranscriptRecord[], rules: { checks?: string[]; notEdits?: string[]; shellEdits?: boolean } = {}): TurnCheckDetail {
  const extraChecks = rules.checks ?? []
  const notEdits = rules.notEdits ?? []
  const isCheck = (command: string) => looksLikeACheck(command) || extraChecks.some((text) => command.includes(text))
  let start = -1
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i] && isPrompt(records[i])) {
      start = i
      break
    }
  }
  let step = 0
  let lastEdit = -1
  let edit: { via: 'tool' | 'shell'; text: string } | null = null
  const shell: Array<{ step: number; id: string | undefined; command: string; check: boolean }> = []
  const errored = new Set<string>()
  for (const rec of records.slice(start + 1)) {
    if (!rec || rec.isSidechain) continue
    for (const block of blocks(rec)) {
      step += 1
      if (block.type === 'tool_result' && block.is_error === true && block.tool_use_id) errored.add(block.tool_use_id)
      if (block.type !== 'tool_use' || !block.name) continue
      if (EDIT_TOOLS.has(block.name)) {
        // A note or a file in scratch space is not work that a check would cover.
        const file = block.input?.file_path ?? block.input?.notebook_path
        if (typeof file === 'string' && !isCodePath(file)) continue
        lastEdit = step
        edit = { via: 'tool', text: block.name }
      } else if (block.name === 'Bash' && typeof block.input?.command === 'string') {
        const command = block.input.command
        const check = isCheck(command)
        shell.push({ step, id: block.id, command, check })
        // A command that checks is not also counted as an edit: `npm run build > build.log` is a check.
        const changed = check || rules.shellEdits === false ? '' : shellEdit(command)
        if (changed && !notEdits.some((text) => changed.includes(text) || command.includes(text))) {
          lastEdit = step
          edit = { via: 'shell', text: changed }
        }
      }
    }
  }
  if (lastEdit < 0 || !edit) return { result: start >= 0 ? 'no-edits' : 'unknown', via: null, evidence: null }
  const after = shell.filter((c) => c.step > lastEdit)
  const checks = after.filter((c) => c.check)
  const last = checks[checks.length - 1]
  const result: TurnCheck = !last ? 'unchecked' : last.id && errored.has(last.id) ? 'failed' : 'checked'
  const evidence: TurnEvidence | null =
    result === 'unchecked' || result === 'failed'
      ? { via: edit.via, edit: edit.via === 'shell' ? short(edit.text) : edit.text, after: [...new Set(after.filter((c) => !c.check).map((c) => short(c.command, 80)))].slice(-6) }
      : null
  return { result, via: edit.via, evidence }
}

export function deriveTurnCheck(records: TranscriptRecord[], rules?: Parameters<typeof deriveTurnCheckDetail>[1]): TurnCheck {
  return deriveTurnCheckDetail(records, rules).result
}
