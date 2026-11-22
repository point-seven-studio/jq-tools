# JQ Agents

A local, read-only board of every Claude Code session on your machine: what each one is doing, and which are waiting on a person.

If you run several sessions at once, the cost is the ones that stopped to ask you something an hour ago in a window you forgot. This shows them on one page.

![The JQ Agents board: two sessions waiting on a person, grouped by working tree, with the question one of them asked.](https://raw.githubusercontent.com/point-seven-studio/jq-tools/main/packages/agents/docs/screenshot.png)

*The data in the picture is made up.*

## Run it

```sh
npx @point-seven-studio/jq-agents
```

Then open <http://127.0.0.1:4319>. Refresh to read again.

```sh
npx @point-seven-studio/jq-agents --json             # print one snapshot
npx @point-seven-studio/jq-agents --signals --json   # print the counts the signals page shows (--days 1 to 90, default 7)
npx @point-seven-studio/jq-agents --html board.html  # write the page to a file
npx @point-seven-studio/jq-agents --port 5000
```

Node 18 or later. No dependency.

## What it shows

Sessions are grouped by working tree (the git repository a session is in), because several sessions often share one.

- **State:** `live` (active in the last 15 minutes), `idle`, `stale`, or `dead` (no running process).
- **Waiting on a person:** the session ended its turn and is alive. "Asked, then left" is the same thing gone stale: an old unanswered question, counted separately so the headline number means "needs you now".
- **Branch** and time since the last activity.
- **CPU and memory** per session, and one line when the machine is short of something. When nothing is short it shows nothing.

## What it reads, and what it does not send

- It reads the tail of each session transcript under `~/.claude/projects`, a socket folder, and the process table.
- The signals page (`/signals`) reads those transcripts whole, because a count needs every record. It keeps counts only, in memory, until the tool stops. No prompt, reply or command text is kept, and the page is not part of any snapshot `--watch` or `--json` hands on.
- It is **read-only**. It never writes into a session, and there is no way to answer a session from the board. It writes two files of its own: its config, when you correct a label (see below), and a note in `~/.jq/running/` while the page is served (see Links to the other tools).
- **Question text is off by default.** The board says a session is waiting, not what it asked. To show the question for sessions in chosen folders:

  ```sh
  npx @point-seven-studio/jq-agents --questions ~/code/my-app,~/code/other
  ```

  The text is cut to 400 characters and strings shaped like secrets are removed. That removal is a pattern list, so it can miss one: only turn this on for folders where you would be content to read the session's last message on this screen.
  From 0.1.7 the page says how, on each waiting row whose folder is off. There is a **Show question text for this folder** button, which saves the folder under `questions` in `~/.jq/config.json` (the key JQ Deck reads too), and a list of what you turned on, each with a way to turn it off. Beside the button is the option to add to your command instead, written out for that folder, with a Copy button.

  A folder turned on from the page applies to **the page only**. `--watch --exec` and `--json` hand a snapshot to something else, and for those only `--questions` counts. A click on a page never changes what a relay sends.
- **Nothing about your sessions leaves your machine** unless you pass one of two flags. Separately, the page asks npm once a day for the latest version number; see [The update check](#the-update-check). The two flags:
  - `--probe` times a TLS handshake to `api.anthropic.com` so the bottleneck line can name the network. Nothing is sent.
  - `--watch --exec CMD` hands each snapshot to a command of yours (below).

## Signals

`http://127.0.0.1:4319/signals` counts what Claude Code already wrote into its transcripts, over today, 7 days or 30 days. Each area is a box that starts closed, showing one figure and a small picture of it; click it for the detail, or use "Open all". It follows the usual eight areas of AI observability, and under each one it names what a transcript cannot answer, so a missing number never reads as a zero.

| Area | Counted from a transcript | Not in a transcript |
| --- | --- | --- |
| Traces | requests to the model, messages from a person, tool calls by tool, requests by subagents | nested spans, retrieval steps |
| Token usage | input, cache read, cache write, output and thinking tokens; tokens a day and by folder; the context each active session carries; times a session was summarized | context as a share of the model limit |
| Latency | a whole turn, thinking per reply, and each tool, as a median and the time 95 in 100 finish under | time to first token, tokens per second |
| Quality drift | which models answered and on which days; which Claude Code versions ran | eval scores, groundedness, embedding drift, prompt diffs |
| Errors | API errors by kind, retries, tool calls that failed or timed out, replies from a model other than the one asked for | schema or parse errors |
| Cost | the estimate Claude Code records, by folder; the share of input read from cache; model mix by output | cost per request, budget alerts |
| User feedback | interruptions, actions a person refused | thumbs, comments, edit rate, regenerations |
| Safety signals | actions not allowed and why, replies the model refused, hooks that stopped a turn, commands run outside the sandbox | jailbreak, PII, toxicity and policy detection |

Read these with care:

- **Cost is an estimate, not a bill.** It is the figure Claude Code writes into the transcript. On a subscription it is not what you pay. It is written now and then, so the newest spending may be missing and one day can hold another day's share.
- **Times include waiting.** A turn and a tool call are timed between records, so both include any wait for a permission answer.
- **A failed tool call is often ordinary**: a test that fails, a search that finds nothing.
- **A reply is counted once.** Claude Code writes one reply as several records, and a resumed session copies its history into a new file. Both are counted once, by the reply's id.
- **The first page after a start is slow.** Every transcript touched in the window is read whole (about a second per gigabyte on the machine this was measured on), then only what was added.
- The transcript format is a Claude Code internal. When it changes, a count falls to nothing. That may mean the format moved, not that the thing stopped.

## Sending snapshots somewhere

For a team board or a history, run it as a relay and give it a command that stores the snapshot:

```sh
npx @point-seven-studio/jq-agents --watch --interval 60 --exec './store-snapshot.sh'
```

Every interval, your command receives one JSON snapshot on stdin (`machine`, `generated_at`, `sessions`, `host`, `bottleneck`). If the command fails, the relay says so each time. This package stores nothing and has no server; where snapshots go, and who may read them, is yours to decide. Question text only appears in a snapshot for folders you listed with `--questions`.

## As a library

```js
import { snapshot, totals, deriveAttention, computeBlockedEpisodes } from '@point-seven-studio/jq-agents'

const snap = await snapshot({ sample: false })
console.log(totals(snap.sessions))
```

`computeBlockedEpisodes` and `summarizeHistory` turn a log of attention changes into "how long were sessions blocked on a person". You keep the log.

## Limits

- **It depends on Claude Code internals.** The transcript files and the socket folder are not a public interface. A Claude Code release can change them; when that happens rows degrade (unknown state, no question text) until this package is updated.
- **macOS for the resource numbers.** Sampling uses `vm_stat`, `sysctl`, `iostat` and `nettop`. On Linux the session list works and those columns are blank.
- **Liveness is matched by working tree,** not by session. Two sessions in one repository are both marked alive if either is.
- It reads your own account's sessions only.

## Copy buttons

Wherever a page shows a command to run, there is a **Copy** button beside it: in the bar at the foot of the page, and on the option that turns question text on for a folder.

That button is the one script the page runs. It copies the command beside the button you pressed and does nothing else: it reads no other part of the page and makes no request. The page's content policy names that script by its hash, so no other script can run there. Where the script cannot run, the buttons stay hidden and the command can be selected by hand.

## The update check

When you start JQ Agents in a terminal to open its page, it asks npm once a day whether a newer version exists. If there is one, it prints one line and shows "Update" in the bar at the foot of the page, with the command to run. It installs nothing.

- **What is sent:** one request to `https://registry.npmjs.org/@point-seven-studio/jq-agents/latest`. It carries nothing about your machine, your project or a session. npm sees the package's name and your network address, as it does when you install.
- **When:** only when a person starts the page in a terminal. Never for `--json`, `--html` or `--watch`, never from a login job, never in CI.
- **How often:** at most once a day. The answer is kept in `~/.jq/update-check.json`.
- **If npm cannot be reached,** nothing happens and nothing is said. The page does not wait for it.
- **To turn it off:** `--no-update-check`, or `JQ_NO_UPDATE_CHECK=1`, or `"updateCheck": false` in `~/.jq/config.json`.

Each build fails if the command holds a second outbound call, or if this one points anywhere else.

## Stopped without a check

When a session ends its turn, it has decided on its own that the work is done. The board says when nothing else looked:

- **stopped without running a check:** the turn edited code, and no test, lint, type-check or build command ran after the last edit.
- **stopped after a failed check:** the last such command after the last edit reported an error.

A session that checked its work, or edited no code, gets no label. In `--json` each session has `turn_check` (`checked`, `failed`, `unchecked`, `no-edits`, `unknown` or `dismissed`, and `null` while the session is still working) and `turn_check_via` (`tool` or `shell`).

### What counts as an edit

- The edit tools, on a file that is code or configuration. A note, a picture, or a file in scratch space is not counted.
- From 0.1.5, a shell command that writes a **named** code file: an in-place `sed` or `perl`, `mv`, `cp`, `rm`, `patch`, `tee`, `git apply|mv|rm`, a redirect into a file, or code handed to an interpreter that writes a file.

A shell command is easy to misread, so the rule leans toward not counting one. We ran a first version over 2,762 ended turns in our own transcripts and it labelled 710 of them, nearly all wrongly: 326 were `source x >/dev/null`. The rule that shipped labels 69 of the same turns. We did not review those 69 one by one, so some of them are wrong too.

### When a label is wrong

On the board, a labelled row has a **Why, and is it wrong?** link. It shows the command that was taken as the edit and what ran after it, and offers:

- **Count "..." as a check here:** for a project whose check is its own command, such as `make verify`.
- **"..." does not edit code here:** for a command that was misread as an edit.
- **Dismiss this one:** hides the label until that session moves again.
- **Never label this tree.**

Everything you have corrected is listed at the bottom of the board, each with a button to take it back.

Corrections are saved under the `turnCheck` key of `~/.jq/config.json` (or `--config FILE`), and folders turned on from the page under its `questions` key. It is the only file of yours JQ Agents changes (the other is its own running note, under Links to the other tools), and other keys in it are left as they were. A save is accepted only from the page this process served: the request must name this server, come from this server's own page, and carry a token made when the process started. `--no-manage` serves the board with no forms at all. `--html`, `--json` and `--exec` never include the forms or the command text.

### Limits

- **"Checked" means a check ran, not that the work is right.** A check whose output is piped into another program can fail and still read as passed.
- **Missed edits:** a write whose target is held in a variable, and a formatter or a generator, which change files without naming them.
- **A check that a subagent ran is not counted.**
- It reads tool names, shell commands and the error flag of a result, on your machine. One word per session goes into a snapshot, and none of the command.

## Links to the other tools

The served page has a bar at the bottom with a link to each of the other JQ tools. A tool that is running on this machine is a link to the port it is really on. One that is not says "not running" and gives the command that starts it. The team board is a link when `~/.jq/config.json` holds a `"team"` line with its address, and says "not set up" otherwise.

How a page knows what is running, without a network call: while a tool serves its page it keeps a small note in `~/.jq/running/` (the tool, its port, its process id), and removes it when it stops. The other pages read those notes and ignore one whose process is gone. The bar is as of the last page load. A page written with `--html`, or shown inside JQ Deck, has no bar.

**A light on a team board.** When this machine has a team board's address saved (`"team"` in `~/.jq/config.json`), JQ Agents answers one small image at `/jq-up.svg`, so that board can show whether JQ Agents answered the viewer's browser. The image says nothing about the machine. With no team board saved, that address answers 404.

## Related tools

- [jq-deck](https://www.npmjs.com/package/@point-seven-studio/jq-deck): all of these on one local page, from one command.
- [jq-deck-server](https://www.npmjs.com/package/@point-seven-studio/jq-deck-server): the same view for a team, across machines.
- [jq-groundcrew](https://www.npmjs.com/package/@point-seven-studio/jq-groundcrew): a setup check for Claude Code.
- [jq-crosstalk](https://www.npmjs.com/package/@point-seven-studio/jq-crosstalk): a file mailbox between agent sessions.

Each one works alone. [Why we built them](https://www.hivejournal.com/blog/jq-tools-one-command).

For a team that wants the board across machines without running a server, there is a [waitlist for a hosted board](https://www.hivejournal.com/jq-deck#hosted).

## About

Made by [Point Seven Studio](https://www.hivejournal.com/point-seven-studio). Licence: Apache-2.0. Unofficial: not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names for their products.
