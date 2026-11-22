/**
 * Showing question text from the page.
 *
 * Question text is off for every folder until a person turns it on for that folder. It can
 * be turned on with `--questions` when the page is started, or from the page itself: a
 * button on a waiting row saves the folder under `questions` in ~/.jq/config.json, the same
 * key JQ Deck reads.
 *
 * A folder saved this way applies to THE PAGE ONLY. `--watch --exec` and `--json` hand a
 * snapshot to something else, and for those only `--questions` and its environment variable
 * count. A click on a page never changes what a relay sends.
 *
 * Pure: the rules for what a form may ask. config.ts reads and writes the file.
 */

export type QuestionsAction = { kind: 'show'; tree: string } | { kind: 'hide'; tree: string }

/**
 * What a posted form asks for, or null when it asks for nothing allowed.
 *  - show: only a folder that the last served page listed. A form cannot name a folder of
 *    its own choosing.
 *  - hide: only a folder that is saved now.
 */
export function parseQuestionsAction(form: Record<string, string>, shownTrees: string[], saved: string[]): QuestionsAction | null {
  const tree = form.tree
  if (typeof tree !== 'string' || !tree) return null
  if (form.action === 'show') return shownTrees.includes(tree) && !saved.includes(tree) ? { kind: 'show', tree } : null
  if (form.action === 'hide') return saved.includes(tree) ? { kind: 'hide', tree } : null
  return null
}

export function applyQuestionsAction(saved: string[], a: QuestionsAction): string[] {
  return a.kind === 'show' ? [...saved, a.tree] : saved.filter((t) => t !== a.tree)
}

/**
 * The option that turns question text on for one folder, to add to the command that started
 * the page. The folder goes in double quotes, with the four characters a shell reads inside
 * them escaped, so a folder with a space in its name still works when pasted.
 */
export function questionsOption(tree: string): string {
  return `--questions "${tree.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`
}
