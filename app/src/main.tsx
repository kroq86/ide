import React from 'react'
import { basename, resolve as resolvePath } from 'node:path'
import { spawnSync } from 'node:child_process'
import { AlternateScreen, Box, Text, render, useInput, type Instance } from 'terminal-react-core'
import { QeSidecar, type Snapshot, type SyntaxToken } from './protocol.js'
import { ShellSidecar, type ShellLine, type ShellSession, type ParsedLocation } from './shell.js'
import { streamCompletion, streamChat, type AiContext } from './ai.js'
import { loadConfig, mergeLeaderTree, type BufferInfo, type EditorContext, type LeaderTree } from './config.js'
import {
  loadGitStatus, loadFileHunks, stageEntry, unstageEntry, commitGit, pullGit, pushGit,
  getGitLog, buildGitDisplayLines,
  type GitStatusData, type GitFileEntry, type GitDisplayLine, type GitLogEntry,
} from './git.js'

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

interface LeaderNode {
  [key: string]: (() => void) | LeaderNode
}

function isLeafAction(v: (() => void) | LeaderNode): v is () => void {
  return typeof v === 'function'
}

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
  | { type: 'commit'; message: string }

type AiMessage = { role: 'user' | 'assistant'; content: string }

type Panel =
  | null
  | { type: 'shell' }
  | { type: 'whichkey'; node: LeaderNode; path: string }
  | { type: 'ai'; focused: boolean }
  | { type: 'git'; data: GitStatusData; cursor: number; pendingKey: string | null; logEntries: GitLogEntry[] | null }

type SelBounds = {
  startRow: number; startCol: number
  endRow: number;   endCol: number
  lineMode: boolean
}

function selectionBounds(
  anchor: { row: number; col: number },
  cursor: { row: number; col: number },
  lineMode: boolean,
): SelBounds {
  let startRow = anchor.row, startCol = anchor.col
  let endRow   = cursor.row, endCol   = cursor.col
  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol]
  }
  return { startRow, startCol, endRow, endCol, lineMode }
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
  if (isCursor && ghostText !== null) {
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

function extractFirstLocation(text: string): ParsedLocation | null {
  // Backtick-wrapped: `src/main.tsx:47:12`
  const bt = text.match(/`([^`\s]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|c|cpp|h|rb|java)):(\d+)(?::(\d+))?`/)
  if (bt) return { file: bt[1]!, row: +bt[2]! - 1, col: bt[3] ? +bt[3] - 1 : 0, message: '' }
  // Bare reference: file.ts:47 or file.ts:47:12
  const bare = text.match(/\b([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|c|cpp|h|rb|java)):(\d+)(?::(\d+))?/)
  if (bare) return { file: bare[1]!, row: +bare[2]! - 1, col: bare[3] ? +bare[3] - 1 : 0, message: '' }
  return null
}

// ── Leader helpers ────────────────────────────────────────────────────────────

function buildLeaderMap(
  sidecar: QeSidecar,
  setPanel: (fn: Panel | ((prev: Panel) => Panel)) => void,
  buffers: {
    openSwitcher: () => void
    openFilePrompt: () => void
    next: () => void
    previous: () => void
    kill: () => void
    newScratch: () => void
    quitAll: () => void
  },
  ai: {
    openChat: () => void
    triggerCompletion: () => void
    explainError: () => void
  },
  git: {
    open: () => void
    stage: () => void
  },
  userLeader: LeaderTree,
  makeCtx: () => EditorContext,
): LeaderNode {
  const builtin: LeaderNode = {
    q: {
      q: buffers.quitAll,
      w: () => { sidecar.save(); buffers.quitAll() },
    },
    b: {
      b: buffers.openSwitcher,
      l: buffers.openSwitcher,
      k: buffers.kill,
      n: buffers.next,
      p: buffers.previous,
      s: () => sidecar.save(),
      N: buffers.newScratch,
    },
    f: { f: buffers.openFilePrompt, s: () => sidecar.save() },
    t: {
      t: () => setPanel(prev => prev?.type === 'shell' ? null : { type: 'shell' }),
      a: () => setPanel(prev => prev?.type === 'ai' ? null : { type: 'ai', focused: true }),
    },
    a: {
      p: ai.openChat,
      c: ai.triggerCompletion,
      e: ai.explainError,
    },
    g: {
      g: git.open,
      s: git.stage,
    },
  }
  return mergeLeaderTree(builtin, userLeader, makeCtx) as LeaderNode
}

const NODE_LABELS: Record<string, string> = {
  q: 'quit',    b: 'buffer',  f: 'file',    t: 'toggle',
  s: 'save',    k: 'kill',    n: 'next',    p: 'prev',
  N: 'new',     l: 'list',    w: 'save+quit',
  a: 'ai',      c: 'complete', e: 'explain-err',
  g: 'git',     d: 'diff',    r: 'refresh',
  o: 'open',
}

function printable(input: string): boolean {
  return input.length === 1 && input >= ' ' && input <= '~'
}

function bufferName(filename: string | null): string {
  return filename ? basename(filename) : '*scratch*'
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

function ShellPane({ lines, rows, focused }: { lines: ShellLine[]; rows: number; focused: boolean }) {
  const borderColor = focused ? C.green : C.grey
  const visible = lines.slice(-rows)
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text bold color={borderColor}>*shell*</Text>
      {visible.length === 0
        ? <Text color={C.grey}>  (no output yet)</Text>
        : visible.map((l, i) => (
            <Text key={i} color={l.isError ? C.red : C.fg} wrap="truncate">{l.text || ' '}</Text>
          ))
      }
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
        desc: isLeafAction(v) ? (NODE_LABELS[k] ?? k) : `+${NODE_LABELS[k] ?? k}`,
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

function AiPanel({
  messages, input, streaming, focused, width, navHint,
}: {
  messages: AiMessage[]
  input: string
  streaming: boolean
  focused: boolean
  width: number
  navHint?: string
}) {
  const borderColor = focused ? C.green : C.grey
  const totalRows = process.stdout.rows ?? 24
  const msgAreaRows = Math.max(3, totalRows - 8)
  const visible = messages.slice(-msgAreaRows)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1} width={width}>
      <Text bold color={borderColor}>*AI*  {streaming ? '...' : focused ? 'i=send  Esc=focus editor' : 'SPC a p=focus'}</Text>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {visible.length === 0
          ? <Text color={C.grey}>Ask anything about the current file...</Text>
          : visible.map((msg, i) => (
              <Box key={i} flexDirection="column" marginBottom={1}>
                <Text bold color={msg.role === 'user' ? C.cyan : C.green}>
                  {msg.role === 'user' ? 'You' : 'AI'}
                </Text>
                <Text color={C.fg} wrap="wrap">
                  {msg.content || (streaming && i === visible.length - 1 ? '▋' : ' ')}
                </Text>
              </Box>
            ))
        }
      </Box>
      {navHint && (
        <Text color={C.yellow}>{`  Tab → ${navHint}`}</Text>
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

// ── Git panel ─────────────────────────────────────────────────────────────────

function GitPanel({ data, cursor, pendingKey, logEntries, totalRows, totalCols }: {
  data: GitStatusData
  cursor: number
  pendingKey: string | null
  logEntries: GitLogEntry[] | null
  totalRows: number
  totalCols: number
}) {
  const displayLines = buildGitDisplayLines(data, logEntries)
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

  const hint = pendingKey === 'c' ? 'c=commit  Esc=cancel'
    : pendingKey === 'l' ? 'l=log  Esc=cancel'
    : 'j/k  TAB=expand  s/u=stage  cc=commit  F=pull  P=push  q=close'

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.magenta} paddingX={1} width={totalCols}>
      <Box flexDirection="row" gap={2}>
        <Text bold color={C.magenta}>*git*</Text>
        <Text bold color={C.cyan}>{data.branch}</Text>
        <Text color={C.grey}>{hint}</Text>
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
  sel, searchQuery, cmdBuf, searchBuf,
}: EditorPaneProps) {
  const lines  = snapshot?.lines  ?? ['']
  const cursor = snapshot?.cursor ?? { row: 0, col: 0 }
  const title  = snapshot?.filename ?? filename ?? bufferName
  const dirty  = snapshot?.dirty ?? false
  const diagnosticCount = snapshot?.diagnostics?.length ?? 0

  const totalRows = process.stdout.rows ?? 24
  const totalCols = process.stdout.columns ?? 80
  const effectiveCols = paneWidth ?? totalCols
  const visibleRows = Math.max(1, totalRows - 8 - panelRows)
  const visibleCols = Math.max(20, effectiveCols - 4)
  const visibleLines = lines.slice(scrollOffset, scrollOffset + visibleRows)

  const modeLabel = mode.toUpperCase()
  const modeColor = mode === 'insert' ? C.green
                  : mode === 'visual'  ? C.magenta
                  : mode === 'command' || mode === 'search' ? C.yellow
                  : C.cyan
  const borderColor = (panel?.type === 'shell' || (panel?.type === 'ai' && !panel.focused)) ? C.grey : C.blue

  let hintLine: string
  if (prompt?.type === 'file') {
    hintLine = `Find file: ${prompt.query}_`
  } else if (prompt?.type === 'buffer') {
    hintLine = `Switch buffer: ${prompt.query}_`
  } else if (prompt?.type === 'commit') {
    hintLine = `Commit: ${prompt.message}_`
  } else if (mode === 'command') {
    hintLine = `:${cmdBuf}_`
  } else if (mode === 'search') {
    hintLine = `/${searchBuf}_`
  } else if (mode === 'insert') {
    hintLine = 'Tab=complete  Esc=normal'
  } else if (mode === 'visual') {
    hintLine = 'y=yank  d=delete  V=line  Esc=normal'
  } else {
    hintLine = 'SPC=menu  i=insert  /=search  :=cmd  Ctrl-Q=quit'
  }

  const matchCount = searchQuery ? findMatches(lines, searchQuery).length : 0
  const sortedBuffers = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  const filteredBuffers = prompt?.type === 'buffer'
    ? filterBuffers(sortedBuffers, prompt.query)
    : []
  const visibleBuffers = filteredBuffers.slice(0, 8)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1} width={paneWidth}>
      <Box flexDirection="row" gap={2}>
        <Text bold color={modeColor}>{`[${modeLabel}]`}</Text>
        <Text bold color={C.magenta}>qe</Text>
        <Text color={dirty ? C.orange : C.fg}>{`${title}${dirty ? ' *' : ''}`}</Text>
        <Text color={C.grey}>{`${bufferIndex + 1}/${bufferCount}`}</Text>
        <Text color={C.grey}>{`${cursor.row + 1}:${cursor.col + 1}`}</Text>
        {diagnosticCount > 0 && <Text color={C.orange}>{`diag ${diagnosticCount}`}</Text>}
        <Text color={C.grey}>{status}</Text>
        {searchQuery && <Text color={C.yellow}>{`  /${searchQuery} (${matchCount})`}</Text>}
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
          const marker    = isCursor ? '>' : ' '
          const cropped   = line.slice(0, visibleCols)
          const segs = lineSegs(cropped, actualRow, cursor, mode, sel, searchQuery, ghostText, snapshot?.tokens)

          return (
            <Box key={index} flexDirection="row">
              <Text color={isCursor ? modeColor : C.grey}>{`${marker} `}</Text>
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
  buffers, activeId, sidecar, shell, shellLines, userLeader, actions,
}: {
  buffers: EditorBuffer[]
  activeId: string
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
  const [cmdBuf,         setCmdBuf]         = React.useState('')
  const [searchBuf,      setSearchBuf]      = React.useState('')
  const [searchQuery,    setSearchQuery]    = React.useState('')
  const [prompt,         setPrompt]         = React.useState<PromptState | null>(null)

  const [aiMessages, setAiMessages] = React.useState<AiMessage[]>([])
  const [aiInput,    setAiInput]    = React.useState('')
  const [aiStreaming, setAiStreaming] = React.useState(false)

  const pendingKeyRef    = React.useRef<string | null>(null)
  const yankRegisterRef  = React.useRef<string | null>(null)
  const abortRef         = React.useRef<AbortController | null>(null)
  const aiAbortRef       = React.useRef<AbortController | null>(null)
  const searchQueryRef   = React.useRef('')
  const searchIdxRef     = React.useRef(0)

  // Parse first navigable location from last AI response (recomputed when streaming ends)
  const aiNavLoc = React.useMemo<ParsedLocation | null>(() => {
    if (aiStreaming) return null
    const last = aiMessages[aiMessages.length - 1]
    if (last?.role === 'assistant' && last.content) return extractFirstLocation(last.content)
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
      save:     () => sidecar.save(),
      quit:     actions.quitAll,
      insert:   (text) => sidecar.insert(text),
      move:     (dir) => sidecar.move(dir as Parameters<QeSidecar['move']>[0]),
      shell:    { run: (cmd) => shell.write(cmd + '\r'), lines: () => shellLines.map(l => l.text) },
      buffers: {
        list: () => bufferInfos,
        current: () => bufferInfos.find(buffer => buffer.active) ?? null,
        switch: actions.switchBuffer,
        kill: actions.killBuffer,
        next: actions.nextBuffer,
        previous: actions.previousBuffer,
      },
      openFile: actions.openFile,
    }), [actions, bufferInfos, shell, shellLines, sidecar, snapshot])

  const leaderMap = React.useMemo(() => buildLeaderMap(
    sidecar,
    setPanel,
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
    },
    {
      open: openGitPanel,
      stage: stageCurrentFile,
    },
    userLeader,
    makeCtx,
  ), [actions, activeId, buffers, makeCtx, sidecar, userLeader])

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

  function enterNormal() {
    abortRef.current?.abort()
    abortRef.current = null
    setGhostText(null)
    setPrompt(null)
    pendingKeyRef.current = null
    // Preserve AI panel (just defocus); close everything else
    setPanel(prev => prev?.type === 'ai' ? { type: 'ai', focused: false } : null)
    setMode('normal')
    setVisualAnchor(null)
    setVisualLineMode(false)
    setCmdBuf('')
    setSearchBuf('')
  }

  function sendAiMessage(overrideText?: string) {
    const text = (overrideText ?? aiInput).trim()
    if (!text || aiStreaming) return
    if (!overrideText) setAiInput('')

    const userMsg: AiMessage = { role: 'user', content: text }
    setAiMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setAiStreaming(true)

    aiAbortRef.current?.abort()
    const ctrl = new AbortController()
    aiAbortRef.current = ctrl

    const ctx: AiContext = {
      filename:     snapshot?.filename ?? null,
      lines:        snapshot?.lines    ?? [],
      cursor:       snapshot?.cursor   ?? { row: 0, col: 0 },
      shellLines,
      shellSessions: shell.sessions,
      gitContext:   getGitContext(),
      openBuffers:  buffers.map(b => b.snapshot?.filename ?? b.filename ?? b.name),
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
      } catch { /* aborted or network error */ }
      setAiStreaming(false)
    })()
  }

  function explainLastError() {
    const lastErr = shell.lastError
    const text = lastErr
      ? [
          `Explain and fix this shell error:`,
          ``,
          `Command: \`${lastErr.cmd}\``,
          ``,
          `Errors:`,
          ...lastErr.errors,
          ``,
          `Output (last 20 lines):`,
          ...lastErr.output.slice(-20),
        ].join('\n')
      : 'No shell error detected yet. What can I help with?'
    setPanel({ type: 'ai', focused: false })
    sendAiMessage(text)
  }

  function openGitPanel() {
    const data = loadGitStatus(process.cwd())
    setPanel({ type: 'git', data, cursor: 0, pendingKey: null, logEntries: null })
  }

  function stageCurrentFile() {
    if (snapshot?.filename) {
      spawnSync('git', ['add', '--', snapshot.filename], { cwd: process.cwd(), timeout: 3000 })
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
    if (t === 'w' || t === 'write')         { sidecar.save() }
    else if (t === 'q' || t === 'quit')     { actions.quitAll() }
    else if (t === 'wq' || t === 'x')       { sidecar.save(); actions.quitAll() }
    else if (t === 'q!')                    { actions.quitAll() }
    else if (t.startsWith('e ') && t.length > 2) {
      actions.openFile(t.slice(2).trim())
    } else if (t.startsWith('!') && t.length > 1) {
      shell.write(t.slice(1) + '\r')
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

  useInput((input, key) => {
    if (key.ctrl && input === 'q') { actions.quitAll(); return }
    if (key.ctrl && input === 't') {
      setPanel(prev => prev?.type === 'shell' ? null : { type: 'shell' })
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

    // ── AI panel (focused) ───────────────────────────────────────────────────
    if (panel?.type === 'ai' && panel.focused) {
      if (key.escape)                                  { setPanel({ type: 'ai', focused: false }); return }
      if (key.ctrl && input === 'c')                   { aiAbortRef.current?.abort(); setAiStreaming(false); return }
      if (key.tab) {
        if (aiNavLoc) { actions.openFile(aiNavLoc.file, { row: aiNavLoc.row, col: aiNavLoc.col }); setPanel({ type: 'ai', focused: false }) }
        return
      }
      if (key.return)                                  { sendAiMessage(); return }
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
      if (input === 'F') { pullGit(process.cwd()); openGitPanel(); return }
      if (input === 'P') { pushGit(process.cwd()); return }
      return
    }

    // ── Shell panel ──────────────────────────────────────────────────────────
    if (panel?.type === 'shell') {
      if (key.escape)                                  { setPanel(null); return }
      if (input === 'o') {
        // jump to first parsed error location
        const loc = shell.lastLocation
        if (loc) { actions.openFile(loc.file, { row: loc.row, col: loc.col }); setPanel(null) }
        return
      }
      if (key.return)                                  { shell.write('\r');    return }
      if (key.backspace || key.delete)                 { shell.write('\x7f'); return }
      if (key.upArrow)                                 { shell.write('\x1b[A'); return }
      if (key.downArrow)                               { shell.write('\x1b[B'); return }
      if (key.leftArrow)                               { shell.write('\x1b[D'); return }
      if (key.rightArrow)                              { shell.write('\x1b[C'); return }
      if (key.ctrl && input === 'c')                   { shell.write('\x03'); return }
      if (key.ctrl && input === 'l')                   { shell.write('\x0c'); return }
      if (key.ctrl && input === 'd')                   { shell.write('\x04'); return }
      if (!key.ctrl && !key.meta && printable(input))  { shell.write(input); return }
      return
    }

    // ── Commit prompt ────────────────────────────────────────────────────────
    if (prompt?.type === 'commit') {
      if (key.escape) { setPrompt(null); return }
      if (key.return) {
        const msg = prompt.message.trim()
        if (msg) commitGit(process.cwd(), msg)
        setPrompt(null)
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
      if (key.return) {
        const q = searchBuf
        setSearchQuery(q)
        searchQueryRef.current = q
        searchIdxRef.current = -1
        setMode('normal')
        setSearchBuf('')
        jumpToMatch(1)
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
      if (key.ctrl && input === 's')  { sidecar.save(); return }
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
      // movement still works
      if (input === 'h') { sidecar.move('left'); return }
      if (input === 'j') { sidecar.move('down'); return }
      if (input === 'k') { sidecar.move('up');   return }
      if (input === 'l') { sidecar.move('right'); return }
      if (input === 'w') { sidecar.move('wordForward'); return }
      if (input === 'b') { sidecar.move('wordBackward'); return }
      if (input === '0') { sidecar.move('home'); return }
      if (input === '$') { sidecar.move('end');  return }
      if (input === 'G') { sidecar.move('fileEnd'); return }
      if (input === 'g') { sidecar.move('fileStart'); return }

      if (input === 'V') { setVisualLineMode(prev => !prev); return }

      if (input === 'y' && snapshot && visualAnchor) {
        const sel = selectionBounds(visualAnchor, snapshot.cursor, visualLineMode)
        yankRegisterRef.current = getVisualText(snapshot.lines, sel)
        enterNormal()
        return
      }

      if ((input === 'd' || input === 'c') && snapshot && visualAnchor) {
        const sel = selectionBounds(visualAnchor, snapshot.cursor, visualLineMode)
        yankRegisterRef.current = getVisualText(snapshot.lines, sel)
        if (sel.lineMode) {
          sidecar.deleteRange(sel.startRow, 0, sel.endRow, 999999)
        } else {
          sidecar.deleteRange(sel.startRow, sel.startCol, sel.endRow, sel.endCol)
        }
        if (input === 'c') { setMode('insert') } else { enterNormal() }
        return
      }
      return
    }

    // ── Normal mode ───────────────────────────────────────────────────────────
    if (key.ctrl && input === 's') { sidecar.save(); return }
    if (key.ctrl && input === 'r') { sidecar.redo(); return }
    if (key.upArrow)    { sidecar.move('up');    return }
    if (key.downArrow)  { sidecar.move('down');  return }
    if (key.leftArrow)  { sidecar.move('left');  return }
    if (key.rightArrow) { sidecar.move('right'); return }

    // Enter command mode
    if (input === ':') { setMode('command'); setCmdBuf(''); pendingKeyRef.current = null; return }

    // Enter search mode
    if (input === '/') { setMode('search'); setSearchBuf(''); pendingKeyRef.current = null; return }

    // Search navigation
    if (input === 'n') { jumpToMatch(1); return }
    if (input === 'N') { jumpToMatch(-1); return }

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

    if (pending === 'g') { if (input === 'g') sidecar.move('fileStart'); return }
    if (pending === 'd') {
      if (input === 'd' && snapshot) {
        yankRegisterRef.current = snapshot.lines[snapshot.cursor.row] ?? ''
        sidecar.deleteLine()
      }
      return
    }
    if (pending === 'y') {
      if (input === 'y' && snapshot)
        yankRegisterRef.current = snapshot.lines[snapshot.cursor.row] ?? ''
      return
    }

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
          setVisualAnchor({ ...snapshot.cursor })
          setVisualLineMode(false)
          setMode('visual')
        }
        break
      case 'V':
        if (snapshot) {
          setVisualAnchor({ row: snapshot.cursor.row, col: 0 })
          setVisualLineMode(true)
          setMode('visual')
        }
        break
      case 'i': setMode('insert'); break
      case 'I': sidecar.move('home'); setMode('insert'); break
      case 'a': sidecar.move('right'); setMode('insert'); break
      case 'A': sidecar.move('end');   setMode('insert'); break
      case 'o':
        sidecar.move('end'); sidecar.insert('\n'); setMode('insert'); break
      case 'O':
        sidecar.move('home'); sidecar.insert('\n'); sidecar.move('up'); setMode('insert'); break
    }
  })

  const sel: SelBounds | null = (mode === 'visual' && visualAnchor && snapshot)
    ? selectionBounds(visualAnchor, snapshot.cursor, visualLineMode)
    : null

  const aiWidth = panel?.type === 'ai' ? Math.floor(totalCols * 0.42) : 0
  const editorWidth = panel?.type === 'ai' ? totalCols - aiWidth : undefined

  const panelRows = panel === null || panel.type === 'ai' ? 0
    : panel.type === 'shell' ? 3 + shellRows
    : panel.type === 'git'   ? Math.min(20, buildGitDisplayLines(panel.data, panel.logEntries).length + 3)
    : 3 + Math.min(9, Math.ceil(Object.keys(panel.node).length / 4))

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
      <Box flexDirection="row" width={totalCols}>
        {editorPane}
        <AiPanel
          messages={aiMessages}
          input={aiInput}
          streaming={aiStreaming}
          focused={panel.focused}
          width={aiWidth}
          navHint={aiNavLoc ? `${aiNavLoc.file}:${aiNavLoc.row + 1}` : undefined}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={totalCols}>
      {editorPane}
      {panel?.type === 'whichkey' && (
        <WhichKeyPanel node={panel.node} path={panel.path} totalCols={totalCols} />
      )}
      {panel?.type === 'shell' && (
        <ShellPane lines={shellLines} rows={shellRows} focused={true} />
      )}
      {panel?.type === 'git' && (
        <GitPanel
          data={panel.data}
          cursor={panel.cursor}
          pendingKey={panel.pendingKey}
          logEntries={panel.logEntries}
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

  const cfg = await loadConfig()
  if (cfg.theme) C = { ...C, ...(cfg.theme as Partial<Theme>) }

  const shell = new ShellSidecar(cwd, cols, Math.floor(rows * 0.3))

  let nextBufferId = 1
  let activeId = ''
  let buffers: EditorBuffer[] = []
  let activeSidecar: QeSidecar | null = null
  let shellLines: ShellLine[] = []
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
    shell:    { run: (cmd) => shell.write(cmd + '\r'), lines: () => shellLines.map(l => l.text) },
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
        case 'exit':
          buffer.status = 'exiting'
          break
      }
      buffers = [...buffers]
      refresh()
    })

    sc.on('exit', () => {
      if (activeSidecar === sc) activeSidecar = null
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
    return [...buffers].sort((a, b) => a.id.localeCompare(b.id))
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
      // If it's already the active buffer, jump immediately
      if (existing.id === activeId && activeSidecar && jump) {
        activeSidecar.moveTo(jump.row, jump.col)
        existing.jumpTo = undefined
      }
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
    activeSidecar?.resize(c, r)
    shell.resize(c, Math.floor(r * 0.3))
    refresh()
  })

  // Initial buffer
  const initial = createBuffer(filename ?? null)
  activateBuffer(initial)

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
