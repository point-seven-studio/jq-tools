# JQ Groundcrew

The setup check for Claude Code.

Groundcrew reads how Claude Code is set up for a project and shows you what to fix. Each fix comes with a prompt you can copy and paste into Claude Code.

It runs on your machine. It sends nothing anywhere.

## Run it

In the folder of a project:

```sh
npx @point-seven-studio/jq-groundcrew
```

Then open <http://127.0.0.1:4317>. Refresh the page to check again after a change.

```sh
npx @point-seven-studio/jq-groundcrew path/to/project    # check another folder
npx @point-seven-studio/jq-groundcrew --html report.html # write the page to a file
npx @point-seven-studio/jq-groundcrew --json             # print the report
npx @point-seven-studio/jq-groundcrew --port 5000        # serve on another port
```

It needs Node 18 or later. It has no dependency.

## In CI

From version 0.1.1, `--fail-on fail` exits with code 1 when any check fails. `--fail-on warn` also counts a warning. The report still prints to stdout, and each counted check is named on stderr.

```sh
npx @point-seven-studio/jq-groundcrew@0.1.1 --json --fail-on fail
```

Pin the version, so a new check cannot fail your build overnight. Running it only when the setup changes (`CLAUDE.md`, `.claude/`, `.env*`) is enough.

Not every check means something in CI. A fresh clone has no `.env` file, because those are ignored by git, so the secrets check passes there whether or not a rule protects them. Run that one on a developer's machine. In CI the useful checks are the ones about files in the repository: `CLAUDE.md` growing past its target, a hook being removed, and a rule that approves every command.

## As a library

From 0.1.2 the checks can be run from your own code:

```js
import { gather, runChecks, summarize } from '@point-seven-studio/jq-groundcrew'

const checks = runChecks(gather(process.cwd()).facts)
console.log(summarize(checks))
```

`boardSummary(checks)` returns only the score, the counts and each check's id, title and status: the part that is safe to send to a team board, because it names none of your files.

## What it checks

**Setup: what loads into every session, and what runs without being asked**

- The length of each `CLAUDE.md`, against the target in the Claude Code docs of under 200 lines per file.
- Whether the auto memory index is longer than the part that loads.
- Whether any hook is configured.
- Whether any command is pre-approved.
- Your skills, subagents, custom commands and MCP servers, as plain facts.

**Guardrails: what the agent may reach, and what stops it**

- Whether a deny rule keeps the agent from reading secret files such as `.env`. This fails only if such a file exists and no rule covers it.
- Whether an allow rule approves every shell command.
- The permission mode.
- Whether the sandbox is on.
- How many folders outside the project the agent can reach.
- How long session transcripts are kept.

**Verification: who checks the work when the agent says it is done**

- Whether the agent can run a test, lint, type-check or build command without asking.
- Whether a hook runs when the agent finishes. A Stop hook can send it back to keep working.
- Whether each subagent is limited to the tools its job needs.

Each check links the page of Anthropic's Claude Code documentation it rests on. Advice that is ours, and not the docs', says "our suggestion".

## What it reads, and what it does not

It reads:

- the Claude Code settings files (user, project, local and managed);
- `CLAUDE.md` files, to count their lines;
- the names of your skills, subagents, commands and MCP servers;
- the names of files that usually hold secrets, to tell you whether a rule protects them.

It never opens a secrets file. It never reads a session transcript. The page lists every file it read.

The page has one small script, which copies a prompt to your clipboard when you press Copy. It loads nothing from the network.

## The prompts

A suggested prompt asks Claude Code to show its plan or its diff before it changes a file. Read that before you approve it. Groundcrew itself changes nothing.

## Limits

- It covers Claude Code only.
- It checks setup. It does not look at how a session went.
- The checks follow the Claude Code documentation as it stood on 2026-11-14. The documentation can change.

## About

Made by Point Seven Studio. Unofficial: not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names for their products.

Licence: Apache-2.0. See the LICENSE file.
