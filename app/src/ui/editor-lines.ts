import type { SyntaxToken } from '../protocol.js'
import { C, type ThemeColor } from './theme.js'
import { thinkingSpinnerGlyph } from './spinner.js'
import type { EditorMode, SelBounds } from './types.js'

export type Seg = { text: string; fg: ThemeColor; bg?: ThemeColor }

function syntaxColor(kind: string): ThemeColor {
  if (kind === 'keyword') return C.magenta
  if (kind === 'type') return C.cyan
  if (kind === 'string') return C.green
  if (kind === 'number' || kind === 'constant') return C.orange
  if (kind === 'comment') return C.grey
  return C.fg
}

function tokenSegs(line: string, row: number, tokens: SyntaxToken[] | undefined): Seg[] {
  const rowTokens = (tokens ?? [])
    .filter(token => token.row === row && token.endCol > token.startCol)
    .sort((a, b) => a.startCol - b.startCol)
  if (rowTokens.length === 0) return [{ text: line || ' ', fg: C.fg }]

  const segs: Seg[] = []
  let pos = 0
  for (const token of rowTokens) {
    const start = Math.max(pos, Math.min(token.startCol, line.length))
    const end = Math.max(start, Math.min(token.endCol, line.length))
    if (start > pos) segs.push({ text: line.slice(pos, start), fg: C.fg })
    if (end > start) segs.push({ text: line.slice(start, end), fg: syntaxColor(token.kind) })
    pos = end
  }
  if (pos < line.length) segs.push({ text: line.slice(pos), fg: C.fg })
  return segs.length ? segs : [{ text: line || ' ', fg: C.fg }]
}

export function findMatches(lines: string[], query: string): Array<{ row: number; col: number }> {
  if (!query) return []
  const out: Array<{ row: number; col: number }> = []
  for (let row = 0; row < lines.length; row++) {
    let col = 0
    while (true) {
      const idx = lines[row].indexOf(query, col)
      if (idx === -1) break
      out.push({ row, col: idx })
      col = idx + 1
    }
  }
  return out
}

export function lineSegs(
  line: string,
  row: number,
  cursor: { row: number; col: number },
  mode: EditorMode,
  sel: SelBounds | null,
  searchQuery: string,
  ghostText: string | null,
  completionStreaming: boolean,
  thinkingTick: number,
  tokens?: SyntaxToken[],
): Seg[] {
  const isCursor = row === cursor.row

  if (isCursor && (completionStreaming || (ghostText !== null && ghostText.length > 0))) {
    const pre = line.slice(0, cursor.col)
    const at = line[cursor.col] ?? ' '
    const post = line.slice(cursor.col + 1)
    const spin = completionStreaming ? thinkingSpinnerGlyph(thinkingTick) : ''
    return [
      ...(pre ? [{ text: pre, fg: C.green }] : []),
      { text: at, fg: C.bg, bg: C.green },
      ...(ghostText && ghostText.length > 0 ? [{ text: ghostText, fg: C.grey }] : []),
      ...(spin ? [{ text: spin, fg: C.grey }] : []),
      ...(post ? [{ text: post, fg: C.green }] : []),
    ]
  }

  if (mode === 'visual' && sel && row >= sel.startRow && row <= sel.endRow) {
    if (sel.lineMode) {
      return [{ text: `${line} ` || ' ', fg: C.bg, bg: C.blue }]
    }
    const sc = row === sel.startRow ? sel.startCol : 0
    const ec = row === sel.endRow ? sel.endCol : line.length - 1
    const pre  = line.slice(0, sc)
    const mid  = line.slice(sc, ec + 1)
    const post = line.slice(ec + 1)
    return [
      ...(pre  ? [{ text: pre,        fg: C.fg }]              : []),
      { text: mid || ' ', fg: C.bg, bg: C.magenta },
      ...(post ? [{ text: post,       fg: isCursor ? C.blue : C.fg }] : []),
    ]
  }

  if (isCursor && mode === 'insert') {
    const pre  = line.slice(0, cursor.col)
    const at   = line[cursor.col] ?? ' '
    const post = line.slice(cursor.col + 1)
    return [
      ...(pre  ? [{ text: pre,  fg: C.green }] : []),
      { text: at,   fg: C.bg,   bg: C.green },
      ...(post ? [{ text: post, fg: C.green }] : []),
    ]
  }

  if (isCursor && mode !== 'insert') {
    const pre  = line.slice(0, cursor.col)
    const at   = line[cursor.col] ?? ' '
    const post = line.slice(cursor.col + 1)
    return [
      ...(pre  ? [{ text: pre,  fg: C.blue }] : []),
      { text: at,   fg: C.bg,   bg: C.cyan },
      ...(post ? [{ text: post, fg: C.blue }] : []),
    ]
  }

  if (searchQuery && line.includes(searchQuery)) {
    const segs: Seg[] = []
    let pos = 0
    while (pos <= line.length) {
      const idx = line.indexOf(searchQuery, pos)
      if (idx === -1) { if (pos < line.length) segs.push({ text: line.slice(pos), fg: C.fg }); break }
      if (idx > pos) segs.push({ text: line.slice(pos, idx), fg: C.fg })
      segs.push({ text: searchQuery, fg: C.bg, bg: C.yellow })
      pos = idx + searchQuery.length
    }
    return segs.length ? segs : [{ text: line || ' ', fg: C.fg }]
  }

  return tokenSegs(line, row, tokens)
}
