import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isConfigAction, type ConfigAction, type QeConfig } from './config.js'
import { registerCommandActions, type CommandRegistry } from './config-runtime.js'

export function getPluginDir(): string {
  return process.env['QE_PLUGIN_DIR'] ?? join(homedir(), '.config', 'qe', 'plugins')
}

/** Default plugin directory (`~/.config/qe/plugins`). */
export const PLUGIN_DIR = getPluginDir()

const PLUGIN_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])

let _pluginImportSeq = 0

export type QePluginModule = {
  default?: QePluginExport | QePluginExport[] | ((...args: unknown[]) => unknown)
  setup?: (registry: CommandRegistry) => void | Promise<void>
  commands?: Record<string, ConfigAction>
  onStartup?: ConfigAction
}

export type QePluginExport =
  | ((registry: CommandRegistry) => void | Promise<void>)
  | { setup?: (registry: CommandRegistry) => void | Promise<void>; commands?: Record<string, ConfigAction>; onStartup?: ConfigAction }

export async function importPlugin(path: string): Promise<QePluginModule> {
  const cacheKey = `p=${Date.now()}-${++_pluginImportSeq}`
  const specifier = `${pathToFileURL(path).href}?${cacheKey}`
  const ext = extname(path)
  if (ext === '.ts' || ext === '.mts') {
    try {
      return await import(specifier) as QePluginModule
    } catch (error) {
      const message = String((error as Error | undefined)?.message ?? error)
      const code = String((error as { code?: unknown } | undefined)?.code ?? '')
      if (!message.includes('Unknown file extension') && code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw error
    }
    const { tsImport } = await import('tsx/esm/api')
    return await tsImport(specifier, import.meta.url) as QePluginModule
  }
  return await import(specifier) as QePluginModule
}

function listPluginFiles(): string[] {
  const dir = getPluginDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && PLUGIN_EXTENSIONS.has(extname(entry.name)))
    .map(entry => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

function collectCommands(commands: Record<string, ConfigAction> | undefined, merged: Record<string, ConfigAction>): void {
  if (!commands) return
  for (const [id, action] of Object.entries(commands)) {
    if (!isConfigAction(action)) continue
    merged[id] = action
  }
}

async function runSetup(setup: ((registry: CommandRegistry) => void | Promise<void>) | undefined, registry: CommandRegistry): Promise<void> {
  if (!setup) return
  await setup(registry)
}

function collectFromModule(mod: QePluginModule, merged: Record<string, ConfigAction>): void {
  if (typeof mod.default === 'function') {
    return
  }
  if (mod.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) {
    collectCommands(mod.default.commands, merged)
    return
  }
  if (Array.isArray(mod.default)) {
    for (const entry of mod.default) {
      if (entry && typeof entry === 'object' && typeof entry !== 'function') {
        collectCommands(entry.commands, merged)
      }
    }
  }
  collectCommands(mod.commands, merged)
}

export function extractCommandsFromModule(mod: QePluginModule): Record<string, ConfigAction> {
  const merged: Record<string, ConfigAction> = {}
  collectFromModule(mod, merged)
  return merged
}

async function runSetupFromModule(mod: QePluginModule, registry: CommandRegistry): Promise<void> {
  if (typeof mod.default === 'function') {
    await runSetup(mod.default as (registry: CommandRegistry) => void | Promise<void>, registry)
    return
  }
  if (mod.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) {
    await runSetup(mod.default.setup, registry)
  } else if (Array.isArray(mod.default)) {
    for (const entry of mod.default) {
      if (typeof entry === 'function') await runSetup(entry, registry)
      else if (entry && typeof entry === 'object') await runSetup(entry.setup, registry)
    }
  }
  await runSetup(mod.setup, registry)
}

export type PluginRegisterResult = {
  commandIds: string[]
  commands: Record<string, ConfigAction>
}

export async function registerPluginModule(mod: QePluginModule, registry: CommandRegistry): Promise<PluginRegisterResult> {
  const merged: Record<string, ConfigAction> = {}
  collectFromModule(mod, merged)
  const commandIds = registerCommandActions(merged, registry, 'plugin')
  await registry.withSource('plugin', () => runSetupFromModule(mod, registry))
  return { commandIds, commands: merged }
}

export async function registerPluginFile(registry: CommandRegistry, path: string): Promise<PluginRegisterResult> {
  const mod = await importPlugin(path)
  return registerPluginModule(mod, registry)
}

export async function loadPluginCommands(): Promise<Record<string, ConfigAction>> {
  const merged: Record<string, ConfigAction> = {}
  for (const path of listPluginFiles()) {
    try {
      const mod = await importPlugin(path)
      collectFromModule(mod, merged)
    } catch (error) {
      process.stderr.write(`qe: plugin error in ${path}: ${String(error)}\n`)
    }
  }
  return merged
}

/** Startup action from a plugin module, if any. */
export function collectStartupFromModule(mod: QePluginModule): ConfigAction | undefined {
  if (mod.onStartup && isConfigAction(mod.onStartup)) return mod.onStartup
  if (mod.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) {
    const startup = mod.default.onStartup
    if (startup && isConfigAction(startup)) return startup
  }
  return undefined
}

const EVAL_EXPORT_SKIP = new Set(['default', 'setup', 'commands'])

/** Named exports that are config actions (onStartup, onShutdown, etc.). */
export function collectEvalExportsFromModule(mod: QePluginModule): Array<{ name: string; action: ConfigAction }> {
  const out: Array<{ name: string; action: ConfigAction }> = []
  for (const [name, value] of Object.entries(mod as Record<string, unknown>)) {
    if (EVAL_EXPORT_SKIP.has(name)) continue
    if (isConfigAction(value)) out.push({ name, action: value as ConfigAction })
  }
  return out
}

export function moduleHasEvaluableShape(mod: QePluginModule): boolean {
  if (Object.keys(extractCommandsFromModule(mod)).length > 0) return true
  if (mod.setup != null) return true
  if (collectEvalExportsFromModule(mod).length > 0) return true
  if (mod.default != null && typeof mod.default !== 'function') return true
  return false
}

/** Run plugin exports meant to execute immediately (e.g. eval selection of `onStartup`). */
export async function runPluginEvalSideEffects(
  mod: QePluginModule,
  registry: CommandRegistry,
  ctx: import('./config.js').EditorContext,
): Promise<string[]> {
  const { runConfigAction } = await import('./config-runtime.js')
  const ran: string[] = []
  for (const { name, action } of collectEvalExportsFromModule(mod)) {
    await runConfigAction(action, ctx, registry)
    ran.push(name)
  }
  return ran
}

/** Startup actions from plugin `onStartup` exports (alphabetical file order). */
export async function loadPluginStartupActions(): Promise<ConfigAction[]> {
  const actions: ConfigAction[] = []
  for (const path of listPluginFiles()) {
    try {
      const mod = await importPlugin(path)
      const action = collectStartupFromModule(mod)
      if (action) actions.push(action)
    } catch (error) {
      process.stderr.write(`qe: plugin error in ${path}: ${String(error)}\n`)
    }
  }
  return actions
}

export async function registerPlugins(registry: CommandRegistry): Promise<void> {
  for (const path of listPluginFiles()) {
    try {
      await registerPluginFile(registry, path)
    } catch (error) {
      process.stderr.write(`qe: plugin error in ${path}: ${String(error)}\n`)
    }
  }
}

export async function applyPluginsToConfig(config: QeConfig): Promise<QeConfig> {
  const pluginCommands = await loadPluginCommands()
  if (Object.keys(pluginCommands).length === 0) return config
  return {
    ...config,
    commands: { ...pluginCommands, ...(config.commands ?? {}) },
  }
}

export async function runDefaultExportWithContext(
  mod: QePluginModule,
  registry: CommandRegistry,
  ctx: import('./config.js').EditorContext,
): Promise<void> {
  if (typeof mod.default !== 'function') return
  const fn = mod.default as (ctx: import('./config.js').EditorContext) => unknown
  const result = await fn(ctx)
  const { executeActionResult } = await import('./config-runtime.js')
  await executeActionResult(result as import('./config.js').ConfigActionResult, ctx, registry)
}
