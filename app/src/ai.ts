import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ShellLine, ShellSession } from './shell.js'

const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'llama3.2:latest'

const RUNNER_DEPS = ['tsx', 'ts-node', 'tsc', 'typescript', 'vitest', 'jest', 'mocha', 'node']

function findProjectContext(filePath: string | null): string {
  if (!filePath) return ''
  let dir = dirname(filePath)
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          scripts?: Record<string, string>
          devDependencies?: Record<string, string>
          dependencies?: Record<string, string>
        }
        const parts: string[] = []
        if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
          const entries = Object.entries(pkg.scripts).map(([k, v]) => `  ${k}: ${v}`).join('\n')
          parts.push(`npm scripts (${candidate}):\n${entries}`)
        }
        const allDeps = { ...pkg.devDependencies, ...pkg.dependencies }
        const runners = RUNNER_DEPS.filter(d => d in allDeps)
        if (runners.length > 0) {
          parts.push(`available runners: ${runners.join(', ')}`)
        }
        return parts.length > 0 ? `\n\n${parts.join('\n')}` : ''
      } catch { return '' }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

function buildShellContext(sessions?: ShellSession[], fallbackLines?: ShellLine[]): string {
  if (sessions?.length) {
    // Last 3 sessions, max 10 lines each — enough context, not enough to confuse small models
    const recent = sessions.slice(-3)
    const parts = recent.map(s => {
      const out = s.stdout.split('\n').slice(-10).join('\n')
      const errMark = s.exitCode && s.exitCode !== 0 ? ` [exit ${s.exitCode}]` : ''
      return `$ ${s.command}${errMark}\n${out}`
    })
    return `\n\nRecent shell sessions:\n${parts.join('\n---\n')}`
  }
  if (fallbackLines?.length) {
    return `\n\nRecent shell output:\n${fallbackLines.slice(-8).map(l => l.text).join('\n')}`
  }
  return ''
}

export type AiContext = {
  filename: string | null
  lines: string[]
  cursor: { row: number; col: number }
  shellLines?: ShellLine[]
  shellSessions?: ShellSession[]
  gitContext?: string
  openBuffers?: string[]
}

export async function* streamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  context: AiContext,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const fileSnippet = context.lines.join('\n').slice(0, 1500)

  const shellPart   = buildShellContext(context.shellSessions, context.shellLines)
  const gitPart     = context.gitContext ? `\n\n${context.gitContext}` : ''
  const bufPart     = context.openBuffers?.length
    ? `\nOpen buffers: ${context.openBuffers.join(', ')}`
    : ''
  const projectPart = findProjectContext(context.filename)

  const systemContent =
    `You are a coding assistant embedded in a terminal editor with a shell pane, git pane, and editor pane.\n` +
    `You can see the user's current file, recent shell output, and git context below.\n` +
    `When the user asks to run something, prefer npm scripts over raw npx commands. Only suggest commands using available runners.\n` +
    `File: ${context.filename ?? 'untitled'}  cursor: ${context.cursor.row + 1}:${context.cursor.col + 1}${bufPart}\n` +
    `\`\`\`\n${fileSnippet}\n\`\`\`${shellPart}${gitPart}${projectPart}`

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'system', content: systemContent }, ...messages],
      stream: true,
    }),
    signal,
  })

  if (!response.ok || !response.body) {
    throw new Error(`ollama ${response.status}: ${await response.text()}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines_buf = buf.split('\n')
    buf = lines_buf.pop() ?? ''

    for (const line of lines_buf) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as { message?: { content?: string }; done?: boolean }
        if (msg.message?.content) yield msg.message.content
        if (msg.done) return
      } catch {
        // skip malformed chunk
      }
    }
  }
}

export async function* streamCompletion(
  filename: string | null,
  lines: string[],
  cursor: { row: number; col: number },
  signal: AbortSignal,
  shellLines?: ShellLine[],
): AsyncGenerator<string> {
  const prefix =
    lines.slice(0, cursor.row).join('\n') +
    (cursor.row > 0 ? '\n' : '') +
    (lines[cursor.row]?.slice(0, cursor.col) ?? '')

  const suffix =
    (lines[cursor.row]?.slice(cursor.col) ?? '') +
    (cursor.row + 1 < lines.length ? '\n' : '') +
    lines.slice(cursor.row + 1).join('\n')

  const shellContext =
    shellLines && shellLines.length > 0
      ? `\nRecent shell output:\n${shellLines.slice(-20).map(l => l.text).join('\n')}\n`
      : ''

  const prompt =
    `Complete the code at the cursor. Output ONLY the inserted text, nothing else.\n` +
    `File: ${filename ?? 'untitled'}${shellContext}\n` +
    `<prefix>${prefix}</prefix><suffix>${suffix}</suffix>`

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: true }),
    signal,
  })

  if (!response.ok || !response.body) {
    throw new Error(`ollama ${response.status}: ${await response.text()}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines_buf = buf.split('\n')
    buf = lines_buf.pop() ?? ''

    for (const line of lines_buf) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as { response?: string; done?: boolean }
        if (msg.response) yield msg.response
        if (msg.done) return
      } catch {
        // skip malformed chunk
      }
    }
  }
}
