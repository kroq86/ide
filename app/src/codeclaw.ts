import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, isAbsolute, normalize, relative, resolve } from 'node:path'
import { formatEditorVsDiskMyersSnippet } from './git.js'
import { debugLog } from './debug-log.js'
import type { ShellRun } from './shell.js'
import {
  PatchProposalInputSchema,
  ReviewProposalInputSchema,
  formatPatchProposalZodError,
} from './codeclaw-schemas.js'
import {
  appendCodeClawTraceEvent,
  writeCodeClawTracePayload,
} from './codeclaw-trace-recorder.js'
import { OLLAMA_MODEL, OLLAMA_URL } from './ollama-env.js'

/** Limits for the fix prompt only — keeps Ollama RAM/context down; traces still use full `FixContext` where saved separately. */
const FIX_PROMPT_MAX_RULES = 8000
const FIX_PROMPT_MAX_GIT_STATUS = 4000
const FIX_PROMPT_MAX_USER_REQUEST = 4000
const FIX_PROMPT_MAX_MEMORY = 4000
const FIX_PROMPT_MAX_GIT_DIFF = 12000
const FIX_PROMPT_MAX_FILE_SNIPPET = 12000
const FIX_PROMPT_MAX_OPEN_BUFFERS = 8
const FIX_PROMPT_MAX_SHELL_STDOUT = 6000
const FIX_PROMPT_MAX_SHELL_STDERR = 6000

function sliceWithTruncNote(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n… [truncated ${String(s.length - max)} chars]`
}

function trimShellRunForPrompt(run: ShellRun): ShellRun {
  return {
    ...run,
    stdout: sliceWithTruncNote(run.stdout, FIX_PROMPT_MAX_SHELL_STDOUT),
    stderr: sliceWithTruncNote(run.stderr, FIX_PROMPT_MAX_SHELL_STDERR),
  }
}

export type FixContext = {
  activeFile: {
    path: string
    content: string
    cursor?: { line: number; column: number }
  }
  openBuffers: Array<{
    path: string
    content: string
  }>
  lastFailedRun: ShellRun
  git: {
    branch?: string
    status: string
    diff: string
  }
  rules: string
  memory?: string
  userRequest: string
}

export type PatchProposal = {
  summary: string
  rootCause: string
  files: Array<{
    path: string
    unifiedDiff: string
  }>
  /** Task ID from .codeclaw/tasks.json. Falls back to the last failed command if unresolvable. */
  verifyTask: string
  risk: 'low' | 'medium' | 'high'
  notes?: string[]
}

export type VerifyResult = {
  run: ShellRun
}

export type FixContextInput = {
  activeFile: FixContext['activeFile']
  openBuffers: FixContext['openBuffers']
  lastFailedRun: ShellRun
  git: FixContext['git']
  rules: string
  memory?: string
  userRequest: string
}

export type CodeClawTrace = {
  id: string
  workflow: 'fix'
  startedAt: string
  input: {
    command: string
    activeFile: string
    gitBranch?: string
  }
  failure: {
    exitCode?: number
    startedAt?: string
    endedAt?: string
    locations: ShellRun['locations']
  }
  proposal?: {
    summary: string
    rootCause: string
    filesChanged: string[]
    risk: PatchProposal['risk']
    assessedRisk?: PatchRiskAssessment
  }
  accepted: boolean
  verify?: {
    command: string
    exitCode?: number
    passed: boolean
    startedAt?: string
    endedAt?: string
  }
  /** Patch applied; verification was delegated to CodeClaw review instead of running a shell command. */
  verifyDelegation?: 'codeclaw_review'
  error?: string
  /** Present when `error` is set — normalized diff heads so traces are debuggable without stderr only. */
  patchPreview?: Array<{ path: string; unifiedDiffHead: string }>
}

export type PatchRiskAssessment = {
  level: 'low' | 'medium' | 'high'
  reasons: string[]
  canAutoApply: boolean
  requiresConfirm: boolean
}

export type ReviewFinding = {
  severity: 'blocker' | 'warning' | 'note'
  file: string
  line?: number
  title: string
  explanation: string
  suggestedPatch?: string
  rule?: string
}

export type ReviewProposal = {
  summary: string
  findings: ReviewFinding[]
  safeToCommit: boolean
}

export type TraceSummary = {
  trace: CodeClawTrace
  path: string
}

/** Persisted under `.codeclaw/traces/review/` so fix traces stay in `traces/*.json`. */
export type CodeClawReviewTrace = {
  id: string
  workflow: 'review'
  startedAt: string
  endedAt: string
  gitBranch?: string
  activeFile: string
  openBuffers: string[]
  diffChars: number
  gitDiffPreview?: string
  status: 'ok' | 'error'
  proposal?: {
    summary: string
    safeToCommit: boolean
    findingCount: number
    findings: Array<{
      severity: ReviewFinding['severity']
      file: string
      line?: number
      title: string
      rule?: string
    }>
  }
  error?: string
}

function dirContainsPath(parent: string, dir: string): boolean {
  const rel = relative(parent, dir)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const DEFAULT_RULES = [
  '- Make the smallest safe change.',
  '- Do not refactor unrelated code.',
  '- Preserve public APIs unless explicitly requested.',
  '- If changing behavior, add or update a test.',
  '- Prefer patches that can be verified by one command.',
].join('\n')

/**
 * CodeClaw uses large `/api/generate` prompts; Ollama keeps models + KV cache resident by default.
 * Default `keep_alive: "0"` unloads after each CodeClaw request (same effect as restarting Ollama for RAM).
 * Set `OLLAMA_CODECLAW_KEEP_ALIVE=` (empty) to omit and use server default, or `5m` etc. to tune.
 */
function codeClawOllamaKeepAliveField(): { keep_alive?: string } {
  const v = process.env['OLLAMA_CODECLAW_KEEP_ALIVE']
  if (v === '') return {}
  return { keep_alive: v ?? '0' }
}

export function codeClawDir(cwd: string): string {
  return join(cwd, '.codeclaw')
}

export type CodeClawTask = {
  id: string
  cmd: string
  description?: string
}

export function loadTasks(cwd: string): CodeClawTask[] {
  const path = join(codeClawDir(cwd), 'tasks.json')
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { tasks?: unknown }).tasks)) return []
    const arr = (raw as { tasks: unknown[] }).tasks
    return arr.flatMap(t => {
      if (typeof t !== 'object' || t === null) return []
      const rec = t as Record<string, unknown>
      const id  = typeof rec['id']  === 'string' && rec['id'].trim()  ? rec['id']  : null
      const cmd = typeof rec['cmd'] === 'string' && rec['cmd'].trim() ? rec['cmd'] : null
      if (!id || !cmd) return []
      const description = typeof rec['description'] === 'string' ? rec['description'] : undefined
      return [{ id, cmd, description }]
    })
  } catch {
    return []
  }
}

export function resolveTaskCommand(taskId: string, tasks: CodeClawTask[]): string | null {
  return tasks.find(t => t.id === taskId)?.cmd ?? null
}

export function loadCodeClawProject(cwd: string): { rules: string; memory: string } {
  const dir = codeClawDir(cwd)
  const rulesPath = join(dir, 'rules.md')
  const memoryPath = join(dir, 'memory.md')
  const rules = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8').trim() : DEFAULT_RULES
  const memory = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8').trim() : ''
  return { rules, memory }
}

/** Loads repo rules, then prepends the nearest `.codeclaw/rules.md` walking up from `activeFile` (when under `cwd`). */
export function loadCodeClawProjectForReview(cwd: string, activeFile: string): { rules: string; memory: string } {
  const base = loadCodeClawProject(cwd)
  const trimmed = activeFile.trim()
  if (!trimmed) return base

  const cwdNorm = normalize(cwd)
  const abs = isAbsolute(trimmed) ? normalize(trimmed) : normalize(join(cwdNorm, trimmed))
  const rootRulesPath = normalize(join(codeClawDir(cwdNorm), 'rules.md'))

  let dir = dirname(abs)
  while (dirContainsPath(cwdNorm, dir)) {
    const localRules = normalize(join(dir, '.codeclaw', 'rules.md'))
    if (existsSync(localRules) && localRules !== rootRulesPath) {
      const extra = readFileSync(localRules, 'utf8').trim()
      if (extra) {
        return {
          ...base,
          rules: `${extra}\n\n---\n\n${base.rules}`,
        }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return base
}

export function collectGitContext(cwd: string): FixContext['git'] {
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).stdout.trim() || undefined
  const status = run(['status', '--short'], cwd).stdout.trim()
  const diff = run(['diff', '--', '.'], cwd).stdout.trim()
  return { branch, status, diff }
}

/**
 * Unstaged diff for **CodeClaw review only**: `git diff` with pathspec excludes so lockfile churn and
 * `.codeclaw/traces/` never enter the raw diff (Codex-style: keep tooling/session trees out of the
 * model-facing diff; `buildReviewDiffSnippet` still drops any stragglers). Fix flow keeps full `collectGitContext().diff`.
 */
const GIT_DIFF_REVIEW_PATHSPEC_EXCLUDES = [
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/npm-shrinkwrap.json',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/pnpm-workspace.yaml',
  ':(exclude,glob)**/bun.lock',
  ':(exclude,glob)**/bun.lockb',
  ':(exclude,glob)**/poetry.lock',
  ':(exclude,glob)**/Pipfile.lock',
  ':(exclude,glob)**/Gemfile.lock',
  ':(exclude,glob)**/Cargo.lock',
  ':(exclude,glob)**/go.sum',
  ':(exclude,glob)**/composer.lock',
  ':(exclude,glob)**/uv.lock',
  ':(exclude,glob)**/flake.lock',
  ':(exclude,glob)**/mix.lock',
  ':(exclude,glob)**/.codeclaw/traces/**',
] as const

export function collectGitDiffForReview(cwd: string): string {
  return run(['diff', '--', '.', ...GIT_DIFF_REVIEW_PATHSPEC_EXCLUDES], cwd).stdout.trim()
}

export function createFixContext(input: FixContextInput): FixContext {
  return {
    activeFile: input.activeFile,
    openBuffers: input.openBuffers,
    lastFailedRun: input.lastFailedRun,
    git: input.git,
    rules: input.rules,
    memory: input.memory,
    userRequest: input.userRequest,
  }
}

/** Optional `traceId` ties Ollama raw I/O to `.codeclaw/traces/events/*.jsonl` when `CODECLAW_TRACE_RAW=1`. */
export type CodeClawOllamaRecording = { traceId: string }

export async function generatePatchProposal(
  context: FixContext,
  signal: AbortSignal,
  tasks: CodeClawTask[] = [],
  cwd: string = process.cwd(),
  recording?: CodeClawOllamaRecording,
): Promise<PatchProposal> {
  const system = buildProposalSystemPrompt(context, tasks)
  const user = buildProposalUserMessage(context, cwd)
  if (recording?.traceId) {
    appendCodeClawTraceEvent(cwd, recording.traceId, 'fix', 'ollama_request', {
      detail: { model: OLLAMA_MODEL, endpoint: 'chat', url: `${OLLAMA_URL}/api/chat` },
    })
  }
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: 'json',
      // Low temperature + bounded output. num_predict must fit whole JSON; models often emit huge
      // unifiedDiff strings — truncation yields "Unterminated string in JSON". Cap via env on weak HW.
      options: {
        temperature: 0.05,
        num_predict: (() => {
          const v = process.env['OLLAMA_CODECLAW_NUM_PREDICT']?.trim()
          if (v && /^\d+$/.test(v)) return Math.min(8192, Math.max(512, parseInt(v, 10)))
          return 2560
        })(),
      },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      ...codeClawOllamaKeepAliveField(),
    }),
    signal,
  })

  if (!response.ok) {
    const errBody = await response.text()
    if (recording?.traceId) {
      const ref = writeCodeClawTracePayload(cwd, recording.traceId, 'fix', 'ollama_error', errBody)
      appendCodeClawTraceEvent(cwd, recording.traceId, 'fix', 'ollama_http_error', {
        payloadRef: ref ?? undefined,
        detail: { status: response.status },
      })
    }
    throw new Error(`ollama ${response.status}: ${errBody}`)
  }

  const payload = await response.json() as { message?: { content?: string } }
  const raw = payload.message?.content ?? ''
  let rawPayloadRef: string | null = null
  if (recording?.traceId) {
    rawPayloadRef = writeCodeClawTracePayload(cwd, recording.traceId, 'fix', 'ollama_raw', raw)
    appendCodeClawTraceEvent(cwd, recording.traceId, 'fix', 'ollama_response', {
      payloadRef: rawPayloadRef ?? undefined,
      detail: { rawChars: raw.length },
    })
  }
  try {
    const proposal = parsePatchProposal(raw, cwd)
    if (recording?.traceId) {
      appendCodeClawTraceEvent(cwd, recording.traceId, 'fix', 'parse_ok', {
        detail: { fileCount: proposal.files.length, risk: proposal.risk },
      })
    }
    return proposal
  } catch (error) {
    if (recording?.traceId) {
      appendCodeClawTraceEvent(cwd, recording.traceId, 'fix', 'parse_error', {
        payloadRef: rawPayloadRef ?? undefined,
        detail: { message: error instanceof Error ? error.message : String(error) },
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    debugLog('codeclaw', 'fix_parse_failed', {
      message,
      rawChars: raw.length,
      rawHead: raw.slice(0, 400),
    })
    throw new Error(
      `${message} (enable QE_DEBUG for a short raw head in logs, or CODECLAW_TRACE_RAW for full payload)`,
    )
  }
}

export function parsePatchProposal(raw: string, cwd: string = process.cwd()): PatchProposal {
  const json = extractJson(raw)
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new Error(`proposal was not valid JSON: ${String(error)}`)
  }

  if (!isObject(value)) throw new Error('proposal must be an object')
  assertPatchProposalTopLevel(value as Record<string, unknown>)
  const validated = PatchProposalInputSchema.safeParse(value)
  if (!validated.success) {
    throw new Error(`proposal failed validation: ${formatPatchProposalZodError(validated.error)}`)
  }
  const v = validated.data
  const summary = v.summary.trim()
  const rootCause = v.rootCause.trim()
  const verifyTask = (v.verifyTask?.trim() ?? '') || (v.verifyCommand?.trim() ?? '')
  const risk = readProposalRisk({ risk: v.risk } as Record<string, unknown>)
  const rawFiles = v.files

  const skipped: string[] = []
  const files: PatchProposal['files'] = []
  for (let index = 0; index < rawFiles.length; index++) {
    const file = rawFiles[index]
    if (!isObject(file)) {
      skipped.push(`#${index}: not an object (${file === null ? 'null' : typeof file})`)
      continue
    }
    try {
      const rawPath = readString(file, 'path')
      const path = normalizeProposalPath(cwd, rawPath)
      const unifiedDiffRaw = readUnifiedDiffField(file)
      const unifiedDiff = normalizeUnifiedDiffForGitApply(path, unifiedDiffRaw)
      if (!unifiedDiff.includes('--- ') || !unifiedDiff.includes('+++ ') || !unifiedDiff.includes('@@')) {
        throw new Error('missing unified diff markers')
      }
      files.push({ path, unifiedDiff })
    } catch (err) {
      skipped.push(`#${index}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (files.length === 0) {
    throw new Error(
      `no valid proposal files (${rawFiles.length} entr${rawFiles.length !== 1 ? 'ies' : 'y'}; skipped ${skipped.join('; ')})`,
    )
  }

  const notesValue = v.notes
  const baseNotes = Array.isArray(notesValue)
    ? notesValue.filter((note): note is string => typeof note === 'string')
    : []
  const skipNote = skipped.length
    ? [`Skipped invalid files[] entries: ${skipped.slice(0, 6).join('; ')}${skipped.length > 6 ? ' …' : ''}`]
    : []
  const notes = [...baseNotes, ...skipNote].length ? [...baseNotes, ...skipNote] : undefined

  return { summary, rootCause, files, verifyTask, risk, notes }
}

/** Cap for unsaved buffer text in review prompt — keep total prompt small for 1.5B models. */
const REVIEW_PROMPT_ACTIVE_BUFFER_MAX = 1800
/** Git diff slice for review — whole-repo diffs are huge; leading slice often omits the focused file entirely. */
const REVIEW_PROMPT_DIFF_MAX = 1200
/** Myers `-`/`+` lines: disk vs editor for the focused file (git diff omits unsaved buffer). */
const REVIEW_PROMPT_DISK_MYERS_MAX_LINES = 80
const REVIEW_PROMPT_DISK_MYERS_MAX_CHARS = 2800

/** Fix user message: Myers snippet cap (lines then char slice). */
const USER_MSG_DISK_MYERS_MAX_LINES = 100
const USER_MSG_DISK_MYERS_MAX_CHARS = 3200

/**
 * Returns the unified-diff chunk for one repo-relative path, or '' if that file does not appear in `fullDiff`.
 */
export type GitDiffChunk = { pathA: string; body: string }

/** Split a combined `git diff` into one string per file hunk (paths from the `a/` side). */
export function splitGitDiffIntoChunks(fullDiff: string): GitDiffChunk[] {
  const text = fullDiff.replace(/\r\n/g, '\n')
  const rx = /^diff --git a\/(.+?) b\/(.+?)$/gm
  const hits: { idx: number; pathA: string }[] = []
  let m: RegExpExecArray | null
  while ((m = rx.exec(text)) !== null) {
    hits.push({ idx: m.index, pathA: (m[1] ?? '').replace(/\\/g, '/') })
  }
  const out: GitDiffChunk[] = []
  for (let i = 0; i < hits.length; i++) {
    const { idx, pathA } = hits[i]!
    const end = i + 1 < hits.length ? hits[i + 1]!.idx : text.length
    out.push({ pathA, body: text.slice(idx, end).trimEnd() })
  }
  return out
}

export function extractGitDiffForPath(fullDiff: string, repoRelativePath: string): string {
  const want = repoRelativePath.trim().replace(/^\.?\//, '').replace(/\\/g, '/')
  if (!want) return ''
  const text = fullDiff.replace(/\r\n/g, '\n')
  const rx = /^diff --git a\/(.+?) b\/(.+?)$/gm
  const hits: { idx: number; pathA: string }[] = []
  let m: RegExpExecArray | null
  while ((m = rx.exec(text)) !== null) {
    hits.push({ idx: m.index, pathA: (m[1] ?? '').replace(/\\/g, '/') })
  }
  for (let i = 0; i < hits.length; i++) {
    const { idx, pathA } = hits[i]!
    if (pathA !== want && !pathA.endsWith(`/${want}`)) continue
    const end = i + 1 < hits.length ? hits[i + 1]!.idx : text.length
    return text.slice(idx, end).trimEnd()
  }
  return ''
}

/** Lockfiles / session artifacts: huge, high-churn, and they steal model attention in review (same class of problem Codex avoids by keeping tooling dirs out of workspace diff context). */
const REVIEW_DIFF_NOISE_BASENAMES = new Set(
  [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'bun.lock',
    'bun.lockb',
    'poetry.lock',
    'pipfile.lock',
    'gemfile.lock',
    'cargo.lock',
    'go.sum',
    'composer.lock',
    'uv.lock',
    'flake.lock',
    'mix.lock',
  ].map(s => s.toLowerCase()),
)

/** True if this diff chunk path should not appear in review except when it is the focused file. */
export function isReviewNoiseDiffPath(pathA: string): boolean {
  const p = pathA.replace(/\\/g, '/')
  const lower = p.toLowerCase()
  if (lower.includes('/.codeclaw/traces/') || lower.startsWith('.codeclaw/traces/')) return true
  const seg = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower
  return REVIEW_DIFF_NOISE_BASENAMES.has(seg)
}

function reviewGitStatusLineShowsNoisePath(line: string): boolean {
  const t = line.replace(/\r\n/g, '')
  const m = t.match(/^(.{2})\s+(.+)$/)
  const rest = (m?.[2] ?? t).trim().replace(/\\/g, '/')
  if (!rest) return false
  const low = rest.toLowerCase()
  if (low.includes('/.codeclaw/traces/') || low.startsWith('.codeclaw/traces/')) return true
  for (const p of low.split(/\s+->\s+/)) {
    const seg = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
    if (REVIEW_DIFF_NOISE_BASENAMES.has(seg)) return true
  }
  return false
}

/**
 * Strip git status lines that mirror review diff excludes: CodeClaw trace dirs (self-tracking) and
 * known lockfiles so `prepareReviewGitInput` is not noisy when only `git status` still lists them.
 */
export function filterReviewGitStatusLines(status: string): string {
  if (!status.trim()) return ''
  return status
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !reviewGitStatusLineShowsNoisePath(line))
    .join('\n')
    .trim()
}

/** `git diff` + filtered `git status --short` for review prompts and traces (noise removed before join). */
export function prepareReviewGitInput(diff: string, status: string): string {
  const s = filterReviewGitStatusLines(status)
  return [diff.trim(), s].filter(Boolean).join('\n')
}

function reviewChunkSortKey(pathA: string, activePath: string): number {
  const want = activePath.trim().replace(/^\.?\//, '').replace(/\\/g, '/')
  if (!want || want === 'unknown') return 0
  const topSeg = want.includes('/') ? want.slice(0, want.indexOf('/')) : want
  const chunkTop = pathA.includes('/') ? pathA.slice(0, pathA.indexOf('/')) : pathA

  let key = 300
  if (pathA === want || pathA.endsWith(`/${want}`)) key = 0
  else if (pathA.startsWith(`${topSeg}/`) || pathA === topSeg) key = 40
  else if (chunkTop !== topSeg) key += 80

  if (/\/test\/|\.test\.ts$|\.test\.tsx$/i.test(pathA)) key += 60
  return key
}

/**
 * Build a short diff excerpt for the review model.
 * - Always prefers hunks for the focused path when present.
 * - If the focused file has no hunk, avoids implying unrelated leading hunks describe that file (small models hallucinate).
 * - Deprioritizes hunks under paths like app/test/ (fixtures may embed fake diff --git string literals).
 */
export function buildReviewDiffSnippet(gitDiff: string, activePath: string, maxChars: number): string {
  const text = gitDiff.replace(/\r\n/g, '\n')
  if (!text.trim()) return '(no changes)'
  const want = activePath.trim().replace(/^\.?\//, '').replace(/\\/g, '/')
  const trunc = (s: string) =>
    s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n… [truncated ${String(s.length - maxChars)} chars]`

  const chunks = splitGitDiffIntoChunks(text)
  const focused = want && want !== 'unknown' ? extractGitDiffForPath(text, want) : ''

  const sorted = [...chunks].sort(
    (a, b) => reviewChunkSortKey(a.pathA, want) - reviewChunkSortKey(b.pathA, want) || a.pathA.localeCompare(b.pathA),
  )

  const wantNorm = want.replace(/\\/g, '/')
  const isFocusedPath = (pathA: string) =>
    want !== 'unknown' && (pathA === wantNorm || pathA.endsWith(`/${wantNorm}`))

  let parts: string[] = []
  if (!focused && want !== 'unknown') {
    parts.push(
      `(No unstaged git diff entry for ${want} — treat the active buffer above as the source of truth for that path.)`,
    )
  }
  if (focused) parts.push(focused)

  for (const ch of sorted) {
    if (isFocusedPath(ch.pathA)) continue
    if (isReviewNoiseDiffPath(ch.pathA)) continue
    parts.push(ch.body)
  }

  const joined = parts.join('\n')
  return trunc(joined)
}

export async function generateReviewProposal(
  gitDiff: string,
  rules: string,
  activeFile: string,
  _openBuffers: string[],
  signal: AbortSignal,
  /** Live editor text for the active buffer (optional). Git diff alone misses unsaved duplicates etc. */
  activeEditorBody?: string,
  /** Repo cwd for disk-vs-editor Myers diff (defaults to `process.cwd()`). */
  cwd: string = process.cwd(),
  recording?: CodeClawOllamaRecording,
): Promise<ReviewProposal> {
  // Keep the prompt short — small models (1.5b) fail on long structured prompts
  const rulesSnippet = rules ? rules.slice(0, 500) : 'none'
  const activePath = activeFile.trim() || 'unknown'
  const diffSnippet = buildReviewDiffSnippet(gitDiff, activePath, REVIEW_PROMPT_DIFF_MAX)
  const editorBodyProvided = activeEditorBody !== undefined
  let editorRaw: string | null = typeof activeEditorBody === 'string' ? activeEditorBody : null
  let trimmedBuf = editorRaw !== null ? editorRaw.trim() : ''
  // `undefined` = no buffer text passed (e.g. snapshot not loaded yet) → may read disk. `''` = caller provided an intentionally empty buffer → do not read disk.
  if (!trimmedBuf && activePath !== 'unknown' && !editorBodyProvided) {
    try {
      const abs = isAbsolute(activePath) ? activePath : join(cwd, activePath)
      if (existsSync(abs)) {
        editorRaw = readFileSync(abs, 'utf8')
        trimmedBuf = editorRaw.trim()
      }
    } catch {
      /* ignore */
    }
  }
  const bufferSnippet =
    trimmedBuf.length === 0
      ? ''
      : `\n--- Active buffer content (${activePath}) — editor state; may be missing from git diff ---\n${
          trimmedBuf.length > REVIEW_PROMPT_ACTIVE_BUFFER_MAX
            ? `${trimmedBuf.slice(0, REVIEW_PROMPT_ACTIVE_BUFFER_MAX)}\n…[truncated]`
            : trimmedBuf
        }\n`
  const diskVsEditorMyers =
    editorRaw === null || activePath === 'unknown'
      ? ''
      : formatEditorVsDiskMyersSnippet(cwd, activePath, editorRaw, REVIEW_PROMPT_DISK_MYERS_MAX_LINES)
  const diskVsEditorSection =
    diskVsEditorMyers.length === 0
      ? ''
      : `\n--- Myers line diff: saved file on disk vs full editor buffer (${activePath}) — git diff does not include unsaved edits ---\n${sliceWithTruncNote(
          diskVsEditorMyers,
          REVIEW_PROMPT_DISK_MYERS_MAX_CHARS,
        )}\n`
  const prompt = `The user ran review while focused on file: ${activePath}
You MUST review that buffer content first (below if present). Report findings for "${activePath}" when you see duplicates, dead imports, merge junk, wrong exports, or syntax issues there — even if the git diff excerpt does not mention this path (diff is truncated; unsaved edits never appear in git).
Then also scan the git diff excerpt for other repo issues.

Hard constraints:
- Do NOT report "unused import" unless the active buffer actually contains an import line (e.g. starts with import). If add/sum are defined with export function in the same file, they are not imports.
- Findings must match the active buffer text above; do not repeat stale issues that are already fixed in that buffer.
- Duplicate export means the **same identifier** exported twice (e.g. two \`export function sum\`). Two different names (add vs sum) are never duplicates. Do not invent duplicates.
- Git excerpt may include test files whose **string literals** look like unified diffs — those lines are **not** the focused source file; ignore them when judging ${activePath}.

Return JSON only: {"summary":"<one sentence>","safeToCommit":true|false,"findings":[{"severity":"blocker|warning|note","file":"<path>","title":"<short>","explanation":"<detail>"}]}

Rules: ${rulesSnippet}
${bufferSnippet}${diskVsEditorSection}
--- Git diff excerpt (focused file first when it has changes; then other paths) ---
${diffSnippet}`

  debugLog('codeclaw', 'review_ollama_begin', {
    activePath,
    model: OLLAMA_MODEL,
    url: OLLAMA_URL,
    gitDiffChars: gitDiff.length,
    bufferChars: trimmedBuf.length,
    promptChars: prompt.length,
    hasDiskVsEditorMyers: diskVsEditorSection.length > 0,
  })

  if (recording?.traceId) {
    appendCodeClawTraceEvent(cwd, recording.traceId, 'review', 'ollama_request', {
      detail: { model: OLLAMA_MODEL, endpoint: 'generate', url: `${OLLAMA_URL}/api/generate`, activePath },
    })
  }

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      ...codeClawOllamaKeepAliveField(),
    }),
    signal,
  })

  if (!response.ok) {
    const errBody = await response.text()
    if (recording?.traceId) {
      const ref = writeCodeClawTracePayload(cwd, recording.traceId, 'review', 'ollama_error', errBody)
      appendCodeClawTraceEvent(cwd, recording.traceId, 'review', 'ollama_http_error', {
        payloadRef: ref ?? undefined,
        detail: { status: response.status },
      })
    }
    throw new Error(`ollama ${response.status}: ${errBody}`)
  }

  const payload = await response.json() as { response?: string }
  const raw = payload.response ?? ''
  let rawPayloadRef: string | null = null
  if (recording?.traceId) {
    rawPayloadRef = writeCodeClawTracePayload(cwd, recording.traceId, 'review', 'ollama_raw', raw)
    appendCodeClawTraceEvent(cwd, recording.traceId, 'review', 'ollama_response', {
      payloadRef: rawPayloadRef ?? undefined,
      detail: { rawChars: raw.length },
    })
  }
  const proposal = parseReviewProposal(raw)
  const rawFindingCount = proposal.findings.length
  if (trimmedBuf) {
    proposal.findings = filterReviewFindingsAgainstActiveBuffer(activePath, trimmedBuf, proposal.findings)
    if (rawFindingCount > 0 && proposal.findings.length === 0) proposal.safeToCommit = true
  }
  debugLog('codeclaw', 'review_ollama_end', {
    activePath,
    model: OLLAMA_MODEL,
    rawResponseChars: raw.length,
    rawFindingCount,
    filteredFindingCount: proposal.findings.length,
    findingsDropped: rawFindingCount - proposal.findings.length,
    safeToCommit: proposal.safeToCommit,
  })
  if (recording?.traceId) {
    appendCodeClawTraceEvent(cwd, recording.traceId, 'review', 'parse_done', {
      payloadRef: rawPayloadRef ?? undefined,
      detail: {
        rawFindingCount,
        filteredFindingCount: proposal.findings.length,
        safeToCommit: proposal.safeToCommit,
        summaryHead: proposal.summary.slice(0, 120),
      },
    })
  }
  return proposal
}

function normReviewPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
}

function reviewPathsMatch(findingFile: string, activePath: string): boolean {
  const f = normReviewPath(findingFile)
  const a = normReviewPath(activePath)
  if (!f || !a || a === 'unknown') return false
  return f === a || f.endsWith(`/${a}`) || a.endsWith(`/${f}`)
}

function escapeRegExpIdent(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Count top-level `export function name` / `export async function name` declarations. */
function countExportedFunctionDeclarations(buffer: string, name: string): number {
  const re = new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s+${escapeRegExpIdent(name)}\\b`, 'gm')
  return (buffer.match(re) ?? []).length
}

/** Distinct identifiers declared as `export function name` in the buffer. */
function exportFunctionDeclarationNames(buffer: string): string[] {
  const re = /^\s*export\s+(?:async\s+)?function\s+(\w+)\b/gm
  return [...new Set([...buffer.matchAll(re)].map(m => m[1]!))]
}

/** True if any exported function name is declared more than once (real duplicate in source). */
function bufferHasDuplicateExportedFunction(buffer: string): boolean {
  return exportFunctionDeclarationNames(buffer).some(n => countExportedFunctionDeclarations(buffer, n) >= 2)
}

function bufferHasImportStatement(buffer: string): boolean {
  return /^\s*import\s+/m.test(buffer)
}

function duplicateKeywordIndices(blob: string): number[] {
  const idx: number[] = []
  for (const m of blob.matchAll(/\bduplicate\b/gi)) idx.push(m.index ?? 0)
  for (const m of blob.matchAll(/\btwo\s+functions\b/gi)) idx.push(m.index ?? 0)
  return idx
}

/**
 * Drop obvious LLM hallucinations for the focused file when we have the real buffer (small models invent duplicate exports / imports).
 * Uses **counts of real `export function <name>` lines** in the buffer. Duplicate-ish prose ("exported twice", phantom overloads)
 * is dropped when it contradicts those counts — no template list of model wordings.
 */
export function filterReviewFindingsAgainstActiveBuffer(
  activePath: string,
  buffer: string,
  findings: ReviewFinding[],
): ReviewFinding[] {
  const want = normReviewPath(activePath)
  if (!want || want === 'unknown' || !buffer.trim()) return findings

  return findings.filter(f => {
    if (!reviewPathsMatch(f.file, want)) return true

    const blob = `${f.title}\n${f.explanation}`

    const dupTitle = f.title.match(/\bDuplicate\s+export\s*:\s*(\w+)/i)
    if (dupTitle) {
      const n = dupTitle[1]!
      if (countExportedFunctionDeclarations(buffer, n) < 2) return false
    }

    const dupTitleDash = f.title.match(/\bDuplicate\s+export\s*[—–-]\s*(\w+)/i)
    if (dupTitleDash && countExportedFunctionDeclarations(buffer, dupTitleDash[1]!) < 2) return false

    const dupTitleOf = f.title.match(/\bDuplicate\s+export\s+of\s+(\w+)\b/i)
    if (dupTitleOf && countExportedFunctionDeclarations(buffer, dupTitleOf[1]!) < 2) return false

    const twoNamed = blob.match(/\btwo\s+functions\s+named\s+[`']?(\w+)[`']?/i)
    if (twoNamed && countExportedFunctionDeclarations(buffer, twoNamed[1]!) < 2) return false

    // "exported twice" / overload-duplicate prose without matching `export function` counts → model fiction (no per-phrase regex list).
    if (/\bis\s+exported\s+twice\b|\bexported\s+twice\b/i.test(blob) && !bufferHasDuplicateExportedFunction(buffer)) return false

    const phantomOverloadDup = blob.match(
      /\bExported function\s+(\w+)\b[^.\n]{0,80}\bdifferent parameter types\b/i,
    )
    if (phantomOverloadDup && countExportedFunctionDeclarations(buffer, phantomOverloadDup[1]!) < 2) return false

    const dupIdxs = duplicateKeywordIndices(blob)
    if (dupIdxs.length > 0 && /\bduplicate\b|\btwo\s+functions\b/i.test(blob)) {
      const linked = new Set<string>()
      for (const m of blob.matchAll(/`(\w+)`/g)) {
        const n = m[1]!
        if (!/^[A-Za-z_$][\w$]*$/.test(n)) continue
        const ix = m.index ?? 0
        if (dupIdxs.some(p => Math.abs(ix - p) <= 100)) linked.add(n)
      }
      if (linked.size === 1) {
        const n = [...linked][0]!
        if (countExportedFunctionDeclarations(buffer, n) < 2) return false
      }
    }

    if (
      /\b(unused\s+import|from\s+an\s+import|imported\s+from)\b/i.test(blob) &&
      !bufferHasImportStatement(buffer)
    )
      return false

    return true
  })
}

export function parseReviewProposal(raw: string): ReviewProposal {
  const json = extractJson(raw)
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    // Model returned non-JSON — wrap it as a single note finding
    return {
      summary: 'Model returned unstructured output',
      safeToCommit: false,
      findings: [{ severity: 'note', file: '(unknown)', title: 'Raw model output', explanation: raw.slice(0, 400) }],
    }
  }

  if (!isObject(value)) {
    return { summary: 'Invalid response shape', safeToCommit: false, findings: [] }
  }

  const validated = ReviewProposalInputSchema.safeParse(value)
  if (!validated.success) {
    return { summary: 'Invalid response shape', safeToCommit: false, findings: [] }
  }

  const rec = validated.data
  const summary = typeof rec.summary === 'string' && rec.summary.trim()
    ? rec.summary
    : 'Review complete'
  const safeToCommit = typeof rec.safeToCommit === 'boolean' ? rec.safeToCommit : false

  const rawFindings = rec.findings ?? []
  const findings: ReviewFinding[] = rawFindings.flatMap((f, i) => {
    if (!isObject(f)) return []
    const fRec = f as Record<string, unknown>
    const severity = fRec['severity']
    const normSeverity: ReviewFinding['severity'] =
      severity === 'blocker' ? 'blocker' : severity === 'warning' ? 'warning' : 'note'
    const file = typeof fRec['file'] === 'string' && fRec['file'].trim() ? fRec['file'] : `(file ${i})`
    const lineRaw = fRec['line']
    const line = typeof lineRaw === 'number' ? lineRaw : undefined
    const title = typeof fRec['title'] === 'string' && fRec['title'].trim() ? fRec['title'] : 'Finding'
    const explanation = typeof fRec['explanation'] === 'string' ? fRec['explanation'] : ''
    const suggestedPatch = typeof fRec['suggestedPatch'] === 'string' && fRec['suggestedPatch'].trim() ? fRec['suggestedPatch'] : undefined
    const rule = typeof fRec['rule'] === 'string' && fRec['rule'].trim() ? fRec['rule'] : undefined
    return [{ severity: normSeverity, file, line, title, explanation, suggestedPatch, rule }]
  })

  return { summary, findings, safeToCommit }
}

export function applyPatchProposal(cwd: string, proposal: PatchProposal): { ok: true } | { ok: false; error: string } {
  const risk = assessPatchRisk(proposal)
  if (!risk.canAutoApply) {
    return { ok: false, error: `patch is ${risk.level} risk: ${risk.reasons.join('; ')}` }
  }

  const filesNorm = proposal.files.map(file => ({
    path: file.path,
    unifiedDiff: normalizeUnifiedDiffForGitApply(file.path, file.unifiedDiff),
  }))

  try {
    validatePatchProposalFiles(filesNorm)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }

  const patch = filesNorm.map(file => file.unifiedDiff.trimEnd()).join('\n') + '\n'
  const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '--'], {
    cwd,
    input: patch,
    encoding: 'utf8',
    timeout: 10000,
  })
  if ((check.status ?? 1) !== 0) {
    return { ok: false, error: (check.stderr || check.stdout || 'git apply --check failed').trim() }
  }

  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '--'], {
    cwd,
    input: patch,
    encoding: 'utf8',
    timeout: 10000,
  })
  if ((applied.status ?? 1) !== 0) {
    return { ok: false, error: (applied.stderr || applied.stdout || 'git apply failed').trim() }
  }
  return { ok: true }
}

export function assessPatchRisk(proposal: PatchProposal): PatchRiskAssessment {
  const reasons: string[] = []
  const filePaths = proposal.files.map(file => file.path)
  const diffText = proposal.files.map(file => file.unifiedDiff).join('\n')
  const changedLines = diffText.split('\n')
    .filter(line => /^[+-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---'))

  let level: PatchRiskAssessment['level'] = 'low'
  let riskRank = 0
  const raise = (next: PatchRiskAssessment['level'], reason: string) => {
    reasons.push(reason)
    const nextRank = next === 'high' ? 2 : next === 'medium' ? 1 : 0
    if (nextRank > riskRank) {
      riskRank = nextRank
      level = next
    }
  }

  if (!proposal.verifyTask.trim()) raise('high', 'missing verify task')
  if (proposal.files.length > 1) raise('medium', 'multiple files changed')
  if (changedLines.length > 80) raise('medium', 'large diff')
  if (filePaths.some(isTestPath)) raise('medium', 'test file changed')
  if (filePaths.some(isConfigPath)) raise('medium', 'config file changed')
  if (filePaths.some(isDependencyPath)) raise('high', 'dependency or lockfile changed')
  if (filePaths.some(isMigrationPath)) raise('high', 'migration or schema file changed')
  if (diffText.split('\n').some(line => line.startsWith('deleted file mode'))) raise('high', 'file deletion')

  for (const path of filePaths) {
    try {
      validatePatchPath(path)
    } catch {
      raise('high', `unsafe path: ${path}`)
    }
  }

  if (reasons.length === 0) reasons.push('small single-file patch with verification command')
  return {
    level,
    reasons,
    canAutoApply: riskRank < 2,
    requiresConfirm: riskRank === 1,
  }
}

export function makeTraceId(date = new Date()): string {
  return `${date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-')}-codeclaw-fix`
}

export function makeReviewTraceId(date = new Date()): string {
  return `${date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-')}-codeclaw-review`
}

export function buildReviewTrace(params: {
  id: string
  startedAt: string
  endedAt: string
  gitBranch?: string
  activeFile: string
  openBuffers: string[]
  diffChars: number
  gitDiffPreview?: string
  status: 'ok' | 'error'
  proposal?: ReviewProposal | null
  error?: string
}): CodeClawReviewTrace {
  const proposal = params.status === 'ok' && params.proposal
    ? {
        summary: params.proposal.summary,
        safeToCommit: params.proposal.safeToCommit,
        findingCount: params.proposal.findings.length,
        findings: params.proposal.findings.map(f => ({
          severity: f.severity,
          file: f.file,
          line: f.line,
          title: f.title,
          rule: f.rule,
        })),
      }
    : undefined

  return {
    id: params.id,
    workflow: 'review',
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    gitBranch: params.gitBranch,
    activeFile: params.activeFile,
    openBuffers: params.openBuffers,
    diffChars: params.diffChars,
    gitDiffPreview: params.gitDiffPreview,
    status: params.status,
    proposal,
    error: params.error,
  }
}

export function writeReviewTrace(cwd: string, trace: CodeClawReviewTrace): string {
  const dir = join(codeClawDir(cwd), 'traces', 'review')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${trace.id}.json`)
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  return path
}

export function buildTrace(
  id: string,
  startedAt: string,
  context: FixContext,
  proposal: PatchProposal | null,
  accepted: boolean,
  verify?: VerifyResult,
  error?: string,
  verifyDelegation?: 'codeclaw_review',
): CodeClawTrace {
  const patchPreview =
    error && proposal && proposal.files.length > 0
      ? proposal.files.slice(0, 8).map(file => ({
          path: file.path,
          unifiedDiffHead: normalizeUnifiedDiffForGitApply(file.path, file.unifiedDiff).slice(0, 4000),
        }))
      : undefined

  return {
    id,
    workflow: 'fix',
    startedAt,
    input: {
      command: context.lastFailedRun.command,
      activeFile: context.activeFile.path,
      gitBranch: context.git.branch,
    },
    failure: {
      exitCode: context.lastFailedRun.exitCode,
      startedAt: context.lastFailedRun.startedAt,
      endedAt: context.lastFailedRun.endedAt,
      locations: context.lastFailedRun.locations,
    },
    proposal: proposal ? {
      summary: proposal.summary,
      rootCause: proposal.rootCause,
      filesChanged: proposal.files.map(file => file.path),
      risk: proposal.risk,
      assessedRisk: assessPatchRisk(proposal),
    } : undefined,
    accepted,
    verify: verify ? {
      command: verify.run.command,
      exitCode: verify.run.exitCode,
      passed: verify.run.exitCode === 0,
      startedAt: verify.run.startedAt,
      endedAt: verify.run.endedAt,
    } : undefined,
    ...(verifyDelegation && !verify ? { verifyDelegation } : {}),
    error,
    ...(patchPreview ? { patchPreview } : {}),
  }
}

export function writeTrace(cwd: string, trace: CodeClawTrace): string {
  const dir = join(codeClawDir(cwd), 'traces')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${trace.id}.json`)
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  return path
}

export function readLatestTrace(cwd: string): TraceSummary | null {
  const dir = join(codeClawDir(cwd), 'traces')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const path = join(dir, file)
      return { path, mtimeMs: statSync(path).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latest = files[0]
  if (!latest) return null
  const trace = JSON.parse(readFileSync(latest.path, 'utf8')) as CodeClawTrace
  return { trace, path: latest.path }
}

function validatePatchProposalFiles(files: PatchProposal['files']): void {
  for (const file of files) {
    validatePatchPath(file.path)
    if (!file.unifiedDiff.includes('--- ') || !file.unifiedDiff.includes('+++ ') || !file.unifiedDiff.includes('@@')) {
      throw new Error(`invalid unified diff for ${file.path}`)
    }
    validateUnifiedDiffBody(file.path, file.unifiedDiff)
  }
}

function validatePatchProposal(proposal: PatchProposal): void {
  validatePatchProposalFiles(proposal.files)
}

/**
 * Walk the diff body once we're inside a hunk (after `@@`). Every line must start with
 * ` `, `+`, `-`, or `\` (no-newline marker). Anything else is prose the model wrote
 * between hunks — `git apply` rejects it as "patch with only garbage at line N",
 * which is opaque to users. Surface the offending line ourselves.
 */
export function validateUnifiedDiffBody(path: string, unifiedDiff: string): void {
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n')
  let inHunk = false
  /** Lines consuming old-file side of the hunk (` ` + `-`). */
  let remainingOld = 0
  /** Lines consuming new-file side (` ` + `+`). `Math.max(old,new)` is wrong when context lines exist. */
  let remainingNew = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('@@')) {
      inHunk = true
      const match = line.match(UNIFIED_DIFF_HUNK_HEADER_LINE_RE)
      if (match) {
        remainingOld = match[2] ? parseInt(match[2], 10) : 1
        remainingNew = match[4] ? parseInt(match[4], 10) : 1
      } else {
        remainingOld = Number.POSITIVE_INFINITY
        remainingNew = Number.POSITIVE_INFINITY
      }
      continue
    }
    if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      inHunk = false
      remainingOld = 0
      remainingNew = 0
      continue
    }
    if (!inHunk) continue

    const hunkEnded = remainingOld <= 0 && remainingNew <= 0
    if (hunkEnded) {
      // Hunk is closed — only blanks or `\ No newline…` may appear before the next `@@`.
      // Do NOT accept `+`/`-`/space lines here: git treats them as a corrupt patch (no fresh @@ header).
      if (line === '') continue
      if (line.startsWith('\\')) continue
      throw new Error(`invalid unified diff for ${path}: extra content after hunk on line ${i + 1}: ${shortLine(line)}`)
    }

    if (line === '' || /^[ +\-\\]/.test(line)) {
      if (line.startsWith('\\')) {
        /* `\ No newline at end of file` — no line-count debit */
      } else if (line.startsWith(' ') || line.startsWith('-')) {
        if (remainingOld > 0) remainingOld--
      }
      if (line.startsWith(' ') || line.startsWith('+')) {
        if (remainingNew > 0) remainingNew--
      }
      continue
    }
    throw new Error(`invalid unified diff for ${path}: line ${i + 1} must start with ' ', '+', '-' or '\\' but got: ${shortLine(line)}`)
  }
}

function shortLine(s: string): string {
  const t = s.length > 80 ? `${s.slice(0, 80)}…` : s
  return JSON.stringify(t)
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
}

function isConfigPath(path: string): boolean {
  return /(^|\/)(tsconfig|vite\.config|webpack\.config|rollup\.config|eslint\.config)\./.test(path)
    || /(^|\/)package\.json$/.test(path)
    || /\.(ya?ml|toml|json)$/.test(path) && /(^|\/)(\.github|config|configs)\//.test(path)
}

function isDependencyPath(path: string): boolean {
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|requirements\.txt|poetry\.lock)$/.test(path)
    || /(^|\/)package\.json$/.test(path)
}

function isMigrationPath(path: string): boolean {
  return /(^|\/)(migrations?|schema)\//i.test(path) || /schema\.(sql|prisma|rb|ts|js)$/i.test(path)
}

function validatePatchPath(path: string): void {
  const normalized = normalize(path)
  if (!path || isAbsolute(path) || normalized.startsWith('..')) {
    throw new Error(`unsafe patch path: ${path}`)
  }
}

/** Walk up from `startDir` until a `.git` entry exists (file or directory). */
function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  for (let i = 0; i < 48; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Models often return paths like `../other/pkg/foo.ts` when cwd is a subfolder — valid on disk but
 * rejected by validatePatchPath. Resolve against cwd + git root and return a safe repo-relative path.
 */
export function normalizeProposalPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\/g, '/')
  if (!trimmed) throw new Error('empty patch path')

  const normTrim = normalize(trimmed).replace(/\\/g, '/')
  try {
    validatePatchPath(normTrim)
    return normTrim
  } catch {
    /* Path escapes cwd — resolve via git root below */
  }

  const repoRoot = findGitRoot(cwd)
  const absFromCwd = resolve(cwd, trimmed)

  const tryUnderRoot = (root: string, absolute: string): string | null => {
    const rel = normalize(relative(root, absolute)).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    validatePatchPath(rel)
    return rel
  }

  if (repoRoot) {
    const hit = tryUnderRoot(repoRoot, absFromCwd)
    if (hit !== null) return hit
  }

  const hitCwd = tryUnderRoot(cwd, absFromCwd)
  if (hitCwd !== null) return hitCwd

  // Model assumed cwd one level deeper: strip leading ../ and re-resolve within repo
  const collapsed = trimmed.replace(/^(\.\.[\\/])+/, '')
  const normCollapsed = normalize(collapsed.replace(/\\/g, '/')).replace(/\\/g, '/')
  if (!normCollapsed || normCollapsed.startsWith('..') || isAbsolute(normCollapsed)) {
    throw new Error(`unsafe patch path: ${rawPath}`)
  }

  const absCollapsed = resolve(cwd, normCollapsed)
  if (repoRoot) {
    const hit = tryUnderRoot(repoRoot, absCollapsed)
    if (hit !== null) return hit
  }

  const hit2 = tryUnderRoot(cwd, absCollapsed)
  if (hit2 !== null) return hit2

  throw new Error(`unsafe patch path: ${rawPath}`)
}

/** Models sometimes wrap hunk headers as `[@@ -1,3 +1,3 @@]` inside JSON strings — git rejects that. */
export function sanitizeUnifiedDiffBracketHunks(unifiedDiff: string): string {
  return unifiedDiff.replace(/\[(@@[^\]\r\n]+)\]/g, '$1')
}

/** Fixes glued tokens small models emit: `--- a/x+++ b/y` or `+++ b/x@@ -1,2`. */
export function sanitizeUnifiedDiffGlue(unifiedDiff: string): string {
  let t = unifiedDiff.replace(/\r\n/g, '\n')
  // Missing newline between --- line and +++ line
  t = t.replace(/(---[^\n]+?)\+\+\+\s/g, '$1\n+++ ')
  // Missing newline between +++ line and @@ hunk header
  t = t.replace(/(\+\+\+[^\n]+?)@@/g, '$1\n@@')
  return t
}

/**
 * Models often emit prose or duplicate source lines between `---`/`+++` and the first `@@`.
 * Our hunk validator skips those lines when not yet `inHunk`, so they slip through — then
 * `git apply` fails with "patch with only garbage at line N". Drop those lines.
 */
export function sanitizeUnifiedDiffInterstitial(unifiedDiff: string): string {
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let gap: 'none' | 'after_minus' | 'after_plus' = 'none'

  for (const line of lines) {
    if (gap === 'after_minus') {
      if (line.startsWith('+++ ')) {
        out.push(line)
        gap = 'after_plus'
        continue
      }
      if (line === '') {
        out.push(line)
        continue
      }
      if (line.startsWith('diff --git')) {
        gap = 'none'
        out.push(line)
        continue
      }
      continue
    }
    if (gap === 'after_plus') {
      if (line.startsWith('@@')) {
        out.push(line)
        gap = 'none'
        continue
      }
      if (line === '') {
        out.push(line)
        continue
      }
      if (line.startsWith('diff --git')) {
        gap = 'none'
        out.push(line)
        continue
      }
      if (line.startsWith('--- ')) {
        gap = 'after_minus'
        out.push(line)
        continue
      }
      continue
    }

    out.push(line)
    if (line.startsWith('--- ')) {
      gap = 'after_minus'
    }
  }
  return out.join('\n')
}

/**
 * Lines small models paste **inside** a hunk with no `/-/+` prefix — not code, not `git apply` input.
 * Dropping avoids `validateUnifiedDiffBody` / git failing on obvious echo text (e.g. "Raw response:").
 */
function isLikelyHunkProseLine(trimmed: string): boolean {
  if (!trimmed) return false
  if (/^raw\s+response\b/i.test(trimmed)) return true
  if (/^here'?s\s+(the\s+)?(unified\s+)?(diff|patch)\b/i.test(trimmed)) return true
  if (/^(the\s+)?(following\s+)?(unified\s+)?diff\s*(is|:)\b/i.test(trimmed)) return true
  if (/^(note|important|warning)\s*:/i.test(trimmed)) return true
  if (/^output\s*:/i.test(trimmed)) return true
  if (/^```(?:json|typescript|ts|js|diff|text)?\s*$/i.test(trimmed)) return true
  return false
}

/**
 * Inside `@@` hunks, every content line must start with ` `, `+`, `-`, or `\`.
 * Small models often paste `}` / `export …` without the leading space — git apply rejects that.
 * Only rewrite lines that look like code fragments (avoid turning prose into fake context).
 */
export function sanitizeUnifiedDiffBareHunkLines(unifiedDiff: string): string {
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n')
  let inHunk = false
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      out.push(line)
      continue
    }
    if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      inHunk = false
      out.push(line)
      continue
    }
    if (!inHunk || line === '' || /^[ +\-\\]/.test(line)) {
      out.push(line)
      continue
    }
    const trimmed = line.trim()
    const looksLikeCodeContin =
      trimmed === '}' ||
      trimmed === '};' ||
      trimmed === ');' ||
      /^[\}\]\);,]\s*;?\s*$/.test(trimmed) ||
      /^[\{\(]\s*$/.test(trimmed) ||
      /^(export|import|return|const|let|var|function|type|interface|enum|namespace|async|await)\b/.test(trimmed)
    if (looksLikeCodeContin) {
      out.push(` ${line}`)
      continue
    }
    if (isLikelyHunkProseLine(trimmed)) continue
    out.push(line)
  }
  return out.join('\n')
}

/** Allow `+ 9,5` typo (space after `+`) — git rejects it as corrupt patch. Shared with `validateUnifiedDiffBody`. */
export const UNIFIED_DIFF_HUNK_HEADER_LINE_RE = /^@@ -(\d+)(?:,(\d+))? \+\s*(\d+)(?:,(\d+))? @@(.*)$/

/**
 * Rewrite each `@@ -ls,lc +rs,rc @@` so `lc`/`rc` match the following hunk body.
 * Models often emit random counts (e.g. `7,7` for four lines) → `git apply`: corrupt patch.
 */
export function repairUnifiedDiffHunkHeaders(unifiedDiff: string): string {
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const hm = line.match(UNIFIED_DIFF_HUNK_HEADER_LINE_RE)
    if (!hm) {
      out.push(line)
      i++
      continue
    }
    const oldStart = hm[1]!
    const newStart = hm[3]!
    const rest = hm[5] ?? ''
    i++
    const bodyStart = i
    while (i < lines.length) {
      const L = lines[i] ?? ''
      if (L.startsWith('@@') && /^@@ -\d+/.test(L)) break
      if (L.startsWith('diff --git ')) break
      i++
    }
    const body = lines.slice(bodyStart, i)
    let oldCnt = 0
    let newCnt = 0
    for (const L of body) {
      if (L.startsWith('\\')) continue
      if (L === '') continue
      const ch = L[0]
      if (ch === ' ') {
        oldCnt++
        newCnt++
      } else if (ch === '-') {
        oldCnt++
      } else if (ch === '+') {
        newCnt++
      }
    }
    // Drop only **empty** placeholder hunks (e.g. `@@ -11,0 +11,0 @@` with no body). If the body is
    // non-empty but lines lack `/-/+` prefixes, counts stay 0 — swallowing the hunk strips all `@@`
    // and `normalizeUnifiedDiffForGitApply` can feed `git apply` a bare `@@` line → "patch fragment without header".
    if (oldCnt === 0 && newCnt === 0) {
      const bodyHasNonBlank = body.some(L => L.trim() !== '')
      if (!bodyHasNonBlank) continue
      out.push(line)
      out.push(...body)
      continue
    }
    out.push(`@@ -${oldStart},${oldCnt} +${newStart},${newCnt} @@${rest}`)
    out.push(...body)
  }
  return out.join('\n')
}

/** Collapse `+ 9,5` / `- 9,5` style typos inside `@@ ... @@` lines (models emit spaces after +/- before line numbers). */
function sanitizeUnifiedDiffSpacedHunkHeaders(unifiedDiff: string): string {
  return unifiedDiff.replace(/^@@ -[^\n]*$/gm, line =>
    line.replace(/-\s+(?=\d)/g, '-').replace(/\+\s+(?=\d)/g, '+'),
  )
}

/**
 * Models sometimes emit only `+`/`-`/` ` lines with no `@@` hunk header — git apply and our validator require `@@`.
 */
function prependSyntheticHunkIfBarePlusMinusLines(t: string): string {
  const s = t.trim()
  if (!s || s.includes('@@')) return t

  const lines = s.split('\n')
  const diffLines: string[] = []
  for (const L of lines) {
    if (L === '') continue
    if (L.startsWith('\\')) {
      diffLines.push(L)
      continue
    }
    if (/^[ +-]/.test(L)) diffLines.push(L)
  }
  if (diffLines.length === 0) return t

  let oldCnt = 0
  let newCnt = 0
  for (const L of diffLines) {
    if (L.startsWith('\\')) continue
    const ch = L[0]
    if (ch === ' ') {
      oldCnt++
      newCnt++
    } else if (ch === '-') {
      oldCnt++
    } else if (ch === '+') {
      newCnt++
    }
  }
  if (oldCnt === 0 && newCnt === 0) return t

  const header =
    oldCnt === 0 && newCnt > 0
      ? `@@ -0,0 +1,${newCnt} @@`
      : newCnt === 0 && oldCnt > 0
        ? `@@ -1,${oldCnt} +0,0 @@`
        : `@@ -1,${oldCnt} +1,${newCnt} @@`

  return `${header}\n${diffLines.join('\n')}`
}

/**
 * `git apply` requires `--- a/` / `+++ b/` before hunks. Models sometimes emit `@@` first, then headers — that
 * still matches `hasGitPaths` and was returned verbatim (broken). Move leading `@@…---` segment after headers.
 */
function canonicalizeUnifiedDiffHeaderOrder(filePath: string, t: string): string {
  const lines = t.replace(/\r\n/g, '\n').split('\n')
  const idxMinus = lines.findIndex(l => /^---\s+a\//.test(l))
  const idxAt = lines.findIndex(l => l.startsWith('@@'))
  if (idxMinus < 0 || idxAt < 0 || idxAt >= idxMinus) return t

  const misplaced = lines.slice(idxAt, idxMinus)
  const minusL = lines[idxMinus]!
  const plusL = lines[idxMinus + 1]
  if (!plusL || !/^\+\+\+\s+b\//.test(plusL)) return t

  const rest = lines.slice(idxMinus + 2)
  const head = lines.slice(0, idxAt)
  const headNoBlank = head.filter(l => l.trim() !== '')
  const headDiffGit = headNoBlank.length === 1 && headNoBlank[0]!.startsWith('diff --git ')
    ? headNoBlank[0]!
    : `diff --git a/${filePath} b/${filePath}`

  const out: string[] = [headDiffGit, minusL, plusL, ...misplaced, ...rest]
  return out.join('\n').trimEnd()
}

/**
 * Small models often return only `@@` hunks. `git apply` needs `--- a/...` + `+++ b/...` (and usually `diff --git`).
 */
export function normalizeUnifiedDiffForGitApply(filePath: string, unifiedDiff: string): string {
  let t = sanitizeUnifiedDiffInterstitial(
    sanitizeUnifiedDiffGlue(sanitizeUnifiedDiffBracketHunks(sanitizeUnifiedDiffBareHunkLines(unifiedDiff))),
  ).replace(/\r\n/g, '\n').trim()
  if (!t) return t

  t = sanitizeUnifiedDiffSpacedHunkHeaders(t)
  t = prependSyntheticHunkIfBarePlusMinusLines(t)

  // `repairUnifiedDiffHunkHeaders` walks hunks until `---`/`+++` would not appear inside a hunk — if `@@` was
  // emitted before file headers, `--- a/` lines start with `-` and were mis-counted as diff lines. Canonicalize first.
  t = canonicalizeUnifiedDiffHeaderOrder(filePath, t)

  if (t.includes('@@')) {
    t = repairUnifiedDiffHunkHeaders(t)
  }

  const hasGitPaths = /^---\s+a\//m.test(t) && /^\+\+\+\s+b\//m.test(t)
  if (hasGitPaths && t.includes('@@')) {
    return t.endsWith('\n') ? t : `${t}\n`
  }

  if (!t.includes('@@')) return t.endsWith('\n') ? t : `${t}\n`

  const body = t
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    body,
    '',
  ].join('\n')
}

/** Shrink context for the fix-model prompt (smaller payload + lower Ollama RAM). Full context remains in React until dismissed. */
export function compactFixContextForPrompt(context: FixContext): FixContext {
  return {
    activeFile: trimFile(context.activeFile),
    openBuffers: context.openBuffers.map(trimFile).slice(0, FIX_PROMPT_MAX_OPEN_BUFFERS),
    lastFailedRun: trimShellRunForPrompt(context.lastFailedRun),
    git: {
      branch: context.git.branch,
      status: sliceWithTruncNote(context.git.status, FIX_PROMPT_MAX_GIT_STATUS),
      diff: sliceWithTruncNote(context.git.diff, FIX_PROMPT_MAX_GIT_DIFF),
    },
    rules: sliceWithTruncNote(context.rules, FIX_PROMPT_MAX_RULES),
    memory: context.memory !== undefined
      ? sliceWithTruncNote(context.memory, FIX_PROMPT_MAX_MEMORY)
      : undefined,
    userRequest: sliceWithTruncNote(context.userRequest, FIX_PROMPT_MAX_USER_REQUEST),
  }
}

/** Top-level keys models wrongly echo instead of emitting a patch proposal (matches FixContext / review wording). */
const FIX_PROMPT_FORBIDDEN_TOP_KEYS = [
  'finding',
  'findings',
  'rules',
  'memory',
  'userRequest',
  'activeFile',
  'openBuffers',
  'git',
  'lastFailedRun',
] as const

/** Maximum chars for each section of the *user* message — small models echo big blobs, so per-section caps are tighter than the trace-saved FixContext caps above. */
const USER_MSG_MAX_FILE = 4000
const USER_MSG_MAX_OPEN_BUFFER = 800
const USER_MSG_MAX_OPEN_BUFFERS = 4
const USER_MSG_MAX_STDERR = 2000
const USER_MSG_MAX_STDOUT = 1000
const USER_MSG_MAX_GIT_DIFF = 4000
const USER_MSG_MAX_GIT_STATUS = 1000
const USER_MSG_MAX_USER_REQUEST = 2000

function buildProposalSystemPrompt(context: FixContext, tasks: CodeClawTask[] = []): string {
  const tasksLine = tasks.length > 0
    ? `Verify tasks (pick one id for "verifyTask"): ${tasks.map(t => t.id).join(', ')}`
    : 'No tasks.json — use a shell command string for "verifyTask".'

  const rules = sliceWithTruncNote(context.rules, 1500)

  return [
    'You produce JSON patch proposals for a code editor.',
    'Output exactly ONE JSON object. No markdown. No prose. No extra keys.',
    '',
    'Schema:',
    '{',
    '  "summary":   "<one sentence>",',
    '  "rootCause": "<one sentence>",',
    '  "files":     [ { "path": "<repo path>", "unifiedDiff": ["<diff line 1>","<diff line 2>", "..."] } ],',
    '  "verifyTask":"<task id or shell command>",',
    '  "risk":      "low" | "medium" | "high"',
    '}',
    '',
    'Rules:',
    '- "files" MUST be a non-empty array of objects each with both "path" and "unifiedDiff".',
    '- "path" MUST be repo-relative from git root. Never ../ or absolute paths.',
    '- **unifiedDiff MUST be valid JSON:** PREFERRED: array of strings — ONE git-diff line per element (no embedded raw newlines inside a string). Alternative: a single string where every newline is the two chars backslash-n `\\n`, never an actual line break inside the quotes.',
    '- Raw line breaks inside a quoted unifiedDiff string INVALIDATE the whole response (parser error).',
    '- Put ONLY the minimal diff — never paste an entire large file unless the failure requires it.',
    '- "unifiedDiff" MUST include @@ hunks; full git headers (diff --git, --- a/, +++ b/) preferred.',
    '- **Hunk header syntax (git apply is strict):** each hunk starts with exactly `@@ -OLDSTART,OLDCOUNT +NEWSTART,NEWCOUNT @@` — there must be **no space** between `+` and NEWSTART (invalid: `+ 9,5`; valid: `+9,5`). Same for OLDSTART after `-`.',
    '- After each `@@` line, every body line must begin with exactly one character: space (unchanged context), `-` (removed), or `+` (added). Do not emit empty lines inside the hunk unless they are real blank context lines.',
    '- Patch the code that caused the failure: when the user message names an **Active file**, use that exact repo-relative path as `files[0].path` for edits to that buffer (do not substitute another path like package.json unless the failure is only there).',
    '- Make the smallest safe change that fixes the failure.',
    '',
    tasksLine,
    '',
    'Project rules:',
    rules,
  ].join('\n')
}

function buildProposalUserMessage(context: FixContext, cwd: string): string {
  const file = context.activeFile
  const fileBody = sliceWithTruncNote(file.content, USER_MSG_MAX_FILE)
  const cursor = file.cursor ? `${file.cursor.line}:${file.cursor.column}` : '(none)'

  const failure = context.lastFailedRun
  const stderr = sliceWithTruncNote(failure.stderr, USER_MSG_MAX_STDERR)
  const stdout = sliceWithTruncNote(failure.stdout, USER_MSG_MAX_STDOUT)

  const otherBuffers = context.openBuffers
    .filter(b => b.path !== file.path)
    .slice(0, USER_MSG_MAX_OPEN_BUFFERS)
    .map(b => `- ${b.path}:\n${sliceWithTruncNote(b.content, USER_MSG_MAX_OPEN_BUFFER)}`)
    .join('\n')

  const gitDiff = sliceWithTruncNote(context.git.diff, USER_MSG_MAX_GIT_DIFF)
  const gitStatus = sliceWithTruncNote(context.git.status, USER_MSG_MAX_GIT_STATUS)
  const branch = context.git.branch ?? '(unknown)'

  const request = sliceWithTruncNote(context.userRequest, USER_MSG_MAX_USER_REQUEST)

  const diskVsEditorMyersRaw = formatEditorVsDiskMyersSnippet(
    cwd,
    file.path,
    context.activeFile.content,
    USER_MSG_DISK_MYERS_MAX_LINES,
  )
  const diskVsEditorMyers =
    diskVsEditorMyersRaw.length === 0
      ? ''
      : sliceWithTruncNote(diskVsEditorMyersRaw, USER_MSG_DISK_MYERS_MAX_CHARS)

  return [
    'Fix this failure. Reply with ONLY the JSON patch proposal.',
    '',
    '== Failure ==',
    `Command: ${failure.command}`,
    `Exit:    ${failure.exitCode ?? '(none)'}`,
    'Stderr:',
    stderr || '(empty)',
    'Stdout:',
    stdout || '(empty)',
    '',
    '== Active file ==',
    `Path:    ${file.path}`,
    `Use this exact string as files[0].path when patching this buffer (repo-relative, no ../).`,
    `Cursor:  ${cursor}`,
    'Content:',
    fileBody,
    ...(otherBuffers ? ['', '== Other open files ==', otherBuffers] : []),
    '',
    '== Git ==',
    `Branch: ${branch}`,
    'Status:',
    gitStatus || '(clean)',
    'Diff:',
    gitDiff || '(no changes)',
    ...(diskVsEditorMyers
      ? [
          '',
          '== Unsaved edits vs disk (Myers line diff; git diff omits buffer-only changes) ==',
          diskVsEditorMyers,
        ]
      : []),
    '',
    '== Request ==',
    request || '(none)',
    '',
    'Emit unifiedDiff as a JSON array of strings (one diff line per array element). Do not put raw newlines inside JSON string values.',
  ].join('\n')
}

function trimFile<T extends { content: string }>(file: T): T {
  return { ...file, content: file.content.slice(0, FIX_PROMPT_MAX_FILE_SNIPPET) }
}

function jsonParseOk(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

/** Walk from `start` to the matching `}` for `{`, respecting JSON string escapes. Returns end index or null. */
function findMatchingBraceEnd(s: string, start: number): number | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!
    if (esc) {
      esc = false
      continue
    }
    if (inStr) {
      if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

/** First `{…}` slice starting at each `{` that `JSON.parse` accepts (prose / fences / malformed outers). */
function peelBalancedJsonObject(s: string): string | null {
  let from = 0
  while (from < s.length) {
    const start = s.indexOf('{', from)
    if (start === -1) return null
    const end = findMatchingBraceEnd(s, start)
    if (end === null) return null
    const slice = s.slice(start, end + 1)
    if (jsonParseOk(slice)) return slice
    from = start + 1
  }
  return null
}

export function extractJson(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    if (trimmed.endsWith('}') && jsonParseOk(trimmed)) return trimmed
    const peeled = peelBalancedJsonObject(trimmed)
    if (peeled) return peeled
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) {
    const inner = fenced[1].trim()
    if (jsonParseOk(inner)) return inner
    const fromFence = peelBalancedJsonObject(inner)
    if (fromFence) return fromFence
  }
  const peeled = peelBalancedJsonObject(trimmed)
  if (peeled) return peeled
  return trimmed
}

/** Models sometimes emit `unifiedDiff` as `["line1", "line2"]` or one multi-line string — normalize to one diff text. */
function readUnifiedDiffField(file: object): string {
  const field = (file as Record<string, unknown>)['unifiedDiff']
  if (typeof field === 'string' && field.trim() !== '') return field.trim()
  if (Array.isArray(field)) {
    const parts = field.flatMap((x): string[] => {
      if (typeof x !== 'string' || x.trim() === '') return []
      // One array element may contain several diff lines — split so +/- headers apply per line.
      return x.replace(/\r\n/g, '\n').split('\n')
    })
    const joined = parts.join('\n').trim()
    if (joined !== '') return joined
  }
  throw new Error('proposal unifiedDiff must be a non-empty string')
}

function readString(value: object, key: string): string {
  const field = (value as Record<string, unknown>)[key]
  if (typeof field !== 'string' || field.trim() === '') {
    throw new Error(`proposal ${key} must be a non-empty string`)
  }
  return field
}

function readProposalRisk(value: object): PatchProposal['risk'] {
  const field = (value as Record<string, unknown>)['risk']
  if (typeof field !== 'string') return 'medium'
  const n = field.trim().toLowerCase()
  if (n === 'low' || n === 'medium' || n === 'high') return n
  return 'medium'
}

/** Models often return `{ "text": "...", "version": N }` instead of patch fields when confused by format=json. */
function assertPatchProposalTopLevel(rec: Record<string, unknown>): void {
  const hasSummary = typeof rec['summary'] === 'string' && rec['summary'].trim().length > 0
  if (hasSummary) return

  const keys = Object.keys(rec).sort().join(', ')
  const echoed = FIX_PROMPT_FORBIDDEN_TOP_KEYS.filter(k => Object.prototype.hasOwnProperty.call(rec, k))
  if (echoed.length > 0) {
    throw new Error(
      `Model echoed session-shaped JSON (${echoed.join(', ')}) instead of a patch proposal. ` +
        `Reply must have ONLY: summary, rootCause, files[], verifyTask, risk — see CodeClaw Fix prompt.`,
    )
  }
  const prose =
    (typeof rec['text'] === 'string' && rec['text'].trim())
    || (typeof rec['message'] === 'string' && rec['message'].trim())
    || (typeof rec['content'] === 'string' && rec['content'].trim())
  if (prose) {
    throw new Error(
      `Model returned narrative JSON (keys: ${keys}), not a patch proposal. Required top-level keys: summary, rootCause, files (non-empty array), verifyTask, risk. Do not wrap the answer in "text" only.`,
    )
  }
  throw new Error(`proposal summary missing or empty (keys: ${keys || '(none)'})`)
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function run(args: string[], cwd: string): { stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 })
  return { stdout: result.stdout ?? '' }
}
