/** Entry point of the `jq-agents` bundle. */
import { DEFAULT_PORT, run } from './cli.js'

declare const __JQ_AGENTS_VERSION__: string
const VERSION = typeof __JQ_AGENTS_VERSION__ === 'string' ? __JQ_AGENTS_VERSION__ : 'dev'

const HELP = `JQ Agents ${VERSION}: what every Claude Code session on this machine is doing.

  jq-agents                        open a board at http://127.0.0.1:${DEFAULT_PORT}
  jq-agents --html FILE            write the board to a file
  jq-agents --json                 print one snapshot
  jq-agents --watch --exec CMD     every interval, pipe a snapshot (JSON) to CMD
        --interval SECONDS         for --watch (default 60)
  jq-agents --week                 print where this week's usage went, by repository,
                                   model and session (the page is at /week)
        --week-resets "sun 06:00" --week-reading 12
                                   save when your week resets and what your usage page
                                   shows now, so figures can be given as percent of it
  jq-agents --questions DIR,DIR    show the question a waiting session asked, for
                                   sessions under these folders (default: none)
  jq-agents --probe                also time a connection to the API host
  jq-agents --no-sample            skip CPU, memory and network sampling
  jq-agents --max-age-days N       ignore sessions idle longer than this (default 3)
  jq-agents --no-manage            serve the board with no forms that save corrections
  jq-agents --config FILE          where corrections are kept (default ~/.jq/config.json)
  jq-agents --port NUMBER

It reads session transcripts under ~/.claude/projects and the process table. It is
read-only: it never writes into a session. The one file it writes is its own
config, when you correct a label on the board or save your week settings.
Nothing about a session leaves this machine unless
you pass --exec (your command gets the snapshot) or --probe (one timed connection).

When you open the page it asks npm once a day for the latest version number;
--no-update-check turns that off.

Unofficial. Not affiliated with or endorsed by Anthropic.`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) console.log(HELP)
else if (args.includes('--version') || args.includes('-v')) console.log(VERSION)
else
  run(args, VERSION).catch((error: any) => {
    console.error(error.message || error)
    process.exit(1)
  })
