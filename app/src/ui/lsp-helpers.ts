import type { LspResponse } from '../protocol.js'
import type { LspTarget } from './types.js'

export function lspHoverText(response: LspResponse): string {
  const result = response.result as { text?: unknown; message?: unknown } | undefined
  const text = typeof result?.text === 'string' && result.text.trim()
    ? result.text.trim()
    : typeof result?.message === 'string'
      ? result.message
      : response.status
  return text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join('  ')
}

export function lspHoverLines(response: LspResponse): string[] {
  const text = lspHoverText(response)
  return text
    .replace(/```[a-zA-Z0-9_-]*/g, '')
    .replace(/```/g, '')
    .split('\n')
    .flatMap(line => line.split('  '))
    .map(line => line.trim())
    .filter(Boolean)
}

export function lspDefinitionTarget(response: LspResponse): LspTarget | null {
  const result = response.result as { target?: LspTarget; message?: unknown } | undefined
  if (result?.target?.path) return result.target
  return null
}

export function lspUnavailableText(response: LspResponse, label: string): string {
  const result = response.result as { available?: boolean; message?: unknown } | undefined
  const message = typeof result?.message === 'string' && result.message.trim()
    ? result.message.trim()
    : response.status
  return `${label}: ${message}`
}
