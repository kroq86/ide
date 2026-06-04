import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve as resolvePath } from 'node:path'

export type WorkspaceConfig = {
  roots?: string[]
  ignore?: string[]
  allow?: string[]
}

export type WorkspaceIndexEntry = {
  path: string
  size: number
  mtimeMs: number
  ext: string
  preview: string
}

export type WorkspaceIndex = {
  version: 1
  roots: string[]
  entries: WorkspaceIndexEntry[]
  updatedAt: string
}

export const DEFAULT_WORKSPACE_IGNORE = [
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'target/**',
  '.qe/**',
  '.codeclaw/traces/**',
]

const MAX_FILE_BYTES = 64 * 1024
const MAX_PREVIEW_BYTES = 512

export function workspaceIndexPath(cwd: string): string {
  return join(cwd, '.qe', 'workspace-index.json')
}

export function loadWorkspaceIndex(cwd: string): WorkspaceIndex | null {
  try {
    const parsed = JSON.parse(readFileSync(workspaceIndexPath(cwd), 'utf8')) as WorkspaceIndex
    return parsed && parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : null
  } catch {
    return null
  }
}

export function saveWorkspaceIndex(cwd: string, index: WorkspaceIndex): void {
  const path = workspaceIndexPath(cwd)
  mkdirSync(join(cwd, '.qe'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

export function buildWorkspaceIndex(cwd: string, config: WorkspaceConfig | undefined = {}, previous?: WorkspaceIndex | null): WorkspaceIndex {
  const roots = normalizeRoots(cwd, config.roots)
  const ignore = [...DEFAULT_WORKSPACE_IGNORE, ...(config.ignore ?? [])]
  const allow = config.allow ?? []
  const previousByPath = new Map((previous?.entries ?? []).map(entry => [resolvePath(cwd, entry.path), entry]))
  const entriesByPath = new Map<string, WorkspaceIndexEntry>()

  for (const root of roots) {
    scanRoot(cwd, root, ignore, allow, previousByPath, entriesByPath)
  }

  const entries = sortedEntries(entriesByPath)
  return {
    version: 1,
    roots: roots.map(root => relative(cwd, root) || '.'),
    entries,
    updatedAt: new Date().toISOString(),
  }
}

export async function buildWorkspaceIndexAsync(
  cwd: string,
  config: WorkspaceConfig | undefined = {},
  previous?: WorkspaceIndex | null,
): Promise<WorkspaceIndex> {
  const roots = normalizeRoots(cwd, config.roots)
  const ignore = [...DEFAULT_WORKSPACE_IGNORE, ...(config.ignore ?? [])]
  const allow = config.allow ?? []
  const previousByPath = new Map((previous?.entries ?? []).map(entry => [resolvePath(cwd, entry.path), entry]))
  const entriesByPath = new Map<string, WorkspaceIndexEntry>()
  const budget = { visited: 0 }

  for (const root of roots) {
    await scanRootAsync(cwd, root, ignore, allow, previousByPath, entriesByPath, budget)
  }

  return {
    version: 1,
    roots: roots.map(root => relative(cwd, root) || '.'),
    entries: sortedEntries(entriesByPath),
    updatedAt: new Date().toISOString(),
  }
}

export function workspaceIndexCandidates(index: WorkspaceIndex | null): string[] {
  return index?.entries.map(entry => entry.path) ?? []
}

function normalizeRoots(cwd: string, roots: string[] | undefined): string[] {
  const raw = roots && roots.length > 0 ? roots : ['.']
  const resolved = [...new Set(raw
    .filter(root => typeof root === 'string' && root.trim().length > 0)
    .map(root => resolvePath(cwd, root)))]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  const normalized: string[] = []
  for (const root of resolved) {
    if (normalized.some(parent => root === parent || root.startsWith(`${parent}/`))) continue
    normalized.push(root)
  }
  return normalized
}

function scanRoot(
  cwd: string,
  dir: string,
  ignore: string[],
  allow: string[],
  previousByPath: Map<string, WorkspaceIndexEntry>,
  entriesByPath: Map<string, WorkspaceIndexEntry>,
): void {
  let children: import('node:fs').Dirent[]
  try {
    children = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }

  for (const child of children) {
    const full = join(dir, child.name)
    const rel = normalizeRel(relative(cwd, full))
    if (!rel) continue
    if (child.isDirectory()) {
      if (shouldIgnore(rel, ignore, allow) && !allowTargetsDescendant(rel, allow)) continue
      scanRoot(cwd, full, ignore, allow, previousByPath, entriesByPath)
    } else if (child.isFile()) {
      if (shouldIgnore(rel, ignore, allow)) continue
      const entry = indexFile(cwd, full, previousByPath.get(full))
      if (entry) entriesByPath.set(full, entry)
    }
  }
}

async function scanRootAsync(
  cwd: string,
  dir: string,
  ignore: string[],
  allow: string[],
  previousByPath: Map<string, WorkspaceIndexEntry>,
  entriesByPath: Map<string, WorkspaceIndexEntry>,
  budget: { visited: number },
): Promise<void> {
  if (++budget.visited % 50 === 0) await yieldToEventLoop()
  let children: import('node:fs').Dirent[]
  try {
    children = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }

  for (const child of children) {
    const full = join(dir, child.name)
    const rel = normalizeRel(relative(cwd, full))
    if (!rel) continue
    if (child.isDirectory()) {
      if (shouldIgnore(rel, ignore, allow) && !allowTargetsDescendant(rel, allow)) continue
      await scanRootAsync(cwd, full, ignore, allow, previousByPath, entriesByPath, budget)
    } else if (child.isFile()) {
      if (shouldIgnore(rel, ignore, allow)) continue
      const entry = await indexFileAsync(cwd, full, previousByPath.get(full))
      if (entry) entriesByPath.set(full, entry)
    }
  }
}

function indexFile(cwd: string, full: string, previous?: WorkspaceIndexEntry): WorkspaceIndexEntry | null {
  let st: import('node:fs').Stats
  try {
    st = statSync(full)
  } catch {
    return null
  }
  const rel = normalizeRel(relative(cwd, full))
  if (previous && previous.size === st.size && previous.mtimeMs === st.mtimeMs) return previous
  return {
    path: rel,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ext: extname(full).replace(/^\./, ''),
    preview: st.size <= MAX_FILE_BYTES ? readPreview(full) : '',
  }
}

async function indexFileAsync(cwd: string, full: string, previous?: WorkspaceIndexEntry): Promise<WorkspaceIndexEntry | null> {
  let st: import('node:fs').Stats
  try {
    st = await stat(full)
  } catch {
    return null
  }
  const rel = normalizeRel(relative(cwd, full))
  if (previous && previous.size === st.size && previous.mtimeMs === st.mtimeMs) return previous
  return {
    path: rel,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ext: extname(full).replace(/^\./, ''),
    preview: st.size <= MAX_FILE_BYTES ? await readPreviewAsync(full) : '',
  }
}

function readPreview(path: string): string {
  try {
    return readFileSync(path, 'utf8')
      .replace(/\0/g, '')
      .split('\n')
      .slice(0, 8)
      .join('\n')
      .slice(0, MAX_PREVIEW_BYTES)
  } catch {
    return ''
  }
}

async function readPreviewAsync(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8'))
      .replace(/\0/g, '')
      .split('\n')
      .slice(0, 8)
      .join('\n')
      .slice(0, MAX_PREVIEW_BYTES)
  } catch {
    return ''
  }
}

function sortedEntries(entriesByPath: Map<string, WorkspaceIndexEntry>): WorkspaceIndexEntry[] {
  return [...entriesByPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function shouldIgnore(rel: string, ignore: string[], allow: string[]): boolean {
  if (allow.some(pattern => globMatch(rel, pattern))) return false
  return ignore.some(pattern => globMatch(rel, pattern))
}

function allowTargetsDescendant(rel: string, allow: string[]): boolean {
  return allow.some(pattern => normalizeRel(pattern).startsWith(`${rel}/`))
}

function globMatch(rel: string, pattern: string): boolean {
  const normalized = normalizeRel(pattern)
  if (!normalized) return false
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3)
    return rel === prefix || rel.startsWith(`${prefix}/`)
  }
  if (normalized.includes('*')) {
    const escaped = normalized.split('*').map(escapeRegExp).join('[^/]*')
    return new RegExp(`^${escaped}$`).test(rel) || new RegExp(`(^|/)${escaped}$`).test(rel)
  }
  return rel === normalized || basename(rel) === normalized
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
