/** The join and the shell page, for building your own view over the three tools. */
export * from './deck.js'
export { checkSetup, collectOverview, looksLikeProject, remoteOf, treesOf, type DeckOptions } from './collect.js'
export { pickRepo, renderShell, TABS, type Tab } from './page.js'
export { buildContext, DEFAULT_PORT, handle, hostAllowed, parseArgs, reportList, type Args, type Context, type Reply } from './cli.js'
