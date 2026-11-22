/**
 * Reading transcripts for the signals page (signals.ts).
 *
 * Unlike the board, which reads the tail of each file, a count needs the whole file, and a
 * transcript can be hundreds of megabytes. So each file is read once and only its new bytes
 * after that. What was counted is held in this process's memory and nowhere else: the first
 * page after a start is slow, and stopping the tool forgets it.
 */
import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import path from 'path'
import { defaultProjectsDir } from './collect.js'
import { addRecord, emptyFileState, summarize, type FileState, type Signals } from './signals.js'

interface Held {
  offset: number
  state: FileState
}

export interface SignalsReader {
  read(days: number, now?: number): Promise<SignalsResult>
}

export interface SignalsResult {
  signals: Signals
  files: number
  /** Bytes read on this call, which is 0 when nothing changed. */
  bytesRead: number
  tookMs: number
}

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
 * The record kinds signals.ts reads. Most of a transcript's bytes are other kinds (saved
 * request bodies, attachments), and checking for the kind before parsing skips them.
 */
const WANTED = /"type":"(assistant|user|system|cost-state)"/

/** Read a file from `from` to its end, calling `onLine` for each whole line. Returns the offset after the last whole line. */
function readLines(file: string, from: number, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    let rest: Buffer[] = []
    let done = from
    const stream = createReadStream(file, { start: from, highWaterMark: 1 << 20 })
    stream.on('data', (chunk) => {
      const buf = chunk as Buffer
      let begin = 0
      for (;;) {
        const nl = buf.indexOf(10, begin)
        if (nl === -1) break
        const piece = buf.subarray(begin, nl)
        const line = rest.length ? Buffer.concat([...rest, piece]) : piece
        done += line.length + 1
        rest = []
        if (line.length) onLine(line.toString('utf8'))
        begin = nl + 1
      }
      if (begin < buf.length) rest.push(buf.subarray(begin))
    })
    stream.on('end', () => resolve(done)) // a last line with no newline is still being written
    stream.on('error', reject)
  })
}

/** The folder name of the repository a working folder is in, found by walking up to `.git`. */
async function folderName(cwd: string, cache: Map<string, string>): Promise<string> {
  const had = cache.get(cwd)
  if (had !== undefined) return had
  let cur = cwd
  let found = cwd
  for (let i = 0; i < 12 && cur; i++) {
    try {
      await stat(path.join(cur, '.git'))
      found = cur
      break
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  const name = path.basename(found)
  cache.set(cwd, name)
  return name
}

export function createSignalsReader(projectsDir = defaultProjectsDir()): SignalsReader {
  const held = new Map<string, Held>()
  const seen = new Set<string>()
  const names = new Map<string, string>()
  let busy: Promise<unknown> = Promise.resolve()

  const read = async (days: number, now = Date.now()): Promise<SignalsResult> => {
    const began = Date.now()
    // Sorted, so a reply copied into a second file is always counted in the same one.
    const files = (await findTranscripts(projectsDir)).sort()
    const cutoff = now - (days + 1) * 86_400_000
    let bytesRead = 0
    for (const file of files) {
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      const h = held.get(file)
      // A file untouched since before the window holds nothing in it. One already read is
      // kept, since its counts are sorted by day and a wider window may want them.
      if (!h && info.mtimeMs < cutoff) continue
      const cur = h ?? { offset: 0, state: emptyFileState() }
      if (info.size < cur.offset) {
        // Shorter than what was read: the file was replaced. Start it over.
        cur.offset = 0
        cur.state = emptyFileState()
      }
      if (info.size > cur.offset) {
        try {
          const end = await readLines(file, cur.offset, (line) => {
            if (!WANTED.test(line)) return
            try {
              addRecord(cur.state, JSON.parse(line), seen)
            } catch {
              /* a torn or foreign line: skip it */
            }
          })
          bytesRead += end - cur.offset
          cur.offset = end
        } catch {
          continue
        }
      }
      held.set(file, cur)
    }
    const states = [...held.values()].map((h) => h.state)
    for (const s of states) {
      if (s.lastCwd) await folderName(s.lastCwd, names)
      for (const key of s.buckets.keys()) await folderName(key.slice(key.indexOf('\n') + 1), names)
    }
    return { signals: summarize(states, now, days, (cwd) => names.get(cwd) ?? path.basename(cwd)), files: held.size, bytesRead, tookMs: Date.now() - began }
  }

  return {
    // One read at a time: two page loads at once would both count the same new bytes.
    read: (days, now) => {
      const next = busy.then(() => read(days, now))
      busy = next.catch(() => {})
      return next
    },
  }
}
