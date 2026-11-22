/**
 * JQ Groundcrew: read the facts of one project's Claude Code setup from disk.
 *
 * It uses the filesystem and nothing else: no database, no network and no `import.meta`,
 * so it can be bundled into another tool.
 *
 * What it reads: the settings files, the instruction files (line counts, and the commands they
 * restrict), the names of skills,
 * subagents and commands, and the names of MCP servers. What it never reads: the contents of
 * a secrets file (it lists names such as "apps/api/.env" only) and session transcripts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import os from 'os'
import path from 'path'
import { findRestrictedCommands, findUnattendedRuns, packageOf, type McpPackage, type MemoryFile, type RestrictedCommand, type SettingsFile, type SetupFacts } from './groundcrew-core.js'

const SECRET_NAMES = /^(\.env(\..+)?|secrets?(\..+)?|credentials(\..+)?|.*\.pem|id_rsa)$/i
const NOT_SECRET = /\.(example|sample|template)$/i
const SECRET_DEPTH = 3
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'coverage'])

const home = () => os.homedir()
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude')
export const tilde = (file: string) => (file.startsWith(home()) ? `~${file.slice(home().length)}` : file)

/**
 * Whether this process may list the project folder. A background process on macOS is refused
 * folders such as ~/Desktop, and a refused folder looks the same as an empty one to
 * `existsSync`. A caller must check this first, or every check would report "nothing found".
 */
export function canRead(project: string): boolean {
  try {
    readdirSync(project)
    return true
  } catch {
    return false
  }
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/** Count files under a directory that pass a test, descending into subdirectories. */
/** Names of the plain files directly in a folder that pass the test. Empty when the folder cannot be read. */
function listFiles(dir: string, test: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** A file's text, or null when it cannot be read or is over 512 KB. */
function readText(file: string): string | null {
  try {
    return statSync(file).size > 512 * 1024 ? null : readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function countFiles(dir: string, test: (name: string) => boolean): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name), test)
    else if (test(entry.name)) total += 1
  }
  return total
}

/** Every Markdown file under a directory, descending into subdirectories. */
function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? markdownFiles(path.join(dir, entry.name)) : entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : [],
  )
}

/**
 * List files whose NAME marks them as holding secrets, down to a few levels, so a monorepo's
 * apps/api/.env is found. It lists names and never opens a file. Dependency and build folders
 * are skipped.
 */
function findSecretFiles(root: string, relative: string, depth: number): string[] {
  const dir = path.join(root, relative)
  if (depth > SECRET_DEPTH || !existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) found.push(...findSecretFiles(root, here, depth + 1))
    } else if (SECRET_NAMES.test(entry.name) && !NOT_SECRET.test(entry.name)) {
      found.push(here)
    }
  }
  return found
}

/** The command of each command hook: hooks.<Event>[].hooks[].command, the nesting the docs give. */
function hookCommands(hooks: Record<string, any>): Array<{ event: string; command: string }> {
  const found: Array<{ event: string; command: string }> = []
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof handler?.command === 'string') found.push({ event, command: handler.command })
      }
    }
  }
  return found
}

/** Each subagent file under a folder, and whether its frontmatter limits its tools. */
function subagentFiles(dir: string): Array<{ name: string; limitsTools: boolean }> {
  if (!existsSync(dir)) return []
  const found: Array<{ name: string; limitsTools: boolean }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...subagentFiles(file))
    else if (entry.name.endsWith('.md')) {
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf-8'))?.[1] ?? ''
      found.push({ name: entry.name.replace(/\.md$/, ''), limitsTools: /^(tools|disallowedTools)\s*:/m.test(frontmatter) })
    }
  }
  return found
}

const isMarkdown = (name: string) => name.endsWith('.md')
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

export function gather(project: string): { facts: SetupFacts; filesRead: string[] } {
  const filesRead: string[] = []
  const label = (file: string) => (file.startsWith(project + path.sep) ? file.slice(project.length + 1) : tilde(file))

  const restricted: RestrictedCommand[] = []
  const memoryFile = (file: string, instructions = true): MemoryFile | null => {
    if (!existsSync(file) || !statSync(file).isFile()) return null
    const text = readFileSync(file, 'utf-8')
    filesRead.push(label(file))
    if (instructions) restricted.push(...findRestrictedCommands(text, label(file)))
    return { label: label(file), lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), bytes: Buffer.byteLength(text) }
  }
  const memory = [
    path.join(project, 'CLAUDE.md'),
    path.join(project, '.claude', 'CLAUDE.md'),
    path.join(project, 'CLAUDE.local.md'),
    path.join(project, 'AGENTS.md'),
    path.join(configDir(), 'CLAUDE.md'),
  ]
    .map((file) => memoryFile(file))
    .filter((file): file is MemoryFile => file !== null)
  // Rule files are instructions too. They are read for restricted commands and counted below.
  for (const dir of [path.join(project, '.claude', 'rules'), path.join(configDir(), 'rules')]) {
    for (const file of markdownFiles(dir)) restricted.push(...findRestrictedCommands(readFileSync(file, 'utf-8'), label(file)))
  }

  const settingsFile = (scope: SettingsFile['scope'], file: string): SettingsFile | null => {
    const json = readJson(file)
    if (!json) return null
    filesRead.push(label(file))
    const permissions = json.permissions || {}
    const hooks = json.hooks && typeof json.hooks === 'object' ? json.hooks : {}
    return {
      scope,
      label: label(file),
      allow: strings(permissions.allow),
      ask: strings(permissions.ask),
      deny: strings(permissions.deny),
      defaultMode: typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null,
      additionalDirectories: strings(permissions.additionalDirectories).length,
      hookEvents: Object.keys(hooks).filter((event) => Array.isArray(hooks[event]) && hooks[event].length > 0),
      hookCommands: hookCommands(hooks),
      sandboxEnabled: typeof json.sandbox?.enabled === 'boolean' ? json.sandbox.enabled : null,
      cleanupPeriodDays: typeof json.cleanupPeriodDays === 'number' ? json.cleanupPeriodDays : null,
    }
  }
  const managed =
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
        : '/etc/claude-code/managed-settings.json'
  const settings = [
    settingsFile('managed', managed),
    settingsFile('local', path.join(project, '.claude', 'settings.local.json')),
    settingsFile('project', path.join(project, '.claude', 'settings.json')),
    settingsFile('user', path.join(configDir(), 'settings.json')),
  ].filter((file): file is SettingsFile => file !== null)

  // MCP servers: names are counted, and the package each is fetched as is read. ~/.claude.json also
  // holds account data, so only the two server maps are touched.
  const projectMcp = readJson(path.join(project, '.mcp.json'))
  const userConfig = readJson(path.join(home(), '.claude.json'))
  const userServers = Object.keys(userConfig?.mcpServers || {}).length + Object.keys(userConfig?.projects?.[project]?.mcpServers || {}).length
  if (projectMcp) filesRead.push('.mcp.json')
  if (userConfig) filesRead.push('~/.claude.json (MCP server names and the package each is fetched as)')
  // Of each server entry, only its name and the package a runner fetches it as are kept. The
  // other arguments and every environment value are never copied: either can hold a key.
  const fetched = (servers: unknown, scope: 'project' | 'user'): McpPackage[] =>
    Object.entries(servers && typeof servers === 'object' ? (servers as Record<string, any>) : {}).flatMap(([name, entry]) => {
      if (!entry || typeof entry.command !== 'string') return []
      const found = packageOf(entry.command, Array.isArray(entry.args) ? entry.args.filter((a: unknown): a is string => typeof a === 'string') : [])
      return found ? [{ name, scope, ...found }] : []
    })
  const mcpPackages = [...fetched(projectMcp?.mcpServers, 'project'), ...fetched(userConfig?.mcpServers, 'user'), ...fetched(userConfig?.projects?.[project]?.mcpServers, 'user')]

  // Where a run with no person present is started. Each file is read for two patterns and only
  // the file and line of a match are kept.
  const runFiles = [
    ...listFiles(path.join(project, '.github', 'workflows'), (n) => /\.ya?ml$/.test(n)).map((n) => `.github/workflows/${n}`),
    ...['package.json', 'Makefile', 'justfile'].filter((n) => existsSync(path.join(project, n))),
    ...['', 'scripts', 'bin', '.claude/scripts'].flatMap((dir) => listFiles(path.join(project, dir), (n) => /\.(sh|bash|zsh)$/.test(n)).map((n) => (dir ? `${dir}/${n}` : n))),
  ].slice(0, 300)
  const unattendedRuns = runFiles.flatMap((rel) => {
    const text = readText(path.join(project, rel))
    return text === null ? [] : findUnattendedRuns(rel, text)
  })
  if (runFiles.length) filesRead.push(`${runFiles.length} workflow, package-script and shell-script ${runFiles.length === 1 ? 'file' : 'files'} (for claude -p and the GitHub action)`)

  const encoded = project.replace(/[^a-zA-Z0-9]/g, '-')
  return {
    filesRead,
    facts: {
      platform: process.platform,
      memory,
      ruleFiles: countFiles(path.join(project, '.claude', 'rules'), isMarkdown) + countFiles(path.join(configDir(), 'rules'), isMarkdown),
      autoMemoryIndex: memoryFile(path.join(configDir(), 'projects', encoded, 'memory', 'MEMORY.md'), false),
      settings,
      skills: {
        project: countFiles(path.join(project, '.claude', 'skills'), (name) => name === 'SKILL.md'),
        user: countFiles(path.join(configDir(), 'skills'), (name) => name === 'SKILL.md'),
      },
      subagents: {
        project: countFiles(path.join(project, '.claude', 'agents'), isMarkdown),
        user: countFiles(path.join(configDir(), 'agents'), isMarkdown),
      },
      subagentFiles: [...subagentFiles(path.join(project, '.claude', 'agents')), ...subagentFiles(path.join(configDir(), 'agents'))],
      legacyCommands: countFiles(path.join(project, '.claude', 'commands'), isMarkdown),
      mcpServers: { project: Object.keys(projectMcp?.mcpServers || {}).length, user: userServers },
      secretFiles: findSecretFiles(project, '', 0).sort(),
      restricted,
      mcpPackages,
      unattendedRuns,
    },
  }
}
