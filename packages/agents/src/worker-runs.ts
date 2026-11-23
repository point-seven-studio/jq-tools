/**
 * How the runs of a JQ Crosstalk worker ended, for the signals page.
 *
 * A crosstalk worker starts a headless run when mail arrives, and writes one line for each
 * run to `<mailbox>/worker/<name>/runs.jsonl`, with how it ended. This reads those files.
 * The mailbox is the one `$CROSSTALK_DIR` names; with no such folder there is nothing to
 * read, and the page leaves the box out.
 *
 * Counts only. A line also holds a thread name and file names, and none of that is kept.
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import path from 'path'

export const ENDINGS = ['message', 'nothing', 'asked', 'failed', 'dropped'] as const
export type Ending = (typeof ENDINGS)[number]

export interface WorkerRuns {
  days: number
  total: number
  byEnding: Record<Ending, number>
  /** The cost each run reported, added up. Runs that failed before reporting add nothing. */
  costUsd: number
  byWorker: { name: string; total: number; byEnding: Record<Ending, number> }[]
  /** One entry per local day in the window, oldest first. `runs` leaves out dropped mail, which started no run. */
  byDay: { day: string; runs: number }[]
}

const zero = (): Record<Ending, number> => ({ message: 0, nothing: 0, asked: 0, failed: 0, dropped: 0 })

function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Pure: `files` is each worker's name and the text of its runs file. */
export function summarizeWorkerRuns(files: { name: string; text: string }[], now: number, days: number): WorkerRuns {
  const perDay = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) perDay.set(dayOf(now - i * 86_400_000), 0)
  const out: WorkerRuns = { days, total: 0, byEnding: zero(), costUsd: 0, byWorker: [], byDay: [] }
  for (const f of files) {
    const mine = { name: f.name, total: 0, byEnding: zero() }
    for (const line of f.text.split('\n')) {
      if (!line.trim()) continue
      let r: any
      try {
        r = JSON.parse(line)
      } catch {
        continue // a torn last line
      }
      const at = Date.parse(r?.at)
      const ended = r?.ended as Ending
      if (Number.isNaN(at) || !ENDINGS.includes(ended)) continue
      const day = dayOf(at)
      if (!perDay.has(day)) continue
      mine.total++
      mine.byEnding[ended]++
      out.total++
      out.byEnding[ended]++
      if (ended !== 'dropped') perDay.set(day, (perDay.get(day) ?? 0) + 1)
      if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) out.costUsd += r.cost_usd
    }
    if (mine.total) out.byWorker.push(mine)
  }
  out.byWorker.sort((a, b) => b.total - a.total)
  out.byDay = [...perDay.entries()].map(([day, runs]) => ({ day, runs }))
  return out
}

/** Read the runs of every worker in a mailbox. Null when there is no mailbox, or no worker has run in it. */
export function readWorkerRuns(days: number, now = Date.now(), mailbox = process.env.CROSSTALK_DIR): WorkerRuns | null {
  if (!mailbox) return null
  const top = path.join(mailbox, 'worker')
  if (!existsSync(top)) return null
  const files: { name: string; text: string }[] = []
  let names: string[]
  try {
    names = readdirSync(top)
  } catch {
    return null
  }
  for (const name of names) {
    const file = path.join(top, name, 'runs.jsonl')
    try {
      files.push({ name, text: readFileSync(file, 'utf8') })
    } catch {
      /* no runs file for this name */
    }
  }
  return files.length ? summarizeWorkerRuns(files, now, days) : null
}
