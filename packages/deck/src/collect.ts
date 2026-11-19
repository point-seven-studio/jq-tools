/**
 * JQ Deck: reading the machine. Calls the three tools as libraries and hands
 * what they return to buildOverview(). Read-only: it opens the same files the
 * three tools open and writes nothing.
 */
import { existsSync, readdirSync } from 'fs'
import path from 'path'
import { snapshot, type CollectOptions, type Snapshot } from '@point-seven-studio/jq-agents'
import { BOARD, readMailbox, waitingBoard } from '@point-seven-studio/jq-crosstalk'
import { canRead, gather, runChecks, summarize } from '@point-seven-studio/jq-groundcrew'
import { buildOverview, type Overview, type SetupResult } from './deck.js'

export interface DeckOptions extends CollectOptions {
  mailbox: string | null
  names?: Record<string, string>
  /** Shown as a repository even with no session in it, when it looks like one. */
  cwd?: string
}

/** A folder worth a row with no session in it: it has a repository or a Claude Code setup. */
export function looksLikeProject(dir: string): boolean {
  return ['.git', '.claude', 'CLAUDE.md'].some((f) => existsSync(path.join(dir, f)))
}

export function checkSetup(tree: string): SetupResult {
  if (!existsSync(tree)) return { error: 'the folder is gone' }
  if (!canRead(tree)) return { error: 'the folder cannot be read' }
  try {
    return { summary: summarize(runChecks(gather(tree).facts)) }
  } catch (e: any) {
    return { error: String(e?.message || e) }
  }
}

export function treesOf(snap: Snapshot, cwd?: string): string[] {
  const trees = [...new Set(snap.sessions.map((r) => r.working_tree))]
  if (cwd && !trees.includes(cwd) && looksLikeProject(cwd)) trees.push(cwd)
  return trees
}

export async function collectOverview(opts: DeckOptions): Promise<Overview> {
  // No resource sampling here: the overview is counts, and the Sessions tab samples.
  const snap = await snapshot({ ...opts, sample: false })
  const trees = treesOf(snap, opts.cwd)
  const setups = new Map(trees.map((t) => [t, checkSetup(t)] as const))
  let waiting = null
  let inboxes: string[] = []
  let mailNote: string | null = null
  if (opts.mailbox) {
    try {
      waiting = waitingBoard(readMailbox(opts.mailbox), opts.now ?? Date.now())
      inboxes = readdirSync(path.join(opts.mailbox, 'inbox'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== BOARD)
        .map((e) => e.name)
    } catch (e: any) {
      // A broken mailbox must not cost the other two tabs.
      mailNote = String(e?.message || e)
    }
  }
  return buildOverview({ snapshot: snap, trees, setups, waiting, inboxes, mailbox: opts.mailbox, mailNote, names: opts.names })
}
