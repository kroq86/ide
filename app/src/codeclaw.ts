import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, isAbsolute, normalize, relative } from 'node:path'
import type { ShellRun } from './shell.js'

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
  error?: string
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

const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'llama3.2:latest'

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

export async function generatePatchProposal(context: FixContext, signal: AbortSignal, tasks: CodeClawTask[] = []): Promise<PatchProposal> {
  const prompt = buildProposalPrompt(context, tasks)
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
    }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`ollama ${response.status}: ${await response.text()}`)
  }

  const payload = await response.json() as { response?: string }
  const raw = payload.response ?? ''
  try {
    return parsePatchProposal(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\nRaw response:\n${raw.slice(0, 2000)}`)
  }
}

export function parsePatchProposal(raw: string): PatchProposal {
  const json = extractJson(raw)
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new Error(`proposal was not valid JSON: ${String(error)}`)
  }

  if (!isObject(value)) throw new Error('proposal must be an object')
  assertPatchProposalTopLevel(value as Record<string, unknown>)
  const summary = readString(value, 'summary')
  const rootCause = readString(value, 'rootCause')
  const verifyTask = readOptionalString(value, 'verifyTask') || readOptionalString(value, 'verifyCommand')
  const risk = readProposalRisk(value)
  const rawFiles = (value as { files?: unknown }).files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('proposal files must be a non-empty array')
  }

  const skipped: string[] = []
  const files: PatchProposal['files'] = []
  for (let index = 0; index < rawFiles.length; index++) {
    const file = rawFiles[index]
    if (!isObject(file)) {
      skipped.push(`#${index}: not an object (${file === null ? 'null' : typeof file})`)
      continue
    }
    try {
      const path = readString(file, 'path')
      const unifiedDiffRaw = readString(file, 'unifiedDiff')
      validatePatchPath(path)
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

  const notesValue = (value as { notes?: unknown }).notes
  const baseNotes = Array.isArray(notesValue)
    ? notesValue.filter((note): note is string => typeof note === 'string')
    : []
  const skipNote = skipped.length
    ? [`Skipped invalid files[] entries: ${skipped.slice(0, 6).join('; ')}${skipped.length > 6 ? ' …' : ''}`]
    : []
  const notes = [...baseNotes, ...skipNote].length ? [...baseNotes, ...skipNote] : undefined

  return { summary, rootCause, files, verifyTask, risk, notes }
}

export async function generateReviewProposal(
  gitDiff: string,
  rules: string,
  activeFile: string,
  _openBuffers: string[],
  signal: AbortSignal,
): Promise<ReviewProposal> {
  // Keep the prompt short — small models (1.5b) fail on long structured prompts
  const rulesSnippet = rules ? rules.slice(0, 500) : 'none'
  const diffSnippet  = gitDiff ? gitDiff.slice(0, 1200) : '(no changes)'
  const prompt = `Review this git diff for bugs, style issues, and rule violations.
Return JSON only: {"summary":"<one sentence>","safeToCommit":true|false,"findings":[{"severity":"blocker|warning|note","file":"<path>","title":"<short>","explanation":"<detail>"}]}

Rules: ${rulesSnippet}

Active file: ${activeFile || 'unknown'}

Diff:
${diffSnippet}`

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
    }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`ollama ${response.status}: ${await response.text()}`)
  }

  const payload = await response.json() as { response?: string }
  const raw = payload.response ?? ''
  return parseReviewProposal(raw)
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

  const rec = value as Record<string, unknown>
  const summary = typeof rec['summary'] === 'string' && rec['summary'].trim()
    ? rec['summary']
    : 'Review complete'
  const safeToCommit = typeof rec['safeToCommit'] === 'boolean' ? rec['safeToCommit'] : false

  const rawFindings = Array.isArray(rec['findings']) ? rec['findings'] : []
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

  try {
    validatePatchProposal(proposal)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }

  const patch = proposal.files.map(file => file.unifiedDiff.trimEnd()).join('\n') + '\n'
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
): CodeClawTrace {
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
    error,
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

function validatePatchProposal(proposal: PatchProposal): void {
  for (const file of proposal.files) {
    validatePatchPath(file.path)
    if (!file.unifiedDiff.includes('--- ') || !file.unifiedDiff.includes('+++ ') || !file.unifiedDiff.includes('@@')) {
      throw new Error(`invalid unified diff for ${file.path}`)
    }
  }
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
 * Small models often return only `@@` hunks. `git apply` needs `--- a/...` + `+++ b/...` (and usually `diff --git`).
 */
export function normalizeUnifiedDiffForGitApply(filePath: string, unifiedDiff: string): string {
  const t = sanitizeUnifiedDiffGlue(unifiedDiff).replace(/\r\n/g, '\n').trim()
  if (!t) return t

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

function buildProposalPrompt(context: FixContext, tasks: CodeClawTask[] = []): string {
  const compact = {
    ...context,
    activeFile: trimFile(context.activeFile),
    openBuffers: context.openBuffers.map(trimFile).slice(0, 8),
    git: {
      ...context.git,
      diff: context.git.diff.slice(0, 12000),
    },
    memory: context.memory?.slice(0, 4000),
  }

  const tasksList = tasks.length > 0
    ? `Available verify tasks (use one of these IDs for "verifyTask"):\n${tasks.map(t => `  ${t.id}: ${t.cmd}${t.description ? ` — ${t.description}` : ''}`).join('\n')}`
    : 'No tasks.json found — use a shell command string as verifyTask.'

  return [
    'You are CodeClaw Fix, an AI workflow engine inside a terminal-native developer workspace.',
    'Return ONLY strict JSON. Do not use markdown fences. Do not include prose outside the JSON.',
    'CRITICAL: Top-level object MUST use keys summary, rootCause, files, verifyTask, risk — never only {"text":"..."}, {"message":"..."}, or {"version":…}.',
    'Example (replace ellipsis with real patch content; unifiedDiff must be git-apply compatible):',
    '{"summary":"Fix off-by-one","rootCause":"Wrong operator","files":[{"path":"src/foo.ts","unifiedDiff":"diff --git a/src/foo.ts b/src/foo.ts\\n--- a/src/foo.ts\\n+++ b/src/foo.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n"}],"verifyTask":"npm test","risk":"low"}',
    'Your JSON must match this TypeScript type exactly:',
    '{ "summary": string, "rootCause": string, "files": [{ "path": string, "unifiedDiff": string }], "verifyTask": string, "risk": "low" | "medium" | "high", "notes"?: string[] }',
    '"verifyTask" must be a task ID from the list below, or a shell command if no tasks are defined.',
    '"risk" must be "low", "medium", or "high"; if omitted or invalid, it defaults to "medium".',
    'Each unifiedDiff must be git-apply compatible: prefer a full unified diff (diff --git, --- a/<path>, +++ b/<path>, then @@ hunks). At minimum include @@ hunks; headers will be filled in if omitted.',
    '"files" must contain only complete { "path", "unifiedDiff" } objects — never null, strings, or truncated entries.',
    'Use the smallest safe change that fixes the observed failure.',
    '',
    tasksList,
    '',
    'FixContext:',
    JSON.stringify(compact, null, 2),
  ].join('\n')
}

function trimFile<T extends { content: string }>(file: T): T {
  return { ...file, content: file.content.slice(0, 12000) }
}

function extractJson(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

function readString(value: object, key: string): string {
  const field = (value as Record<string, unknown>)[key]
  if (typeof field !== 'string' || field.trim() === '') {
    throw new Error(`proposal ${key} must be a non-empty string`)
  }
  return field
}

function readOptionalString(value: object, key: string): string {
  const field = (value as Record<string, unknown>)[key]
  if (field === undefined) return ''
  if (typeof field !== 'string') {
    throw new Error(`proposal ${key} must be a string`)
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
