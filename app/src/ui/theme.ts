import { basename } from 'node:path'

export type ThemeColor = `#${string}`

export type Theme = {
  bg: ThemeColor
  fg: ThemeColor
  grey: ThemeColor
  red: ThemeColor
  orange: ThemeColor
  green: ThemeColor
  yellow: ThemeColor
  blue: ThemeColor
  magenta: ThemeColor
  cyan: ThemeColor
  violet: ThemeColor
}

export let C: Theme = {
  bg:      '#282c34',
  fg:      '#bbc2cf',
  grey:    '#5b6268',
  red:     '#ff6c6b',
  orange:  '#da8548',
  green:   '#98be65',
  yellow:  '#ecbe7b',
  blue:    '#51afef',
  magenta: '#c678dd',
  cyan:    '#46d9ff',
  violet:  '#a9a1e1',
}

export function applyTheme(partial: Partial<Theme>): void {
  C = { ...C, ...partial }
}

/** Keep header readable on narrow terminals (avoid path/status/search overlapping). */
export function truncateChars(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  if (max <= 1) return '…'
  return `${s.slice(0, max - 1)}…`
}

export function editorHeaderPath(title: string, maxChars: number): string {
  if (title.length <= maxChars) return title
  const base = basename(title)
  const tail = `…/${base}`
  if (tail.length <= maxChars) return tail
  return truncateChars(base, maxChars)
}

export function editorHeaderMeta(status: string, searchQuery: string, matchCount: number, maxChars: number): string {
  const tail = searchQuery ? `  /${searchQuery} (${matchCount})` : ''
  return truncateChars(`${status}${tail}`, maxChars)
}
