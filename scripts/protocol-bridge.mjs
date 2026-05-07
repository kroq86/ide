import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [portArg, ...editorArgs] = process.argv.slice(2)
const port = Number(portArg)

if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: protocol-bridge.mjs <port> [filename]')
  process.exit(2)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const binary = join(root, 'native/qe-core/qe-protocol')
const child = spawn(binary, editorArgs, {
  stdio: ['pipe', 'pipe', 'inherit'],
})

const server = createServer(socket => {
  child.stdout.pipe(socket)
  socket.pipe(child.stdin)

  child.on('exit', () => {
    socket.end()
    server.close()
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`qe protocol bridge listening on ${port}\n`)
})

function shutdown() {
  child.kill()
  server.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
