/** The rules and the reader, for building your own view of a mailbox. */
export * from './board.js'
export { parseMessage, SETTLED_BY } from './parse.js'
export { readMailbox, type MailboxMessage } from './read.js'
export { buildReport } from './view.js'
export { renderPage, type Report } from './page.js'
