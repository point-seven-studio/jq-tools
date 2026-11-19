/**
 * JQ Agents: the I/O half of resource sampling. Shells out; parsing and
 * judgment live in host-metrics.ts so they can be golden-tested.
 *
 * Runs on your own machine. The commands are macOS ones (vm_stat, sysctl, iostat,
 * nettop); elsewhere they are missing and the sample is nulls. Everything here is best-effort: a missing binary,
 * a sandboxed environment or a slow disk must degrade the sample to nulls, not
 * kill the sweep. A board that stops updating because iostat wasn't on PATH is
 * a worse outcome than a board with one blank column.
 *
 * SCOPE. This reads host telemetry about the operator's OWN machines — load,
 * memory, per-process CPU and byte counters. It never reads session content;
 * that stays behind the per-tree question allowlist.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import {
  parsePs,
  parseNettop,
  parseVmStat,
  parseLoadAvg,
  parseSwapUsedMb,
  parseIostat,
  type HostSample,
  type ProcSample,
  type NetSample,
} from './host-metrics.js'

const execFileAsync = promisify(execFile)

/** The endpoint whose reachability actually matters to a session. */
const PROBE_URL = 'https://api.anthropic.com/'

async function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

/**
 * TLS connect time to the API, sampled three times.
 *
 * NOT ping, and this is the whole reason the function exists. Measured
 * 2026-08-19: `ping api.anthropic.com` reports ~50% packet loss because the
 * edge deprioritises ICMP, and `ping <default gateway>` reported 100% loss
 * because that router drops ICMP outright. Either would have driven a
 * permanent, confident, wrong "network is the bottleneck" verdict. A TLS
 * handshake uses the same path, port and protocol the session does, and cannot
 * be filtered away like that.
 *
 * Jitter is the spread across the samples — variance costs an agentic turn more
 * than latency does, because one turn is dozens of sequential round trips.
 */
export async function probeLatency(): Promise<{ rttMs: number | null; jitterMs: number | null }> {
  const samples: number[] = []
  for (let i = 0; i < 3; i++) {
    const out = await run(
      'curl',
      ['-sS', '-o', '/dev/null', '-w', '%{time_connect}', '--max-time', '3', PROBE_URL],
      5000,
    )
    const t = Number(out)
    if (Number.isFinite(t) && t > 0) samples.push(t * 1000)
  }
  if (samples.length === 0) return { rttMs: null, jitterMs: null }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const variance =
    samples.length > 1
      ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples.length - 1)
      : 0
  return { rttMs: Math.round(mean), jitterMs: Math.round(Math.sqrt(variance)) }
}

/**
 * `probe` is off unless asked for: it is the one outbound connection this package
 * can make (a TLS handshake to the API host, timed; nothing is sent). Without it
 * the network columns are null and the verdict cannot name the network.
 */
export async function sampleHost(probe = false): Promise<HostSample> {
  const [vmstat, swap, load, iostat, latency] = await Promise.all([
    run('vm_stat', []),
    run('sysctl', ['-n', 'vm.swapusage']),
    run('sysctl', ['-n', 'vm.loadavg']),
    // Two samples a second apart: the first row iostat prints is a since-boot
    // average that never moves, so a single-shot call reads as a flat line.
    run('iostat', ['-d', '-w', '1', '-c', '2'], 6000),
    probe ? probeLatency() : Promise.resolve({ rttMs: null, jitterMs: null }),
  ])
  const disk = parseIostat(iostat)
  return {
    cpuCount: os.cpus()?.length || 0,
    load1: parseLoadAvg(load) || os.loadavg()[0] || 0,
    memUsedPct: parseVmStat(vmstat, os.totalmem()),
    swapUsedMb: parseSwapUsedMb(swap),
    diskReadMbs: disk?.readMbs ?? null,
    diskWriteMbs: disk?.writeMbs ?? null,
    rttMs: latency.rttMs,
    jitterMs: latency.jitterMs,
  }
}

/**
 * Per-process CPU/RSS and cumulative byte counters for the given pids.
 *
 * nettop is called ONCE for the whole process table rather than once per pid:
 * each invocation costs about a second, so per-pid calls would make the sweep
 * scale with fleet size — the relay would spend a minute sampling a fleet of
 * sixty.
 *
 * Expect gaps. `nettop -l 1` is an instantaneous snapshot listing only sockets
 * live in that instant — measured here, it returned 36 rows and included three
 * claude processes while omitting two others that were plainly running. A pid
 * absent from the snapshot yields no sample and therefore a NULL rate, which is
 * the honest reading: "not measured this tick", not "moved no bytes".
 */
export async function sampleProcs(pids: number[]): Promise<{
  procs: Map<number, ProcSample>
  net: Map<number, NetSample>
}> {
  if (pids.length === 0) return { procs: new Map(), net: new Map() }
  const [ps, nettop] = await Promise.all([
    run('ps', ['-o', 'pid=,pcpu=,rss=', '-p', pids.join(',')]),
    run('nettop', ['-P', '-x', '-l', '1'], 10000),
  ])
  const all = parseNettop(nettop)
  const net = new Map<number, NetSample>()
  for (const pid of pids) {
    const s = all.get(pid)
    if (s) net.set(pid, s)
  }
  return { procs: parsePs(ps), net }
}
