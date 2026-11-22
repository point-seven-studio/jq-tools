/**
 * Turning question text on from the page: what a form may ask, what is saved, and what the
 * page says to a person who sees "off".
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import type { AgentStatusRow } from '../src/agent-status.js'
import type { Snapshot } from '../src/collect.js'
import { readQuestionTrees, writeQuestionTrees } from '../src/config.js'
import { renderPage } from '../src/page.js'
import { COPY_SCRIPT_TAG } from '../src/presence.js'
import { applyQuestionsAction, parseQuestionsAction, questionsOption } from '../src/questions.js'
import { EMPTY_CONFIG } from '../src/turn-check.js'

const NOW = Date.parse('2026-11-22T12:00:00Z')
const row = (over: Partial<AgentStatusRow> = {}): AgentStatusRow =>
  ({
    machine: 'm',
    session_id: 's1',
    product: 'shop',
    working_tree: '/code/shop',
    branch: 'main',
    state: 'idle',
    waiting: true,
    last_activity_at: '2026-11-22T11:50:00.000Z',
    blocked_question: null,
    question_allowed: false,
    question_redacted: false,
    ...over,
  }) as AgentStatusRow
const snap = (rows: AgentStatusRow[]): Snapshot => ({ machine: 'm', generated_at: '2026-11-22T12:00:00.000Z', sessions: rows, host: null, bottleneck: { kind: 'none', reason: null } }) as Snapshot

describe('parseQuestionsAction', () => {
  const shown = ['/code/shop', '/code/api']
  it('turns a folder on only when the page listed it, and only once', () => {
    expect(parseQuestionsAction({ action: 'show', tree: '/code/shop' }, shown, [])).toEqual({ kind: 'show', tree: '/code/shop' })
    expect(parseQuestionsAction({ action: 'show', tree: '/etc' }, shown, [])).toBeNull()
    expect(parseQuestionsAction({ action: 'show', tree: '/code/shop' }, shown, ['/code/shop'])).toBeNull()
    expect(parseQuestionsAction({ action: 'show', tree: '' }, shown, [])).toBeNull()
    expect(parseQuestionsAction({ action: 'show' }, shown, [])).toBeNull()
  })
  it('turns a folder off only when it is saved, and takes no other action', () => {
    expect(parseQuestionsAction({ action: 'hide', tree: '/code/old' }, shown, ['/code/old'])).toEqual({ kind: 'hide', tree: '/code/old' })
    expect(parseQuestionsAction({ action: 'hide', tree: '/code/shop' }, shown, [])).toBeNull()
    expect(parseQuestionsAction({ action: 'wipe', tree: '/code/shop' }, shown, ['/code/shop'])).toBeNull()
  })
  it('adds and removes one folder', () => {
    expect(applyQuestionsAction(['/a'], { kind: 'show', tree: '/b' })).toEqual(['/a', '/b'])
    expect(applyQuestionsAction(['/a', '/b'], { kind: 'hide', tree: '/a' })).toEqual(['/b'])
  })
})

describe('questionsOption', () => {
  it('quotes the folder so a pasted option survives a space or a shell character', () => {
    expect(questionsOption('/code/shop')).toBe('--questions "/code/shop"')
    expect(questionsOption('/Users/dana/My Code/shop')).toBe('--questions "/Users/dana/My Code/shop"')
    expect(questionsOption('/code/a"b$c`d\\e')).toBe('--questions "/code/a\\"b\\$c\\`d\\\\e"')
  })
})

describe('the saved folders', () => {
  it('are kept under "questions" and leave every other key alone', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'jq-agents-q-')), 'nested', 'config.json')
    expect(readQuestionTrees(file)).toEqual([])
    writeQuestionTrees(['/code/shop', '/code/shop', '/code/api'], file)
    expect(readQuestionTrees(file)).toEqual(['/code/shop', '/code/api'])
    writeFileSync(file, JSON.stringify({ team: 'https://deck.example.com', turnCheck: { rules: [], muted: ['/x'], dismissed: {} }, questions: ['/code/old', 5, ''] }))
    expect(readQuestionTrees(file)).toEqual(['/code/old'])
    writeQuestionTrees(['/code/new'], file)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ team: 'https://deck.example.com', turnCheck: { rules: [], muted: ['/x'], dismissed: {} }, questions: ['/code/new'] })
  })
  it('reads a home-relative folder as a full path, and a broken file as none', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'jq-agents-q-')), 'config.json')
    writeFileSync(file, JSON.stringify({ questions: ['~/code/shop'] }))
    expect(readQuestionTrees(file)).toEqual([path.join(os.homedir(), 'code', 'shop')])
    writeFileSync(file, '{half')
    expect(readQuestionTrees(file)).toEqual([])
    expect(() => writeQuestionTrees(['/a'], file)).toThrow()
  })
})

describe('the page', () => {
  const manage = { token: 'tok123', config: EMPTY_CONFIG, questions: [] as string[] }
  it('gives a button and the option when the page can save the choice', () => {
    const html = renderPage(snap([row()]), NOW, manage)
    expect(html).toContain('Question text is off for this folder')
    expect(html).toContain('<form method="post" action="/questions"><input type="hidden" name="token" value="tok123"><input type="hidden" name="action" value="show"><input type="hidden" name="tree" value="/code/shop"><button type="submit">Show question text for this folder</button></form>')
    expect(html).toContain('<span class="jqcp"><code>--questions &quot;/code/shop&quot;</code><button type="button" data-jqcopy hidden aria-label="Copy this command">Copy</button></span>')
    expect(html).toContain('It is shown on this page only')
  })
  it('gives the option alone, with no form, when the page cannot save', () => {
    const html = renderPage(snap([row()]), NOW)
    expect(html).toContain('<span class="jqcp"><code>--questions &quot;/code/shop&quot;</code><button type="button" data-jqcopy hidden aria-label="Copy this command">Copy</button></span>')
    expect(html).toContain('or add the folder under <code>&quot;questions&quot;</code>'.replace(/&quot;/g, '"'))
    expect(html).not.toContain('action="/questions"')
    // The page's one script is the Copy button's. A page shown inside JQ Deck carries it too.
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain(COPY_SCRIPT_TAG)
  })
  it('says nothing about it where there is nothing to turn on', () => {
    const answered = renderPage(snap([row({ waiting: false, state: 'live' })]), NOW, manage)
    expect(answered).not.toContain('Question text is off')
    const shown = renderPage(snap([row({ question_allowed: true, blocked_question: 'Shall I merge?' })]), NOW, manage)
    expect(shown).not.toContain('Question text is off')
    expect(shown).toContain('Shall I merge?')
  })
  it('lists what was turned on from the page, each with a way to turn it off', () => {
    const html = renderPage(snap([row({ question_allowed: true, blocked_question: 'Shall I merge?' })]), NOW, { ...manage, questions: ['/code/shop', '/code/<b>x</b>'] })
    expect(html).toContain('Question text is shown for')
    expect(html).toContain('<input type="hidden" name="action" value="hide"><input type="hidden" name="tree" value="/code/shop"><button type="submit">Stop showing it</button>')
    expect(html).not.toContain('<b>x</b>')
    expect(renderPage(snap([row()]), NOW, manage)).not.toContain('Question text is shown for')
  })
})
