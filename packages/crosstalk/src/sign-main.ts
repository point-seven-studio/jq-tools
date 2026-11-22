/**
 * Entry point of dist/sign.mjs, run by `crosstalk verify`, `crosstalk read` and
 * `crosstalk keygen`. Reads files in one mailbox; makes no outbound call.
 *
 *   node sign.mjs check <mailbox> <file>     one line; exit 0 when nothing is wrong, 3 otherwise
 *   node sign.mjs keygen <mailbox> <name>    add a signer; prints the private key ONCE
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import path from 'path'
import { checkSignature, describeCheck, fingerprint, generateSigningKey, parseSigners } from './sign.js'

const signersFile = (root: string) => path.join(root, 'registry', 'signers.txt')

function readSigners(root: string): Map<string, string> {
  const file = signersFile(root)
  return existsSync(file) ? parseSigners(readFileSync(file, 'utf8')) : new Map()
}

function check(root: string, file: string): number {
  const name = path.basename(file)
  const result = checkSignature(name, readFileSync(file, 'utf8'), readSigners(root))
  const line = describeCheck(result)
  if (result.state === 'not-required') return 0
  // A good signature on a message that was already acknowledged is a replay: the same
  // signed file, put back in an inbox to be acted on a second time.
  const inbox = path.basename(path.dirname(path.resolve(file)))
  const inArchive = path.join(root, 'archive', inbox, name)
  const isArchiveCopy = path.resolve(file) === path.resolve(inArchive)
  if (result.state === 'verified' && !isArchiveCopy && existsSync(inArchive)) {
    console.log(`signature: REPLAYED. The signature is good, and this message was already acknowledged (archive/${inbox}/${name}). Do not act on it again.`)
    return 3
  }
  console.log(line)
  return result.state === 'verified' ? 0 : 3
}

function keygen(root: string, name: string): number {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`bad name: ${name} (lowercase letters, digits and dashes)`)
  if (name === 'board') throw new Error("'board' cannot sign")
  if (readSigners(root).has(name)) throw new Error(`${name} already has a key in registry/signers.txt; remove that line first to replace it`)
  const { publicKey, privateKey } = generateSigningKey()
  mkdirSync(path.join(root, 'registry'), { recursive: true })
  const file = signersFile(root)
  if (!existsSync(file)) {
    appendFileSync(file, '# Senders whose mail must be signed. One line per sender: `name: public key`.\n# Mail from a name listed here that carries no good signature is reported by `crosstalk read`.\n')
  }
  appendFileSync(file, `${name}: ${publicKey}\n`)
  for (const dir of ['inbox', 'archive']) mkdirSync(path.join(root, dir, name), { recursive: true })
  console.log(`added ${name} to registry/signers.txt`)
  console.log(`key fingerprint: ${fingerprint(publicKey)}`)
  console.log('')
  console.log('The private key is below. It is shown once and stored nowhere. Give it to the')
  console.log('one writer that signs for this sender, and keep it out of the mailbox and out')
  console.log('of any file a session can read.')
  console.log('')
  console.log(privateKey)
  return 0
}

try {
  const [command, root, arg] = process.argv.slice(2)
  if (!root || !arg) throw new Error('usage: sign.mjs check <mailbox> <file> | keygen <mailbox> <name>')
  if (command === 'check') process.exit(check(root, arg))
  else if (command === 'keygen') process.exit(keygen(root, arg))
  else throw new Error(`unknown command: ${command}`)
} catch (error: any) {
  console.error(error.message || error)
  process.exit(1)
}
