/**
 * JQ Agents — the deterministic core of host + per-session resource sampling.
 *
 * Same split as agent-status.ts: everything exported here is PURE (parsers and
 * one judgment function), so it can be golden-tested against captured command
 * output. The IO half — actually shelling out to ps/nettop/vm_stat/iostat —
 * lives in host-sampler.ts.
 *
 * WHY THIS EXISTS. The board answers "what is each session doing". It could not
 * answer "why is that one slow", which is the question you have when one
 * machine crawls and another doesn't. Answering it needs numbers per session,
 * not vibes per machine.
 *
 * THE HONEST DEFAULT IS "NOTHING". For an LLM session the wall clock is
 * dominated by waiting on the API, and local resources are usually idle. A
 * bottleneck attributor that always names a culprit is worse than useless — it
 * teaches people to ignore it. `deriveBottleneck` returns 'none' unless a
 * threshold is actually crossed, and every non-'none' verdict carries the
 * measurement that triggered it so a reader can check the claim.
 */

/** Per-process resource sample, keyed by pid. */
export interface ProcSample {
  cpuPct: number
  rssMb: number
}

/** Per-process cumulative network counters, keyed by pid. */
export interface NetSample {
  bytesIn: number
  bytesOut: number
}

export interface HostSample {
  cpuCount: number
  load1: number
  memUsedPct: number
  swapUsedMb: number
  diskReadMbs: number | null
  diskWriteMbs: number | null
  /** TLS connect time to the API endpoint, ms — see host-sampler for why not ping. */
  rttMs: number | null
  jitterMs: number | null
}

export type BottleneckKind = 'none' | 'cpu' | 'memory' | 'disk' | 'network' | 'unknown'

export interface Bottleneck {
  kind: BottleneckKind
  /** The measurement behind the verdict, so a reader can check rather than trust. */
  reason: string | null
}

/**
 * `ps -o pid=,pcpu=,rss=` — "  1206   1.7 123520". RSS is KB.
 *
 * Note pcpu is an average over the process's LIFETIME, not an instantaneous
 * reading; a session that pinned a core an hour ago still reports high. It is
 * kept because it is nearly free, but it is deliberately NOT used to declare a
 * CPU bottleneck — load average is, because that is a current measure.
 */
export function parsePs(stdout: string): Map<number, ProcSample> {
  const out = new Map<number, ProcSample>()
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)$/)
    if (!m) continue
    out.set(Number(m[1]), { cpuPct: Number(m[2]), rssMb: Number(m[3]) / 1024 })
  }
  return out
}

/**
 * `nettop -P -x -l 1` rows look like:
 *   16:00:06.765990 mDNSResponder.253    1012880014   47672137   0   0   0
 * i.e. time, name.pid, bytes_in, bytes_out, rx_dupe, rx_ooo, re-tx.
 *
 * The re-tx column is deliberately ignored. Measured on this machine it tracks
 * bytes_out at roughly 1:1, which cannot mean "bytes retransmitted", and a
 * number whose units are unconfirmed has no business driving a warning.
 *
 * Counters are cumulative since process start, so a rate needs two samples —
 * see `rateBps`.
 */
export function parseNettop(stdout: string): Map<number, NetSample> {
  const out = new Map<number, NetSample>()
  for (const line of stdout.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    const name = f[1]
    if (!name || !name.includes('.')) continue
    const pid = Number(name.slice(name.lastIndexOf('.') + 1))
    const bytesIn = Number(f[2])
    const bytesOut = Number(f[3])
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!Number.isFinite(bytesIn) || !Number.isFinite(bytesOut)) continue
    out.set(pid, { bytesIn, bytesOut })
  }
  return out
}

/**
 * Bytes/second between two cumulative readings.
 *
 * Returns null rather than 0 when the counter went BACKWARDS: that means the
 * pid was recycled onto a different process between ticks, and reporting the
 * difference as a rate would invent traffic that never happened.
 */
export function rateBps(prev: number | null | undefined, cur: number, seconds: number): number | null {
  if (prev == null || !Number.isFinite(prev) || seconds <= 0) return null
  if (cur < prev) return null
  return Math.round((cur - prev) / seconds)
}

/**
 * `vm_stat`. Page size comes from its own header rather than being assumed —
 * Apple Silicon uses 16384, Intel 4096, and hardcoding either silently
 * quadruples or quarters every number on the other platform.
 *
 * "Used" counts wired + active + compressed. Inactive is deliberately excluded:
 * macOS reclaims it on demand, so counting it makes a healthy machine look
 * permanently full — the single most common way this metric is reported wrong.
 */
export function parseVmStat(stdout: string, memTotalBytes: number): number {
  const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1] || 0)
  if (!pageSize || !memTotalBytes) return 0
  const pages = (label: string): number =>
    Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] || 0)
  const used =
    (pages('Pages wired down') + pages('Pages active') + pages('Pages occupied by compressor')) *
    pageSize
  return Math.min(100, Math.round((used / memTotalBytes) * 1000) / 10)
}

/** `sysctl -n vm.loadavg` → "{ 2.48 3.00 5.29 }". */
export function parseLoadAvg(stdout: string): number {
  return Number(stdout.replace(/[{}]/g, '').trim().split(/\s+/)[0] || 0)
}

/** `sysctl -n vm.swapusage` → "total = 4096.00M used = 1234.50M free = ...". */
export function parseSwapUsedMb(stdout: string): number {
  const m = stdout.match(/used\s*=\s*([\d.]+)([MG])/)
  if (!m) return 0
  const v = Number(m[1])
  return Math.round(m[2] === 'G' ? v * 1024 : v)
}

/**
 * `iostat -d -w 1 -c 2` prints a since-boot row then a live one. Only the LAST
 * row is a current rate; using the first reports the machine's lifetime average
 * and never moves.
 */
export function parseIostat(stdout: string): { readMbs: number; writeMbs: number } | null {
  const rows = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\d.\s]+$/.test(l) && l.length > 0)
  const last = rows[rows.length - 1]
  if (!last) return null
  const f = last.split(/\s+/).map(Number)
  // Columns per disk are KB/t, tps, MB/s. One disk is the common case; with
  // several, sum the MB/s of each triple.
  let mbs = 0
  for (let i = 2; i < f.length; i += 3) if (Number.isFinite(f[i])) mbs += f[i]
  if (!Number.isFinite(mbs)) return null
  // iostat does not split read from write, so report the combined figure in
  // both fields rather than inventing a split.
  return { readMbs: Math.round(mbs * 100) / 100, writeMbs: Math.round(mbs * 100) / 100 }
}

/** Thresholds, named so the dashboard and the tests agree on one source. */
export const THRESHOLDS = {
  /** load per core above which the machine is genuinely contended */
  loadPerCore: 1.5,
  /** % of RAM in wired+active+compressed */
  memUsedPct: 90,
  /**
   * Swap in use, MB. Paired with memUsedPct because on its own it is a WEAK
   * signal, and this machine proves it: measured 23.9 GB of swap used on 16 GB
   * of RAM while memory sat at 67% and the machine was responsive. macOS
   * swapusage is close to cumulative — it reflects what has been paged out at
   * some point, not what is being paged now — so a high figure alone says
   * little about current pressure.
   *
   * The RIGHT current-pressure signal is the swapin/swapout RATE, which needs
   * two vm_stat samples the way byte counters need two nettop samples. Until
   * that exists, this stays conservative and deliberately under-reports: a
   * false 'memory-bound' on a healthy machine would teach people to ignore the
   * chip, which is the failure this whole feature is trying to avoid.
   */
  swapUsedMb: 1024,
  /*
   * NO DISK THRESHOLD — deliberately removed after it produced a wrong verdict
   * against real data.
   *
   * First live sample on prod (2026-08-20) read disk 118 MB/s alongside
   * 376ms ±378 to the API. It returned 'disk'. That is backwards: 376ms of
   * latency with more jitter than latency is the thing costing that session
   * time, while 118 MB/s on an NVMe drive that does multiple GB/s is a disk
   * that is busy, not one that is saturated.
   *
   * The deeper problem is that throughput is the wrong measure entirely.
   * Saturation is utilisation or queue wait — %util and await on Linux — and
   * macOS iostat reports neither. There is no honest disk verdict to be had
   * from the numbers available, so disk_read_mbs / disk_write_mbs are still
   * sampled and still displayed for context, and they no longer vote.
   *
   * This is the rule that keeps the board trustworthy: a signal that cannot
   * justify its verdict is reported, not ruled on.
   */
  /** TLS connect jitter, ms — variance hurts an agentic loop more than latency */
  jitterMs: 60,
  /** TLS connect time, ms */
  rttMs: 400,
} as const

/**
 * Which resource, if any, is actually holding this session back.
 *
 * Ordered by how directly the reader can act on it, and gated so that a quiet
 * machine reports 'none'. Memory first: swapping degrades everything else and
 * misreads as CPU. Then CPU, then network. Disk deliberately never votes — see
 * THRESHOLDS for the real sample that removed it.
 *
 * Network is judged from HOST-level link quality, not from the session's byte
 * counters. A session moving few bytes on a bad link is still network-bound —
 * it is waiting on round trips, not throughput — so byte volume is reported
 * for context but never used to declare the verdict.
 */
export function deriveBottleneck(host: HostSample): Bottleneck {
  if (!host.cpuCount) return { kind: 'unknown', reason: null }

  if (host.swapUsedMb > THRESHOLDS.swapUsedMb && host.memUsedPct > THRESHOLDS.memUsedPct) {
    return {
      kind: 'memory',
      reason: `${host.memUsedPct}% RAM in use, ${host.swapUsedMb}MB swapped`,
    }
  }
  const perCore = host.load1 / host.cpuCount
  if (perCore > THRESHOLDS.loadPerCore) {
    return {
      kind: 'cpu',
      reason: `load ${host.load1.toFixed(2)} across ${host.cpuCount} cores (${perCore.toFixed(1)}x)`,
    }
  }
  if (host.jitterMs != null && host.jitterMs > THRESHOLDS.jitterMs) {
    return { kind: 'network', reason: `${host.rttMs}ms ±${host.jitterMs} to the API` }
  }
  if (host.rttMs != null && host.rttMs > THRESHOLDS.rttMs) {
    return { kind: 'network', reason: `${host.rttMs}ms to the API` }
  }
  return { kind: 'none', reason: null }
}
