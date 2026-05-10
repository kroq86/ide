import React from 'react'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { AlternateScreen, Box, Text, render, useInput, type Instance } from 'terminal-react-core'
import { QeSidecar, type LspResponse, type Snapshot, type SyntaxToken } from './protocol.js'
import { ShellSidecar, type ShellLine, type ParsedLocation, type ShellRun } from './shell.js'
import { streamCompletion, streamChat, type AiContext } from './ai.js'
import {
  REPO_ROOT, COMMAND_LABELS, NODE_LABELS,
  buildLeaderMap, flattenLeader, isLeafAction, whichKeyDesc,
  findNearestTestScript, extractFirstCodeBlock, extractFirstLocation,
  printable, printableText, bufferName,
  type LeaderNode, type CmdItem,
} from './leader.js'
import {
  applyPatchProposal,
  assessPatchRisk,
  buildReviewTrace,
  buildTrace,
  collectGitContext,
  generatePatchProposal,
  generateReviewProposal,
  loadCodeClawProject,
  loadCodeClawProjectForReview,
  loadTasks,
  makeReviewTraceId,
  makeTraceId,
  readLatestTrace,
  resolveTaskCommand,
  writeReviewTrace,
  writeTrace,
  type CodeClawTask,
  type FixContext,
  type PatchProposal,
  type PatchRiskAssessment,
  type ReviewFinding,
  type ReviewProposal,
  type TraceSummary,
  type VerifyResult,
} from './codeclaw.js'
import { loadConfig, reloadConfig, getConfigPath, CONFIG_PATHS, type BufferInfo, type EditorContext, type LeaderTree } from './config.js'
import {
  loadGitStatus, loadFileHunks, getGitRepoRoot, hunkNewStartRow, resolveRepoFilePath, stageEntry, unstageEntry, commitGit, pullGit, pushGit,
  getGitLog, buildGitDisplayLines,
  type GitStatusData, type GitFileEntry, type GitDisplayLine, type GitLogEntry,
} from './git.js'
import { readDiredEntries, type DiredEntry } from './dired.js'


/** Keep header readable on narrow terminals (avoid path/status/search overlapping). */
function truncateChars(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  if (max <= 1) return '…'
  return `${s.slice(0, max - 1)}…`
}

function editorHeaderPath(title: string, maxChars: number): string {
  if (title.length <= maxChars) return title
  const base = basename(title)
  const tail = `…/${base}`
  if (tail.length <= maxChars) return tail
  return truncateChars(base, maxChars)
}

function editorHeaderMeta(status: string, searchQuery: string, matchCount: number, maxChars: number): string {
  const tail = searchQuery ? `  /${searchQuery} (${matchCount})` : ''
  return truncateChars(`${status}${tail}`, maxChars)
}

type ThemeColor = `#${string}`
type Theme = {
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

let C: Theme = {
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

type EditorMode = 'normal' | 'insert' | 'visual' | 'command' | 'search'


type EditorBuffer = {
  id: string
  name: string
  filename: string | null
  snapshot: Snapshot | null
  status: string
  lastUsedAt: number
  jumpTo?: { row: number; col: number }
}

type PromptState =
  | { type: 'buffer'; query: string; selected: number }
  | { type: 'file'; query: string }
  | { type: 'saveAs'; query: string; thenQuit?: boolean }
  | { type: 'commit'; message: string }

type AiMessage = { role: 'user' | 'assistant'; content: string; error?: boolean }

type LspTarget = { path?: string; row?: number; col?: number }

type CodeClawFixState =
  | { status: 'idle' }
  | { status: 'generating'; traceId: string; startedAt: string; context: FixContext }
  | { status: 'proposal'; traceId: string; startedAt: string; context: FixContext; proposal: PatchProposal; risk: PatchRiskAssessment; mediumConfirm: boolean }
  | { status: 'editing'; traceId: string; startedAt: string; context: FixContext; proposal: PatchProposal }
  | { status: 'applying'; traceId: string; startedAt: string; context: FixContext; proposal: PatchProposal; risk: PatchRiskAssessment }
  | { status: 'trace'; latest: TraceSummary | null }
  | { status: 'done'; message: string; tracePath: string; verify?: VerifyResult }
  | { status: 'error'; message: string; tracePath?: string }

type ReviewState =
  | { status: 'idle' }
  | { status: 'generating' }
  | { status: 'findings'; proposal: ReviewProposal; cursor: number; tracePath: string }
  | { status: 'error'; message: string; tracePath?: string }

type Panel =
  | null
  | { type: 'shell' }
  | { type: 'whichkey'; node: LeaderNode; path: string }
  | { type: 'cmdpalette'; query: string; cursor: number; items: CmdItem[] }
  | { type: 'ai'; focused: boolean }
  | { type: 'git'; data: GitStatusData; cursor: number; pendingKey: string | null; logEntries: GitLogEntry[] | null; gitError?: string }
  | { type: 'dired'; path: string; cursor: number }

type SelBounds = {
  startRow: number; startCol: number
  endRow: number;   endCol: number
  lineMode: boolean
}

function selectionBounds(
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

/** Snapshot for restoring visual selection (expand-region / contract). */
type VisualSnap = {
  anchor: { row: number; col: number }
  cursor: { row: number; col: number }
  lineMode: boolean
}

function lastInclusiveCol(lines: string[], row: number): number {
  const len = (lines[row] ?? '').length
  return Math.max(0, len - 1)
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
function expandRegionOnce(
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

function getVisualText(lines: string[], sel: SelBounds): string {
  if (sel.lineMode) return lines.slice(sel.startRow, sel.endRow + 1).join('\n')
  if (sel.startRow === sel.endRow) {
    return lines[sel.startRow]?.slice(sel.startCol, sel.endCol + 1) ?? ''
  }
  const parts = [lines[sel.startRow]?.slice(sel.startCol) ?? '']
  for (let r = sel.startRow + 1; r < sel.endRow; r++) parts.push(lines[r] ?? '')
  parts.push(lines[sel.endRow]?.slice(0, sel.endCol + 1) ?? '')
  return parts.join('\n')
}

function findMatches(lines: string[], query: string): Array<{ row: number; col: number }> {
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

type Seg = { text: string; fg: ThemeColor; bg?: ThemeColor }

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

function lineSegs(
  line: string,
  row: number,
  cursor: { row: number; col: number },
  mode: EditorMode,
  sel: SelBounds | null,
  searchQuery: string,
  ghostText: string | null,
  tokens?: SyntaxToken[],
): Seg[] {
  const isCursor = row === cursor.row

  // Ghost text (insert mode only)
  if (isCursor && ghostText !== null && ghostText.length > 0) {
    const pre = line.slice(0, cursor.col)
    const post = line.slice(cursor.col)
    return [
      { text: `${pre}|`, fg: C.blue },
      { text: ghostText, fg: C.grey },
      { text: post || ' ', fg: C.blue },
    ]
  }

  // Visual selection
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

  // Block cursor (normal / command / search modes)
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

  // Thin cursor (insert mode)
  if (isCursor) {
    const pre  = line.slice(0, cursor.col)
    const post = line.slice(cursor.col)
    return [{ text: `${pre}|${post || ' '}`, fg: C.green }]
  }

  // Search highlights
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

function getGitContext(): string {
  const cwd = process.cwd()
  try {
    const status = spawnSync('git', ['status', '--short'], { cwd, encoding: 'utf8', timeout: 800 })
    const diff   = spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd, encoding: 'utf8', timeout: 800 })
    const parts: string[] = []
    if (status.stdout?.trim()) parts.push(`git status:\n${status.stdout.trim()}`)
    if (diff.stdout?.trim())   parts.push(`git diff --stat:\n${diff.stdout.trim()}`)
    return parts.join('\n\n')
  } catch { return '' }
}

function updateGitEntry(entries: GitFileEntry[], path: string, fn: (e: GitFileEntry) => GitFileEntry): GitFileEntry[] {
  return entries.map(e => e.path === path ? fn(e) : e)
}

// ── Leader helpers ────────────────────────────────────────────────────────────

// ── Command palette panel ─────────────────────────────────────────────────────

function CmdPalettePanel({
  items, query, cursor, width,
}: {
  items: CmdItem[]
  query: string
  cursor: number
  width: number
}) {
  const filtered = query
    ? items.filter(it => it.label.toLowerCase().includes(query.toLowerCase()) || it.keys.includes(query))
    : items
  const visible = filtered.slice(0, 12)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.violet} paddingX={1} width={width}>
      <Text bold color={C.violet}>M-x  <Text color={C.grey}>j/k=navigate  Enter=run  Esc=close</Text></Text>
      <Box flexDirection="row" marginTop={1}>
        <Text color={C.yellow}>{'> '}</Text>
        <Text color={C.fg}>{query}</Text>
        <Text color={C.grey}>{'_'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0
          ? <Text color={C.grey}>no commands match</Text>
          : visible.map((item, i) => {
              const active = i === cursor % visible.length
              return (
                <Box key={item.keys} flexDirection="row">
                  <Text color={active ? C.bg : C.grey} backgroundColor={active ? C.violet : undefined}>{' '}</Text>
                  <Text color={active ? C.cyan : C.fg} backgroundColor={active ? C.bg : undefined} bold={active}>
                    {` ${item.label.padEnd(36)} `}
                  </Text>
                  <Text color={C.grey} backgroundColor={active ? C.bg : undefined}>{item.keys}</Text>
                </Box>
              )
            })
        }
      </Box>
    </Box>
  )
}

function lspHoverText(response: LspResponse): string {
  const result = response.result as { text?: unknown; message?: unknown } | undefined
  const text = typeof result?.text === 'string' && result.text.trim()
    ? result.text.trim()
    : typeof result?.message === 'string'
      ? result.message
      : response.status
  return text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join('  ')
}

function lspDefinitionTarget(response: LspResponse): LspTarget | null {
  const result = response.result as { target?: LspTarget; message?: unknown } | undefined
  if (result?.target?.path) return result.target
  return null
}

function isDirty(buffer: EditorBuffer): boolean {
  return buffer.snapshot?.dirty ?? false
}

function toBufferInfo(buffer: EditorBuffer, activeId: string): BufferInfo {
  return {
    id: buffer.id,
    name: buffer.name,
    filename: buffer.snapshot?.filename ?? buffer.filename,
    dirty: isDirty(buffer),
    active: buffer.id === activeId,
  }
}

function filterBuffers(buffers: EditorBuffer[], query: string): EditorBuffer[] {
  const q = query.trim().toLowerCase()
  if (!q) return buffers
  return buffers.filter(buffer => {
    const filename = buffer.snapshot?.filename ?? buffer.filename ?? ''
    return buffer.name.toLowerCase().includes(q) || filename.toLowerCase().includes(q)
  })
}

// ── Shell pane ────────────────────────────────────────────────────────────────

function ShellPane({
  lines, rows, focused, mode, input, running, height,
}: {
  lines: ShellLine[]
  rows: number
  focused: boolean
  mode: 'pty' | 'runner'
  input: string
  running: boolean
  height: number
}) {
  const borderColor = focused ? C.green : C.grey
  const visible = lines.slice(-Math.max(1, rows - 2))
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1} height={height}>
      <Text bold color={borderColor}>{`*shell*  mode: ${mode}${running ? '  running...' : ''}`}</Text>
      {visible.length === 0
        ? <Text color={C.grey}>  (no output yet)</Text>
        : visible.map((l, i) => (
            <Text key={i} color={l.isError ? C.red : C.fg} wrap="truncate">{l.text || ' '}</Text>
          ))
      }
      {mode === 'runner' && (
        <Box flexDirection="row">
          <Text color={C.cyan}>{'$ '}</Text>
          <Text color={C.fg}>{input}</Text>
          {focused && <Text color={C.grey}>_</Text>}
        </Box>
      )}
      {mode === 'pty' && focused && <Text color={C.grey}>Enter=tracked run  Esc=editor</Text>}
    </Box>
  )
}

// ── Which-key panel ───────────────────────────────────────────────────────────

function WhichKeyPanel({ node, path, totalCols }: { node: LeaderNode; path: string; totalCols: number }) {
  const entries = Object.entries(node)
  const label   = path ? `SPC ${path.trimEnd()}` : 'SPC'
  const topKey  = path.trimEnd().split(' ').pop() ?? ''
  const category = NODE_LABELS[topKey] ?? 'leader'

  const NUM_COLS = Math.min(4, Math.max(1, entries.length))
  const colWidth = Math.floor((totalCols - 4) / NUM_COLS)

  const rowGroups: Array<Array<{ key: string; desc: string }>> = []
  for (let i = 0; i < entries.length; i += NUM_COLS) {
    rowGroups.push(
      entries.slice(i, i + NUM_COLS).map(([k, v]) => ({
        key: k,
        desc: whichKeyDesc(path, k, v),
      })),
    )
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.violet} paddingX={1}>
      <Box flexDirection="row">
        <Box flexGrow={1}>
          <Text bold color={C.cyan}>{label}</Text>
        </Box>
        <Text color={C.grey}>{`[${category}]`}</Text>
      </Box>
      {rowGroups.map((row, i) => (
        <Box key={i} flexDirection="row">
          {row.map(({ key, desc }) => (
            <Box key={key} width={colWidth} flexDirection="row">
              <Text bold color={C.cyan}>{` ${key} `}</Text>
              <Text color={C.grey}>{desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// ── AI chat panel ─────────────────────────────────────────────────────────────

const THINKING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

function thinkingSpinnerGlyph(tick: number): string {
  return THINKING_SPINNER_FRAMES[tick % THINKING_SPINNER_FRAMES.length]!
}

function thinkingPrefixedLine(tick: number, rest: string): string {
  return `${thinkingSpinnerGlyph(tick)} ${rest}`
}

function AiPanel({
  messages, input, streaming, focused, width, height, navHint, shellHint, fixState, reviewState, scrollOffset, thinkingTick,
}: {
  messages: AiMessage[]
  input: string
  streaming: boolean
  focused: boolean
  width: number
  height: number
  navHint?: string
  shellHint?: string
  fixState: CodeClawFixState
  reviewState: ReviewState
  scrollOffset: number
  /** Incremented on an interval while the AI panel is busy (stream / CodeClaw). */
  thinkingTick: number
}) {
  const borderColor = focused ? C.green : C.grey
  const msgAreaRows = Math.max(3, height - 8)
  const clampedOffset = Math.min(scrollOffset, Math.max(0, messages.length - msgAreaRows))
  const sliceEnd = clampedOffset === 0 ? undefined : -clampedOffset
  const visible = messages.slice(-msgAreaRows - clampedOffset, sliceEnd)
  const hiddenAbove = Math.max(0, messages.length - msgAreaRows - clampedOffset)
  const fixLines = codeClawFixLines(fixState, msgAreaRows, thinkingTick)
  const reviewLns = reviewLines(reviewState, msgAreaRows, thinkingTick)
  /** While a fix is active, show fix overlay so review → `f` is visible (review alone would hide generating/proposal). */
  const overlayLines = fixState.status !== 'idle' ? fixLines : reviewLns.length > 0 ? reviewLns : fixLines

  const scrollHint = clampedOffset > 0 ? `  ↑${clampedOffset} scrolled  j/k=scroll` : !focused && messages.length > msgAreaRows ? '  k=scroll up' : ''
  const overlayActive = fixState.status !== 'idle' || reviewState.status !== 'idle'
  const aiPanelBusy =
    streaming
    || fixState.status === 'generating'
    || fixState.status === 'applying'
    || reviewState.status === 'generating'
  const hint = aiPanelBusy
    ? `${thinkingSpinnerGlyph(thinkingTick)} …`
    : focused ? 'Enter=send  Esc=focus editor' : overlayActive ? 'x=dismiss  SPC a p=focus' : 'SPC a p=focus'

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1} width={width} height={height}>
      <Text bold color={borderColor}>*AI*  {hint}{scrollHint}</Text>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {overlayLines.length > 0
          ? overlayLines.map((line, i) => (
              <Text key={i} color={line.color} wrap={line.wrap ?? 'truncate'}>{line.text || ' '}</Text>
            ))
          : visible.length === 0
          ? <Text color={C.grey}>Ask anything about the current file...</Text>
          : <>
              {hiddenAbove > 0 && (
                <Text color={C.grey}>{`  ↑ ${hiddenAbove} more message${hiddenAbove === 1 ? '' : 's'}`}</Text>
              )}
              {visible.map((msg, i) => (
                <Box key={i} flexDirection="column" marginBottom={1}>
                  <Text bold color={msg.role === 'user' ? C.cyan : msg.error ? C.red : C.green}>
                    {msg.role === 'user' ? 'You' : msg.error ? 'Error' : 'AI'}
                  </Text>
                  <Text color={msg.error ? C.red : C.fg} wrap="wrap">
                    {msg.content}
                    {streaming && i === visible.length - 1
                      ? (msg.content ? ` ${thinkingSpinnerGlyph(thinkingTick)}` : `${thinkingSpinnerGlyph(thinkingTick)} ▋`)
                      : ''}
                  </Text>
                </Box>
              ))}
            </>
        }
      </Box>
      {navHint && (
        <Text color={C.yellow}>{`  Tab → ${navHint}`}</Text>
      )}
      {shellHint && (
        <Text color={C.green}>{`  ! → run in shell: ${shellHint}`}</Text>
      )}
      {focused && (
        <Box flexDirection="row" marginTop={1}>
          <Text color={C.cyan}>{'> '}</Text>
          <Text color={C.fg}>{input}</Text>
          <Text color={C.grey}>{'_'}</Text>
        </Box>
      )}
    </Box>
  )
}

function codeClawFixLines(
  state: CodeClawFixState,
  maxRows: number,
  thinkingTick: number,
): Array<{ text: string; color: ThemeColor; wrap?: 'wrap' | 'truncate' }> {
  if (state.status === 'idle') return []
  if (state.status === 'generating') {
    return [
      { text: thinkingPrefixedLine(thinkingTick, 'CodeClaw fix'), color: C.cyan },
      { text: thinkingPrefixedLine(thinkingTick, 'Building session context and asking AI for a structured patch…'), color: C.grey, wrap: 'wrap' },
    ]
  }
  if (state.status === 'applying') {
    return [
      { text: thinkingPrefixedLine(thinkingTick, 'CodeClaw fix'), color: C.cyan },
      { text: thinkingPrefixedLine(thinkingTick, 'Applying patch and rerunning verification…'), color: C.grey, wrap: 'wrap' },
    ]
  }
  if (state.status === 'trace') {
    if (!state.latest) {
      return [
        { text: 'CodeClaw trace', color: C.cyan },
        { text: 'No trace entries yet. Run SPC a f, accept or reject a proposal, then come back here.', color: C.grey, wrap: 'wrap' },
      ]
    }
    const { trace, path } = state.latest
    const lines: Array<{ text: string; color: ThemeColor; wrap?: 'wrap' | 'truncate' }> = [
      { text: 'CodeClaw trace last', color: C.cyan },
      { text: `Workflow: ${trace.workflow}`, color: C.fg },
      { text: `Failure command: ${trace.input?.command ?? '(unknown)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Root cause: ${trace.proposal?.rootCause ?? '(none recorded)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Files changed: ${trace.proposal?.filesChanged?.join(', ') || '(none)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Accepted: ${trace.accepted ? 'yes' : 'no'}`, color: trace.accepted ? C.green : C.yellow },
      { text: `Risk: ${trace.proposal?.assessedRisk?.level ?? trace.proposal?.risk ?? '(unknown)'}`, color: C.yellow },
      { text: `Verify task: ${trace.verify?.command ?? '(not run)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Verify result: ${trace.verify ? (trace.verify.passed ? 'passed' : 'failed') : '(not run)'}`, color: trace.verify?.passed ? C.green : C.red },
      { text: `Trace file: ${path}`, color: C.grey, wrap: 'wrap' },
    ]
    return lines.slice(0, maxRows)
  }
  if (state.status === 'done') {
    return [
      { text: 'CodeClaw fix complete', color: C.green },
      { text: state.message, color: C.fg, wrap: 'wrap' },
      { text: `Trace: ${state.tracePath}`, color: C.grey, wrap: 'wrap' },
    ]
  }
  if (state.status === 'error') {
    return [
      { text: 'CodeClaw fix failed', color: C.red },
      { text: state.message, color: C.fg, wrap: 'wrap' },
      ...(state.tracePath ? [{ text: `Trace: ${state.tracePath}`, color: C.grey as ThemeColor, wrap: 'wrap' as const }] : []),
    ]
  }

  const proposal = state.proposal
  const risk = state.status === 'proposal' ? state.risk : assessPatchRisk(proposal)
  const lines: Array<{ text: string; color: ThemeColor; wrap?: 'wrap' | 'truncate' }> = [
    { text: 'Root cause:', color: C.cyan },
    { text: proposal.rootCause, color: C.fg, wrap: 'wrap' },
    { text: 'Summary:', color: C.cyan },
    { text: proposal.summary, color: C.fg, wrap: 'wrap' },
    { text: 'Patch:', color: C.cyan },
  ]

  for (const file of proposal.files) {
    lines.push({ text: file.path, color: C.yellow })
    for (const diffLine of file.unifiedDiff.split('\n').slice(0, Math.max(6, maxRows - 12))) {
      const color = diffLine.startsWith('+') && !diffLine.startsWith('+++') ? C.green
        : diffLine.startsWith('-') && !diffLine.startsWith('---') ? C.red
        : diffLine.startsWith('@@') ? C.magenta
        : C.grey
      lines.push({ text: diffLine, color })
    }
  }

  lines.push({ text: 'Verify:', color: C.cyan })
  lines.push({ text: proposal.verifyTask, color: C.fg, wrap: 'wrap' })
  lines.push({ text: `Risk: ${risk.level} (${risk.reasons.join('; ')})`, color: risk.level === 'high' ? C.red : risk.level === 'medium' ? C.yellow : C.green, wrap: 'wrap' })
  if (proposal.notes?.length) {
    lines.push({ text: `Notes: ${proposal.notes.join(' ')}`, color: C.grey, wrap: 'wrap' })
  }
  if (state.status === 'editing') {
    lines.push({ text: 'Edit request, then press Enter to regenerate. Esc cancels edit.', color: C.yellow, wrap: 'wrap' })
  } else if (risk.level === 'high') {
    lines.push({ text: 'High risk: manual patch only. [r] reject  [e] edit prompt', color: C.red, wrap: 'wrap' })
  } else if (risk.requiresConfirm && state.status === 'proposal' && state.mediumConfirm) {
    lines.push({ text: 'Medium risk: press [a] again to confirm apply. [r] reject  [e] edit prompt', color: C.yellow, wrap: 'wrap' })
  } else if (risk.requiresConfirm) {
    lines.push({ text: 'Medium risk: [a] review confirm  [r] reject  [e] edit prompt', color: C.yellow, wrap: 'wrap' })
  } else {
    lines.push({ text: 'Accept? [a] apply  [r] reject  [e] edit prompt', color: C.yellow, wrap: 'wrap' })
  }
  return lines.slice(0, maxRows)
}

function reviewLines(
  state: ReviewState,
  maxRows: number,
  thinkingTick: number,
): Array<{ text: string; color: ThemeColor; wrap?: 'wrap' | 'truncate' }> {
  if (state.status === 'idle') return []
  if (state.status === 'generating') {
    return [{ text: thinkingPrefixedLine(thinkingTick, 'CodeClaw Review — generating…'), color: C.cyan }]
  }
  if (state.status === 'error') {
    const lines: Array<{ text: string; color: ThemeColor; wrap?: 'wrap' | 'truncate' }> = [
      { text: 'CodeClaw Review failed', color: C.red },
      { text: state.message, color: C.fg, wrap: 'wrap' },
    ]
    if (state.tracePath) lines.push({ text: `Trace: ${state.tracePath}`, color: C.grey, wrap: 'truncate' })
    return lines
  }

  const { proposal, cursor } = state
  const severityColor = (s: ReviewFinding['severity']): ThemeColor =>
    s === 'blocker' ? C.red : s === 'warning' ? C.yellow : C.cyan

  const lines: Array<{ text: string; color: ThemeColor; wrap?: 'wrap' | 'truncate' }> = [
    {
      text: `CodeClaw Review — ${proposal.safeToCommit ? '✓ safe to commit' : '✗ not safe to commit'}  (${proposal.findings.length} finding${proposal.findings.length !== 1 ? 's' : ''})`,
      color: proposal.safeToCommit ? C.green : C.red,
    },
    { text: proposal.summary, color: C.fg, wrap: 'wrap' },
  ]

  for (let i = 0; i < proposal.findings.length; i++) {
    const f = proposal.findings[i]!
    const prefix = i === cursor ? '▶ ' : '  '
    const loc = f.line != null ? `${f.file}:${f.line}` : f.file
    lines.push({ text: `${prefix}[${f.severity.toUpperCase()}] ${loc} — ${f.title}`, color: severityColor(f.severity) })
    if (i === cursor) {
      lines.push({ text: `    ${f.explanation}`, color: C.fg, wrap: 'wrap' })
      if (f.rule) lines.push({ text: `    rule: ${f.rule}`, color: C.grey, wrap: 'wrap' })
    }
  }

  lines.push({ text: `Trace: ${state.tracePath}`, color: C.grey, wrap: 'truncate' })
  lines.push({
    text: 'j/k=navigate  f=CodeClaw fix (uses finding text; suggestedPatch optional)  i=ignore  t=trace  x=dismiss',
    color: C.grey,
    wrap: 'wrap',
  })
  return lines.slice(0, maxRows)
}

// ── Git panel ─────────────────────────────────────────────────────────────────

function GitPanel({ data, cursor, pendingKey, logEntries, gitError, displayLines, totalRows, totalCols }: {
  data: GitStatusData
  cursor: number
  pendingKey: string | null
  logEntries: GitLogEntry[] | null
  gitError?: string
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

  const contentRows = Math.max(1, totalRows - 4)
  const idealOffset = Math.max(0, cursorDIdx - Math.floor(contentRows / 2))
  const scrollOffset = Math.min(idealOffset, Math.max(0, displayLines.length - contentRows))
  const visible = displayLines.slice(scrollOffset, scrollOffset + contentRows)

  const hint = gitError ? `ERROR: ${gitError}`
    : pendingKey === 'c' ? 'c=commit  Esc=cancel'
    : pendingKey === 'l' ? 'l=log  Esc=cancel'
    : 'j/k  TAB=expand  Ret=open file  s/u=stage  cc=commit  F=pull  P=push  q/Esc=close'
  const hintColor: ThemeColor = gitError ? C.red : C.grey

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.magenta} paddingX={1} width={totalCols} height={totalRows}>
      <Box flexDirection="row" gap={2}>
        <Text bold color={C.magenta}>*git*</Text>
        <Text bold color={C.cyan}>{data.branch}</Text>
        <Text color={hintColor}>{hint}</Text>
      </Box>
      {visible.map((line, i) => {
        const actualIdx = i + scrollOffset
        const isCursor = actualIdx === cursorDIdx && cursorDIdx >= 0

        if (line.type === 'blank') return <Text key={actualIdx}>{' '}</Text>

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
        else if (line.type === 'log-entry') { color = C.grey }

        return (
          <Box key={actualIdx} flexDirection="row">
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

// ── Dired panel (Evil `dired-jump` / vim-style h l) ───────────────────────────

function DiredPanel({ path, cursor, totalRows, totalCols, entries }: {
  path: string
  cursor: number
  totalRows: number
  totalCols: number
  entries: DiredEntry[]
}) {
  const maxIdx = Math.max(0, entries.length - 1)
  const safeCursor = Math.min(cursor, maxIdx)
  const contentRows = Math.max(1, totalRows - 4)
  const idealOffset = Math.max(0, safeCursor - Math.floor(contentRows / 2))
  const scrollOffset = Math.min(idealOffset, Math.max(0, entries.length - contentRows))
  const visible = entries.slice(scrollOffset, scrollOffset + contentRows)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.blue} paddingX={1} width={totalCols} height={totalRows}>
      <Box flexDirection="row" gap={2}>
        <Text bold color={C.cyan}>*dired*</Text>
        <Text color={C.grey} wrap="truncate">{path}</Text>
      </Box>
      {visible.map((e, i) => {
        const idx = scrollOffset + i
        const isCur = idx === safeCursor
        const suffix = e.isDir ? '/' : ''
        return (
          <Box key={`${e.fullPath}:${idx}`} flexDirection="row">
            <Text color={isCur ? C.cyan : C.grey}>{isCur ? '>' : ' '}</Text>
            <Text color={e.isDir ? C.blue : C.fg} bold={e.isDir} wrap="truncate">{`${e.name}${suffix}`}</Text>
          </Box>
        )
      })}
      <Text color={C.grey}>h=parent  l/Ret=open  j/k=nav  q/Esc=close</Text>
    </Box>
  )
}

// ── Editor pane ───────────────────────────────────────────────────────────────

type EditorPaneProps = {
  filename?: string
  snapshot: Snapshot | null
  status: string
  bufferName: string
  bufferIndex: number
  bufferCount: number
  buffers: EditorBuffer[]
  activeBufferId: string
  prompt: PromptState | null
  ghostText: string | null
  mode: EditorMode
  scrollOffset: number
  panelRows: number
  paneHeight: number
  paneWidth?: number
  panel: Panel
  sel: SelBounds | null
  searchQuery: string
  cmdBuf: string
  searchBuf: string
}

function EditorPane({
  filename, snapshot, status, bufferName, bufferIndex, bufferCount, buffers, prompt,
  activeBufferId, ghostText, mode, scrollOffset, panelRows, paneWidth, panel,
  paneHeight, sel, searchQuery, cmdBuf, searchBuf,
}: EditorPaneProps) {
  const lines  = snapshot?.lines  ?? ['']
  const cursor = snapshot?.cursor ?? { row: 0, col: 0 }
  const title  = snapshot?.filename ?? filename ?? bufferName
  const dirty  = snapshot?.dirty ?? false
  const diagnosticCount = snapshot?.diagnostics?.length ?? 0
  const matchCount = searchQuery ? findMatches(lines, searchQuery).length : 0

  const totalRows = process.stdout.rows ?? 24
  const totalCols = process.stdout.columns ?? 80
  const effectiveCols = paneWidth ?? totalCols
  const headerBarW = Math.max(24, effectiveCols - 4)
  const titleMax = Math.max(12, headerBarW - 46)
  const pathShown = editorHeaderPath(title, titleMax)
  const metaShown = editorHeaderMeta(status, searchQuery, matchCount, headerBarW)
  const visibleRows = Math.max(1, paneHeight - 5)
  const lineNumWidth = Math.max(2, String(Math.max(1, lines.length)).length)
  const lineGutterCols = lineNumWidth + 1
  const visibleCols = Math.max(20, effectiveCols - 4 - lineGutterCols)
  const visibleLines = lines.slice(scrollOffset, scrollOffset + visibleRows)

  const modeLabel = mode.toUpperCase()
  const modeColor = mode === 'insert' ? C.green
                  : mode === 'visual'  ? C.magenta
                  : mode === 'command' || mode === 'search' ? C.yellow
                  : C.cyan
  const borderColor = (panel?.type === 'shell' || panel?.type === 'dired' || (panel?.type === 'ai' && !panel.focused))
    ? C.grey
    : C.blue

  let hintLine: string
  if (prompt?.type === 'file') {
    hintLine = `Find file: ${prompt.query}_`
  } else if (prompt?.type === 'saveAs') {
    hintLine = `Save as: ${prompt.query}_`
  } else if (prompt?.type === 'buffer') {
    hintLine = `Switch buffer: ${prompt.query}_`
  } else if (prompt?.type === 'commit') {
    hintLine = `Commit: ${prompt.message}_`
  } else if (mode === 'command') {
    hintLine = `:${cmdBuf}_`
  } else if (mode === 'search') {
    hintLine = `/${searchBuf}_  Enter=normal  i/a/I/A/o/O=find & insert  Esc=cancel`
  } else if (mode === 'insert') {
    hintLine = 'Tab=complete  Esc=normal'
  } else if (mode === 'visual') {
    hintLine = 'y=yank  d=delete  o=swap  v=expand  V=contract  hjkl/arrows=extend  Esc=normal'
  } else {
    hintLine = 'SPC=menu  v=expand-region  V=line-visual  -=dired  [/]=block  i=insert  /=search  :=cmd'
  }

  const sortedBuffers = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  const filteredBuffers = prompt?.type === 'buffer'
    ? filterBuffers(sortedBuffers, prompt.query)
    : []
  const visibleBuffers = filteredBuffers.slice(0, 8)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1} width={paneWidth} height={paneHeight}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text bold color={modeColor}>{`[${modeLabel}]`}</Text>
          <Text bold color={C.magenta}>qe</Text>
          <Text color={dirty ? C.orange : C.fg}>{`${pathShown}${dirty ? ' *' : ''}`}</Text>
          <Text color={C.grey}>{`${bufferIndex + 1}/${bufferCount}`}</Text>
          <Text color={C.grey}>{`${cursor.row + 1}:${cursor.col + 1}`}</Text>
          {diagnosticCount > 0 && <Text color={C.orange}>{`diag ${diagnosticCount}`}</Text>}
        </Box>
        <Box flexDirection="row">
          <Text color={searchQuery ? C.yellow : C.grey}>{metaShown}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {prompt?.type === 'buffer' && (
          <Box flexDirection="column">
            {visibleBuffers.length === 0
              ? <Text color={C.grey}>  no matching buffers</Text>
              : visibleBuffers.map((buffer, index) => {
                  const actualIndex = filteredBuffers.indexOf(buffer)
                  const selected = actualIndex === prompt.selected
                  const filenameLabel = buffer.snapshot?.filename ?? buffer.filename ?? ''
                  const mark = buffer.id === activeBufferId ? '>' : ' '
                  const mod = isDirty(buffer) ? '*' : ' '
                  return (
                    <Text key={buffer.id} color={selected ? C.bg : C.fg} backgroundColor={selected ? C.cyan : undefined}>
                      {`${mark}${mod} ${buffer.name}${filenameLabel ? `  ${filenameLabel}` : ''}`}
                    </Text>
                  )
                })}
            <Text color={C.grey}>{' '}</Text>
          </Box>
        )}
        {visibleLines.map((line, index) => {
          const actualRow = index + scrollOffset
          const isCursor  = actualRow === cursor.row
          const lineNum   = String(actualRow + 1).padStart(lineNumWidth, ' ')
          const cropped   = line.slice(0, visibleCols)
          const clippedSel = sel ? {
            ...sel,
            startCol: Math.min(sel.startCol, visibleCols),
            endCol:   Math.min(sel.endCol,   visibleCols),
          } : null
          const segs = lineSegs(cropped, actualRow, cursor, mode, clippedSel, searchQuery, ghostText, snapshot?.tokens)

          return (
            <Box key={index} flexDirection="row">
              <Text color={isCursor ? modeColor : C.grey}>{`${lineNum} `}</Text>
              {segs.map((s, si) => (
                <Text key={si} color={s.fg} backgroundColor={s.bg}>{s.text}</Text>
              ))}
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text color={prompt || mode === 'command' || mode === 'search' ? C.yellow : C.grey}>
          {hintLine}
        </Text>
      </Box>
    </Box>
  )
}

// ── Main app component ────────────────────────────────────────────────────────

function App({
  buffers, activeId, bufferKey, sidecar, shell, shellLines, userLeader, actions,
}: {
  buffers: EditorBuffer[]
  activeId: string
  bufferKey: number
  sidecar: QeSidecar
  shell: ShellSidecar
  shellLines: ShellLine[]
  userLeader: LeaderTree
  actions: {
    openFile: (path: string, jump?: { row: number; col: number }) => void
    switchBuffer: (id: string) => void
    killBuffer: (id?: string) => void
    nextBuffer: () => void
    previousBuffer: () => void
    newScratch: () => void
    quitAll: () => void
    reloadConfig: () => Promise<void>
    openConfig: () => void
  }
}) {
  const activeIndex = Math.max(0, buffers.findIndex(buffer => buffer.id === activeId))
  const activeBuffer = buffers[activeIndex] ?? buffers[0]!
  const snapshot = activeBuffer.snapshot
  const status = activeBuffer.status
  const filename = activeBuffer.snapshot?.filename ?? activeBuffer.filename ?? undefined

  const [mode,           setMode]           = React.useState<EditorMode>('normal')
  const [ghostText,      setGhostText]      = React.useState<string | null>(null)
  const [scrollOffset,   setScrollOffset]   = React.useState(0)
  const [panel,          setPanel]          = React.useState<Panel>(null)
  const [visualAnchor,   setVisualAnchor]   = React.useState<{ row: number; col: number } | null>(null)
  const [visualLineMode, setVisualLineMode] = React.useState(false)
  /** Stack of selections before each expand (contract pops). Not react state — avoids stale handlers. */
  const visualExpandHistoryRef = React.useRef<VisualSnap[]>([])
  const [cmdBuf,         setCmdBuf]         = React.useState('')
  const [searchBuf,      setSearchBuf]      = React.useState('')
  const [searchQuery,    setSearchQuery]    = React.useState('')
  const [prompt,         setPrompt]         = React.useState<PromptState | null>(null)

  const [aiMessages,     setAiMessages]     = React.useState<AiMessage[]>([])
  const [aiInput,        setAiInput]        = React.useState('')
  const [aiStreaming,    setAiStreaming]     = React.useState(false)
  const [aiScrollOffset, setAiScrollOffset] = React.useState(0)
  const [fixState, setFixState] = React.useState<CodeClawFixState>({ status: 'idle' })
  const [reviewState, setReviewState] = React.useState<ReviewState>({ status: 'idle' })
  const [thinkingTick, setThinkingTick] = React.useState(0)
  const [shellInput, setShellInput] = React.useState('')
  const [shellRunning, setShellRunning] = React.useState(false)

  const aiPanelBusy =
    aiStreaming
    || fixState.status === 'generating'
    || fixState.status === 'applying'
    || reviewState.status === 'generating'

  React.useEffect(() => {
    if (!aiPanelBusy) return
    const id = setInterval(() => setThinkingTick(t => (t + 1) % 4096), 90)
    return () => clearInterval(id)
  }, [aiPanelBusy])

  const pendingKeyRef    = React.useRef<string | null>(null)
  const yankRegisterRef  = React.useRef<string | null>(null)
  const abortRef         = React.useRef<AbortController | null>(null)
  const aiAbortRef       = React.useRef<AbortController | null>(null)
  const searchQueryRef   = React.useRef('')
  const searchIdxRef     = React.useRef(0)

  const enterNormal = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setGhostText(null)
    setPrompt(null)
    pendingKeyRef.current = null
    setPanel(prev => prev?.type === 'ai' ? { type: 'ai', focused: false } : null)
    setMode('normal')
    setVisualAnchor(null)
    setVisualLineMode(false)
    visualExpandHistoryRef.current = []
    setCmdBuf('')
    setSearchBuf('')
  }, [])

  const saveCurrentBuffer = React.useCallback(() => {
    const path = snapshot?.filename ?? activeBuffer.filename ?? null
    if (path) {
      sidecar.save()
      return
    }
    enterNormal()
    setPrompt({ type: 'saveAs', query: '', thenQuit: false })
  }, [activeBuffer.filename, enterNormal, sidecar, snapshot?.filename])

  const saveBufferAndQuit = React.useCallback(() => {
    const path = snapshot?.filename ?? activeBuffer.filename ?? null
    if (path) {
      sidecar.save()
      actions.quitAll()
      return
    }
    enterNormal()
    setPrompt({ type: 'saveAs', query: '', thenQuit: true })
  }, [actions, activeBuffer.filename, enterNormal, sidecar, snapshot?.filename])

  // Reset editor state whenever the active buffer changes
  React.useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setGhostText(null)
    setPrompt(null)
    pendingKeyRef.current = null
    setMode('normal')
    setVisualAnchor(null)
    setVisualLineMode(false)
    visualExpandHistoryRef.current = []
    setCmdBuf('')
    setSearchBuf('')
    setSearchQuery('')
    searchQueryRef.current = ''
    searchIdxRef.current = 0
    setScrollOffset(0)
    setAiScrollOffset(0)
    setPanel(prev => prev?.type === 'ai' ? { type: 'ai', focused: false } : null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferKey])

  // Parse first navigable location from last AI response (recomputed when streaming ends)
  const aiNavLoc = React.useMemo<ParsedLocation | null>(() => {
    if (aiStreaming) return null
    const last = aiMessages[aiMessages.length - 1]
    if (last?.role === 'assistant' && last.content) return extractFirstLocation(last.content)
    return null
  }, [aiStreaming, aiMessages])

  // Parse first code block from last AI response — offered as a shell command via !
  const aiShellCmd = React.useMemo<string | null>(() => {
    if (aiStreaming) return null
    const last = aiMessages[aiMessages.length - 1]
    if (last?.role === 'assistant' && last.content) return extractFirstCodeBlock(last.content)
    return null
  }, [aiStreaming, aiMessages])

  const bufferInfos = React.useMemo(
    () => buffers.map(buffer => toBufferInfo(buffer, activeId)),
    [buffers, activeId],
  )

  const makeCtx = React.useCallback((): EditorContext => ({
      filename: snapshot?.filename ?? null,
      lines:    snapshot?.lines   ?? [],
      cursor:   snapshot?.cursor  ?? { row: 0, col: 0 },
      save:     saveCurrentBuffer,
      quit:     actions.quitAll,
      insert:   (text) => sidecar.insert(text),
      move:     (dir) => sidecar.move(dir as Parameters<QeSidecar['move']>[0]),
      shell:    { run: (cmd) => { void shell.runTracked(cmd) }, lines: () => shellLines.map(l => l.text) },
      buffers: {
        list: () => bufferInfos,
        current: () => bufferInfos.find(buffer => buffer.active) ?? null,
        switch: actions.switchBuffer,
        kill: actions.killBuffer,
        next: actions.nextBuffer,
        previous: actions.previousBuffer,
      },
      openFile: actions.openFile,
    }), [actions, bufferInfos, saveCurrentBuffer, shell, shellLines, sidecar, snapshot])

  const leaderMap = React.useMemo(() => buildLeaderMap(
    { save: saveCurrentBuffer, saveAndQuit: saveBufferAndQuit },
    setPanel as (v: unknown) => void,
    {
      openSwitcher: () => {
        enterNormal()
        const sorted = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        const selected = Math.max(0, sorted.findIndex(buffer => buffer.id === activeId))
        setPrompt({ type: 'buffer', query: '', selected })
      },
      openFilePrompt: () => {
        enterNormal()
        setPrompt({ type: 'file', query: '' })
      },
      next: actions.nextBuffer,
      previous: actions.previousBuffer,
      kill: () => actions.killBuffer(activeId),
      newScratch: actions.newScratch,
      quitAll: actions.quitAll,
    },
    {
      openChat: () => setPanel({ type: 'ai', focused: true }),
      triggerCompletion: () => triggerCompletion(),
      explainError: () => explainLastError(),
      fixFailure: () => runCodeClawFix(),
      showTrace: () => showLastTrace(),
      rerunLast: () => {
        const last = shell.lastRun
        if (!last) return
        void shell.runTracked(last.command)
        setPanel({ type: 'shell' })
      },
      review: () => runCodeClawReview(),
    },
    {
      open: openGitPanel,
      stage: stageCurrentFile,
    },
    {
      hover: () => {
        const cursor = snapshot?.cursor ?? { row: 0, col: 0 }
        sidecar.hover(cursor.row, cursor.col)
      },
      definition: () => {
        const cursor = snapshot?.cursor ?? { row: 0, col: 0 }
        sidecar.goToDefinition(cursor.row, cursor.col)
      },
    },
    {
      open:   actions.openConfig,
      reload: () => { void actions.reloadConfig() },
    },
    {
      testFile: () => {
        const file = snapshot?.filename ?? null
        const script = findNearestTestScript(file)
        if (!script) return
        void shell.runTracked(script)
        setPanel({ type: 'shell' })
      },
      testAll: () => {
        const script = findNearestTestScript(snapshot?.filename ?? null)
        if (!script) return
        void shell.runTracked(script)
        setPanel({ type: 'shell' })
      },
    },
    userLeader,
    makeCtx,
  ), [actions, activeId, buffers, makeCtx, saveBufferAndQuit, saveCurrentBuffer, shell, snapshot, userLeader])

  const totalRows  = process.stdout.rows    || 24
  const totalCols  = process.stdout.columns || 80
  const shellRows  = Math.floor(totalRows * 0.3)

  React.useEffect(() => {
    if (!snapshot) return
    const vh = Math.max(1, totalRows - 8)
    setScrollOffset(prev => {
      const row = snapshot.cursor.row
      if (row < prev) return row
      if (row >= prev + vh) return row - vh + 1
      return prev
    })
  }, [snapshot, totalRows])

  function sendAiMessage(overrideText?: string) {
    const text = (overrideText ?? aiInput).trim()
    if (!text || aiStreaming) return
    if (!overrideText) setAiInput('')

    const userMsg: AiMessage = { role: 'user', content: text }
    setAiMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setAiStreaming(true)
    setAiScrollOffset(0)

    aiAbortRef.current?.abort()
    const ctrl = new AbortController()
    aiAbortRef.current = ctrl

    const { rules, memory } = loadCodeClawProject(process.cwd())
    const ctx: AiContext = {
      filename:      snapshot?.filename ?? null,
      lines:         snapshot?.lines    ?? [],
      cursor:        snapshot?.cursor   ?? { row: 0, col: 0 },
      shellLines,
      shellSessions: shell.sessions,
      gitContext:    getGitContext(),
      openBuffers:   buffers.map(b => b.snapshot?.filename ?? b.filename ?? b.name),
      projectRules:  rules  || undefined,
      projectMemory: memory || undefined,
    }

    void (async () => {
      try {
        for await (const chunk of streamChat([...aiMessages, userMsg], ctx, ctrl.signal)) {
          setAiMessages(prev => {
            const msgs = [...prev]
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, content: last.content + chunk }
            }
            return msgs
          })
        }
      } catch (err) {
        if (ctrl.signal.aborted) {
          // Remove the trailing assistant bubble only if it received no content
          setAiMessages(prev => {
            const last = prev[prev.length - 1]
            return last?.role === 'assistant' && !last.content ? prev.slice(0, -1) : prev
          })
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          setAiMessages(prev => {
            const msgs = [...prev]
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant' && !last.content) {
              msgs[msgs.length - 1] = { role: 'assistant', content: `[Error: ${msg}]`, error: true }
            } else {
              msgs.push({ role: 'assistant', content: `[Error: ${msg}]`, error: true })
            }
            return msgs
          })
        }
      }
      setAiStreaming(false)
      setAiScrollOffset(0)
    })()
  }

  function explainLastError() {
    const lastErr = shell.lastError ?? shell.lastFailedRun
    const text = lastErr
      ? [
          `Explain and fix this shell error:`,
          ``,
          `Command: \`${lastErr.command}\``,
          ``,
          `Errors:`,
          ...lastErr.stderr.split('\n').filter(Boolean),
          ``,
          `Output (last 20 lines):`,
          ...lastErr.stdout.split('\n').slice(-20),
        ].join('\n')
      : 'No shell error detected yet. What can I help with?'
    setPanel({ type: 'ai', focused: false })
    sendAiMessage(text)
  }

  function syntheticReviewFindingRun(finding: ReviewFinding): ShellRun {
    const now = new Date().toISOString()
    const cwd = process.cwd()
    let locPath = finding.file.trim()
    if (locPath && !locPath.startsWith('/')) {
      try {
        locPath = resolvePath(cwd, locPath)
      } catch {
        /* keep locPath */
      }
    }
    const locations: ParsedLocation[] =
      finding.line != null && locPath
        ? [{ file: locPath, row: Math.max(0, finding.line - 1), col: 0, message: finding.title }]
        : []
    const patchNote = finding.suggestedPatch?.trim()
      ? `\n\nSuggested unified diff:\n${finding.suggestedPatch}`
      : ''
    return {
      id: `codeclaw-review-${now}`,
      command: 'codeclaw-review',
      cwd,
      startedAt: now,
      endedAt: now,
      exitCode: 1,
      stdout: '',
      stderr: `[${finding.severity.toUpperCase()}] ${finding.title}\n${finding.explanation}${finding.rule ? `\nRule: ${finding.rule}` : ''}${patchNote}`,
      locations,
    }
  }

  function buildFixContext(userRequest: string, previous?: FixContext, syntheticFailure?: ShellRun): FixContext | null {
    const lastFailedRun = syntheticFailure ?? shell.lastFailedRun ?? previous?.lastFailedRun
    if (!lastFailedRun) return null

    const project = loadCodeClawProject(process.cwd())
    const activePath = snapshot?.filename ?? activeBuffer.filename ?? '*scratch*'
    const activeContent = snapshot?.lines.join('\n') ?? ''

    return {
      activeFile: {
        path: activePath,
        content: activeContent,
        cursor: snapshot?.cursor
          ? { line: snapshot.cursor.row + 1, column: snapshot.cursor.col + 1 }
          : undefined,
      },
      openBuffers: buffers
        .filter(buffer => buffer.snapshot?.filename || buffer.filename)
        .map(buffer => ({
          path: buffer.snapshot?.filename ?? buffer.filename ?? buffer.name,
          content: buffer.snapshot?.lines.join('\n') ?? '',
        })),
      lastFailedRun,
      git: collectGitContext(process.cwd()),
      rules: project.rules,
      memory: project.memory,
      userRequest,
    }
  }

  function runCodeClawFix(
    userRequest = 'Fix this failure using current session context.',
    previous?: FixContext,
    reviewFinding?: ReviewFinding,
  ) {
    const synthetic = reviewFinding ? syntheticReviewFindingRun(reviewFinding) : undefined
    const context = buildFixContext(userRequest, previous, synthetic)
    if (!context) {
      setFixState({
        status: 'error',
        message: reviewFinding
          ? 'Could not build fix context from this finding (internal error).'
          : 'No failed tracked shell run yet. Run a command from the shell pane first.',
      })
      setPanel({ type: 'ai', focused: false })
      return
    }

    const startedAt = new Date().toISOString()
    const traceId = makeTraceId(new Date(startedAt))
    setFixState({ status: 'generating', traceId, startedAt, context })
    setPanel({ type: 'ai', focused: false })
    setAiStreaming(true)

    aiAbortRef.current?.abort()
    const ctrl = new AbortController()
    aiAbortRef.current = ctrl

    void (async () => {
      try {
        const tasks = loadTasks(process.cwd())
        const proposal = await generatePatchProposal(context, ctrl.signal, tasks)
        setFixState({ status: 'proposal', traceId, startedAt, context, proposal, risk: assessPatchRisk(proposal), mediumConfirm: false })
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        const trace = buildTrace(traceId, startedAt, context, null, false, undefined, message)
        const tracePath = writeTrace(process.cwd(), trace)
        setFixState({ status: 'error', message, tracePath })
      } finally {
        setAiStreaming(false)
      }
    })()
  }

  function runCodeClawReview() {
    const cwd = process.cwd()
    const gitCtx = collectGitContext(cwd)
    const activeFile = snapshot?.filename ?? ''
    const { rules } = loadCodeClawProjectForReview(cwd, activeFile)
    const openBuffers = buffers.map(b => b.filename ?? b.id)

    const traceId = makeReviewTraceId()
    const startedAt = new Date().toISOString()

    setReviewState({ status: 'generating' })
    setPanel({ type: 'ai', focused: false })
    setAiStreaming(true)

    aiAbortRef.current?.abort()
    const ctrl = new AbortController()
    aiAbortRef.current = ctrl

    void (async () => {
      const diff = [gitCtx.diff, gitCtx.status].filter(Boolean).join('\n')
      try {
        const proposal = await generateReviewProposal(diff, rules, activeFile, openBuffers, ctrl.signal)
        const endedAt = new Date().toISOString()
        const trace = buildReviewTrace({
          id: traceId,
          startedAt,
          endedAt,
          gitBranch: gitCtx.branch,
          activeFile,
          openBuffers,
          diffChars: diff.length,
          gitDiffPreview: diff.slice(0, 12000),
          status: 'ok',
          proposal,
        })
        const tracePath = writeReviewTrace(cwd, trace)
        setReviewState({ status: 'findings', proposal, cursor: 0, tracePath })
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        const endedAt = new Date().toISOString()
        const trace = buildReviewTrace({
          id: traceId,
          startedAt,
          endedAt,
          gitBranch: gitCtx.branch,
          activeFile,
          openBuffers,
          diffChars: diff.length,
          gitDiffPreview: diff.slice(0, 12000),
          status: 'error',
          proposal: null,
          error: message,
        })
        const tracePath = writeReviewTrace(cwd, trace)
        setReviewState({ status: 'error', message, tracePath })
      } finally {
        setAiStreaming(false)
      }
    })()
  }

  function rejectCodeClawFix() {
    if (fixState.status !== 'proposal' && fixState.status !== 'editing') return
    const trace = buildTrace(fixState.traceId, fixState.startedAt, fixState.context, fixState.proposal, false)
    const tracePath = writeTrace(process.cwd(), trace)
    setFixState({ status: 'done', message: 'Patch rejected. No files changed.', tracePath })
  }

  function acceptCodeClawFix() {
    if (fixState.status !== 'proposal') return
    const { traceId, startedAt, context, proposal, risk } = fixState
    if (!risk.canAutoApply) return
    if (risk.requiresConfirm && !fixState.mediumConfirm) {
      setFixState({ ...fixState, mediumConfirm: true })
      return
    }
    setFixState({ status: 'applying', traceId, startedAt, context, proposal, risk })

    void (async () => {
      const applied = applyPatchProposal(process.cwd(), proposal)
      if (!applied.ok) {
        const trace = buildTrace(traceId, startedAt, context, proposal, true, undefined, applied.error)
        const tracePath = writeTrace(process.cwd(), trace)
        setFixState({ status: 'error', message: applied.error, tracePath })
        return
      }

      const activePath = snapshot?.filename ?? activeBuffer.filename
      if (activePath && proposal.files.some(file => resolvePath(file.path) === resolvePath(activePath))) {
        sidecar.open(activePath)
      }

      const tasks = loadTasks(process.cwd())
      const verifyCommand = resolveTaskCommand(proposal.verifyTask, tasks)
        ?? (proposal.verifyTask.includes(' ') ? proposal.verifyTask : null)
        ?? context.lastFailedRun.command
      const verify = await shell.runTracked(verifyCommand)
      const result: VerifyResult = { run: verify }
      const trace = buildTrace(traceId, startedAt, context, proposal, true, result)
      const tracePath = writeTrace(process.cwd(), trace)
      const passed = result.run.exitCode === 0
      setFixState({
        status: 'done',
        message: passed
          ? `Verification passed: ${result.run.command}`
          : `Verification failed${result.run.exitCode === undefined ? '' : ` with exit ${result.run.exitCode}`}: ${result.run.command}`,
        tracePath,
        verify: result,
      })
      setPanel({ type: 'shell' })
    })()
  }

  function showLastTrace() {
    setFixState({ status: 'trace', latest: readLatestTrace(process.cwd()) })
    setPanel({ type: 'ai', focused: false })
  }

  function openGitPanel() {
    const data = loadGitStatus(process.cwd())
    setPanel({ type: 'git', data, cursor: 0, pendingKey: null, logEntries: null, gitError: undefined })
  }

  function stageCurrentFile() {
    if (snapshot?.filename) {
      spawnSync('git', ['add', '--', snapshot.filename], { cwd: getGitRepoRoot(process.cwd()), timeout: 3000 })
      setPanel(prev => prev?.type === 'git'
        ? { ...prev, data: loadGitStatus(process.cwd()), cursor: 0 }
        : prev)
    }
  }

  function triggerCompletion() {
    if (!snapshot) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setGhostText('')
    void (async () => {
      try {
        let acc = ''
        for await (const chunk of streamCompletion(
          snapshot.filename, snapshot.lines, snapshot.cursor, controller.signal, shellLines,
        )) {
          acc += chunk
          setGhostText(acc)
        }
      } catch { setGhostText(null) }
    })()
  }

  function executeCommand(cmd: string) {
    const t = cmd.trim()
    if (t === 'w' || t === 'write')         { saveCurrentBuffer() }
    else if (t === 'q' || t === 'quit')     { actions.quitAll() }
    else if (t === 'wq' || t === 'x')       { saveBufferAndQuit() }
    else if (t === 'q!')                    { actions.quitAll() }
    else if (t.startsWith('e ') && t.length > 2) {
      actions.openFile(t.slice(2).trim())
    } else if (t.startsWith('!') && t.length > 1) {
      void shell.runTracked(t.slice(1))
      setPanel({ type: 'shell' })
    }
  }

  function jumpToMatch(delta: number) {
    const lines = snapshot?.lines ?? []
    const matches = findMatches(lines, searchQueryRef.current)
    if (!matches.length) return
    const idx = ((searchIdxRef.current + delta) % matches.length + matches.length) % matches.length
    searchIdxRef.current = idx
    const m = matches[idx]!
    sidecar.moveTo(m.row, m.col)
  }

  const clearSearchHighlights = React.useCallback(() => {
    setSearchQuery('')
    searchQueryRef.current = ''
    searchIdxRef.current = -1
  }, [])

  useInput((input, key) => {
    if (key.ctrl && input === 'q') { actions.quitAll(); return }
    if (key.ctrl && input === 't') {
      setPanel(prev => prev?.type === 'shell' ? null : { type: 'shell' })
      return
    }

    // ── Command palette ───────────────────────────────────────────────────────
    if (panel?.type === 'cmdpalette') {
      if (key.escape) { setPanel(null); return }
      if (key.return) {
        const { items, query, cursor } = panel
        const filtered = query
          ? items.filter(it => it.label.toLowerCase().includes(query.toLowerCase()) || it.keys.includes(query))
          : items
        const item = filtered[cursor % Math.max(1, filtered.length)]
        if (item) { item.action(); setPanel(null) }
        return
      }
      if (input === 'j' && !panel.query) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: prev.cursor + 1 } : prev)
        return
      }
      if (input === 'k' && !panel.query) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : prev)
        return
      }
      if (key.downArrow) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: prev.cursor + 1 } : prev)
        return
      }
      if (key.upArrow) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : prev)
        return
      }
      if (key.backspace || key.delete) {
        setPanel(prev => prev?.type === 'cmdpalette'
          ? { ...prev, query: prev.query.slice(0, -1), cursor: 0 }
          : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPanel(prev => prev?.type === 'cmdpalette'
          ? { ...prev, query: prev.query + input, cursor: 0 }
          : prev)
        return
      }
      return
    }

    // ── Which-key panel ──────────────────────────────────────────────────────
    if (panel?.type === 'whichkey') {
      if (key.escape) { setPanel(null); return }
      const entry = panel.node[input]
      if (!entry) { setPanel(null); return }
      if (isLeafAction(entry)) { entry(); setPanel(prev => prev?.type === 'whichkey' ? null : prev); return }
      setPanel({ type: 'whichkey', node: entry as LeaderNode, path: panel.path + input + ' ' })
      return
    }

    // ── AI panel (unfocused) — review findings navigation ────────────────────
    if (panel?.type === 'ai' && !panel.focused && reviewState.status === 'findings') {
      if (input === 'j') {
        setReviewState(s => s.status === 'findings' ? { ...s, cursor: Math.min(s.cursor + 1, s.proposal.findings.length - 1) } : s)
        return
      }
      if (input === 'k') {
        setReviewState(s => s.status === 'findings' ? { ...s, cursor: Math.max(s.cursor - 1, 0) } : s)
        return
      }
      if (input === 'i') {
        setReviewState(s => s.status === 'findings' ? { ...s, cursor: Math.min(s.cursor + 1, s.proposal.findings.length - 1) } : s)
        return
      }
      if (input === 'f') {
        const finding = reviewState.proposal.findings[reviewState.cursor]
        if (!finding) return
        const request = [
          'Fix this CodeClaw review finding using the current buffers and git context.',
          finding.suggestedPatch?.trim()
            ? `Prefer applying or refining this suggested unified diff:\n${finding.suggestedPatch}`
            : `Finding: ${finding.title}`,
          finding.explanation,
          finding.rule ? `Rule reference: ${finding.rule}` : '',
        ].filter(Boolean).join('\n\n')
        runCodeClawFix(request, undefined, finding)
        return
      }
      if (input === 't') { showLastTrace(); return }
      if (input === 'x') { setReviewState({ status: 'idle' }); return }
    }

    // ── AI panel (unfocused) — dismiss fixState overlay + scroll chat ────────
    if (panel?.type === 'ai' && !panel.focused) {
      if (input === 'x' && (fixState.status !== 'idle' || reviewState.status !== 'idle')) {
        setFixState({ status: 'idle' })
        setReviewState({ status: 'idle' })
        return
      }
      if (input === '!' && aiShellCmd) {
        if (shell.mode === 'runner') {
          setShellInput(aiShellCmd)
        } else {
          shell.write(aiShellCmd)
        }
        setPanel({ type: 'shell' })
        return
      }
      if (reviewState.status === 'idle') {
        if (input === 'j') {
          setAiScrollOffset(prev => Math.max(0, prev - 1))
          return
        }
        if (input === 'k') {
          setAiScrollOffset(prev => prev + 1)
          return
        }
      }
    }

    // ── AI panel (focused) ───────────────────────────────────────────────────
    if (panel?.type === 'ai' && fixState.status === 'proposal' && !aiStreaming) {
      if (input === 'a') { acceptCodeClawFix(); return }
      if (input === 'r') { rejectCodeClawFix(); return }
      if (input === 'e') {
        setFixState({ ...fixState, status: 'editing' })
        setAiInput(fixState.context.userRequest)
        setPanel({ type: 'ai', focused: true })
        return
      }
    }

    if (panel?.type === 'ai' && panel.focused) {
      if (key.escape)                                  { setPanel({ type: 'ai', focused: false }); return }
      if (key.ctrl && input === 'c')                   { aiAbortRef.current?.abort(); setAiStreaming(false); return }
      if (input === '!' && !aiInput && aiShellCmd) {
        if (shell.mode === 'runner') {
          setShellInput(aiShellCmd)
        } else {
          shell.write(aiShellCmd)
        }
        setPanel({ type: 'shell' })
        return
      }
      if (key.tab) {
        if (aiNavLoc) { actions.openFile(aiNavLoc.file, { row: aiNavLoc.row, col: aiNavLoc.col }); setPanel({ type: 'ai', focused: false }) }
        return
      }
      if (key.return) {
        if (fixState.status === 'editing') {
          const request = aiInput.trim() || fixState.context.userRequest
          setAiInput('')
          runCodeClawFix(request, fixState.context)
        } else {
          sendAiMessage()
        }
        return
      }
      if (key.backspace || key.delete)                 { setAiInput(prev => prev.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && printable(input))  { setAiInput(prev => prev + input); return }
      return
    }

    // ── Git panel ────────────────────────────────────────────────────────────
    if (panel?.type === 'git') {
      const displayLines = buildGitDisplayLines(panel.data, panel.logEntries)
      const selectables: Array<{ line: Extract<GitDisplayLine, { selectable: true }>; i: number }> = []
      for (let i = 0; i < displayLines.length; i++) {
        const l = displayLines[i]!
        if (l.selectable) selectables.push({ line: l as Extract<GitDisplayLine, { selectable: true }>, i })
      }
      const cursorEntry = selectables[Math.min(panel.cursor, Math.max(0, selectables.length - 1))]?.line ?? null

      if (panel.pendingKey !== null) {
        const pk = panel.pendingKey
        setPanel(prev => prev?.type === 'git' ? { ...prev, pendingKey: null } : prev)
        if (pk === 'c' && input === 'c') {
          setPanel(null)
          setPrompt({ type: 'commit', message: '' })
          return
        }
        if (pk === 'l' && input === 'l') {
          const logEntries = getGitLog(process.cwd(), 20)
          setPanel(prev => prev?.type === 'git' ? { ...prev, logEntries } : prev)
          return
        }
        return
      }

      if (key.escape || input === 'q') { setPanel(null); return }
      if (input === 'g' || input === 'r') { openGitPanel(); return }

      if (input === 'j') {
        setPanel(prev => prev?.type === 'git'
          ? { ...prev, cursor: Math.min(Math.max(0, selectables.length - 1), prev.cursor + 1) }
          : prev)
        return
      }
      if (input === 'k') {
        setPanel(prev => prev?.type === 'git'
          ? { ...prev, cursor: Math.max(0, prev.cursor - 1) }
          : prev)
        return
      }

      if (key.tab) {
        if (cursorEntry?.type === 'file') {
          const entry = cursorEntry.entry
          const hunks = (!entry.expanded && entry.hunks.length === 0)
            ? loadFileHunks(process.cwd(), entry.path, entry.section)
            : entry.hunks
          setPanel(prev => {
            if (prev?.type !== 'git') return prev
            const update = (es: GitFileEntry[]) =>
              updateGitEntry(es, entry.path, e => ({ ...e, expanded: !e.expanded, hunks }))
            return { ...prev, data: { ...prev.data, untracked: update(prev.data.untracked), unstaged: update(prev.data.unstaged), staged: update(prev.data.staged) } }
          })
        }
        return
      }

      if (key.return) {
        const cwd = process.cwd()
        if (cursorEntry?.type === 'file') {
          actions.openFile(resolveRepoFilePath(cwd, cursorEntry.entry.path))
          setPanel(null)
          return
        }
        if (cursorEntry?.type === 'hunk') {
          const abs = resolveRepoFilePath(cwd, cursorEntry.entry.path)
          const row = hunkNewStartRow(cursorEntry.hunk.header)
          actions.openFile(abs, row != null ? { row, col: 0 } : undefined)
          setPanel(null)
          return
        }
        return
      }

      if (input === 's') {
        if (cursorEntry?.type === 'file')  stageEntry(process.cwd(), cursorEntry.entry)
        else if (cursorEntry?.type === 'hunk') stageEntry(process.cwd(), cursorEntry.entry, cursorEntry.hunk)
        if (cursorEntry) openGitPanel()
        return
      }
      if (input === 'u') {
        if (cursorEntry?.type === 'file')  unstageEntry(process.cwd(), cursorEntry.entry)
        else if (cursorEntry?.type === 'hunk') unstageEntry(process.cwd(), cursorEntry.entry, cursorEntry.hunk)
        if (cursorEntry) openGitPanel()
        return
      }
      if (input === 'c') { setPanel(prev => prev?.type === 'git' ? { ...prev, pendingKey: 'c' } : prev); return }
      if (input === 'l') { setPanel(prev => prev?.type === 'git' ? { ...prev, pendingKey: 'l' } : prev); return }
      if (input === 'F') {
        const result = pullGit(process.cwd())
        if (result.ok) { openGitPanel() } else { setPanel(prev => prev?.type === 'git' ? { ...prev, gitError: result.error } : prev) }
        return
      }
      if (input === 'P') {
        const result = pushGit(process.cwd())
        openGitPanel()
        if (!result.ok) { setPanel(prev => prev?.type === 'git' ? { ...prev, gitError: result.error } : prev) }
        return
      }
      return
    }

    // ── Dired panel (directory browser; mirrors Evil dired + h / l) ───────────
    if (panel?.type === 'dired') {
      const entries = readDiredEntries(panel.path)
      const maxIdx = Math.max(0, entries.length - 1)
      const cur = Math.min(panel.cursor, maxIdx)

      if (key.escape || input === 'q') {
        setPanel(null)
        return
      }
      if (input === 'h') {
        const parent = dirname(panel.path)
        if (parent !== panel.path) {
          setPanel({ type: 'dired', path: resolvePath(parent), cursor: 0 })
        }
        return
      }
      if (input === 'j' || key.downArrow) {
        setPanel({ ...panel, cursor: Math.min(maxIdx, cur + 1) })
        return
      }
      if (input === 'k' || key.upArrow) {
        setPanel({ ...panel, cursor: Math.max(0, cur - 1) })
        return
      }
      if (input === 'l' || key.return) {
        const e = entries[cur]
        if (!e) return
        if (e.isDir) {
          setPanel({ type: 'dired', path: resolvePath(e.fullPath), cursor: 0 })
        } else {
          actions.openFile(e.fullPath)
          setPanel(null)
        }
        return
      }
      return
    }

    // ── Shell panel ──────────────────────────────────────────────────────────
    if (panel?.type === 'shell') {
      if (key.escape)                                  { setPanel(null); return }
      if (shell.mode === 'runner') {
        if (key.return) {
          const cmd = shellInput.trim()
          if (!cmd || shellRunning) return
          setShellInput('')
          setShellRunning(true)
          void shell.runTracked(cmd).finally(() => setShellRunning(false))
          return
        }
        if (key.backspace || key.delete) { setShellInput(prev => prev.slice(0, -1)); return }
        if (key.ctrl && input === 'c') { shell.cancelRunner(); setShellRunning(false); return }
        if (!key.ctrl && !key.meta && printableText(input)) { setShellInput(prev => prev + input); return }
        return
      }
      if (input === 'o') {
        // jump to first parsed error location
        const loc = shell.lastLocation
        if (loc) { actions.openFile(loc.file, { row: loc.row, col: loc.col }); setPanel(null) }
        return
      }
      if (key.return)                                  { void shell.submitCurrentInput(); return }
      if (key.backspace || key.delete)                 { shell.write('\x7f'); return }
      if (key.upArrow)                                 { shell.write('\x1b[A'); return }
      if (key.downArrow)                               { shell.write('\x1b[B'); return }
      if (key.leftArrow)                               { shell.write('\x1b[D'); return }
      if (key.rightArrow)                              { shell.write('\x1b[C'); return }
      if (key.ctrl && input === 'c')                   { shell.write('\x03'); return }
      if (key.ctrl && input === 'l')                   { shell.write('\x0c'); return }
      if (key.ctrl && input === 'd')                   { shell.write('\x04'); return }
      if (!key.ctrl && !key.meta && printableText(input))  { shell.write(input); return }
      return
    }

    // ── Commit prompt ────────────────────────────────────────────────────────
    if (prompt?.type === 'commit') {
      if (key.escape) { setPrompt(null); return }
      if (key.return) {
        const msg = prompt.message.trim()
        if (msg) {
          const result = commitGit(process.cwd(), msg)
          setPrompt(null)
          openGitPanel()
          if (!result.ok) {
            setPanel(prev => prev?.type === 'git' ? { ...prev, gitError: result.error } : prev)
          }
        } else {
          setPrompt(null)
        }
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'commit' ? { ...prev, message: prev.message.slice(0, -1) } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'commit' ? { ...prev, message: prev.message + input } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'saveAs') {
      if (key.escape) { enterNormal(); return }
      if (key.return) {
        const raw = prompt.query.trim()
        if (!raw) {
          enterNormal()
          return
        }
        sidecar.saveAs(resolvePath(raw))
        const thenQuit = Boolean(prompt.thenQuit)
        enterNormal()
        if (thenQuit) actions.quitAll()
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'saveAs' ? { ...prev, query: prev.query.slice(0, -1) } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'saveAs' ? { ...prev, query: prev.query + input } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'file') {
      if (key.escape) { enterNormal(); return }
      if (key.return) {
        const path = prompt.query.trim()
        if (path) actions.openFile(path)
        enterNormal()
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'file' ? { ...prev, query: prev.query.slice(0, -1) } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'file' ? { ...prev, query: prev.query + input } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'buffer') {
      if (key.escape) { enterNormal(); return }
      const sorted = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const filtered = filterBuffers(sorted, prompt.query)
      const selected = Math.min(prompt.selected, Math.max(0, filtered.length - 1))
      if (key.return) {
        const target = filtered[selected]
        if (target) actions.switchBuffer(target.id)
        enterNormal()
        return
      }
      if (key.upArrow || input === 'k') {
        setPrompt(prev => prev?.type === 'buffer'
          ? { ...prev, selected: Math.max(0, Math.min(prev.selected, filtered.length - 1) - 1) }
          : prev)
        return
      }
      if (key.downArrow || input === 'j') {
        setPrompt(prev => prev?.type === 'buffer'
          ? { ...prev, selected: Math.min(Math.max(0, filtered.length - 1), prev.selected + 1) }
          : prev)
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'buffer' ? { ...prev, query: prev.query.slice(0, -1), selected: 0 } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'buffer' ? { ...prev, query: prev.query + input, selected: 0 } : prev)
        return
      }
      return
    }

    if (key.escape) { enterNormal(); return }

    // ── Command mode ─────────────────────────────────────────────────────────
    if (mode === 'command') {
      if (key.return) { executeCommand(cmdBuf); enterNormal(); return }
      if (key.backspace || key.delete) {
        setCmdBuf(prev => { if (prev.length <= 0) { enterNormal(); return prev } return prev.slice(0, -1) })
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) { setCmdBuf(prev => prev + input); return }
      return
    }

    // ── Search mode ───────────────────────────────────────────────────────────
    if (mode === 'search') {
      const commitSearchFromPrompt = (keepHighlights: boolean) => {
        const q = searchBuf
        searchQueryRef.current = q
        searchIdxRef.current = -1
        visualExpandHistoryRef.current = []
        setVisualAnchor(null)
        setVisualLineMode(false)
        setSearchBuf('')
        jumpToMatch(1)
        if (keepHighlights) {
          setSearchQuery(q)
        } else {
          setSearchQuery('')
          searchQueryRef.current = ''
        }
      }

      if (key.return) {
        commitSearchFromPrompt(true)
        setMode('normal')
        return
      }
      if (!key.ctrl && !key.meta && input === 'i') {
        commitSearchFromPrompt(false)
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'a') {
        commitSearchFromPrompt(false)
        sidecar.move('right')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'I') {
        commitSearchFromPrompt(false)
        sidecar.move('home')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'A') {
        commitSearchFromPrompt(false)
        sidecar.move('end')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'o') {
        commitSearchFromPrompt(false)
        sidecar.move('end')
        sidecar.insert('\n')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'O') {
        commitSearchFromPrompt(false)
        sidecar.move('home')
        sidecar.insert('\n')
        sidecar.move('up')
        setMode('insert')
        return
      }
      if (key.backspace || key.delete) { setSearchBuf(prev => prev.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && printable(input)) { setSearchBuf(prev => prev + input); return }
      return
    }

    // ── Insert mode ───────────────────────────────────────────────────────────
    if (mode === 'insert') {
      if (key.upArrow)                { sidecar.move('up');    return }
      if (key.downArrow)              { sidecar.move('down');  return }
      if (key.leftArrow)              { sidecar.move('left');  return }
      if (key.rightArrow)             { sidecar.move('right'); return }
      if (key.backspace || key.delete){ sidecar.deleteBackward(); return }
      if (key.return)                 { sidecar.insert('\n'); return }
      if (key.ctrl && input === 's')  { saveCurrentBuffer(); return }
      if (key.tab || input === '\t') {
        if (ghostText !== null && ghostText.length > 0) {
          sidecar.insert(ghostText)
          setGhostText(null)
          abortRef.current = null
        } else {
          triggerCompletion()
        }
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) { sidecar.insert(input) }
      return
    }

    // ── Visual mode ───────────────────────────────────────────────────────────
    if (mode === 'visual') {
      if (input === '/') {
        visualExpandHistoryRef.current = []
        setVisualAnchor(null)
        setVisualLineMode(false)
        setMode('search')
        setSearchBuf('')
        pendingKeyRef.current = null
        return
      }

      if (input === 'v' && snapshot && visualAnchor) {
        const curSnap: VisualSnap = {
          anchor: { ...visualAnchor },
          cursor: { ...snapshot.cursor },
          lineMode: visualLineMode,
        }
        const next = expandRegionOnce(snapshot.lines, visualAnchor, snapshot.cursor, visualLineMode)
        if (next) {
          visualExpandHistoryRef.current.push(curSnap)
          setVisualAnchor(next.anchor)
          setVisualLineMode(next.lineMode)
          sidecar.moveTo(next.cursor.row, next.cursor.col)
        }
        return
      }

      if (input === 'V' && snapshot && visualAnchor) {
        const h = visualExpandHistoryRef.current
        if (h.length > 0) {
          const prev = h.pop()!
          setVisualAnchor(prev.anchor)
          setVisualLineMode(prev.lineMode)
          sidecar.moveTo(prev.cursor.row, prev.cursor.col)
        }
        return
      }

      // movement extends selection (hjkl + arrows) — clears expand/contract stack
      if (input === 'h' || key.leftArrow)  { visualExpandHistoryRef.current = []; sidecar.move('left');  return }
      if (input === 'j' || key.downArrow)  { visualExpandHistoryRef.current = []; sidecar.move('down');  return }
      if (input === 'k' || key.upArrow)    { visualExpandHistoryRef.current = []; sidecar.move('up');    return }
      if (input === 'l' || key.rightArrow) { visualExpandHistoryRef.current = []; sidecar.move('right'); return }
      if (input === 'w') { visualExpandHistoryRef.current = []; sidecar.move('wordForward'); return }
      if (input === 'b') { visualExpandHistoryRef.current = []; sidecar.move('wordBackward'); return }
      if (input === '0') { visualExpandHistoryRef.current = []; sidecar.move('home'); return }
      if (input === '$') { visualExpandHistoryRef.current = []; sidecar.move('end');  return }
      if (input === 'G') { visualExpandHistoryRef.current = []; sidecar.move('fileEnd'); return }
      if (input === 'g') { visualExpandHistoryRef.current = []; sidecar.move('fileStart'); return }

      if (input === 'o' && snapshot && visualAnchor) {
        visualExpandHistoryRef.current = []
        const ar = visualAnchor.row
        const ac = visualAnchor.col
        const cr = snapshot.cursor.row
        const cc = snapshot.cursor.col
        setVisualAnchor({ row: cr, col: cc })
        sidecar.moveTo(ar, ac)
        return
      }

      if (input === 'y' && snapshot && visualAnchor) {
        const sel = selectionBounds(visualAnchor, snapshot.cursor, visualLineMode, snapshot.lines)
        yankRegisterRef.current = getVisualText(snapshot.lines, sel)
        enterNormal()
        return
      }

      if ((input === 'd' || input === 'c') && snapshot && visualAnchor) {
        const sel = selectionBounds(visualAnchor, snapshot.cursor, visualLineMode, snapshot.lines)
        yankRegisterRef.current = getVisualText(snapshot.lines, sel)
        if (sel.lineMode) {
          sidecar.deleteRange(sel.startRow, 0, sel.endRow, 999999)
        } else {
          sidecar.deleteRange(sel.startRow, sel.startCol, sel.endRow, sel.endCol)
        }
        if (input === 'c') { clearSearchHighlights(); setMode('insert') } else { enterNormal() }
        return
      }
      return
    }

    // ── Normal mode ───────────────────────────────────────────────────────────
    if (input === '-' && !key.ctrl && !key.meta) {
      const fp = snapshot?.filename ?? activeBuffer.filename ?? null
      const dir = fp ? dirname(resolvePath(fp)) : process.cwd()
      let path = resolvePath(dir)
      try {
        path = realpathSync(path)
      } catch {
        /* stay with resolved path */
      }
      setPanel({ type: 'dired', path, cursor: 0 })
      return
    }
    if (input === '[' || input === '{') {
      sidecar.move('paragraphBackward')
      return
    }
    if (input === ']' || input === '}') {
      sidecar.move('paragraphForward')
      return
    }
    if (key.ctrl && input === 's') { saveCurrentBuffer(); return }
    if (key.ctrl && input === 'r') { sidecar.redo(); return }
    if (key.upArrow)    { sidecar.move('up');    return }
    if (key.downArrow)  { sidecar.move('down');  return }
    if (key.leftArrow)  { sidecar.move('left');  return }
    if (key.rightArrow) { sidecar.move('right'); return }

    // Enter command mode
    if (input === ':') { setMode('command'); setCmdBuf(''); pendingKeyRef.current = null; return }

    // Enter search mode (clear any stale visual — should already be empty in normal)
    if (input === '/') {
      visualExpandHistoryRef.current = []
      setVisualAnchor(null)
      setVisualLineMode(false)
      setMode('search')
      setSearchBuf('')
      pendingKeyRef.current = null
      return
    }

    // Clear search highlight
    if (key.ctrl && input === 'h') { setSearchQuery(''); searchQueryRef.current = ''; return }

    // SPC opens which-key menu
    if (input === ' ') {
      setPanel({ type: 'whichkey', node: leaderMap, path: '' })
      pendingKeyRef.current = null
      return
    }

    // ── Two-key sequences ────────────────────────────────────────────────────
    const pending = pendingKeyRef.current
    pendingKeyRef.current = null

    if (pending === 'g') {
      if (input === 'g') {
        sidecar.move('fileStart')
        return
      }
      /* incomplete `gg` — fall through so e.g. `n` still runs search-next */
    } else if (pending === 'd') {
      if (input === 'd' && snapshot) {
        yankRegisterRef.current = snapshot.lines[snapshot.cursor.row] ?? ''
        sidecar.deleteLine()
      }
      return
    } else if (pending === 'y') {
      if (input === 'y' && snapshot)
        yankRegisterRef.current = snapshot.lines[snapshot.cursor.row] ?? ''
      return
    }

    if (input === 'n') { jumpToMatch(1); return }
    if (input === 'N') { jumpToMatch(-1); return }

    // ── Single-key normal mode ────────────────────────────────────────────────
    switch (input) {
      case 'h': sidecar.move('left');        break
      case 'j': sidecar.move('down');        break
      case 'k': sidecar.move('up');          break
      case 'l': sidecar.move('right');       break
      case 'w': sidecar.move('wordForward'); break
      case 'b': sidecar.move('wordBackward');break
      case '0': sidecar.move('home');        break
      case '$': sidecar.move('end');         break
      case 'G': sidecar.move('fileEnd');     break
      case 'g': pendingKeyRef.current = 'g'; break
      case 'd': pendingKeyRef.current = 'd'; break
      case 'y': pendingKeyRef.current = 'y'; break
      case 'u': sidecar.undo();              break
      case 'x': sidecar.deleteForward();     break
      case 'X': sidecar.deleteBackward();    break
      case 'p':
        if (yankRegisterRef.current !== null) {
          if (yankRegisterRef.current.includes('\n')) {
            // line-wise yank → paste as new line below
            sidecar.move('end'); sidecar.insert('\n' + yankRegisterRef.current)
          } else {
            // char-wise yank → paste after cursor
            sidecar.move('right'); sidecar.insert(yankRegisterRef.current)
          }
        }
        break
      case 'P':
        if (yankRegisterRef.current !== null) {
          if (yankRegisterRef.current.includes('\n')) {
            // line-wise → paste as new line above
            sidecar.move('home'); sidecar.insert(yankRegisterRef.current + '\n'); sidecar.move('up')
          } else {
            // char-wise → paste before cursor
            sidecar.insert(yankRegisterRef.current)
          }
        }
        break
      case 'v':
        if (snapshot) {
          const cur = snapshot.cursor
          visualExpandHistoryRef.current = []
          setVisualAnchor({ ...cur })
          setVisualLineMode(false)
          setMode('visual')
          const next = expandRegionOnce(snapshot.lines, cur, cur, false)
          if (next) {
            visualExpandHistoryRef.current.push({ anchor: { ...cur }, cursor: { ...cur }, lineMode: false })
            setVisualAnchor(next.anchor)
            setVisualLineMode(next.lineMode)
            sidecar.moveTo(next.cursor.row, next.cursor.col)
          }
        }
        break
      case 'V':
        if (snapshot) {
          visualExpandHistoryRef.current = []
          setVisualAnchor({ row: snapshot.cursor.row, col: 0 })
          setVisualLineMode(true)
          setMode('visual')
        }
        break
      case 'i': clearSearchHighlights(); setMode('insert'); break
      case 'I': sidecar.move('home'); clearSearchHighlights(); setMode('insert'); break
      case 'a': sidecar.move('right'); clearSearchHighlights(); setMode('insert'); break
      case 'A': sidecar.move('end');   clearSearchHighlights(); setMode('insert'); break
      case 'o':
        sidecar.move('end'); sidecar.insert('\n'); clearSearchHighlights(); setMode('insert'); break
      case 'O':
        sidecar.move('home'); sidecar.insert('\n'); sidecar.move('up'); clearSearchHighlights(); setMode('insert'); break
    }
  })

  const sel: SelBounds | null = (mode === 'visual' && visualAnchor && snapshot)
    ? selectionBounds(visualAnchor, snapshot.cursor, visualLineMode, snapshot.lines)
    : null

  const aiWidth = panel?.type === 'ai' ? Math.floor(totalCols * 0.42) : 0
  const editorWidth = panel?.type === 'ai' ? totalCols - aiWidth : undefined

  const gitDisplayLines = panel?.type === 'git'
    ? buildGitDisplayLines(panel.data, panel.logEntries)
    : null
  const diredEntries = panel?.type === 'dired' ? readDiredEntries(panel.path) : []

  if (panel?.type === 'git') {
    return (
      <Box flexDirection="column" width={totalCols} height={totalRows}>
        <GitPanel
          data={panel.data}
          cursor={panel.cursor}
          pendingKey={panel.pendingKey}
          logEntries={panel.logEntries}
          gitError={panel.gitError}
          displayLines={gitDisplayLines!}
          totalRows={totalRows}
          totalCols={totalCols}
        />
      </Box>
    )
  }

  const panelRows = panel === null || panel.type === 'ai' ? 0
    : panel.type === 'shell'      ? 3 + shellRows
    : panel.type === 'dired'
      ? Math.min(Math.floor(totalRows * 0.48), Math.max(7, diredEntries.length + 4))
    : panel.type === 'cmdpalette' ? 0
    : 3 + Math.min(9, Math.ceil(Object.keys(panel.node).length / 4))
  const editorHeight = Math.max(1, totalRows - panelRows)

  const editorPane = (
    <EditorPane
      filename={filename}
      snapshot={snapshot}
      status={status}
      bufferName={activeBuffer.name}
      bufferIndex={activeIndex}
      bufferCount={buffers.length}
      buffers={buffers}
      activeBufferId={activeId}
      prompt={prompt}
      ghostText={ghostText}
      mode={mode}
      scrollOffset={scrollOffset}
      panelRows={panelRows}
      paneHeight={editorHeight}
      paneWidth={editorWidth}
      panel={panel}
      sel={sel}
      searchQuery={searchQuery}
      cmdBuf={cmdBuf}
      searchBuf={searchBuf}
    />
  )

  if (panel?.type === 'ai') {
    return (
      <Box flexDirection="row" width={totalCols} height={totalRows}>
        {editorPane}
        <AiPanel
          messages={aiMessages}
          input={aiInput}
          streaming={aiStreaming}
          focused={panel.focused}
          width={aiWidth}
          height={totalRows}
          navHint={aiNavLoc ? `${aiNavLoc.file}:${aiNavLoc.row + 1}` : undefined}
          shellHint={aiShellCmd ? aiShellCmd.split('\n')[0] : undefined}
          fixState={fixState}
          reviewState={reviewState}
          scrollOffset={aiScrollOffset}
          thinkingTick={thinkingTick}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={totalCols} height={totalRows}>
      {editorPane}
      {panel?.type === 'whichkey' && (
        <WhichKeyPanel node={panel.node} path={panel.path} totalCols={totalCols} />
      )}
      {panel?.type === 'cmdpalette' && (
        <CmdPalettePanel items={panel.items} query={panel.query} cursor={panel.cursor} width={Math.min(70, totalCols - 4)} />
      )}
      {panel?.type === 'shell' && (
        <ShellPane
          lines={shellLines}
          rows={shellRows}
          focused={true}
          mode={shell.mode}
          input={shellInput}
          running={shellRunning}
          height={panelRows}
        />
      )}
      {panel?.type === 'dired' && (
        <DiredPanel
          path={panel.path}
          cursor={panel.cursor}
          entries={diredEntries}
          totalRows={panelRows}
          totalCols={totalCols}
        />
      )}
    </Box>
  )
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const filename = process.argv[2]
  const cwd  = process.cwd()
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows    || 24

  let cfg = await loadConfig()
  if (cfg.theme) C = { ...C, ...(cfg.theme as Partial<Theme>) }

  const shell = new ShellSidecar(cwd, cols, Math.floor(rows * 0.3))

  let nextBufferId = 1
  let activeId = ''
  let buffers: EditorBuffer[] = []
  let activeSidecar: QeSidecar | null = null
  let bufferSwitchCount = 0
  const sidecarMap = new Map<string, QeSidecar>()
  let shellLines: ShellLine[] = [...shell.lines]
  let instance: Instance | null = null
  let quitting = false

  const refresh = () => instance?.rerender(view())

  const bufferInfos = () => buffers.map(buffer => toBufferInfo(buffer, activeId))

  const makeCtx = (buffer: EditorBuffer): EditorContext => ({
    filename: buffer.snapshot?.filename ?? buffer.filename,
    lines:    buffer.snapshot?.lines   ?? [],
    cursor:   buffer.snapshot?.cursor  ?? { row: 0, col: 0 },
    save:     () => activeSidecar?.save(),
    quit:     quitAll,
    insert:   (text) => activeSidecar?.insert(text),
    move:     (dir) => activeSidecar?.move(dir as Parameters<QeSidecar['move']>[0]),
    shell:    { run: (cmd) => { void shell.runTracked(cmd) }, lines: () => shellLines.map(l => l.text) },
    buffers:  {
      list: bufferInfos,
      current: () => bufferInfos().find(info => info.active) ?? null,
      switch: switchBuffer,
      kill: killBuffer,
      next: nextBuffer,
      previous: previousBuffer,
    },
    openFile,
  })

  function createSidecarForBuffer(buffer: EditorBuffer): QeSidecar {
    const sc = new QeSidecar(buffer.filename ?? undefined)
    sidecarMap.set(buffer.id, sc)

    sc.on('message', message => {
      if (activeSidecar !== sc) return  // stale, ignore
      switch (message.type) {
        case 'ready':
          buffer.status = 'ready'
          if (buffer.jumpTo) {
            sc.moveTo(buffer.jumpTo.row, buffer.jumpTo.col)
            buffer.jumpTo = undefined
          }
          break
        case 'snapshot':
          buffer.snapshot = message
          buffer.filename = message.filename
          buffer.name = bufferName(message.filename)
          buffer.status = message.status
          break
        case 'saved':
          buffer.status = 'saved'
          if (cfg.hooks?.onSave) void cfg.hooks.onSave(makeCtx(buffer))
          break
        case 'error':
          buffer.status = message.message
          break
        case 'lspResponse':
          if (message.kind === 'definition') {
            const target = lspDefinitionTarget(message)
            if (target?.path) {
              openFile(target.path, { row: target.row ?? 0, col: target.col ?? 0 })
              buffer.status = `definition ${target.path}:${(target.row ?? 0) + 1}`
            } else {
              buffer.status = message.status
            }
          } else if (message.kind === 'hover') {
            buffer.status = lspHoverText(message)
          } else if (message.kind === 'completion') {
            const result = message.result as { available?: boolean; items?: Array<{ label: string; insertText: string; detail: string }> } | undefined
            const items = result?.items ?? []
            if (items.length > 0) {
              buffer.status = `completion: ${items.length} item${items.length === 1 ? '' : 's'} — Tab to accept`
            } else {
              buffer.status = message.status
            }
          } else {
            buffer.status = message.status
          }
          break
        case 'exit':
          buffer.status = 'exiting'
          break
      }
      buffers = [...buffers]
      refresh()
    })

    sc.on('exit', () => {
      if (activeSidecar === sc) activeSidecar = null
      sidecarMap.delete(buffer.id)
      // Don't auto-remove; the buffer record stays, user can re-open
    })

    const c = process.stdout.columns || 80
    const r = process.stdout.rows    || 24
    sc.resize(c, r)
    return sc
  }

  function createBuffer(file?: string | null): EditorBuffer {
    const id = `buffer-${nextBufferId++}`
    const buffer: EditorBuffer = {
      id,
      name: bufferName(file ?? null),
      filename: file ?? null,
      snapshot: null,
      status: 'starting',
      lastUsedAt: Date.now(),
    }
    buffers = [...buffers, buffer]
    return buffer
  }

  function activateBuffer(buffer: EditorBuffer): void {
    if (activeSidecar) { activeSidecar.kill(); activeSidecar = null }
    activeId = buffer.id
    buffer.lastUsedAt = Date.now()
    bufferSwitchCount++
    activeSidecar = createSidecarForBuffer(buffer)
  }

  function ensureScratch(): void {
    if (buffers.length > 0) return
    const scratch = createBuffer(null)
    activateBuffer(scratch)
  }

  function activeBuffer(): EditorBuffer {
    ensureScratch()
    return buffers.find(buffer => buffer.id === activeId) ?? buffers[0]!
  }

  function switchBuffer(id: string): void {
    const buffer = buffers.find(b => b.id === id)
    if (!buffer || buffer.id === activeId) return
    activateBuffer(buffer)
    refresh()
  }

  function orderedBuffers(): EditorBuffer[] {
    const num = (id: string) => parseInt(id.replace(/^.*-/, ''), 10) || 0
    return [...buffers].sort((a, b) => num(a.id) - num(b.id))
  }

  function cycleBuffer(delta: number): void {
    if (buffers.length <= 1) return
    const ordered = orderedBuffers()
    const index = Math.max(0, ordered.findIndex(b => b.id === activeId))
    const next = ordered[((index + delta) % ordered.length + ordered.length) % ordered.length]
    if (next) switchBuffer(next.id)
  }

  function nextBuffer(): void { cycleBuffer(1) }
  function previousBuffer(): void { cycleBuffer(-1) }

  function removeBuffer(id: string): void {
    if (!buffers.find(b => b.id === id)) return  // already gone — idempotent

    buffers = buffers.filter(b => b.id !== id)

    if (activeId === id) {
      if (activeSidecar) { activeSidecar.kill(); activeSidecar = null }
      const next = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
      if (next) {
        activateBuffer(next)
      } else {
        activeId = ''
      }
    }

    ensureScratch()
    refresh()
  }

  function killBuffer(id = activeId): void { removeBuffer(id) }

  function newScratch(): void {
    const buffer = createBuffer(null)
    activateBuffer(buffer)
    refresh()
  }

  function openFile(path: string, jump?: { row: number; col: number }): void {
    const resolved = resolvePath(path)
    const existing = buffers.find(b => {
      const bPath = b.snapshot?.filename ?? b.filename
      return bPath ? resolvePath(bPath) === resolved : false
    })
    if (existing) {
      if (jump) existing.jumpTo = jump
      switchBuffer(existing.id)
      return
    }
    const buffer = createBuffer(resolved)
    if (jump) buffer.jumpTo = jump
    activateBuffer(buffer)
    if (cfg.hooks?.onOpen) void cfg.hooks.onOpen(makeCtx(buffer))
    refresh()
  }

  function quitAll(): void {
    quitting = true
    if (activeSidecar) { activeSidecar.kill(); activeSidecar = null }
    shell.kill()
    instance?.unmount()
    process.exit(0)
  }

  // Terminal resize — one handler, no React effect needed
  process.stdout.on('resize', () => {
    const c = process.stdout.columns || 80
    const r = process.stdout.rows    || 24
    for (const sc of sidecarMap.values()) sc.resize(c, r)
    shell.resize(c, Math.floor(r * 0.3))
    refresh()
  })

  // Initial buffer
  const initial = createBuffer(filename ?? null)
  activateBuffer(initial)

  function openConfig() {
    const existing = getConfigPath()
    if (existing) { openFile(existing); return }
    // Create the default config file with a starter template
    import('node:fs').then(({ mkdirSync, writeFileSync }) => {
      import('node:path').then(({ dirname }) => {
        const target = CONFIG_PATHS[0]!
        mkdirSync(dirname(target), { recursive: true })
        const template = [
          `// ~/.config/qe/config.js — qe editor user config`,
          `// Add custom keybindings under "leader". Keys receive an EditorContext.`,
          ``,
          `export default {`,
          `  // leader: {`,
          `  //   z: { r: (ctx) => ctx.shell.run('cargo test') },`,
          `  // },`,
          `}`,
        ].join('\n')
        writeFileSync(target, template, 'utf8')
        openFile(target)
      })
    })
  }

  async function reloadCfg() {
    cfg = await reloadConfig()
    if (cfg.theme) C = { ...C, ...(cfg.theme as Partial<Theme>) }
    refresh()
  }

  const view = () => {
    const cur = shell.currentLine
    const displayLines = cur.trim()
      ? [...shellLines, { text: cur, isError: false }]
      : shellLines
    const current = activeBuffer()
    return (
      <AlternateScreen mouseTracking={false}>
        <App
          buffers={buffers}
          activeId={current.id}
          bufferKey={bufferSwitchCount}
          sidecar={activeSidecar!}
          shell={shell}
          shellLines={displayLines}
          userLeader={cfg.leader ?? {}}
          actions={{
            openFile,
            switchBuffer,
            killBuffer,
            nextBuffer,
            previousBuffer,
            newScratch,
            quitAll,
            reloadConfig: reloadCfg,
            openConfig,
          }}
        />
      </AlternateScreen>
    )
  }

  // Throttle shell redraws to ~60fps to avoid sticky editor feel
  let shellUpdateTimer: ReturnType<typeof setTimeout> | null = null
  shell.on('line', (line: ShellLine) => {
    shellLines = [...shellLines, line]
    if (shellLines.length > 500) shellLines = shellLines.slice(-500)
    refresh()
  })
  shell.on('update', () => {
    if (shellUpdateTimer) return
    shellUpdateTimer = setTimeout(() => { shellUpdateTimer = null; refresh() }, 16)
  })

  instance = await render(view())
}

void main()
