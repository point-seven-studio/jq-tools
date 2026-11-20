# JQ Deck

One command, one local page: every Claude Code session on your machine, the setup check for each repository, and the mailbox between sessions.

It is [jq-agents](https://www.npmjs.com/package/@point-seven-studio/jq-agents), [jq-groundcrew](https://www.npmjs.com/package/@point-seven-studio/jq-groundcrew) and [jq-crosstalk](https://www.npmjs.com/package/@point-seven-studio/jq-crosstalk) behind one page. It reads what they read and writes nothing.

![The JQ Deck overview: one row per repository with its sessions, setup score and unread mail.](https://raw.githubusercontent.com/point-seven-studio/jq-tools/main/packages/deck/docs/screenshot.png)

*The data in the picture is made up.*

## Run it

```sh
npx @point-seven-studio/jq-deck
```

Then open <http://127.0.0.1:4316>. Refresh to read again.

```sh
npx @point-seven-studio/jq-deck --mailbox ~/crosstalk   # show a mailbox
npx @point-seven-studio/jq-deck --json                  # print the overview
npx @point-seven-studio/jq-deck --port 5000
```

Node 18 or later. No dependency: the three tools are bundled in.

## What it shows

- **Overview.** One row per repository that has had a session in the last 3 days, plus the folder you ran it in: how many sessions and how many are waiting on you, the setup score, and unread mail. The line at the top says what needs you.
- **Sessions.** The jq-agents board.
- **Setup.** The jq-groundcrew report for each repository on the page. You do not pass a path: the repositories come from the sessions.
- **Mail.** The jq-crosstalk page: what is waiting, the board, and threads. With no mailbox, this tab shows the one command that makes one.

## Which mailbox, and which inbox belongs to which repository

The mailbox is the first of: `--mailbox`, `mailbox` in the config file, `$CROSSTALK_DIR`, the nearest folder above you holding a `.crosstalk` file.

An inbox is tied to a repository when it has the folder's name, or when it is the only inbox the folder's name starts with (`shop-v2` matches the inbox `shop`). When that guess is wrong or finds nothing, say so in the config file. An inbox tied to no repository on the page is listed under the table with its unread count; a repository with no inbox says "no inbox", never 0.

## The config file

Optional. `~/.jq/config.json`, or the file named by `--config` or `$JQ_DECK_CONFIG`:

```json
{
  "mailbox": "~/crosstalk",
  "names": { "billing": "~/code/payments-service" },
  "questions": ["~/code/shop"]
}
```

`names` maps an inbox to a repository folder. `questions` is the same as `--questions`. `"report": ["shop", "api"]` is the same as `--repos`.

## What it reads, and what it does not send

- It reads the tail of each session transcript under `~/.claude/projects` and the process table (jq-agents), the Claude Code settings and `CLAUDE.md` files of each repository listed (jq-groundcrew), and the message files in the mailbox (jq-crosstalk). Each tool's README lists exactly what it opens.
- It is **read-only**. There is no way to answer a session or send mail from the page.
- **Question text is off by default.** The page says a session is waiting, not what it asked. `--questions DIR,DIR` turns it on for sessions under those folders.
- **Mail is shown in full** on the Mail tab, to anyone who can open the page on this machine.
- **Nothing leaves your machine** unless you pass `--probe`, which times one connection to `api.anthropic.com` so the Sessions tab can name the network as a bottleneck, or `--watch --exec CMD`, which hands a report to a command of yours (below).
- The server listens on `127.0.0.1` only, answers only requests addressed to `127.0.0.1` or `localhost`, refuses anything but GET, and may not be framed by another site. The Setup tab checks only repositories the page lists: a URL carries an id, never a path.

## Reporting to a team board

```sh
export JQ_DECK_TOKEN=jqm_...
npx @point-seven-studio/jq-deck --watch --repos shop,api --exec "jq-deck-server send --url https://deck.example.com"
```

Every interval (60 seconds, or `--interval`), your command receives one JSON report on stdin. [jq-deck-server](https://www.npmjs.com/package/@point-seven-studio/jq-deck-server) is a server that takes them; any command works.

- **You list what is reported.** `--repos` (or `report` in the config file) names the repositories, by folder name, remote or path. Nothing else is in the report, not even as a count. `--all-repos` reports every one. With neither, `--watch` refuses to start.
- **A report is counts and scores:** per repository its name, git remote, session counts, how long the longest-waiting session has waited, the setup score and the unread count. No folder path, no message, no file name.
- **Question text is not sent unless you opt a folder in:** `--send-questions ~/code/shop` (or `sendQuestions` in the config file) adds what each waiting session under that folder asked. `--questions` is about your own screen and sends nothing. The repository must also be one you report. The relay says at start whether question text is being sent.
- If the command fails, jq-deck says so each time.

## As a library

```js
import { collectOverview } from '@point-seven-studio/jq-deck'

const overview = await collectOverview({ mailbox: process.env.CROSSTALK_DIR ?? null, cwd: process.cwd() })
console.log(overview.headline)
```

## Limits

- **One machine.** The page shows your own account's sessions on this machine. For a view across a team's machines, report to [jq-deck-server](https://www.npmjs.com/package/@point-seven-studio/jq-deck-server).
- Everything each tool lists as a limit applies here: jq-agents depends on Claude Code internals and samples resources on macOS only; a mailbox has no access control.
- Every page load reads again. With many repositories the Overview runs the setup check on each, which takes a moment.

## Related tools

- [jq-deck-server](https://www.npmjs.com/package/@point-seven-studio/jq-deck-server): the same view for a team, across machines.
- [jq-agents](https://www.npmjs.com/package/@point-seven-studio/jq-agents): a board of every Claude Code session on your machine.
- [jq-groundcrew](https://www.npmjs.com/package/@point-seven-studio/jq-groundcrew): a setup check for Claude Code.
- [jq-crosstalk](https://www.npmjs.com/package/@point-seven-studio/jq-crosstalk): a file mailbox between agent sessions.

Each one works alone. [Why we built them](https://www.hivejournal.com/blog/jq-tools-one-command).

For a team that wants the board across machines without running a server, there is a [waitlist for a hosted board](https://www.hivejournal.com/jq-deck#hosted).

## About

Made by [Point Seven Studio](https://www.hivejournal.com/point-seven-studio). Licence: Apache-2.0. Unofficial: not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names for their products.
