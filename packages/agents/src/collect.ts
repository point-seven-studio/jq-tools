/**
 * JQ Agents: read what every Claude Code session on this machine is doing.
 *
 * It reverse-reads the tail of each session transcript under ~/.claude/projects
 * and matches live sessions by working tree. It reads files and the process
 * table. It never writes into a session, sends a message or touches a socket.
 *
 * ⚠️ The transcript files and the socket folder are Claude Code internals. Their
 * format is not a public interface and can change in any release; when it does,
 * rows degrade (unknown state, no question text) and this file is what to fix.
 *
 * Privacy:
 *   - reads YOUR ~/.claude/projects only, never another account's home;
 *   - question text is copied only for trees on the allowlist, truncated and
 *     secret-redacted; every other tree reports liveness only;
 *   - the allowlist is EMPTY by default, so a tree nobody thought about fails closed.
 *
 * Three measured traps this code exists to avoid:
 *   1. Transcripts nest at several depths under ~/.claude/projects. A fixed-depth
 *      glob sees an arbitrary slice and looks like it worked. Hence the recursive walk.
 *   2. Transcripts get big (hundreds of MB). Hence reverse-read from the end.
 *   3. Socket files are named by PID and outlive a dead session. Hence the explicit
 *      liveness check.
 */
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { open, readdir, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { buildStatusRow, type AgentStatusRow, type TranscriptRecord } from './agent-status.js'
import { deriveBottleneck, rateBps, type Bottleneck, type HostSample, type NetSample } from './host-metrics.js'
import { sampleHost, sampleProcs } from './host-sampler.js'

const execFileAsync = promisify(execFile)

export interface CollectOptions {
  /** Default ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects). */
  projectsDir?: string
  /** Default /tmp/cc-socks. */
  sockDir?: string
  /** Trees allowed to report question text. Default: none. */
  questionTrees?: string[]
  /** Skip transcripts untouched for longer than this. Default 3. */
  maxAgeDays?: number
  machine?: string
  now?: number
}

export function defaultProjectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
}

/** Transcript records read from the tail: enough to get past metadata records. */
const TAIL_RECORDS = 60

/** Recursive walk, NEVER a fixed-depth glob (trap 1). */
async function findTranscripts(dir: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await findTranscripts(full, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/**
 * A cwd normalized to its git repo root. A session's cwd follows it into
 * subdirectories, which would name the product after a subfolder and break the
 * match between a live process and its tree. Both sides go through here.
 */
const rootCache = new Map<string, string>()
async function repoRoot(dir: string): Promise<string> {
  if (!dir) return dir
  const cached = rootCache.get(dir)
  if (cached) return cached
  let cur = dir
  for (let i = 0; i < 12; i++) {
    try {
      await stat(path.join(cur, '.git')) // a folder, or a file in a worktree
      break
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) {
        cur = dir // no repo above it: keep the original
        break
      }
      cur = parent
    }
  }
  rootCache.set(dir, cur)
  return cur
}

/** The last `n` complete JSONL records, without loading the file (trap 2). */
export async function tailRecords(file: string, n = TAIL_RECORDS): Promise<TranscriptRecord[]> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const chunk = 128 * 1024
    let pos = size
    let buf = Buffer.alloc(0)
    while (pos > 0 && buf.toString('utf8').split('\n').length <= n + 1) {
      const start = Math.max(0, pos - chunk)
      const len = pos - start
      const b = Buffer.alloc(len)
      await fh.read(b, 0, len, start)
      buf = Buffer.concat([b, buf])
      pos = start
      if (buf.length > 8 * 1024 * 1024) break // hard cap; one record is never this big
    }
    const recs: TranscriptRecord[] = []
    // The first line may be a fragment if the read began mid-record; JSON.parse drops it.
    for (const line of buf.toString('utf8').split('\n').filter((l) => l.trim()).slice(-n)) {
      try {
        recs.push(JSON.parse(line))
      } catch {
        /* partial or non-JSON line */
      }
    }
    return recs
  } finally {
    await fh.close()
  }
}

/** Live session PIDs: socket filenames, each checked against the process table (trap 3). */
async function liveSessionPids(sockDir: string): Promise<number[]> {
  let files: string[] = []
  try {
    files = await readdir(sockDir)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.sock'))
    .map((f) => Number(f.replace('.sock', '')))
    .filter((p) => Number.isInteger(p) && p > 0)
    .filter((pid) => {
      try {
        process.kill(pid, 0) // signal 0: only asks whether the process exists
        return true
      } catch {
        return false
      }
    })
}

/**
 * Live PID by working tree. There is no direct join from a PID to a session id,
 * so liveness is matched by tree. That is coarse when several sessions share a
 * tree, which is how the board groups them anyway.
 */
async function pidCwds(pids: number[]): Promise<Map<string, number>> {
  const byCwd = new Map<string, number>()
  if (pids.length === 0) return byCwd
  try {
    // An absolute path first. Under a background service the PATH is minimal, and
    // a missing lsof does not fail loudly: every session just reads as dead.
    const lsof = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof'
    const { stdout } = await execFileAsync(lsof, ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], { maxBuffer: 4 * 1024 * 1024 })
    let current: number | null = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1))
      else if (line.startsWith('n') && current) {
        const cwd = await repoRoot(line.slice(1))
        if (!byCwd.has(cwd)) byCwd.set(cwd, current)
      }
    }
  } catch {
    /* lsof unavailable: every row degrades to dead, which is the safe direction */
  }
  return byCwd
}

export async function collectRows(opts: CollectOptions = {}): Promise<AgentStatusRow[]> {
  const now = opts.now ?? Date.now()
  const machine = opts.machine ?? os.hostname()
  const files = await findTranscripts(opts.projectsDir ?? defaultProjectsDir())
  const cwdToPid = await pidCwds(await liveSessionPids(opts.sockDir ?? '/tmp/cc-socks'))
  const cutoff = now - (opts.maxAgeDays ?? 3) * 86_400_000

  const rows: AgentStatusRow[] = []
  for (const file of files) {
    try {
      if ((await stat(file)).mtimeMs < cutoff) continue // a finished session is not status
      const records = await tailRecords(file)
      if (records.length === 0) continue
      const rawCwd = [...records].reverse().find((r) => r?.cwd)?.cwd || ''
      const tree = rawCwd ? await repoRoot(rawCwd) : ''
      const pid = tree ? (cwdToPid.get(tree) ?? null) : null
      const row = buildStatusRow({
        machine,
        records,
        workingTreeOverride: tree || undefined,
        sessionIdFallback: path.basename(file, '.jsonl'),
        alive: pid !== null,
        pid,
        allowlist: opts.questionTrees ?? [],
        now,
      })
      if (row) rows.push(row)
    } catch {
      /* one unreadable transcript must not end the sweep */
    }
  }
  // A resumed session can have several transcripts with one id; keep the freshest,
  // so anything that stores rows by session id never sees a duplicate key.
  const byKey = new Map<string, AgentStatusRow>()
  for (const r of rows) {
    const prev = byKey.get(r.session_id)
    if (!prev || (r.last_activity_at || '') > (prev.last_activity_at || '')) byKey.set(r.session_id, r)
  }
  return [...byKey.values()]
}

export interface Snapshot {
  machine: string
  generated_at: string
  sessions: AgentStatusRow[]
  /** null when sampling was skipped or failed. */
  host: HostSample | null
  bottleneck: Bottleneck | null
}

/**
 * Byte counters from the previous snapshot, per pid, so a rate can be derived.
 * In memory on purpose: it is meaningless after a restart, so a one-shot run
 * reports null rates, which is the honest answer.
 */
let prevNet = new Map<number, { sample: NetSample; at: number }>()

export async function snapshot(opts: CollectOptions & { sample?: boolean; probe?: boolean } = {}): Promise<Snapshot> {
  const sessions = await collectRows(opts)
  let host: HostSample | null = null
  let bottleneck: Bottleneck | null = null
  if (opts.sample !== false) {
    // After the sweep, and wrapped: liveness is the product, resource numbers are
    // the bonus, and a missing iostat must not cost the former.
    try {
      const pids = sessions.map((r) => r.pid).filter((p): p is number => typeof p === 'number')
      const [h, proc] = await Promise.all([sampleHost(opts.probe === true), sampleProcs(pids)])
      const at = Date.now()
      for (const row of sessions) {
        if (row.pid == null) continue
        const p = proc.procs.get(row.pid)
        if (p) {
          row.cpu_pct = p.cpuPct
          row.rss_mb = Math.round(p.rssMb * 10) / 10
        }
        const cur = proc.net.get(row.pid)
        const prev = prevNet.get(row.pid)
        if (cur && prev) {
          const seconds = (at - prev.at) / 1000
          row.net_rx_bps = rateBps(prev.sample.bytesIn, cur.bytesIn, seconds)
          row.net_tx_bps = rateBps(prev.sample.bytesOut, cur.bytesOut, seconds)
        }
      }
      prevNet = new Map([...proc.net].map(([pid, sample]) => [pid, { sample, at }]))
      host = h
      bottleneck = deriveBottleneck(h)
    } catch {
      host = null
      bottleneck = null
    }
  }
  return { machine: opts.machine ?? os.hostname(), generated_at: new Date(opts.now ?? Date.now()).toISOString(), sessions, host, bottleneck }
}
