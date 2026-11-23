/** The `jq-deck-server` command. */
import path from 'path'
import { send, sendApprovals } from './send.js'
import { startServer } from './server.js'
import { addMachine, addViewer, initStore, readConfig, remove } from './store.js'

export const DEFAULT_PORT = 4320
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export interface Parsed {
  command: string
  positional: string[]
  options: Record<string, string>
  flags: Set<string>
}

const VALUE_OPTIONS = new Set(['--dir', '--who', '--repos', '--port', '--host', '--url'])
const FLAGS = new Set(['--plain-http', '--no-lights'])

export function parse(argv: string[]): Parsed {
  const [command = '', ...rest] = argv
  const positional: string[] = []
  const options: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (VALUE_OPTIONS.has(a)) {
      const v = rest[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      options[a] = v
    } else if (FLAGS.has(a)) flags.add(a)
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`)
    else positional.push(a)
  }
  return { command, positional, options, flags }
}

function dirOf(p: Parsed, env: Record<string, string | undefined>): string {
  const dir = p.options['--dir'] || env.JQ_DECK_SERVER_DIR
  if (!dir) throw new Error('which folder? pass --dir DIR or set $JQ_DECK_SERVER_DIR')
  return path.resolve(dir)
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function run(argv: string[], version: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const p = parse(argv)
  const name = () => {
    if (!p.positional[0]) throw new Error(`${p.command} needs a name`)
    return p.positional[0]
  }
  switch (p.command) {
    case 'init': {
      const dir = path.resolve(p.positional[0] || p.options['--dir'] || env.JQ_DECK_SERVER_DIR || '')
      if (!p.positional[0] && !p.options['--dir'] && !env.JQ_DECK_SERVER_DIR) throw new Error('usage: jq-deck-server init DIR')
      initStore(dir)
      console.log(`made ${dir}\nnext: export JQ_DECK_SERVER_DIR="${dir}", then add-machine and add-viewer`)
      return
    }
    case 'add-machine': {
      const token = addMachine(dirOf(p, env), name(), p.options['--who'] || '')
      console.log(`machine ${name()} added. Its token, shown once:\n\n  ${token}\n\nOn that machine:\n  export JQ_DECK_TOKEN=<the token>\n  jq-deck --watch --exec "jq-deck-server send --url <this server's address>"`)
      return
    }
    case 'add-viewer': {
      const repos = (p.options['--repos'] || '').split(',').map((r) => r.trim()).filter(Boolean)
      const token = addViewer(dirOf(p, env), name(), repos)
      console.log(`viewer ${name()} added${repos.length ? `, limited to: ${repos.join(', ')}` : ', who sees every repository'}. Their token, shown once:\n\n  ${token}\n\nThey paste it into the sign-in page.`)
      return
    }
    case 'remove': {
      if (!remove(dirOf(p, env), name())) throw new Error(`no machine or viewer is named ${name()}`)
      console.log(`removed ${name()}. Its token no longer works.`)
      return
    }
    case 'list': {
      const config = readConfig(dirOf(p, env))
      for (const m of config.machines) console.log(`machine  ${m.name}  (${m.who})`)
      for (const v of config.viewers) console.log(`viewer   ${v.name}  ${v.repos?.length ? `sees: ${v.repos.join(', ')}` : 'sees everything'}`)
      if (!config.machines.length && !config.viewers.length) console.log('no machine or viewer yet')
      return
    }
    case 'send': {
      if (!p.options['--url']) throw new Error('send needs --url (the team server\'s address)')
      await send(p.options['--url'], env.JQ_DECK_TOKEN, await stdin())
      return
    }
    case 'approvals': {
      if (!p.options['--url']) throw new Error('approvals needs --url (the board\'s address)')
      // stdout is the board's answer, for `jq-deck approvals` to read. Nothing else is printed there.
      process.stdout.write(await sendApprovals(p.options['--url'], env.JQ_DECK_TOKEN, await stdin()))
      return
    }
    case 'serve': {
      const dir = dirOf(p, env)
      readConfig(dir) // fail now, not on the first request
      const port = Number(p.options['--port'] ?? DEFAULT_PORT)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port needs a number from 1 to 65535')
      const host = p.options['--host'] || '127.0.0.1'
      const local = LOOPBACK.has(host)
      // Off this machine the sign-in cookie is marked Secure, so it only works
      // behind HTTPS. --plain-http is the explicit way to give that up.
      const secureCookie = !local && !p.flags.has('--plain-http')
      startServer({ dir, version, secureCookie, lights: !p.flags.has('--no-lights') }, port, host, (bound) => {
        console.log(`jq-deck-server: http://${host}:${bound} (Ctrl-C to stop), data in ${dir}`)
        if (!local) console.log(secureCookie ? 'jq-deck-server: reachable from other machines. Put HTTPS in front of it: sign-in needs it.' : 'jq-deck-server: WARNING: reachable from other machines over plain HTTP. Tokens travel in the clear.')
      })
      return
    }
    default:
      throw new Error(p.command ? `unknown command: ${p.command} (try --help)` : 'which command? (try --help)')
  }
}
