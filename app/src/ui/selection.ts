import type { SelBounds, VisualSnap } from './types.js'

function lastInclusiveCol(lines: string[], row: number): number {
  const len = (lines[row] ?? '').length
  return Math.max(0, len - 1)
}

export function selectionBounds(
  anchor: { row: number; col: number },
  cursor: { row: number; col: number },
  lineMode: boolean,
  lines?: string[],
): SelBounds {
  let startRow = anchor.row, startCol = anchor.col
  let endRow   = cursor.row, endCol   = cursor.col
  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol]
  }
  if (lineMode && lines) {
    startCol = 0
    const endLine = lines[endRow] ?? ''
    endCol = endLine.length > 0 ? endLine.length - 1 : 0
  }
  return { startRow, startCol, endRow, endCol, lineMode }
}

function selFromBounds(bounds: SelBounds, lines: string[]): SelBounds {
  return selectionBounds(
    { row: bounds.startRow, col: bounds.startCol },
    { row: bounds.endRow, col: bounds.endCol },
    bounds.lineMode,
    lines,
  )
}

function selEqual(a: SelBounds, b: SelBounds): boolean {
  return (
    a.startRow === b.startRow &&
    a.startCol === b.startCol &&
    a.endRow === b.endRow &&
    a.endCol === b.endCol &&
    a.lineMode === b.lineMode
  )
}

function intervalForRow(sel: SelBounds, row: number, lines: string[]): [number, number] | null {
  if (row < sel.startRow || row > sel.endRow) return null
  const last = lastInclusiveCol(lines, row)
  if (sel.lineMode) return [0, last]
  const sc = row === sel.startRow ? sel.startCol : 0
  const ec = row === sel.endRow ? sel.endCol : last
  return [Math.min(sc, ec), Math.max(sc, ec)]
}

function selContains(outer: SelBounds, inner: SelBounds, lines: string[]): boolean {
  const o = selFromBounds(outer, lines)
  const i = selFromBounds(inner, lines)
  for (let r = i.startRow; r <= i.endRow; r++) {
    const oi = intervalForRow(o, r, lines)
    const ii = intervalForRow(i, r, lines)
    if (oi === null || ii === null) return false
    if (ii[0] < oi[0] || ii[1] > oi[1]) return false
  }
  return true
}

function selStrictContains(outer: SelBounds, inner: SelBounds, lines: string[]): boolean {
  const o = selFromBounds(outer, lines)
  const i = selFromBounds(inner, lines)
  return selContains(o, i, lines) && !selEqual(o, i)
}

function wordBoundsOnLine(line: string, col: number): { start: number; end: number } {
  const chars = [...line]
  if (chars.length === 0) return { start: 0, end: 0 }
  const c = Math.min(Math.max(0, col), chars.length - 1)
  const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
  if (!isWord(chars[c])) return { start: col, end: col }
  let s = c
  while (s > 0 && isWord(chars[s - 1])) s--
  let e = c
  while (e + 1 < chars.length && isWord(chars[e + 1])) e++
  return { start: s, end: e }
}

function wordExpandSel(
  lines: string[],
  anchor: { row: number; col: number },
  cursor: { row: number; col: number },
): SelBounds | null {
  if (anchor.row !== cursor.row) return null
  const line = lines[anchor.row] ?? ''
  const wa = wordBoundsOnLine(line, anchor.col)
  const wc = wordBoundsOnLine(line, cursor.col)
  const sc = Math.min(wa.start, wc.start)
  const ec = Math.max(wa.end, wc.end)
  return { startRow: anchor.row, startCol: sc, endRow: anchor.row, endCol: ec, lineMode: false }
}

function fullLinesSel(lines: string[], startRow: number, endRow: number): SelBounds {
  if (lines.length === 0) return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, lineMode: false }
  const sr = Math.max(0, startRow)
  const er = Math.min(Math.max(0, lines.length - 1), endRow)
  return {
    startRow: sr,
    startCol: 0,
    endRow: er,
    endCol: lastInclusiveCol(lines, er),
    lineMode: false,
  }
}

function paragraphSel(lines: string[], row: number): SelBounds {
  if (lines.length === 0) return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, lineMode: false }
  const r = Math.max(0, Math.min(row, lines.length - 1))
  let start = r
  while (start > 0 && (lines[start - 1] ?? '').trim() !== '') start--
  let end = r
  while (end + 1 < lines.length && (lines[end + 1] ?? '').trim() !== '') end++
  return {
    startRow: start,
    startCol: 0,
    endRow: end,
    endCol: lastInclusiveCol(lines, end),
    lineMode: false,
  }
}

function bufferSel(lines: string[]): SelBounds {
  if (lines.length === 0) return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, lineMode: false }
  const er = lines.length - 1
  return { startRow: 0, startCol: 0, endRow: er, endCol: lastInclusiveCol(lines, er), lineMode: false }
}

function boundsToVisualSnap(bounds: SelBounds, lines: string[]): VisualSnap {
  const n = selFromBounds(bounds, lines)
  return {
    anchor: { row: n.startRow, col: n.startCol },
    cursor: { row: n.endRow, col: n.endCol },
    lineMode: n.lineMode,
  }
}

/** Emacs-style expand-region: next strictly larger selection (word → lines → line-vis → paragraph → buffer). */
export function expandRegionOnce(
  lines: string[],
  anchor: { row: number; col: number },
  cursor: { row: number; col: number },
  lineMode: boolean,
): VisualSnap | null {
  const cur = selectionBounds(anchor, cursor, lineMode, lines)
  const candidates: SelBounds[] = []

  if (!lineMode) {
    const w = wordExpandSel(lines, anchor, cursor)
    if (w) candidates.push(selFromBounds(w, lines))
  }

  candidates.push(selFromBounds(fullLinesSel(lines, cur.startRow, cur.endRow), lines))

  candidates.push(selFromBounds(
    {
      startRow: cur.startRow,
      startCol: 0,
      endRow: cur.endRow,
      endCol: lastInclusiveCol(lines, cur.endRow),
      lineMode: true,
    },
    lines,
  ))

  candidates.push(selFromBounds(paragraphSel(lines, cur.startRow), lines))
  candidates.push(selFromBounds(bufferSel(lines), lines))

  for (const raw of candidates) {
    const c = selFromBounds(raw, lines)
    if (selStrictContains(c, cur, lines)) return boundsToVisualSnap(c, lines)
  }
  return null
}

export function getVisualText(lines: string[], sel: SelBounds): string {
  if (sel.lineMode) return lines.slice(sel.startRow, sel.endRow + 1).join('\n')
  if (sel.startRow === sel.endRow) {
    return lines[sel.startRow]?.slice(sel.startCol, sel.endCol + 1) ?? ''
  }
  const parts = [lines[sel.startRow]?.slice(sel.startCol) ?? '']
  for (let r = sel.startRow + 1; r < sel.endRow; r++) parts.push(lines[r] ?? '')
  parts.push(lines[sel.endRow]?.slice(0, sel.endCol + 1) ?? '')
  return parts.join('\n')
}
