export type TextPosition = { row: number; col: number }

function isIdentifierChar(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9_$]/.test(ch)
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z_$]/.test(ch)
}

function identifierSpanAt(line: string, col: number): { start: number; end: number } | null {
  if (!isIdentifierChar(line[col])) return null
  let start = col
  let end = col + 1
  while (start > 0 && isIdentifierChar(line[start - 1])) start--
  while (end < line.length && isIdentifierChar(line[end])) end++
  if (!isIdentifierStart(line[start])) return null
  return { start, end }
}

function lspColumnForSpan(span: { start: number; end: number }): number {
  return span.end - span.start > 1 ? span.start + 1 : span.start
}

export function nearestIdentifierPosition(lines: readonly string[], cursor: TextPosition): TextPosition {
  const line = lines[cursor.row] ?? ''
  const col = Math.max(0, Math.min(cursor.col, line.length))

  const direct = col < line.length ? identifierSpanAt(line, col) : null
  if (direct) return { row: cursor.row, col: lspColumnForSpan(direct) }

  for (let left = col - 1; left >= 0; left--) {
    const span = identifierSpanAt(line, left)
    if (span) return { row: cursor.row, col: lspColumnForSpan(span) }
  }

  for (let right = col + 1; right < line.length; right++) {
    const span = identifierSpanAt(line, right)
    if (span) return { row: cursor.row, col: lspColumnForSpan(span) }
  }

  return cursor
}
