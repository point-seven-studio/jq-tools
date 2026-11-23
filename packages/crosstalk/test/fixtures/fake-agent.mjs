#!/usr/bin/env node
// A stand-in for the agent tool, for worker.test.ts. It reads the same arguments, asks
// the worker's hook about one Bash call when told to, and prints a result as JSON.
//
// What it does is set by the file $FAKE_DIR/mode:
//   reply     answer the first mail in the prompt with `crosstalk reply`
//   nothing   send nothing
//   bash:<command>   "call" Bash with that command, going through the hook
//   fail      exit 1 with no result
import { spawnSync } from 'child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

const dir = process.env.FAKE_DIR
const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const prompt = args[0] === '-p' && args[1] && !args[1].startsWith('--') ? args[1] : null
const resume = flag('--resume')
const session = resume ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ prompt, resume, budget: flag('--max-budget-usd'), model: flag('--model'), cwd: process.cwd(), self: process.env.CROSSTALK_SELF }) + '\n')

const mode = readFileSync(path.join(dir, 'mode'), 'utf8').trim()
const result = (more = {}) => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: 0.05, stop_reason: 'end_turn', ...more }))

if (mode === 'fail') process.exit(1)
if (mode === 'nothing') result()
else if (mode === 'reply') {
  const mail = prompt.match(/^- (\/.+\.md)$/m)[1]
  const r = spawnSync('crosstalk', ['reply', mail], { input: 'An answer.', encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  result()
} else if (mode.startsWith('bash:')) {
  // A resumed run is asked about the same call again, as the agent tool does.
  const pendingFile = path.join(dir, `pending-${session}`)
  const id = resume && existsSync(pendingFile) ? readFileSync(pendingFile, 'utf8') : `toolu_${Math.random().toString(36).slice(2, 10)}`
  const input = { command: mode.slice(5) }
  const hook = JSON.parse(flag('--settings')).hooks.PreToolUse[0].hooks[0].command
  const h = spawnSync('bash', ['-c', hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: input, tool_use_id: id }), encoding: 'utf8' })
  const decision = h.stdout.trim() ? JSON.parse(h.stdout).hookSpecificOutput.permissionDecision : 'none'
  appendFileSync(path.join(dir, 'decisions'), `${decision}\n`)
  if (decision === 'defer') {
    writeFileSync(pendingFile, id)
    result({ stop_reason: 'tool_deferred', deferred_tool_use: { id, name: 'Bash', input } })
  } else result()
} else throw new Error(`fake agent: unknown mode ${mode}`)
