/**
 * Entry point of dist/hook.mjs: the check the worker puts in front of every tool call of
 * a run it starts. The agent tool runs it before each call and reads one line of JSON
 * from it. It reads files in the worker's folder and makes no outbound call.
 *
 * It answers in one of four ways (worker.ts `decideCall`): allow or deny a call a person
 * has answered, put a call aside until a person answers, or say nothing.
 */
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { decideCall, parseAskRules } from './worker.js'

function say(decision: 'allow' | 'deny' | 'defer', reason: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }))
}

try {
  const dir = process.env.CROSSTALK_WORKER_DIR
  if (!dir) throw new Error('CROSSTALK_WORKER_DIR is not set')
  const call = JSON.parse(readFileSync(0, 'utf8'))
  const id = typeof call.tool_use_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(call.tool_use_id) ? call.tool_use_id : ''
  const answerFile = id ? path.join(dir, 'answers', id) : ''
  const answer = answerFile && existsSync(answerFile) ? readFileSync(answerFile, 'utf8').trim() : null
  const askFile = path.join(dir, 'ask.txt')
  const rules = existsSync(askFile) ? parseAskRules(readFileSync(askFile, 'utf8')) : []
  const d = decideCall({ tool: String(call.tool_name ?? ''), input: call.tool_input, answer, rules, workerDir: dir, canAsk: process.env.CROSSTALK_WORKER_ASK === '1' })
  if (d) say(d.decision, d.reason)
} catch (error: any) {
  // A check that cannot run must not read as "fine".
  say('deny', `The crosstalk worker's check could not run (${error?.message || error}), so the call was refused.`)
}
