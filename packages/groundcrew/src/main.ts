/**
 * The entry point of the `jq-groundcrew` package.
 *
 * build.sh bundles this file and its imports into one file with no
 * dependency. It checks the folder it is run in. It has no --sync: this build holds no database
 * client. It makes one network call, from update-check.ts: it asks npm for the latest version
 * number, at most once a day, when a person starts the page. A test (groundcrew-public.test.ts)
 * fails if any other file in the bundle's source graph reaches a network or database module.
 */
import { DEFAULT_PORT, parseArgs, runLocal } from './groundcrew-cli.js'

declare const __GROUNDCREW_VERSION__: string
const VERSION = typeof __GROUNDCREW_VERSION__ === 'string' ? __GROUNDCREW_VERSION__ : 'dev'

const HELP = `JQ Groundcrew ${VERSION}: the setup check for Claude Code.

It reads how Claude Code is set up for a project and shows what to fix, with a prompt to copy
for each fix. It runs on your machine and sends nothing about your project
anywhere. When you open the page it asks npm once a day for the latest version
number; --no-update-check turns that off.

  jq-groundcrew [folder]               open a page at http://127.0.0.1:${DEFAULT_PORT}
  jq-groundcrew [folder] --html FILE   write the page to a file
  jq-groundcrew [folder] --json        print the report
  jq-groundcrew --port NUMBER          serve on another port
  jq-groundcrew --json --fail-on fail  exit 1 if a check fails, for CI
                                       (--fail-on warn also counts a warning)
  jq-groundcrew --json > before.json   keep a report, then after a change:
  jq-groundcrew --since before.json    show what changed since it
  jq-groundcrew --json --since before.json --fail-on worse
                                       exit 1 if a check is worse than it was

The folder defaults to the one you are in. It reads settings files, counts lines in CLAUDE.md
files, and lists the names of skills, subagents, MCP servers and files that usually hold
secrets. It never opens a secrets file and never reads a session transcript.

Unofficial. Not affiliated with or endorsed by Anthropic.`

try {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) console.log(HELP)
  else if (args.includes('--version') || args.includes('-v')) console.log(VERSION)
  else process.exitCode = runLocal(parseArgs(args, process.cwd()), VERSION)
} catch (error: any) {
  console.error(error.message || error)
  process.exit(1)
}
