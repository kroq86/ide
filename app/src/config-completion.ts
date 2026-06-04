import { CONFIG_API_DIRECTIVE_TYPES } from './config-api-template.js'
import type { NormalizedPickItem } from './ui/types.js'

const DIRECTIVE_HINTS: Record<string, string> = {
  'shell.run': 'run shell command',
  'panel.open': 'open shell / ai / git panel',
  'openFile': 'open file in editor',
  'editor.insert': 'insert text at cursor',
  'editor.move': 'move cursor',
  'command.run': 'run registered command',
  'ui.notify': 'status notification',
  'ui.splash': 'startup splash screen',
}

export type ConfigDirectiveContext = {
  quote: string
  partial: string
  candidates: readonly string[]
  replaceStartCol: number
}

/**
 * Parses `type: '…'` / `type: "…"` at cursor for directive literal completion.
 */
export function parseConfigDirectiveContext(
  line: string,
  col: number,
  catalog: readonly string[] = CONFIG_API_DIRECTIVE_TYPES,
): ConfigDirectiveContext | null {
  const before = line.slice(0, Math.max(0, col))
  const m = before.match(/type:\s*(['"])([^'"]*)$/)
  if (!m) return null

  const quote = m[1]!
  const partial = m[2]!

  return {
    quote,
    partial,
    candidates: catalog,
    replaceStartCol: col - partial.length,
  }
}

export function directivePickItems(candidates: readonly string[]): NormalizedPickItem[] {
  return candidates.map(type => ({
    label: type,
    value: type,
    description: DIRECTIVE_HINTS[type],
  }))
}

export function insertTextForDirective(value: string, quote: string): string {
  return `${value}${quote}`
}

export function isConfigOrPluginSourceFile(path: string | null | undefined): boolean {
  if (!path?.trim()) return false
  const norm = path.replace(/\\/g, '/')
  if (norm.includes('/.config/qe/')) return true
  if (norm.includes('/plugins/') && /\.(ts|mts|js|mjs)$/.test(norm)) return true
  return /(?:^|\/)(config|config-api)\.(ts|mts|js|mjs)$/.test(norm)
}

/** @deprecated Use parseConfigDirectiveContext — kept for tests migrating from ghost API */
export type ConfigDirectiveCompletion = ConfigDirectiveContext & { ghost: string }

export function matchConfigDirectiveCompletion(
  line: string,
  col: number,
  catalog: readonly string[] = CONFIG_API_DIRECTIVE_TYPES,
): ConfigDirectiveCompletion | null {
  const ctx = parseConfigDirectiveContext(line, col, catalog)
  if (!ctx) return null
  const first = ctx.candidates[0]!
  const suffix = first.slice(ctx.partial.length)
  if (!suffix) return null
  return { ...ctx, ghost: insertTextForDirective(suffix, ctx.quote) }
}
