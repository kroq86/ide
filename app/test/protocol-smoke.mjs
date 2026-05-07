import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(new URL('../..', import.meta.url).pathname)
const binary = join(root, 'native/editor-core/target/release/editor-core')
const dir = mkdtempSync(join(tmpdir(), 'qe-react-editor-'))
const file = join(dir, 'sample.txt')
writeFileSync(file, 'hello\nworld\n')

const child = spawn(binary, [file], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.pipe(process.stderr)

const messages = []
let buffer = ''

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) messages.push(JSON.parse(line))
  }
})

function send(command) {
  child.stdin.write(`${JSON.stringify(command)}\n`)
}

function waitFor(type) {
  return new Promise((resolveWait, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const found = messages.find(message => message.type === type)
      if (found) {
        clearInterval(timer)
        resolveWait(found)
      } else if (Date.now() - started > 2000) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${type}`))
      }
    }, 10)
  })
}

function waitForSnapshotAfter(offset, predicate = () => true) {
  return new Promise((resolveWait, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const found = messages
        .slice(offset)
        .find(message => message.type === 'snapshot' && predicate(message))
      if (found) {
        clearInterval(timer)
        resolveWait(found)
      } else if (Date.now() - started > 2000) {
        clearInterval(timer)
        reject(new Error('Timed out waiting for snapshot'))
      }
    }, 10)
  })
}

await waitFor('ready')
let snapshot = await waitFor('snapshot')
assert.equal(snapshot.lines[0], 'hello')
assert.equal(snapshot.protocolVersion, 2)
assert.equal(snapshot.visibleLines[0], 'hello')
assert.equal(typeof snapshot.revision, 'number')

send({ type: 'move', direction: 'end' })
send({ type: 'insert', text: '!' })
let mark = messages.length
send({ type: 'undo' })
snapshot = await waitForSnapshotAfter(mark, message => message.lines[0] === 'hello')
assert.equal(snapshot.lines[0], 'hello')

mark = messages.length
send({ type: 'redo' })
snapshot = await waitForSnapshotAfter(mark, message => message.lines[0] === 'hello!')
assert.equal(snapshot.lines[0], 'hello!')

mark = messages.length
send({ type: 'resize', width: 80, height: 12 })
snapshot = await waitForSnapshotAfter(mark, message => message.viewport && message.visibleLines)
assert.ok(snapshot.totalLines >= 2)
assert.ok(Array.isArray(snapshot.tokens))
assert.ok(Array.isArray(snapshot.diagnostics))

send({ type: 'save' })
await waitFor('saved')

assert.equal(readFileSync(file, 'utf8'), 'hello!\nworld\n')

send({ type: 'quit' })
await new Promise(resolveExit => child.once('exit', resolveExit))

console.log('protocol smoke passed')
