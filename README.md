# JQ Tools

Open tools for people who work with coding agents, from [Point Seven Studio](https://www.hivejournal.com/point-seven-studio). We built them for our own work and are moving them here one package at a time.

## Packages

| Package | What it does | State |
|---|---|---|
| [`jq-groundcrew`](packages/groundcrew) | A setup check for Claude Code: what loads into every session, what runs automatically, and which guardrails are on. Runs on your machine and sends nothing anywhere. | Here. `npx jq-groundcrew` |
| `jq-crosstalk` | A file mailbox that lets several agent sessions send each other briefs and questions, with a shared board for questions anyone may answer. | Not here yet. |
| `jq-agents` | A board of every agent session on your machines: what each is doing and which are waiting on a person. | Not here yet. |

Only the first row exists in this repository today. The other two run inside our own product and will be extracted next.

## Develop

```
npm install
npm run check    # typecheck, tests, build, and the bundle check
```

Node 18 or later.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Unofficial: not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names for their products.
