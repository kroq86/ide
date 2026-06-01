import React from 'react'
import { Box, Text } from 'terminal-react-core'
import type { GitDisplayLine, GitLogEntry, GitPanelView, GitStatusData } from '../git.js'
import { C, type ThemeColor } from './theme.js'

function clampGitDim(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Printable width for log rows (panel padding, border, cursor column). */
function gitLogRowInnerWidth(totalCols: number): number {
  // Border + padding + Ink overhead; keep subject column as wide as possible.
  return Math.max(44, totalCols - 6)
}

function gitLogColumnWidths(usable: number): { hash: number; author: number; date: number; subject: number } {
  const hash = 8
  const gaps = 3
  const rest = Math.max(24, usable - hash - gaps)
  let author = clampGitDim(Math.floor(rest * 0.30), 10, 26)
  let date = clampGitDim(Math.floor(rest * 0.34), 12, 28)
  let subject = rest - author - date
  if (subject < 16) {
    const need = 16 - subject
    const da = Math.min(need >> 1, Math.max(0, author - 8))
    author -= da
    const dd = Math.min(need - da, Math.max(0, date - 10))
    date -= dd
    subject = rest - author - date
  }
  return { hash, author, date, subject: Math.max(14, subject) }
}

function gitLogFitCell(s: string, w: number): string {
  if (w <= 0) return ''
  const t = s.trim()
  if (t.length <= w) return t.padEnd(w, ' ')
  if (w <= 1) return '…'
  return `${t.slice(0, w - 1)}…`
}

/** Split commit subject across up to `maxLines` rows (Magit-style); last row gets … if truncated. */
function gitLogWrapMessage(msg: string, firstWidth: number, contWidth: number, maxLines: number): string[] {
  const t = msg.trim()
  if (!t) return ['']
  const out: string[] = []
  let pos = 0
  for (let li = 0; li < maxLines && pos < t.length; li++) {
    const w = li === 0 ? firstWidth : contWidth
    if (w <= 0) break
    const remaining = t.length - pos
    const lastLine = li === maxLines - 1
    if (lastLine && remaining > w) {
      out.push(`${t.slice(pos, pos + w - 1)}…`)
      pos = t.length
    } else {
      const take = Math.min(w, remaining)
      out.push(t.slice(pos, pos + take))
      pos += take
    }
  }
  return out
}

type FlatGitRow =
  | { flatKind: 'std'; line: GitDisplayLine; srcIdx: number }
  | {
      flatKind: 'log-head'
      line: Extract<GitDisplayLine, { type: 'log-entry' }>
      subject0: string
      srcIdx: number
    }
  | { flatKind: 'log-tail'; logEntry: GitLogEntry; chunk: string; metaPad: number; srcIdx: number }

function flattenGitPanelRows(displayLines: GitDisplayLine[], view: GitPanelView, totalCols: number): FlatGitRow[] {
  if (view !== 'log') {
    return displayLines.map((line, srcIdx) => ({ flatKind: 'std', line, srcIdx }))
  }
  const inner = gitLogRowInnerWidth(totalCols)
  const cursorGutter = 2
  const { hash: hw, author: aw, date: dw, subject: sw } = gitLogColumnWidths(inner - cursorGutter)
  const metaPad = hw + 1 + aw + 1 + dw + 1
  const contW = Math.max(14, inner - cursorGutter - metaPad)
  const out: FlatGitRow[] = []
  for (let srcIdx = 0; srcIdx < displayLines.length; srcIdx++) {
    const line = displayLines[srcIdx]!
    if (line.type !== 'log-entry') {
      out.push({ flatKind: 'std', line, srcIdx })
      continue
    }
    const chunks = gitLogWrapMessage(line.logEntry.msg, sw, contW, 3)
    const subject0 = chunks[0] ?? ''
    out.push({ flatKind: 'log-head', line, subject0, srcIdx })
    for (let ti = 1; ti < chunks.length; ti++) {
      out.push({
        flatKind: 'log-tail',
        logEntry: line.logEntry,
        chunk: chunks[ti]!,
        metaPad,
        srcIdx,
      })
    }
  }
  return out
}

function flatRowIndexForCursorHighlight(flatRows: FlatGitRow[], cursorDIdx: number): number {
  if (cursorDIdx < 0) return -1
  return flatRows.findIndex(r => r.srcIdx === cursorDIdx && r.flatKind !== 'log-tail')
}

function gitPanelRowHighlighted(
  r: FlatGitRow,
  cursorDIdx: number,
  displayLines: GitDisplayLine[],
): boolean {
  if (cursorDIdx < 0) return false
  if (r.srcIdx !== cursorDIdx) return false
  const src = displayLines[cursorDIdx]
  if (!src?.selectable) return false
  if (r.flatKind === 'log-head' || r.flatKind === 'log-tail') return src.type === 'log-entry'
  return r.flatKind === 'std'
}

export function GitPanel({ data, cursor, pendingKey, logEntries, gitError, view, displayLines, totalRows, totalCols }: {
  data: GitStatusData
  cursor: number
  pendingKey: string | null
  logEntries: GitLogEntry[] | null
  gitError?: string
  view: GitPanelView
  displayLines: GitDisplayLine[]
  totalRows: number
  totalCols: number
}) {
  const selectableIdxs: number[] = []
  for (let i = 0; i < displayLines.length; i++) {
    if (displayLines[i]!.selectable) selectableIdxs.push(i)
  }
  const safeIdx    = Math.min(cursor, Math.max(0, selectableIdxs.length - 1))
  const cursorDIdx = selectableIdxs[safeIdx] ?? -1

  const flatRows = flattenGitPanelRows(displayLines, view, totalCols)
  const cursorFlatAnchor = flatRowIndexForCursorHighlight(flatRows, cursorDIdx)

  const contentRows = Math.max(1, totalRows - 2)
  const idealOffset = Math.max(0, cursorFlatAnchor - Math.floor(contentRows / 2))
  const scrollOffset = Math.min(idealOffset, Math.max(0, flatRows.length - contentRows))
  const visibleFlat = flatRows.slice(scrollOffset, scrollOffset + contentRows)

  const hint = gitError ? `ERROR: ${gitError}`
    : pendingKey === 'c' ? 'c=commit  Esc=cancel'
    : pendingKey === 'l' ? 'l=log (Magit)  Esc=cancel'
    : view === 'log'
      ? 'j/k  Ret=git show  b=status  q/Esc=close'
      : 'j/k  TAB=expand  Ret=open  s/u=stage  ll=log  cc=commit  F=pull  P=push  q/Esc=close'
  const hintColor: ThemeColor = gitError ? C.red : C.grey

  const gitTitleLeft = ` *git*  *git*  ${data.branch} `
  const gitTitlePad = ' '.repeat(Math.max(0, totalCols - gitTitleLeft.length - hint.length - 2))
  return (
    <Box flexDirection="column" width={totalCols} height={totalRows}>
      <Box flexDirection="row">
        <Text backgroundColor={C.magenta} color={C.bg}>{gitTitleLeft}</Text>
        <Text backgroundColor='#21252b' color={hintColor}>{gitTitlePad + ' ' + hint}</Text>
      </Box>
      {visibleFlat.map((row, i) => {
        const flatIdx = i + scrollOffset
        const rowKey = `gf:${flatIdx}:${row.srcIdx}:${row.flatKind}`
        const hilite = gitPanelRowHighlighted(row, cursorDIdx, displayLines)
        const cursorHere = hilite && row.flatKind !== 'log-tail'
        const cursorGutter = 2

        if (row.flatKind === 'log-head') {
          const e = row.line.logEntry
          const inner = gitLogRowInnerWidth(totalCols)
          const { hash: hw, author: aw, date: dw } = gitLogColumnWidths(inner - cursorGutter)
          const rowBg = hilite ? C.violet : undefined
          const ink = (c: ThemeColor) => (hilite ? C.bg : c)
          return (
            <Box key={rowKey} flexDirection="row">
              <Box width={cursorGutter}>
                <Text bold={cursorHere} color={ink(cursorHere ? C.cyan : C.grey)}>{cursorHere ? '>' : ' '}</Text>
              </Box>
              <Box flexDirection="row" gap={1} backgroundColor={rowBg}>
                <Text bold color={ink(C.yellow)}>{gitLogFitCell(e.hash, hw)}</Text>
                <Text color={ink(C.magenta)}>{gitLogFitCell(e.author, aw)}</Text>
                <Text color={ink(C.green)}>{gitLogFitCell(e.date, dw)}</Text>
                <Text color={ink(C.fg)}>{row.subject0}</Text>
              </Box>
            </Box>
          )
        }

        if (row.flatKind === 'log-tail') {
          const rowBg = hilite ? C.violet : undefined
          const ink = (c: ThemeColor) => (hilite ? C.bg : c)
          return (
            <Box key={rowKey} flexDirection="row">
              <Box width={cursorGutter}>
                <Text color={ink(C.grey)}>│</Text>
              </Box>
              <Box flexDirection="row" backgroundColor={rowBg}>
                <Text color={ink(C.grey)}>{' '.repeat(row.metaPad)}</Text>
                <Text color={ink(C.fg)}>{row.chunk}</Text>
              </Box>
            </Box>
          )
        }

        const line = row.line
        const isCursor = cursorHere && line.selectable

        if (line.type === 'blank') return <Text key={rowKey}>{' '}</Text>

        let color: ThemeColor = C.fg
        let bold = false
        let bg: ThemeColor | undefined

        if (line.type === 'header') { color = C.cyan; bold = true }
        else if (line.type === 'section' || line.type === 'log-header') { color = C.blue; bold = true }
        else if (line.type === 'file') {
          color = line.entry.section === 'staged'    ? C.green
                : line.entry.section === 'untracked' ? C.grey
                : C.orange
          if (isCursor) { bg = C.violet; color = C.bg }
        }
        else if (line.type === 'hunk') {
          color = C.violet
          if (isCursor) { bg = C.violet; color = C.bg }
        }
        else if (line.type === 'diff') {
          const t = line.text.trimStart()
          color = t.startsWith('+') ? C.green : t.startsWith('-') ? C.red : C.grey
        }

        return (
          <Box key={rowKey} flexDirection="row">
            <Text color={isCursor ? C.cyan : C.grey}>{isCursor ? '>' : ' '}</Text>
            <Text color={color} backgroundColor={bg} bold={bold} wrap="truncate">
              {line.text || ' '}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
