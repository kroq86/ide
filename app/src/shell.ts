import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require('node-pty') as typeof import('node-pty')

export type ShellLine = {
  text: string
  isError: boolean
}

export type ParsedLocation = {
  file: string
  row: number  // 0-indexed
  col: number  // 0-indexed
  message: string
}

export type ShellSession = {
  cmd: string
  output: string[]             // cleaned text lines (for AI context)
  errors: string[]             // raw error lines
  locations: ParsedLocation[]  // navigable file:line references
}

function parseErrorLine(text: string): { isError: boolean; location: ParsedLocation | null } {
  // TypeScript: src/main.tsx(47,12): error TS2345: message
  const tsMatch = text.match(/^(.+?\.tsx?)\((\d+),(\d+)\):\s+(?:error|warning)\s+TS\d+:\s+(.*)$/)
  if (tsMatch) {
    return {
      isError: true,
      location: { file: tsMatch[1]!, row: parseInt(tsMatch[2]!, 10) - 1, col: parseInt(tsMatch[3]!, 10) - 1, message: tsMatch[4]! },
    }
  }

  // Cargo/Rust location: "  --> src/main.rs:47:12"
  const cargoLoc = text.match(/^\s+-->\s+(.+?):(\d+):(\d+)/)
  if (cargoLoc) {
    return {
      isError: true,
      location: { file: cargoLoc[1]!, row: parseInt(cargoLoc[2]!, 10) - 1, col: parseInt(cargoLoc[3]!, 10) - 1, message: '' },
    }
  }

  // Python: '  File "foo.py", line 47'
  const pyFile = text.match(/^\s+File "(.+?)", line (\d+)/)
  if (pyFile) {
    return {
      isError: true,
      location: { file: pyFile[1]!, row: parseInt(pyFile[2]!, 10) - 1, col: 0, message: '' },
    }
  }

  // Pytest: "FAILED tests/test_foo.py::test_bar"
  const pytestFail = text.match(/^FAILED\s+([\w./\\-]+\.py)::(.+)$/)
  if (pytestFail) {
    return {
      isError: true,
      location: { file: pytestFail[1]!, row: 0, col: 0, message: `FAILED ${pytestFail[2]!}` },
    }
  }

  // Node.js stack frame: "    at Foo.bar (/path/file.js:47:12)"
  const nodeStack = text.match(/^\s+at\s+.+?\((.+?\.(?:js|ts|mjs|cjs)):(\d+):(\d+)\)/)
  if (nodeStack) {
    return {
      isError: true,
      location: { file: nodeStack[1]!, row: parseInt(nodeStack[2]!, 10) - 1, col: parseInt(nodeStack[3]!, 10) - 1, message: '' },
    }
  }

  // Cargo error line (no location on this line — follows separately)
  if (/^error(\[E\d+\])?:\s/.test(text)) return { isError: true, location: null }

  // Generic error signals
  if (/^(FAILED|ERROR)\s/.test(text)) return { isError: true, location: null }
  if (/SyntaxError|ReferenceError|TypeError|RangeError/.test(text)) return { isError: true, location: null }
  if (/\berror:\s/i.test(text) && !/no\s+errors?/i.test(text)) return { isError: true, location: null }
  if (/^make.*Error \d+/i.test(text)) return { isError: true, location: null }

  return { isError: false, location: null }
}

export class ShellSidecar extends EventEmitter {
  #term: ReturnType<typeof pty.spawn>
  #lines: ShellLine[] = []
  #buf = ''
  #sessions: ShellSession[] = []

  constructor(cwd: string, cols: number, rows: number) {
    super()
    const shell = process.env['SHELL'] ?? '/bin/sh'
    try {
      this.#term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: process.env as Record<string, string>,
      })
    } catch {
      this.#lines.push({ text: '(shell unavailable in this environment)', isError: true })
      this.#term = null as unknown as ReturnType<typeof pty.spawn>
      return
    }

    this.#term.onData((data: string) => {
      this.#buf += data
      const parts = this.#buf.split('\n')
      this.#buf = parts.pop() ?? ''
      for (const raw of parts) {
        const text = stripAnsi(raw)
        if (!text.trim()) continue
        const { isError, location } = parseErrorLine(text)
        const line: ShellLine = { text, isError }
        this.#lines.push(line)
        if (this.#lines.length > 500) this.#lines.shift()

        const session = this.#sessions[this.#sessions.length - 1]
        if (session) {
          session.output.push(text)
          if (session.output.length > 200) session.output.shift()
          if (isError) session.errors.push(text)
          if (location) session.locations.push(location)
        }

        this.emit('line', line)
      }
      this.emit('update')
    })

    this.#term.onExit(() => this.emit('exit'))
  }

  get lines(): ShellLine[] { return this.#lines }

  get currentLine(): string { return stripAnsi(this.#buf) }

  get sessions(): ShellSession[] { return this.#sessions }

  get lastError(): ShellSession | null {
    for (let i = this.#sessions.length - 1; i >= 0; i--) {
      if (this.#sessions[i]!.errors.length > 0) return this.#sessions[i]!
    }
    return null
  }

  get lastLocation(): ParsedLocation | null {
    for (let i = this.#sessions.length - 1; i >= 0; i--) {
      const locs = this.#sessions[i]!.locations
      if (locs.length > 0) return locs[0]!
    }
    return null
  }

  write(data: string) {
    if (data === '\r') {
      const cmd = this.currentLine.trim()
      if (cmd) this.#startSession(cmd)
    } else if (data.endsWith('\r') && data.length > 1) {
      const cmd = stripAnsi(data.slice(0, -1)).trim()
      if (cmd) this.#startSession(cmd)
    }
    this.#term?.write(data)
  }

  #startSession(cmd: string): void {
    const session: ShellSession = { cmd, output: [], errors: [], locations: [] }
    this.#sessions.push(session)
    if (this.#sessions.length > 50) this.#sessions.shift()
  }

  resize(cols: number, rows: number) { this.#term?.resize(cols, rows) }

  kill() { this.#term?.kill() }
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[\]]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '')
}
