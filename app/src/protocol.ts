import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Cursor = {
  row: number
  col: number
}

export type Snapshot = {
  type: 'snapshot'
  protocolVersion?: number
  bufferId?: string
  revision?: number
  width: number
  height: number
  cursor: Cursor
  lines: string[]
  dirty: boolean
  filename: string | null
  status: string
  totalLines?: number
  viewport?: { start: number; end: number }
  visibleLines?: string[]
  tokens?: SyntaxToken[]
  diagnostics?: Diagnostic[]
}

export type SidecarMessage =
  | { type: 'ready' }
  | Snapshot
  | { type: 'saved'; filename: string | null }
  | { type: 'error'; message: string }
  | LspResponse
  | { type: 'exit' }

export type LspResponse = {
  type: 'lspResponse'
  kind: 'hover' | 'definition' | 'completion' | 'format' | string
  status: string
  result?: unknown
}

export type SyntaxToken = {
  row: number
  startCol: number
  endCol: number
  kind: 'keyword' | 'identifier' | 'type' | 'string' | 'number' | 'comment' | 'constant' | string
}

export type Diagnostic = {
  row: number
  startCol: number
  endCol: number
  severity: 'error' | 'warning' | 'info' | 'hint' | string
  message: string
  source: string
}

type Command =
  | { type: 'open'; filename: string }
  | { type: 'insert'; text: string }
  | { type: 'deleteBackward' }
  | { type: 'deleteForward' }
  | { type: 'deleteLine' }
  | { type: 'deleteRange'; startRow: number; startCol: number; endRow: number; endCol: number }
  | { type: 'move'; direction: 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'wordForward' | 'wordBackward' | 'fileStart' | 'fileEnd' }
  | { type: 'moveTo'; row: number; col: number }
  | { type: 'save' }
  | { type: 'saveAs'; filename: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'setViewport'; start: number; height: number }
  | { type: 'hover'; row: number; col: number }
  | { type: 'goToDefinition'; row: number; col: number }
  | { type: 'completion'; row: number; col: number }
  | { type: 'format' }
  | { type: 'quit' }

type MoveDirection = Extract<Command, { type: 'move' }>['direction']

export class QeSidecar extends EventEmitter {
  #child: ChildProcessWithoutNullStreams
  #buffer = ''
  #closed = false

  constructor(filename?: string) {
    super()

    const appDir = dirname(fileURLToPath(import.meta.url))
    const root = join(appDir, '../..')
    const rustBinary = join(root, 'native/editor-core/target/release/editor-core')
    const legacyBinary = join(root, 'native/qe-core/qe-protocol')
    const binary = existsSync(rustBinary) ? rustBinary : legacyBinary
    const args = filename ? [filename] : []

    this.#child = spawn(binary, args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', chunk => this.#onStdout(String(chunk)))
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', chunk => {
      this.emit('message', {
        type: 'error',
        message: String(chunk).trim(),
      } satisfies SidecarMessage)
    })
    this.#child.on('error', error => {
      const msg = `failed to start editor sidecar: ${error.message}`
      this.emit('message', { type: 'error', message: msg } satisfies SidecarMessage)
      // Emit a stub snapshot so the editor pane renders the error instead of staying blank
      this.emit('message', {
        type: 'snapshot',
        width: 80, height: 24,
        cursor: { row: 0, col: 0 },
        lines: [`[ERROR] ${msg}`, 'Run: npm run build:native'],
        dirty: false,
        filename: null,
        status: msg,
      } satisfies SidecarMessage)
    })
    this.#child.on('exit', () => {
      this.#closed = true
      this.emit('exit')
    })
  }

  send(command: Command): void {
    if (this.#closed || !this.#child.stdin.writable) {
      return
    }

    this.#child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  open(filename: string): void {
    this.send({ type: 'open', filename })
  }

  insert(text: string): void {
    this.send({ type: 'insert', text })
  }

  deleteBackward(): void {
    this.send({ type: 'deleteBackward' })
  }

  deleteForward(): void {
    this.send({ type: 'deleteForward' })
  }

  deleteLine(): void {
    this.send({ type: 'deleteLine' })
  }

  deleteRange(startRow: number, startCol: number, endRow: number, endCol: number): void {
    this.send({ type: 'deleteRange', startRow, startCol, endRow, endCol })
  }

  moveTo(row: number, col: number): void {
    this.send({ type: 'moveTo', row, col })
  }

  move(direction: MoveDirection): void {
    this.send({ type: 'move', direction })
  }

  save(): void {
    this.send({ type: 'save' })
  }

  saveAs(filename: string): void {
    this.send({ type: 'saveAs', filename })
  }

  undo(): void {
    this.send({ type: 'undo' })
  }

  redo(): void {
    this.send({ type: 'redo' })
  }

  resize(width: number, height: number): void {
    this.send({ type: 'resize', width, height })
  }

  setViewport(start: number, height: number): void {
    this.send({ type: 'setViewport', start, height })
  }

  hover(row: number, col: number): void {
    this.send({ type: 'hover', row, col })
  }

  goToDefinition(row: number, col: number): void {
    this.send({ type: 'goToDefinition', row, col })
  }

  completion(row: number, col: number): void {
    this.send({ type: 'completion', row, col })
  }

  format(): void {
    this.send({ type: 'format' })
  }

  quit(): void {
    this.send({ type: 'quit' })
  }

  kill(): void {
    if (!this.#closed) {
      this.#child.kill()
    }
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk

    for (;;) {
      const index = this.#buffer.indexOf('\n')
      if (index === -1) {
        return
      }

      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)

      if (!line.trim()) {
        continue
      }

      try {
        this.emit('message', JSON.parse(line) as SidecarMessage)
      } catch (error) {
        this.emit('message', {
          type: 'error',
          message: `invalid sidecar JSON: ${String(error)}`,
        } satisfies SidecarMessage)
      }
    }
  }
}
