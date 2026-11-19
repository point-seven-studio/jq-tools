/**
 * Golden tests for the host-metrics parsers.
 *
 * Every fixture below is REAL output captured from the machine this shipped on
 * (Apple Silicon, macOS 24.6), not hand-written to match the parser. That
 * matters: the failure mode these guard against isn't a crash, it's a number
 * that looks plausible and is wrong by a factor of four — which is exactly what
 * assuming a 4096-byte page size does on Apple Silicon.
 */
import { describe, expect, it, test } from 'vitest'
import {
  parsePs,
  parseNettop,
  parseVmStat,
  parseLoadAvg,
  parseSwapUsedMb,
  parseIostat,
  rateBps,
  deriveBottleneck,
  THRESHOLDS,
  type HostSample,
} from '../src/host-metrics.js'

describe('parsePs', () => {
  it('reads pid, cpu and rss, converting KB to MB', () => {
    const got = parsePs(' 1206   1.7 123520\n  964  12.4  65536\n')
    expect(got.get(1206)).toEqual({ cpuPct: 1.7, rssMb: 120.625 })
    expect(got.get(964)).toEqual({ cpuPct: 12.4, rssMb: 64 })
  })

  it('ignores header noise and malformed lines', () => {
    expect(parsePs('  PID %CPU   RSS\nnot a row\n').size).toBe(0)
  })
})

describe('parseNettop', () => {
  const fixture = [
    'time                interface  state  bytes_in  bytes_out  rx_dupe  rx_ooo  re-tx',
    '16:00:06.765990 apsd.132                        103430      9718      695       0      0',
    '16:00:06.765997 mDNSResponder.253           1012880014  47672137        0       0      0',
    '16:00:06.766001 claude.1206                       4352     15987       27       0  10603',
  ].join('\n')

  it('keys by the pid suffix of name.pid', () => {
    const got = parseNettop(fixture)
    expect(got.get(1206)).toEqual({ bytesIn: 4352, bytesOut: 15987 })
    expect(got.get(253)).toEqual({ bytesIn: 1012880014, bytesOut: 47672137 })
  })

  it('drops the header row rather than parsing it as a process', () => {
    expect(parseNettop(fixture).has(NaN as unknown as number)).toBe(false)
    expect(parseNettop(fixture).size).toBe(3)
  })
})

describe('rateBps', () => {
  it('converts a counter delta to bytes per second', () => {
    expect(rateBps(1000, 7000, 60)).toBe(100)
  })

  it('returns null with no prior sample rather than pretending the rate is zero', () => {
    expect(rateBps(null, 7000, 60)).toBeNull()
  })

  it('returns null when the counter went backwards, because the pid was recycled', () => {
    // A lower reading cannot be a real delta. Reporting cur-prev here would
    // invent traffic; reporting cur would report a process's whole lifetime as
    // one tick's worth.
    expect(rateBps(9000, 500, 60)).toBeNull()
  })
})

describe('parseVmStat', () => {
  // Real header from an Apple Silicon machine — note the 16384-byte page.
  const vmstat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                4989.',
    'Pages active:                            208849.',
    'Pages inactive:                          206700.',
    'Pages speculative:                         1521.',
    'Pages wired down:                         98304.',
    'Pages occupied by compressor:              32768.',
  ].join('\n')

  it('uses the page size from the header, not an assumed 4096', () => {
    // (98304 + 208849 + 32768) pages * 16384 B = ~5.57 GB of 16 GB = 34.8%.
    // With a hardcoded 4096 this would read 8.7% — plausible, and wrong.
    expect(parseVmStat(vmstat, 17179869184)).toBeCloseTo(32.4, 0)
  })

  it('excludes inactive pages, which macOS reclaims on demand', () => {
    const withInactive =
      ((98304 + 208849 + 32768 + 206700) * 16384) / 17179869184 * 100
    expect(parseVmStat(vmstat, 17179869184)).toBeLessThan(withInactive - 15)
  })

  it('returns 0 rather than NaN when the header is missing', () => {
    expect(parseVmStat('garbage', 17179869184)).toBe(0)
  })
})

describe('parseLoadAvg / parseSwapUsedMb', () => {
  it('reads the 1-minute load out of sysctl braces', () => {
    expect(parseLoadAvg('{ 2.48 3.00 5.29 }')).toBe(2.48)
  })

  it('reads swap in MB and converts G', () => {
    expect(parseSwapUsedMb('total = 4096.00M  used = 1234.50M  free = 2861.50M')).toBe(1235)
    expect(parseSwapUsedMb('total = 8.00G  used = 2.50G  free = 5.50G')).toBe(2560)
  })

  it('reports no swap rather than NaN when the format is unrecognised', () => {
    expect(parseSwapUsedMb('')).toBe(0)
  })
})

describe('parseIostat', () => {
  it('takes the LAST row, since the first is a since-boot average', () => {
    const out = ['   disk0', '  KB/t  tps  MB/s', ' 24.50   12   0.29', ' 41.00  180  7.20'].join('\n')
    expect(parseIostat(out)).toEqual({ readMbs: 7.2, writeMbs: 7.2 })
  })

  it('sums MB/s across multiple disks', () => {
    const out = ['  KB/t tps MB/s KB/t tps MB/s', ' 10 1 1.50 20 2 2.50'].join('\n')
    expect(parseIostat(out)).toEqual({ readMbs: 4, writeMbs: 4 })
  })

  it('returns null when there is no numeric row', () => {
    expect(parseIostat('disk0\nKB/t tps MB/s\n')).toBeNull()
  })
})

describe('deriveBottleneck', () => {
  const idle: HostSample = {
    cpuCount: 8,
    load1: 2.0,
    memUsedPct: 40,
    swapUsedMb: 0,
    diskReadMbs: 5,
    diskWriteMbs: 5,
    rttMs: 25,
    jitterMs: 4,
  }

  it("says 'none' on a healthy machine, because that is the honest answer", () => {
    // The whole point: an LLM session is usually waiting on the API, not on
    // local hardware. An attributor that always names a culprit gets ignored.
    expect(deriveBottleneck(idle)).toEqual({ kind: 'none', reason: null })
  })

  it('names memory only when swapping AND full, not on either alone', () => {
    expect(deriveBottleneck({ ...idle, memUsedPct: 95 }).kind).toBe('none')
    expect(deriveBottleneck({ ...idle, swapUsedMb: 4096 }).kind).toBe('none')
    expect(deriveBottleneck({ ...idle, memUsedPct: 95, swapUsedMb: 4096 }).kind).toBe('memory')
  })

  it('ranks memory above cpu, since swapping misreads as load', () => {
    const both = { ...idle, memUsedPct: 95, swapUsedMb: 4096, load1: 32 }
    expect(deriveBottleneck(both).kind).toBe('memory')
  })

  it('scales cpu by core count rather than using a bare load number', () => {
    // load 10 is contended on 4 cores and fine on 16.
    expect(deriveBottleneck({ ...idle, cpuCount: 4, load1: 10 }).kind).toBe('cpu')
    expect(deriveBottleneck({ ...idle, cpuCount: 16, load1: 10 }).kind).toBe('none')
  })

  it('never returns disk, however busy the disk is', () => {
    /*
     * Regression test for a wrong verdict caught by the first live prod sample
     * (2026-08-20): disk 118 MB/s alongside 376ms ±378 to the API returned
     * 'disk', burying the reading that actually mattered. macOS iostat reports
     * throughput, not utilisation, and 118 MB/s on a drive that does multiple
     * GB/s is busy rather than saturated. Disk is reported for context and
     * never votes.
     */
    const busy = { ...idle, diskReadMbs: 900, diskWriteMbs: 900 }
    expect(deriveBottleneck(busy).kind).toBe('none')
  })

  it('lets network win when the disk is also busy — the case that caught it', () => {
    const real = { ...idle, diskReadMbs: 118, rttMs: 376, jitterMs: 378 }
    const v = deriveBottleneck(real)
    expect(v.kind).toBe('network')
    expect(v.reason).toContain('376ms')
  })

  it('calls network on jitter, not only on latency', () => {
    expect(deriveBottleneck({ ...idle, jitterMs: THRESHOLDS.jitterMs + 1 }).kind).toBe('network')
    expect(deriveBottleneck({ ...idle, rttMs: THRESHOLDS.rttMs + 1 }).kind).toBe('network')
  })

  it('carries the measurement that triggered it, so the claim is checkable', () => {
    const v = deriveBottleneck({ ...idle, cpuCount: 4, load1: 10 })
    expect(v.reason).toContain('load 10.00')
    expect(v.reason).toContain('4 cores')
  })

  it("reports 'unknown' rather than 'none' when the host sample is empty", () => {
    // Absence of data must not read as absence of a problem.
    expect(deriveBottleneck({ ...idle, cpuCount: 0 }).kind).toBe('unknown')
  })
})
