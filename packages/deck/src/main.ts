/** Entry point of the `jq-deck` bundle. */
import { DEFAULT_PORT, run } from './cli.js'
import { join, leave } from './join.js'

declare const __JQ_DECK_VERSION__: string
const VERSION = typeof __JQ_DECK_VERSION__ === 'string' ? __JQ_DECK_VERSION__ : 'dev'

const HELP = `JQ Deck ${VERSION}: one page for your Claude Code sessions, their setup and their mail.

  jq-deck                        open the page at http://127.0.0.1:${DEFAULT_PORT}
  jq-deck --json                 print the overview
  jq-deck --watch --exec CMD     every interval, pipe a team report (JSON) to CMD:
                                 counts and scores per repository, no paths, no mail,
                                 and no question text unless you opt a folder in
        --repos NAME,NAME        which repositories to report (required, or "report"
                                 in the config file); --all-repos reports every one
        --send-questions DIR,DIR also send what a waiting session asked, for sessions
                                 under these folders (default: none)
        --interval SECONDS       for --watch (default 60)
        --quiet                  say nothing when a report goes through
  jq-deck join --url ADDRESS --repos NAME,NAME
                                 set this machine up to report to a board: sends one
                                 report to check the address and the token, saves the
                                 token ($JQ_DECK_TOKEN, or pasted when asked) where only
                                 you can read it, and installs a login job that keeps
                                 reporting after a restart. Needs jq-deck-server installed.
        --board ADDRESS          the board's own page, for the links on the local pages
        --send-questions DIR,DIR as for --watch (default: none)
        --no-service             write the files, install no login job
  jq-deck leave                  stop reporting and remove what join wrote
  jq-deck --mailbox DIR          the crosstalk mailbox to show (default: $CROSSTALK_DIR,
                                 or the nearest folder above you holding .crosstalk)
  jq-deck --questions DIR,DIR    show the question a waiting session asked, for
                                 sessions under these folders (default: none)
  jq-deck --probe                also time a connection to the API host
  jq-deck --no-sample            skip CPU, memory and network sampling
  jq-deck --max-age-days N       ignore sessions idle longer than this (default 3)
  jq-deck --config FILE          default ~/.jq/config.json
  jq-deck --port NUMBER

It reads what jq-agents, jq-groundcrew and jq-crosstalk read. It writes a small note
while its page runs, and nothing else unless you run join.
The page is served to this machine only. Nothing leaves it unless you pass --exec
(your command gets the report) or --probe (one timed connection).

Unofficial. Not affiliated with or endorsed by Anthropic.`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) console.log(HELP)
else if (args.includes('--version') || args.includes('-v')) console.log(VERSION)
else if (args[0] === 'join' || args[0] === 'leave')
  (args[0] === 'join' ? join(args.slice(1)) : leave()).catch((error: any) => {
    console.error(`jq-deck: ${error.message || error}`)
    process.exit(1)
  })
else
  run(args, VERSION).catch((error: any) => {
    console.error(error.message || error)
    process.exit(1)
  })
