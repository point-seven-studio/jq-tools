/** Entry point of the `jq-deck-server` bundle. */
import { DEFAULT_PORT, run } from './cli.js'

declare const __JQ_DECK_SERVER_VERSION__: string
const VERSION = typeof __JQ_DECK_SERVER_VERSION__ === 'string' ? __JQ_DECK_SERVER_VERSION__ : 'dev'

const HELP = `JQ Deck Server ${VERSION}: one page for a team's Claude Code sessions.

On the server:
  jq-deck-server init DIR                      make the data folder
  jq-deck-server add-machine NAME --who "Dana" allow a machine to report; prints its token once
  jq-deck-server add-viewer NAME               allow a person to look; prints their token once
        --repos shop,api                       ...at these repositories only
  jq-deck-server remove NAME                   a machine or a viewer; the token stops working
  jq-deck-server list
  jq-deck-server serve                         http://127.0.0.1:${DEFAULT_PORT}
        --port NUMBER  --host ADDRESS          --host 0.0.0.0 to accept other machines
        --plain-http                           allow sign-in without HTTPS (not advised)
        --no-lights                            do not ask a viewer's browser whether their local
                                               JQ tools answer (the lights in the bar)

On each machine that reports:
  JQ_DECK_TOKEN=... jq-deck --watch --exec "jq-deck-server send --url ADDRESS"
  JQ_DECK_TOKEN=... jq-deck approvals --watch --exec "jq-deck-server approvals --url ADDRESS"
                    post the approval requests a crosstalk worker is waiting on, which
                    quote the waiting commands, and print the signed answers. Only a
                    board that takes them answers; this server's own \`serve\` does not.

The folder comes from --dir or $JQ_DECK_SERVER_DIR. A report holds counts and scores
per repository: no folder path and no message. What a waiting session asked is in a
report only when that machine opted the folder in (jq-deck --send-questions). The server keeps the
latest report from each machine, as files in that folder, and calls nothing.

Unofficial. Not affiliated with or endorsed by Anthropic.`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h') || args.length === 0) console.log(HELP)
else if (args.includes('--version') || args.includes('-v')) console.log(VERSION)
else
  run(args, VERSION).catch((error: any) => {
    console.error(`jq-deck-server: ${error.message || error}`)
    process.exit(1)
  })
