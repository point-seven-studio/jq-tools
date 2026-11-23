/**
 * List prices, for turning token counts into an estimate.
 *
 * ⚠️ AN ESTIMATE, NEVER A BILL. On a Claude subscription nothing is charged per token, so
 * the figure is only useful as a share of a whole. On API billing the charge can still
 * differ: Claude Code's own figure for the same run has come out lower than this one where
 * cache writes were marked as one-hour writes. The page says so wherever a dollar is shown.
 *
 * The table is a copy of Anthropic's public price list on the day in PRICES_READ. Prices
 * change and a new model has no row: an install that is not updated shows old prices, and a
 * model with no row is counted as "no price known", never as zero.
 *
 * Pure.
 */

export const PRICES_READ = '2026-11-23'
export const PRICES_SOURCE = 'platform.claude.com/docs/en/about-claude/pricing'

/** US dollars per million tokens. */
export interface Price {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

const row = (input: number, write5m: number, write1h: number, read: number, output: number): Price => ({ input, write5m, write1h, read, output })

/**
 * A model id starts with one of these. The longest match wins, so `claude-opus-5-5-…` is
 * not priced as `claude-opus-5`. Ids seen in transcripts carry a date after the name.
 */
const TABLE: [string, Price][] = [
  ['claude-fable-5-2', row(8, 10, 16, 0.2, 40)],
  ['claude-mythos-5-2', row(8, 10, 16, 0.2, 40)],
  ['claude-fable-5-1', row(10, 12.5, 20, 0.25, 50)],
  ['claude-mythos-5-1', row(10, 12.5, 20, 0.25, 50)],
  ['claude-fable-5', row(10, 12.5, 20, 1, 50)],
  ['claude-mythos-5', row(10, 12.5, 20, 1, 50)],
  ['claude-opus-5-5', row(4, 5, 8, 0.2, 20)],
  ['claude-opus-5', row(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-8', row(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-7', row(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-6', row(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-5', row(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-1', row(15, 18.75, 30, 1.5, 75)],
  ['claude-opus-4', row(15, 18.75, 30, 1.5, 75)],
  ['claude-sonnet-5-5', row(2, 2.5, 4, 0.1, 10)],
  ['claude-sonnet-5', row(2, 2.5, 4, 0.2, 10)],
  ['claude-sonnet-4-6', row(3, 3.75, 6, 0.3, 15)],
  ['claude-sonnet-4-5', row(3, 3.75, 6, 0.3, 15)],
  ['claude-sonnet-4', row(3, 3.75, 6, 0.3, 15)],
  ['claude-haiku-5-5', row(0.1, 0.125, 0.2, 0.01, 0.5)],
  ['claude-haiku-4-5', row(1, 1.25, 2, 0.1, 5)],
]
const BY_LENGTH = [...TABLE].sort((a, b) => b[0].length - a[0].length)

/** Haiku 5.5 costs five times as much for a prompt over this many tokens. */
const HAIKU_55_LONG = 100_000
const HAIKU_55_LONG_PRICE = row(0.5, 0.625, 1, 0.05, 2.5)

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** The price row for a model id, or null when the table has none. */
export function priceFor(model: string): Price | null {
  for (const [prefix, price] of BY_LENGTH) if (model === prefix || model.startsWith(`${prefix}-`)) return price
  return null
}

/**
 * The list price of one reply, from the usage block Claude Code saved with it. Null when the
 * model has no row.
 *
 * - A cache write is priced by its kind when the usage block says which (five minutes or
 *   one hour). When it does not, it is priced at the five-minute rate, the lower one.
 * - Fast mode is priced at twice the standard rate, which is what the list shows for input
 *   and output on the models that have it.
 * - Requests kept in the US (`inference_geo: "us"`) are 1.1 times the rate.
 */
export function estimateUsd(model: string, usage: any): number | null {
  let p = priceFor(model)
  if (!p || !usage || typeof usage !== 'object') return p ? 0 : null
  const input = num(usage.input_tokens)
  const read = num(usage.cache_read_input_tokens)
  const written = num(usage.cache_creation_input_tokens)
  const kinds = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null
  const write1h = kinds ? num(kinds.ephemeral_1h_input_tokens) : 0
  const write5m = kinds ? num(kinds.ephemeral_5m_input_tokens) : written
  // Counted as a whole when the two kinds do not add up to it, so no token is priced twice or dropped.
  const loose = kinds ? Math.max(0, written - write1h - write5m) : 0
  if (model.startsWith('claude-haiku-5-5') && input + read + written > HAIKU_55_LONG) p = HAIKU_55_LONG_PRICE
  let usd = (input * p.input + (write5m + loose) * p.write5m + write1h * p.write1h + read * p.read + num(usage.output_tokens) * p.output) / 1_000_000
  if (usage.speed === 'fast') usd *= 2
  if (usage.inference_geo === 'us') usd *= 1.1
  return usd
}
