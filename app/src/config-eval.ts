import { existsSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import {
  CONFIG_PATHS,
  reloadConfigFromImportPath,
  reloadConfigFromPath,
  type ConfigAction,
  type EditorContext,
  type QeConfig,
} from './config.js'
import {
  getPluginDir,
  importPlugin,
  registerPluginModule,
  runDefaultExportWithContext,
  runPluginEvalSideEffects,
  collectStartupFromModule,
  extractCommandsFromModule,
} from './config-plugins.js'
import { executeActionResult, type CommandRegistry } from './config-runtime.js'

export type EvalResult = {
  ok: boolean
  message: string
  /** False for side-effect-only runs (no value to echo). */
  displayed?: boolean
  commandIds?: string[]
  commands?: Record<string, ConfigAction>
}

export type EvalFileResult =
  | ({ kind: 'config' } & EvalResult & { config: QeConfig })
  | ({ kind: 'module' } & EvalResult)

export type EvalFileOptions = {
  /** When set, evaluate buffer text instead of on-disk file contents. */
  lines?: string[] | null
}

const EVAL_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])

let _evalSeq = 0

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function normalizeEvalPath(path: string): string {
  const resolved = resolve(expandTilde(path))
  if (!existsSync(resolved)) return resolved
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function isConfigFilePath(path: string): boolean {
  const norm = normalizeEvalPath(path)
  return CONFIG_PATHS.some(candidate => normalizeEvalPath(candidate) === norm)
}

export function isPluginFilePath(path: string): boolean {
  const norm = normalizeEvalPath(path)
  const pluginDir = normalizeEvalPath(getPluginDir())
  return norm === pluginDir || norm.startsWith(`${pluginDir}/`)
}

export function resolveEvalPath(filename: string | null | undefined): string | null {
  if (!filename?.trim()) return null
  const resolved = resolve(expandTilde(filename.trim()))
  if (!EVAL_EXTENSIONS.has(extname(resolved))) return null
  return resolved
}

function writeTempEvalModule(source: string, ext: string): string {
  const tmp = join(tmpdir(), `qe-eval-file-${process.pid}-${++_evalSeq}${ext || '.ts'}`)
  writeFileSync(tmp, source.endsWith('\n') ? source : `${source}\n`, 'utf8')
  return tmp
}

/** Emacs-style: eval input is treated as an expression; its value is printed. */
export function wrapEvalExpressionBody(body: string): string {
  const trimmed = body.trim()
  if (/^\s*return\b/m.test(trimmed)) return trimmed
  // Single-line input is one expression (even if it contains `;` inside an IIFE)
  if (!trimmed.includes('\n')) {
    return `return (${trimmed})`
  }
  // Simple bare expression without statement syntax
  if (!/[\n;{}]/.test(trimmed)) {
    return `return (${trimmed})`
  }
  // Multiline statements — run in async IIFE (use explicit `return` in body)
  return `return await (async () => {\n${trimmed}\n})()`
}

export function formatEvalValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    const json = JSON.stringify(value)
    return json.length > 500 ? `${json.slice(0, 497)}…` : json
  } catch {
    return String(value)
  }
}

function isEvalDirectiveResult(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0
      && value.every(item => item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string')
  }
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string')
}

function resolveImportPath(path: string, lines: string[] | null | undefined): { importPath: string; cleanup: (() => void) | null } {
  if (lines == null) return { importPath: path, cleanup: null }
  const tmp = writeTempEvalModule(lines.join('\n'), extname(path) || '.ts')
  return {
    importPath: tmp,
    cleanup: () => {
      try { unlinkSync(tmp) } catch { /* best effort */ }
    },
  }
}

export async function evalConfigFile(path: string): Promise<QeConfig> {
  return reloadConfigFromPath(path)
}

export async function evalModuleFile(
  registry: CommandRegistry,
  importPath: string,
  ctx: EditorContext,
  labelPath: string,
): Promise<EvalResult> {
  const mod = await importPlugin(importPath)
  const commands = extractCommandsFromModule(mod)
  const startup = collectStartupFromModule(mod)
  const label = labelPath === 'eval selection' || labelPath === 'eval expression'
    ? labelPath
    : isPluginFilePath(labelPath)
      ? 'eval plugin'
      : 'eval file'
  const hasPluginShape =
    Object.keys(commands).length > 0
    || mod.setup != null
    || startup != null
    || (mod.default != null && typeof mod.default !== 'function')

  if (hasPluginShape) {
    const { commandIds, commands: merged } = await registerPluginModule(mod, registry)
    const sideEffects = await runPluginEvalSideEffects(mod, registry, ctx)
    const ran = [...commandIds, ...sideEffects]
    if (ran.length > 0) {
      return { ok: true, message: `${label}: ${ran.join(', ')}`, commandIds, commands: merged }
    }
    if (mod.setup) {
      return { ok: true, message: `${label}: setup (${labelPath})`, commandIds, commands: merged }
    }
    return { ok: false, message: `${label}: nothing to run in ${labelPath}` }
  }

  if (typeof mod.default === 'function') {
    await runDefaultExportWithContext(mod, registry, ctx)
    return { ok: true, message: `${label}: ran default export (${labelPath})` }
  }
  return { ok: false, message: `${label}: nothing to run in ${labelPath}` }
}

export async function evalCurrentFile(
  registry: CommandRegistry,
  ctx: EditorContext,
  filename: string | null | undefined,
  options?: EvalFileOptions,
): Promise<EvalFileResult> {
  const path = resolveEvalPath(filename)
  if (!path) {
    return { kind: 'module', ok: false, message: 'eval file: no evaluable buffer path' }
  }

  const fromBuffer = options?.lines != null
  if (!fromBuffer && !existsSync(path)) {
    return { kind: 'module', ok: false, message: `eval file: not found (${path})` }
  }

  const { importPath, cleanup } = resolveImportPath(path, fromBuffer ? options!.lines! : null)
  try {
    if (isConfigFilePath(path)) {
      const config = fromBuffer
        ? await reloadConfigFromImportPath(importPath, path)
        : await evalConfigFile(path)
      return {
        kind: 'config',
        ok: true,
        message: `eval config: ${path}`,
        config,
      }
    }
    if (isPluginFilePath(path)) {
      const result = await evalModuleFile(registry, importPath, ctx, path)
      return { kind: 'module', ...result }
    }
    const result = await evalModuleFile(registry, importPath, ctx, path)
    return { kind: 'module', ...result }
  } catch (error) {
    return { kind: 'module', ok: false, message: `eval file failed: ${String(error)}` }
  } finally {
    cleanup?.()
  }
}

export function isModuleShapedEvalBody(body: string): boolean {
  return /^\s*(import\s|export\s)/m.test(body.trim())
}

export async function evalTypeScriptBody(
  registry: CommandRegistry,
  ctx: EditorContext,
  body: string,
  label: string,
): Promise<EvalResult> {
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, message: `${label}: empty body` }

  const tmp = join(tmpdir(), `qe-eval-${process.pid}-${++_evalSeq}.ts`)
  const wrapped = wrapEvalExpressionBody(trimmed)
  const source = [
    'export default async function(ctx: any) {',
    wrapped,
    '}',
    '',
  ].join('\n')
  writeFileSync(tmp, source, 'utf8')
  try {
    const mod = await importPlugin(tmp) as import('./config-plugins.js').QePluginModule
    if (typeof mod.default !== 'function') {
      return { ok: false, message: `${label}: eval produced no function` }
    }
    const fn = mod.default as (ctx: EditorContext) => unknown
    const result = await fn(ctx)
    if (isEvalDirectiveResult(result)) {
      await executeActionResult(result as import('./config.js').ConfigActionResult, ctx, registry)
      return { ok: true, message: `${label} ok`, displayed: false }
    }
    if (result !== undefined) {
      const printed = formatEvalValue(result)
      ctx.ui.notify(printed)
      return { ok: true, message: printed, displayed: true }
    }
    return { ok: true, message: `${label} ok`, displayed: false }
  } catch (error) {
    return { ok: false, message: `${label} failed: ${String(error)}` }
  } finally {
    try { unlinkSync(tmp) } catch { /* best effort */ }
  }
}

async function evalModuleBody(
  registry: CommandRegistry,
  ctx: EditorContext,
  body: string,
  label: string,
): Promise<EvalResult> {
  const tmp = join(tmpdir(), `qe-eval-module-${process.pid}-${++_evalSeq}.ts`)
  writeFileSync(tmp, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  try {
    return await evalModuleFile(registry, tmp, ctx, label)
  } finally {
    try { unlinkSync(tmp) } catch { /* best effort */ }
  }
}

async function evalBody(
  registry: CommandRegistry,
  ctx: EditorContext,
  body: string,
  label: string,
): Promise<EvalResult> {
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, message: `${label}: empty body` }
  if (isModuleShapedEvalBody(trimmed)) {
    return evalModuleBody(registry, ctx, trimmed, label)
  }
  return evalTypeScriptBody(registry, ctx, body, label)
}

export async function evalExpression(
  registry: CommandRegistry,
  ctx: EditorContext,
  body: string,
): Promise<EvalResult> {
  return evalBody(registry, ctx, body, 'eval expression')
}

export async function evalRegion(
  registry: CommandRegistry,
  ctx: EditorContext,
  body: string,
): Promise<EvalResult> {
  return evalBody(registry, ctx, body, 'eval selection')
}
