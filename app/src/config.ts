import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Public types — what users write in their config file ─────────────────────

export type EditorContext = {
  readonly filename: string | null
  readonly lines: string[]
  readonly cursor: { row: number; col: number }
  save: () => void
  quit: () => void
  insert: (text: string) => void
  move: (dir: string) => void
  shell: {
    run: (cmd: string) => void
    lines: () => string[]
  }
  buffers: {
    list: () => BufferInfo[]
    current: () => BufferInfo | null
    switch: (id: string) => void
    kill: (id?: string) => void
    next: () => void
    previous: () => void
  }
  openFile: (path: string) => void
}

export type BufferInfo = {
  id: string
  name: string
  filename: string | null
  dirty: boolean
  active: boolean
}

export interface LeaderNode {
  [key: string]: ((ctx: EditorContext) => void) | LeaderTree
}

export type LeaderTree = LeaderNode

export type QeConfig = {
  theme?: Partial<{
    bg: string; fg: string; grey: string
    red: string; orange: string; green: string
    yellow: string; blue: string; magenta: string
    cyan: string; violet: string
  }>
  leader?: LeaderTree
  hooks?: {
    onSave?:   (ctx: EditorContext) => void | Promise<void>
    onOpen?:   (ctx: EditorContext) => void | Promise<void>
    onChange?: (ctx: EditorContext) => void | Promise<void>
  }
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const CONFIG_PATHS = [
  join(homedir(), '.config', 'qe', 'config.js'),
  join(homedir(), '.config', 'qe', 'config.mjs'),
  join(homedir(), '.qe', 'config.js'),
]

let _config: QeConfig = {}
let _configPath: string | null = null

export function getConfigPath(): string | null { return _configPath }

export async function loadConfig(): Promise<QeConfig> {
  for (const p of CONFIG_PATHS) {
    if (!existsSync(p)) continue
    try {
      const mod = await import(p) as { default?: QeConfig }
      _config = mod.default ?? {}
      _configPath = p
      return _config
    } catch (e) {
      process.stderr.write(`qe: config error in ${p}: ${String(e)}\n`)
    }
  }
  return _config
}

// Re-import with a timestamp query string to bust Node's ESM module cache
export async function reloadConfig(): Promise<QeConfig> {
  const p = _configPath
  if (!p || !existsSync(p)) return _config
  try {
    const mod = await import(`${p}?t=${Date.now()}`) as { default?: QeConfig }
    _config = mod.default ?? {}
    return _config
  } catch (e) {
    process.stderr.write(`qe: config reload error in ${p}: ${String(e)}\n`)
    return _config
  }
}

export function getConfig(): QeConfig {
  return _config
}

// Merge user leader tree on top of the built-in one — user wins on conflicts
export function mergeLeaderTree(
  builtin: Record<string, (() => void) | Record<string, unknown>>,
  user: LeaderTree,
  makeCtx: () => EditorContext,
): Record<string, (() => void) | Record<string, unknown>> {
  const result = { ...builtin }
  for (const [key, value] of Object.entries(user)) {
    if (typeof value === 'function') {
      result[key] = () => value(makeCtx())
    } else {
      const existing = result[key]
      if (existing && typeof existing === 'object') {
        result[key] = mergeLeaderTree(
          existing as Record<string, (() => void) | Record<string, unknown>>,
          value,
          makeCtx,
        )
      } else {
        result[key] = mergeLeaderTree({}, value, makeCtx)
      }
    }
  }
  return result
}
