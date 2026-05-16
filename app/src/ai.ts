import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ShellLine, ShellSession } from './shell.js'
import { debugLog } from './debug-log.js'
import { getActiveProvider } from './ai-registry.js'

/** Defaults use loopback IP — on some hosts `localhost` resolves to ::1 while Ollama listens on IPv4 only. */

/** Model base name (strip `:tag`) for family detection. */
export function ollamaModelBase(modelName: string): string {
  const i = modelName.indexOf(':')
  return (i >= 0 ? modelName.slice(0, i) : modelName).trim()
}

/** Code models trained on FIM tokens — use /api/generate + <|fim_*|> prompt, not chat. */
const FIM_MODEL_FAMILY_RE = /^(qwen.*coder|deepseek-coder|starcoder|codellama)/i

export function isFimCapableModel(modelName: string): boolean {
  return FIM_MODEL_FAMILY_RE.test(ollamaModelBase(modelName))
}

/**
 * Use /api/generate with <|fim_*|> when true; otherwise chat + [CURSOR] (still Ollama).
 * Qwen2.5-Coder **1.5B** often emits only tutorial prose in FIM middle → ghost stays empty after sanitize.
 */
export function shouldUseOllamaFimPrompt(modelName: string): boolean {
  if (!isFimCapableModel(modelName)) return false
  const base = ollamaModelBase(modelName).toLowerCase()
  if (!/^qwen/.test(base) || !base.includes('coder')) return true
  return !/(^|:)1\.5b\b/i.test(modelName)
}

export function buildFimPrompt(prefix: string, suffix: string): string {
  return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
}

const FIM_STOP_SEQS = [
  '<|endoftext|>',
  '<|fim_pad|>',
  '<|fim_prefix|>',
  '<|fim_suffix|>',
  '<|fim_middle|>',
  '<|repo_name|>',
  '<|file_sep|>',
  '<|im_end|>',
  '<|im_start|>',
  // FIM should insert code, not chat / markdown; stop before ``` turns the stream into a tutorial.
  '```',
] as const

const RUNNER_DEPS = ['tsx', 'ts-node', 'tsc', 'typescript', 'vitest', 'jest', 'mocha', 'node']

export function findProjectContext(filePath: string | null): string {
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

export function buildShellContext(sessions?: ShellSession[], fallbackLines?: ShellLine[]): string {
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
  projectRules?: string
  projectMemory?: string
}

/** Ollama streams are usually newline-delimited JSON; some proxies wrap lines as SSE. */
function trimOllamaNdjsonLine(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('data:')) return t.slice(5).trimStart()
  return t
}

/** Exported for tests — chat NDJSON lines from POST /api/chat?stream=true */
export function parseOllamaChatLine(line: string): { delta: string; done: boolean } | null {
  const payload = trimOllamaNdjsonLine(line)
  if (!payload) return null
  try {
    const msg = JSON.parse(payload) as { message?: { content?: string }; done?: boolean }
    return { delta: typeof msg.message?.content === 'string' ? msg.message.content : '', done: Boolean(msg.done) }
  } catch {
    return null
  }
}

/** Exported for tests — generate NDJSON lines from POST /api/generate?stream=true */
export function parseOllamaGenerateLine(line: string): { delta: string; done: boolean } | null {
  const payload = trimOllamaNdjsonLine(line)
  if (!payload) return null
  try {
    const msg = JSON.parse(payload) as { response?: string; done?: boolean }
    return { delta: typeof msg.response === 'string' ? msg.response : '', done: Boolean(msg.done) }
  } catch {
    return null
  }
}

export function buildProjectMemoryPart(rules?: string, memory?: string): string {
  const parts: string[] = []
  if (rules?.trim())  parts.push(`Project rules:\n${rules.trim().slice(0, 800)}`)
  if (memory?.trim()) parts.push(`Project memory:\n${memory.trim().slice(0, 800)}`)
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : ''
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
  const projectPart  = findProjectContext(context.filename)
  const memoryPart   = buildProjectMemoryPart(context.projectRules, context.projectMemory)

  const systemContent =
    `You are a coding assistant embedded in a terminal editor with a shell pane, git pane, and editor pane.\n` +
    `You can see the user's current file, recent shell output, and git context below.\n` +
    `When the user asks to run something, prefer npm scripts over raw npx commands. Only suggest commands using available runners.\n` +
    `File: ${context.filename ?? 'untitled'}  cursor: ${context.cursor.row + 1}:${context.cursor.col + 1}${bufPart}\n` +
    `\`\`\`\n${fileSnippet}\n\`\`\`${shellPart}${gitPart}${projectPart}${memoryPart}`

  yield* getActiveProvider().streamChatMessages(systemContent, messages, signal)
}

/** If the model mixed chat with a fence, keep only the first fenced code body ( drops "It looks like…" wrappers). */
function extractFirstCompleteMdFenceBody(s: string): string | null {
  const m = s.match(/```[\w.#+-]*\s*\r?\n([\s\S]*?)```/)
  return m && m[1] !== undefined ? m[1].trimEnd() : null
}

/** Chat/tutorial signatures small code models paste instead of FIM gaps — match anywhere on a line. */
const TUTORIAL_SPAM =
  /The code you provided|simple function that subtracts|subtracts the second argument|argument from the first|However, there are|few issues with it|Here's the corrected|Here's a corrected|corrected version of your code|should be `subtract`|function name `add`|\bit looks\b.*\b(code|function|subtract)/i

function lineLooksLikeTutorialSpam(raw: string): boolean {
  const t = raw.trim()
  return t.length > 0 && TUTORIAL_SPAM.test(t)
}

/**
 * True if this line could be TypeScript/JavaScript source (not chat).
 * Used to slice leading/trailing tutorial walls that bypass regex-only sanitizers.
 */
export function lineLooksLikeCodeLine(raw: string): boolean {
  const t = raw.trim()
  if (t === '') return false
  if (lineLooksLikeTutorialSpam(raw)) return false
  if (/^(export|import|function|const|let|var|return|type|interface|enum|namespace|async|await|debugger|throw)\b/.test(t)) return true
  if (/^(?:\/\/|\/\*|\*\/)/.test(t)) return true
  if (/^[\}\]\)\];]$/.test(t)) return true
  // Typical editor indent (2+ spaces or tab) before code
  if (/^[\t ]{2,}\S/.test(raw)) return true
  // Short gap-fill expressions (operators, calls, literals)
  if (t.length <= 72 && /^[\w\s+\-*/().,:'"`[\]{}=<>!?|&%;$]+$/.test(t) && /[=+(){},;:<>\-\[\]]/.test(t)) return true
  // Tiny identifier / suffix fragments (e.g. completing `a -` with `b`)
  if (t.length <= 28 && /^[\w.+\-`'"]+$/.test(t)) return true
  return false
}

/** Long lines with almost no code punctuation are almost always model prose. */
function looksLikeLongProseLine(raw: string): boolean {
  const t = raw.trim()
  if (t.length < 56) return false
  if (/^\d+\.\s/.test(t)) return false
  if (/^(export|import|function|const|let|var|return|type|interface)\b/.test(t)) return false
  if (/[{}();=`]/.test(t)) return false
  const words = t.split(/\s+/).length
  return words >= 12
}

/**
 * Drop leading tutorial walls; keep short ambiguous lines (single-token gap fills).
 */
function stripLeadingUntilCodeLine(s: string): string {
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const t = raw.trim()
    if (t === '') {
      i++
      continue
    }
    if (lineLooksLikeTutorialSpam(raw)) {
      i++
      continue
    }
    if (lineLooksLikeCodeLine(raw)) break
    if (looksLikeLongProseLine(raw)) {
      i++
      continue
    }
    break
  }
  return lines.slice(i).join('\n')
}

/** Drop trailing tutorial after the last plausible code line. */
function stripTrailingAfterLastCodeLine(s: string): string {
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  let j = lines.length - 1
  while (j >= 0) {
    const raw = lines[j] ?? ''
    const t = raw.trim()
    if (t === '') {
      j--
      continue
    }
    if (lineLooksLikeTutorialSpam(raw)) {
      j--
      continue
    }
    if (lineLooksLikeCodeLine(raw)) break
    if (looksLikeLongProseLine(raw)) {
      j--
      continue
    }
    break
  }
  if (j < 0) return ''
  return lines.slice(0, j + 1).join('\n')
}

// Secondary: line-start phrases we still skip when trimming chat-prefixed junk.
const LEADING_CHAT_LINE =
  /^(It looks like\b|It looks\b|The provided code snippet\b|Here's a breakdown\b|Here's how you can\b|Here's the corrected\b|Here is (the fix|how)\b|Yes,\s+(you're|you |we |I |this |that )\b|These functions\b|The first function\b|The second function\b|This function will\b|Note:\s*$|#{1,6}\s|\d+\.\s*\*\*)/i

/** Drop leading blank lines and obvious tutorial openers before code. */
function stripLeadingChatLines(s: string): string {
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const t = raw.trim()
    if (t === '') {
      i++
      continue
    }
    if (lineLooksLikeTutorialSpam(raw)) {
      i++
      continue
    }
    if (LEADING_CHAT_LINE.test(t)) {
      i++
      continue
    }
    break
  }
  return lines.slice(i).join('\n')
}

/** After a code block, models often append a tutorial paragraph — drop it. */
function stripTrailingTutorialParagraph(s: string): string {
  const parts = s.split(/\n\n+/)
  if (parts.length < 2) return s
  const p2 = (parts[1] ?? '').trim()
  if (
    p2.length > 0
    && /^(These functions\b|The following\b|This means\b|It (also )?means\b|You can\b|I can\b|Here's how\b|The provided code snippet\b)/i.test(p2)
    && !/^\s*(export|import|function|const|let|type|interface|\/\/)/m.test(p2)
  ) {
    return (parts[0] ?? '').trimEnd()
  }
  return s
}

/** Cut everything from the first line that looks like tutorial / markdown explainer (mid-completion). */
function truncateAtTutorialNoise(s: string): string {
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  const isNoiseLine = (line: string): boolean => {
    const t = line.trim()
    if (lineLooksLikeTutorialSpam(line)) return true
    if (/^(Yes,\s+(you're|you |we |I )\b|No,\s+(that's|this |it )\b)/i.test(t)) return true
    if (/The provided code snippet/i.test(t)) return true
    if (/\bdefines two functions\b/i.test(t) && !/\bexport\s+function\b/.test(t)) return true
    if (/Here's how you can/i.test(t)) return true
    if (/^#{1,6}\s/.test(t)) return true
    if (/^\d+\.\s*\*\*/.test(t)) return true
    if (/\*\*[Ff]unction\s*`?[a-z_]+`?\*\*/i.test(t)) return true
    if (/^-\s+This function/i.test(t)) return true
    if (/^-\s+It returns/i.test(t)) return true
    return false
  }
  for (const line of lines) {
    if (isNoiseLine(line)) break
    out.push(line)
  }
  return out.join('\n')
}

/** Inline ghost text must stay a snippet — not a chapter. */
const MAX_INLINE_COMPLETION_LINES = 18
const MAX_INLINE_COMPLETION_CHARS = 780

function capInlineCompletionSize(s: string): string {
  const lines = s.split('\n')
  const cappedLines = lines.length > MAX_INLINE_COMPLETION_LINES
    ? lines.slice(0, MAX_INLINE_COMPLETION_LINES)
    : lines
  let t = cappedLines.join('\n')
  if (t.length > MAX_INLINE_COMPLETION_CHARS) {
    t = t.slice(0, MAX_INLINE_COMPLETION_CHARS)
    const lastNl = t.lastIndexOf('\n')
    if (lastNl > MAX_INLINE_COMPLETION_CHARS * 0.35) t = t.slice(0, lastNl)
  }
  return t
}

/**
 * Strip markdown fences / language tags small models often emit around inline completions.
 * Pass the full streamed accumulator each update (handles partial ``` lines by returning '').
 */
export function sanitizeInlineCompletion(acc: string, loose = false): string {
  let s = acc
  if (/^\s*```/.test(s)) {
    // Language tag is only word-like chars — do not use [^`\n]* or it eats the whole code line.
    const blockOpen = s.match(/^\s*```\s*[\w.#+-]*\s*\r?\n/)
    if (blockOpen) {
      s = s.slice(blockOpen[0].length)
    } else if (/^\s*```\s*[\w.#+-]*\s*$/.test(s) || /^\s*```\s*$/.test(s)) {
      return ''
    } else {
      const inlineOpen = s.match(/^\s*```\s*[\w.#+-]*\s+(.*)$/s)
      if (inlineOpen && inlineOpen[1] !== undefined) {
        s = inlineOpen[1]
      } else {
        return ''
      }
    }
  }

  // Model returned prose then a fence: prefer the fenced code only (still streaming may lack closing ```).
  const fenced = extractFirstCompleteMdFenceBody(s)
  if (fenced !== null) {
    s = fenced
  }

  s = s.replace(/\r?\n```[^\n`]*$/g, '')
  s = s.replace(/```\s*$/g, '')

  if (!loose) {
    s = stripLeadingUntilCodeLine(s)
    s = stripTrailingAfterLastCodeLine(s)
    s = truncateAtTutorialNoise(s)
  }
  s = stripLeadingChatLines(s)
  s = stripTrailingTutorialParagraph(s)
  s = capInlineCompletionSize(s)

  if (!loose) {
    const lines = s.replace(/\r\n/g, '\n').split('\n')
    if (!lines.some(line => lineLooksLikeCodeLine(line))) return ''
  }

  return s
}

/**
 * Prefix/suffix around [CURSOR] for Ollama completion.
 * On a whitespace-only row, collapse blank runs so the marker sits between the nearest
 * non-empty lines — otherwise the prompt is mostly newlines and small models return nothing.
 */
export function buildCompletionAffixes(
  lines: string[],
  cursor: { row: number; col: number },
): { prefix: string; suffix: string; gapCollapsed: boolean } {
  if (lines.length === 0) return { prefix: '', suffix: '', gapCollapsed: false }

  const row = Math.max(0, Math.min(cursor.row, lines.length - 1))
  const line = lines[row] ?? ''
  const col = Math.max(0, Math.min(cursor.col, line.length))

  if (line.trim().length !== 0) {
    const prefix =
      lines.slice(0, row).join('\n') +
      (row > 0 ? '\n' : '') +
      line.slice(0, col)
    const suffix =
      line.slice(col) +
      (row + 1 < lines.length ? '\n' : '') +
      lines.slice(row + 1).join('\n')
    return { prefix, suffix, gapCollapsed: false }
  }

  let pr = row - 1
  while (pr >= 0 && !(lines[pr]?.trim())) pr--
  let nr = row
  while (nr < lines.length && !(lines[nr]?.trim())) nr++

  let prefix = ''
  if (pr >= 0) {
    prefix =
      lines.slice(0, pr).join('\n') +
      (pr > 0 ? '\n' : '') +
      (lines[pr] ?? '')
  }

  const suffix = nr < lines.length ? lines.slice(nr).join('\n') : ''

  return { prefix, suffix, gapCollapsed: true }
}

/**
 * Drop a leading run of newlines from suffix when prefix already ends with non-whitespace.
 * Fixes prompts like `}[CURSOR]\n\n\n\n\nexport...` that make qwen 1.5b return empty.
 */
export function tightenCompletionAffixes(prefix: string, suffix: string): { prefix: string; suffix: string; tightened: boolean } {
  if (!suffix.startsWith('\n')) return { prefix, suffix, tightened: false }
  if (!/\S$/.test(prefix)) return { prefix, suffix, tightened: false }
  const stripped = suffix.replace(/^\n+/, '')
  if (stripped === suffix || !/\S/.test(stripped)) return { prefix, suffix, tightened: false }
  return { prefix, suffix: stripped, tightened: true }
}

export async function* streamCompletion(
  filename: string | null,
  lines: string[],
  cursor: { row: number; col: number },
  signal: AbortSignal,
  shellLines?: ShellLine[],
): AsyncGenerator<string> {
  let { prefix, suffix, gapCollapsed } = buildCompletionAffixes(lines, cursor)
  const tight = tightenCompletionAffixes(prefix, suffix)
  prefix = tight.prefix
  suffix = tight.suffix

  // Shell context is not used in completion prompts (noise + wrong shape for FIM).
  void shellLines

  debugLog('completion', 'stream_completion_route', {
    cursor, gapCollapsed, suffixTightened: tight.tightened,
    lineCount: lines.length, prefixLen: prefix.length, suffixLen: suffix.length,
    prefixTail: prefix.slice(-120), suffixHead: suffix.slice(0, 120),
  })

  yield* getActiveProvider().streamInlineCompletion(prefix, suffix, filename, signal)
}
