import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
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

export type ShellRun = {
  id: string
  command: string
  cwd: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  stdout: string
  stderr: string
  locations: ParsedLocation[]
}

export type ShellSession = ShellRun
export type TrackedShellResult = ShellRun

function parseErrorLine(text: string): { isError: boolean; location: ParsedLocation | null } {
  const tsMatch = text.match(/^(.+?\.tsx?)\((\d+),(\d+)\):\s+(?:error|warning)\s+TS\d+:\s+(.*)$/)
  if (tsMatch) {
    return {
      isError: true,
      location: { file: tsMatch[1]!, row: parseInt(tsMatch[2]!, 10) - 1, col: parseInt(tsMatch[3]!, 10) - 1, message: tsMatch[4]! },
    }
  }

  const cargoLoc = text.match(/^\s+-->\s+(.+?):(\d+):(\d+)/)
  if (cargoLoc) {
    return {
      isError: true,
      location: { file: cargoLoc[1]!, row: parseInt(cargoLoc[2]!, 10) - 1, col: parseInt(cargoLoc[3]!, 10) - 1, message: '' },
    }
  }

  const pyFile = text.match(/^\s+File "(.+?)", line (\d+)/)
  if (pyFile) {
    return {
      isError: true,
      location: { file: pyFile[1]!, row: parseInt(pyFile[2]!, 10) - 1, col: 0, message: '' },
    }
  }

  const pytestFail = text.match(/^FAILED\s+([\w./\\-]+\.py)::(.+)$/)
  if (pytestFail) {
    return {
      isError: true,
      location: { file: pytestFail[1]!, row: 0, col: 0, message: `FAILED ${pytestFail[2]!}` },
    }
  }

  const nodeStack = text.match(/^\s+at\s+.+?\((.+?\.(?:js|ts|mjs|cjs)):(\d+):(\d+)\)/)
  if (nodeStack) {
    return {
      isError: true,
      location: { file: nodeStack[1]!, row: parseInt(nodeStack[2]!, 10) - 1, col: parseInt(nodeStack[3]!, 10) - 1, message: '' },
    }
  }

  if (/^error(\[E\d+\])?:\s/.test(text)) return { isError: true, location: null }
  if (/^(FAILED|ERROR)\s/.test(text)) return { isError: true, location: null }
  if (/SyntaxError|ReferenceError|TypeError|RangeError/.test(text)) return { isError: true, location: null }
  if (/\berror:\s/i.test(text) && !/no\s+errors?/i.test(text)) return { isError: true, location: null }
  if (/^make.*Error \d+/i.test(text)) return { isError: true, location: null }

  return { isError: false, location: null }
}

export class ShellSidecar extends EventEmitter {
  #term: ReturnType<typeof pty.spawn>
  #cwd: string
  #lines: ShellLine[] = []
  #buf = ''
  #inputLine = ''
  #runs: ShellRun[] = []
  #tracked = new Map<string, {
    run: ShellRun
    timer: ReturnType<typeof setTimeout>
    resolve: (result: TrackedShellResult) => void
  }>()

  constructor(cwd: string, cols: number, rows: number) {
    super()
    this.#cwd = cwd
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

        if (this.#handleTrackedExit(text.trim())) continue

        const { isError, location } = parseErrorLine(text)
        const line: ShellLine = { text, isError }
        this.#lines.push(line)
        if (this.#lines.length > 500) this.#lines.shift()

        const run = this.#runs[this.#runs.length - 1]
        if (run && !run.endedAt) {
          appendTail(run, 'stdout', text)
          if (isError) appendTail(run, 'stderr', text)
          if (location) run.locations.push(location)
        }

        this.emit('line', line)
      }
      this.emit('update')
    })

    this.#term.onExit(() => this.emit('exit'))
  }

  get lines(): ShellLine[] { return this.#lines }

  get currentLine(): string { return stripAnsi(this.#buf) }

  get sessions(): ShellSession[] { return this.#runs }

  get runs(): ShellRun[] { return this.#runs }

  get lastRun(): ShellRun | null { return this.#runs[this.#runs.length - 1] ?? null }

  get lastFailedRun(): ShellRun | null {
    for (let i = this.#runs.length - 1; i >= 0; i--) {
      const run = this.#runs[i]!
      if (run.exitCode !== undefined && run.exitCode !== 0) return run
    }
    return null
  }

  get lastError(): ShellSession | null {
    for (let i = this.#runs.length - 1; i >= 0; i--) {
      if (this.#runs[i]!.stderr.trim()) return this.#runs[i]!
    }
    return null
  }

  get lastLocation(): ParsedLocation | null {
    for (let i = this.#runs.length - 1; i >= 0; i--) {
      const locs = this.#runs[i]!.locations
      if (locs.length > 0) return locs[0]!
    }
    return null
  }

  write(data: string) {
    if (data === '\x7f') {
      this.#inputLine = this.#inputLine.slice(0, -1)
    } else if (data === '\x15' || data === '\r' || (data.endsWith('\r') && data.length > 1)) {
      this.#inputLine = ''
    } else if (isPlainInput(data)) {
      this.#inputLine += data
    }
    this.#term?.write(data)
  }

  submitCurrentInput(): Promise<TrackedShellResult | null> {
    const cmd = this.#inputLine.trim()
    this.#inputLine = ''
    if (!cmd) {
      this.#term?.write('\r')
      return Promise.resolve(null)
    }
    this.#term?.write('\x15')
    return this.runTracked(cmd)
  }

  runTracked(command: string): Promise<TrackedShellResult> {
    const cmd = command.trim()
    if (!cmd) {
      const now = new Date().toISOString()
      return Promise.resolve({ id: '', command: cmd, cwd: this.#cwd, startedAt: now, endedAt: now, stdout: '', stderr: '', locations: [] })
    }

    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`
    const run = this.#startRun(id, cmd)

    if (!this.#term) {
      const result = spawnSync(cmd, {
        cwd: this.#cwd,
        encoding: 'utf8',
        shell: true,
        timeout: 120000,
      })
      run.stdout = trimTail(result.stdout ?? '')
      run.stderr = trimTail(result.stderr ?? '')
      run.exitCode = result.status ?? undefined
      run.endedAt = new Date().toISOString()
      for (const line of `${run.stdout}\n${run.stderr}`.split('\n')) {
        const parsed = parseErrorLine(line)
        if (parsed.location) run.locations.push(parsed.location)
      }
      return Promise.resolve({ ...run })
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#tracked.delete(id)
        run.endedAt = new Date().toISOString()
        resolve({ ...run })
      }, 120000)

      this.#tracked.set(id, { run, timer, resolve })
      const sentinel = `__CODECLAW_EXIT_${id}:`
      this.#term?.write(`(${cmd}); __codeclaw_status=$?; printf '\\n${sentinel}%s\\n' "$__codeclaw_status"\r`)
    })
  }

  #startRun(id: string, command: string): ShellRun {
    const run: ShellRun = {
      id,
      command,
      cwd: this.#cwd,
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
      locations: [],
    }
    this.#runs.push(run)
    if (this.#runs.length > 50) this.#runs.shift()
    return run
  }

  #handleTrackedExit(text: string): boolean {
    const match = text.match(/__CODECLAW_EXIT_([^:]+):(\d+)/)
    if (!match) return false

    const tracked = this.#tracked.get(match[1]!)
    if (!tracked) return true

    clearTimeout(tracked.timer)
    this.#tracked.delete(match[1]!)
    tracked.run.exitCode = parseInt(match[2]!, 10)
    tracked.run.endedAt = new Date().toISOString()
    tracked.resolve({ ...tracked.run })
    return true
  }

  resize(cols: number, rows: number) { this.#term?.resize(cols, rows) }

  kill() { this.#term?.kill() }
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[\]]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '')
}

function isPlainInput(data: string): boolean {
  return data.length > 0 && /^[\x20-\x7e]+$/.test(data)
}

function appendTail(run: ShellRun, field: 'stdout' | 'stderr', line: string): void {
  const next = run[field] ? `${run[field]}\n${line}` : line
  run[field] = trimTail(next)
}

function trimTail(text: string): string {
  return text.replace(/\r/g, '').split('\n').slice(-200).join('\n').trimEnd()
}
