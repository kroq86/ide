import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyPluginsToConfig, PLUGIN_DIR } from './config-plugins.js'
import type { ShellRun } from './shell.js'
import type { QeProjectProfile, QeTask } from './workflow.js'

// ── Public types — what users write in their config file ─────────────────────

export type EditorContext = {
  readonly filename: string | null
  readonly lines: string[]
  readonly cursor: { row: number; col: number }
  /** Set during `onShellDone` to the finished tracked run; otherwise `null`. */
  readonly lastShellRun: ShellRun | null
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
  openFile: (path: string, jump?: { row: number; col: number }) => void
  commands: {
    run: (id: string, args?: Record<string, unknown>) => Promise<void>
  }
  ui: {
    pick: (title: string, items: ConfigPickItem[]) => Promise<string | null>
    input: (title: string, initial?: string) => Promise<string | null>
    confirm: (title: string, body?: string) => Promise<boolean>
    notify: (message: string, level?: ConfigNotifyLevel) => void
    panel: (name: ConfigPanelName, options?: Record<string, unknown>) => void
    splash: (options: { title: string; message?: string; hint?: string }) => void
  }
  git: {
    status: () => void
    stageCurrentFile: () => void
    stageHunk: () => void
    previewHunk: () => void
  }
  lsp: {
    hover: () => void
    definition: () => void
    format: () => void
  }
  diagnostics: {
    list: () => void
    next: () => void
    line: () => void
  }
}

export type BufferInfo = {
  id: string
  name: string
  filename: string | null
  dirty: boolean
  active: boolean
}

export type QeExtra =
  | 'typescript'
  | 'rust'
  | 'git'
  | 'ai'
  | 'formatting'
  | 'debug'

export type QePreset = {
  name: string
  extras: readonly QeExtra[]
  description: string
}

export const QE_PRESETS = {
  web: {
    name: 'web',
    extras: ['typescript', 'git', 'ai', 'formatting', 'debug'],
    description: 'TypeScript/React defaults with Git, AI, formatting, and debug entry points.',
  },
  rust: {
    name: 'rust',
    extras: ['rust', 'git', 'ai', 'formatting', 'debug'],
    description: 'Rust defaults with Cargo-aware project roots, Git, AI, and formatting commands.',
  },
  minimal: {
    name: 'minimal',
    extras: ['git'],
    description: 'Small terminal-editor setup with Git workflows enabled.',
  },
} as const satisfies Record<string, QePreset>

export type ConfigNotifyLevel = 'info' | 'warn' | 'error'
export type ConfigPanelName = 'shell' | 'ai' | 'git' | 'diagnostics' | 'commandPalette'
export type ConfigPickItem = string | { label: string; value?: string; description?: string }

export type ConfigDirective =
  | { type: 'shell.run'; command: string }
  | { type: 'panel.open'; panel: ConfigPanelName; options?: Record<string, unknown> }
  | { type: 'openFile'; path: string; row?: number; col?: number }
  | { type: 'editor.insert'; text: string }
  | { type: 'editor.move'; direction: string }
  | { type: 'command.run'; command: string; args?: Record<string, unknown> }
  | { type: 'ui.notify'; message: string; level?: ConfigNotifyLevel }
  | { type: 'ui.splash'; title: string; message?: string; hint?: string }

export type ConfigCommand = {
  command: string
  args?: Record<string, unknown>
  label?: string
}

export type ConfigActionResult =
  | void
  | ConfigDirective
  | ConfigDirective[]
  | Promise<void | ConfigDirective | ConfigDirective[]>

export type ConfigAction =
  | string
  | ConfigCommand
  | ConfigDirective
  | ConfigDirective[]
  | ((ctx: EditorContext) => ConfigActionResult)

export interface LeaderNode {
  [key: string]: ConfigAction | LeaderTree
}

export type LeaderTree = LeaderNode

export type QeConfig = {
  preset?: keyof typeof QE_PRESETS
  extras?: QeExtra[]
  theme?: Partial<{
    bg: string; fg: string; grey: string
    red: string; orange: string; green: string
    yellow: string; blue: string; magenta: string
    cyan: string; violet: string
  }>
  leader?: LeaderTree
  hooks?: {
    onSave?:      ConfigAction
    onOpen?:      ConfigAction
    onChange?:    ConfigAction
    onBufEnter?:  ConfigAction
    onShellDone?: ConfigAction
  }
  commands?: Record<string, ConfigAction>
  tasks?: QeTask[]
  projects?: QeProjectProfile[]
}

export function defineConfig<const T extends QeConfig>(config: T): T {
  return config
}

export function resolveExtras(config: QeConfig): QeExtra[] {
  const preset = config.preset ? QE_PRESETS[config.preset] : QE_PRESETS.web
  const extras = [...preset.extras, ...(config.extras ?? [])]
  return [...new Set(extras)]
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const CONFIG_PATHS = [
  join(homedir(), '.config', 'qe', 'config.ts'),
  join(homedir(), '.config', 'qe', 'config.mts'),
  join(homedir(), '.config', 'qe', 'config.js'),
  join(homedir(), '.config', 'qe', 'config.mjs'),
  join(homedir(), '.qe', 'config.js'),
]

let _config: QeConfig = {}
let _configPath: string | null = null
let _configImportSeq = 0

export function getConfigPath(): string | null { return _configPath }

async function importConfig(path: string): Promise<{ default?: QeConfig }> {
  const [file = path, query] = path.split('?')
  const ext = extname(file)
  const cacheKey = query ?? `t=${Date.now()}-${++_configImportSeq}`
  const specifier = `${pathToFileURL(file).href}?${cacheKey}`
  if (ext === '.ts' || ext === '.mts') {
    try {
      return await import(specifier) as { default?: QeConfig }
    } catch (error) {
      const message = String((error as Error | undefined)?.message ?? error)
      const code = String((error as { code?: unknown } | undefined)?.code ?? '')
      if (!message.includes('Unknown file extension') && code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw error
      // In the bundled app Node cannot import .ts directly; use tsx's API.
    }
    const { tsImport } = await import('tsx/esm/api')
    return await tsImport(specifier, import.meta.url) as { default?: QeConfig }
  }
  return await import(specifier) as { default?: QeConfig }
}

function configFromModule(mod: { default?: QeConfig | { default?: QeConfig } }): QeConfig {
  const value = mod.default
  if (value && typeof value === 'object' && 'default' in value) {
    return (value as { default?: QeConfig }).default ?? {}
  }
  return (value as QeConfig | undefined) ?? {}
}

export async function loadConfig(): Promise<QeConfig> {
  return loadConfigFromPaths(CONFIG_PATHS)
}

export async function loadConfigFromPaths(paths: readonly string[]): Promise<QeConfig> {
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const mod = await importConfig(p)
      _config = await applyPluginsToConfig(configFromModule(mod))
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
  return reloadConfigFromPath(p)
}

export async function reloadConfigFromPath(path: string): Promise<QeConfig> {
  if (!existsSync(path)) {
    throw new Error(`config not found: ${path}`)
  }
  return reloadConfigFromImportPath(path, path)
}

/** Import config module from `importPath` (may be a temp file) and set active path to `logicalPath`. */
export async function reloadConfigFromImportPath(importPath: string, logicalPath: string): Promise<QeConfig> {
  try {
    const mod = await importConfig(`${importPath}?t=${Date.now()}`)
    _config = await applyPluginsToConfig(configFromModule(mod))
    _configPath = logicalPath
    return _config
  } catch (e) {
    process.stderr.write(`qe: config reload error in ${logicalPath}: ${String(e)}\n`)
    throw e
  }
}

export { PLUGIN_DIR, loadPluginCommands, loadPluginStartupActions, registerPlugins } from './config-plugins.js'

export function getConfig(): QeConfig {
  return _config
}

export function isConfigAction(value: unknown): value is ConfigAction {
  if (typeof value === 'function' || typeof value === 'string' || Array.isArray(value)) return true
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.command === 'string' || typeof record.type === 'string'
}

// Merge user leader tree on top of the built-in one — user wins on conflicts
export function mergeLeaderTree(
  builtin: Record<string, (() => void) | Record<string, unknown>>,
  user: LeaderTree,
  makeCtx: () => EditorContext,
  runAction?: (action: ConfigAction, ctx: EditorContext) => void,
): Record<string, (() => void) | Record<string, unknown>> {
  const result = { ...builtin }
  for (const [key, value] of Object.entries(user)) {
    if (isConfigAction(value)) {
      result[key] = () => {
        const ctx = makeCtx()
        if (runAction) runAction(value, ctx)
        else if (typeof value === 'function') void value(ctx)
      }
    } else {
      const existing = result[key]
      if (existing && typeof existing === 'object') {
        result[key] = mergeLeaderTree(
          existing as Record<string, (() => void) | Record<string, unknown>>,
          value,
          makeCtx,
          runAction,
        )
      } else {
        result[key] = mergeLeaderTree({}, value, makeCtx, runAction)
      }
    }
  }
  return result
}
