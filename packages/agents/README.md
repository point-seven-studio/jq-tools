# JQ Agents

A local, read-only board of every Claude Code session on your machine: what each one is doing, and which are waiting on a person.

If you run several sessions at once, the cost is the ones that stopped to ask you something an hour ago in a window you forgot. This shows them on one page.

## Run it

```sh
npx jq-agents
```

Then open <http://127.0.0.1:4319>. Refresh to read again.

```sh
npx jq-agents --json             # print one snapshot
npx jq-agents --html board.html  # write the page to a file
npx jq-agents --port 5000
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
- It is **read-only**. It never writes into a session, and there is no way to answer a session from the board.
- **Question text is off by default.** The board says a session is waiting, not what it asked. To show the question for sessions in chosen folders:

  ```sh
  npx jq-agents --questions ~/code/my-app,~/code/other
  ```

  The text is cut to 400 characters and strings shaped like secrets are removed. That removal is a pattern list, so it can miss one: only turn this on for folders where you would be content to read the session's last message on this screen.
- **Nothing leaves your machine** unless you pass one of two flags:
  - `--probe` times a TLS handshake to `api.anthropic.com` so the bottleneck line can name the network. Nothing is sent.
  - `--watch --exec CMD` hands each snapshot to a command of yours (below).

## Sending snapshots somewhere

For a team board or a history, run it as a relay and give it a command that stores the snapshot:

```sh
npx jq-agents --watch --interval 60 --exec './store-snapshot.sh'
```

Every interval, your command receives one JSON snapshot on stdin (`machine`, `generated_at`, `sessions`, `host`, `bottleneck`). If the command fails, the relay says so each time. This package stores nothing and has no server; where snapshots go, and who may read them, is yours to decide. Question text only appears in a snapshot for folders you listed with `--questions`.

## As a library

```js
import { snapshot, totals, deriveAttention, computeBlockedEpisodes } from 'jq-agents'

const snap = await snapshot({ sample: false })
console.log(totals(snap.sessions))
```

`computeBlockedEpisodes` and `summarizeHistory` turn a log of attention changes into "how long were sessions blocked on a person". You keep the log.

## Limits

- **It depends on Claude Code internals.** The transcript files and the socket folder are not a public interface. A Claude Code release can change them; when that happens rows degrade (unknown state, no question text) until this package is updated.
- **macOS for the resource numbers.** Sampling uses `vm_stat`, `sysctl`, `iostat` and `nettop`. On Linux the session list works and those columns are blank.
- **Liveness is matched by working tree,** not by session. Two sessions in one repository are both marked alive if either is.
- It reads your own account's sessions only.

## About

Made by Point Seven Studio. Licence: Apache-2.0. Unofficial: not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names for their products.
