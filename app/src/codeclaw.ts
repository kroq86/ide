import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, isAbsolute, normalize } from 'node:path'
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
  verifyCommand: string
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

export type TraceSummary = {
  trace: CodeClawTrace
  path: string
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

export function loadCodeClawProject(cwd: string): { rules: string; memory: string } {
  const dir = codeClawDir(cwd)
  const rulesPath = join(dir, 'rules.md')
  const memoryPath = join(dir, 'memory.md')
  const rules = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8').trim() : DEFAULT_RULES
  const memory = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8').trim() : ''
  return { rules, memory }
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

export async function generatePatchProposal(context: FixContext, signal: AbortSignal): Promise<PatchProposal> {
  const prompt = buildProposalPrompt(context)
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
  const summary = readString(value, 'summary')
  const rootCause = readString(value, 'rootCause')
  const verifyCommand = readOptionalString(value, 'verifyCommand')
  const risk = readString(value, 'risk')
  if (risk !== 'low' && risk !== 'medium' && risk !== 'high') {
    throw new Error('proposal risk must be low, medium, or high')
  }
  const rawFiles = (value as { files?: unknown }).files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('proposal files must be a non-empty array')
  }
  const files = rawFiles.map((file, index) => {
    if (!isObject(file)) throw new Error(`proposal file ${index} must be an object`)
    const path = readString(file, 'path')
    const unifiedDiff = readString(file, 'unifiedDiff')
    validatePatchPath(path)
    if (!unifiedDiff.includes('--- ') || !unifiedDiff.includes('+++ ') || !unifiedDiff.includes('@@')) {
      throw new Error(`proposal file ${path} must contain a unified diff`)
    }
    return { path, unifiedDiff }
  })
  const notesValue = (value as { notes?: unknown }).notes
  const notes = Array.isArray(notesValue)
    ? notesValue.filter((note): note is string => typeof note === 'string')
    : undefined

  return { summary, rootCause, files, verifyCommand, risk, notes }
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

  if (!proposal.verifyCommand.trim()) raise('high', 'missing verification command')
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
  return /(^|\/)(tsconfig|vite\.config|webpack\.config|rollup\.config|eslint\.config|package)\./.test(path)
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

function buildProposalPrompt(context: FixContext): string {
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

  return [
    'You are CodeClaw Fix, an AI workflow engine inside a terminal-native developer workspace.',
    'Return ONLY strict JSON. Do not use markdown fences. Do not include prose outside the JSON.',
    'Your JSON must match this TypeScript type exactly:',
    '{ "summary": string, "rootCause": string, "files": [{ "path": string, "unifiedDiff": string }], "verifyCommand": string, "risk": "low" | "medium" | "high", "notes"?: string[] }',
    'Each unifiedDiff must be a complete git-apply compatible unified diff for that file.',
    'Use the smallest safe change that fixes the observed failure.',
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

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function run(args: string[], cwd: string): { stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 })
  return { stdout: result.stdout ?? '' }
}
