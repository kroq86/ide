import React from 'react'
import { Box, Text } from 'terminal-react-core'
import type { Snapshot } from '../protocol.js'
import type { WorkspaceTab } from '../workflow.js'
import { editorHeaderMeta, editorHeaderPath, C } from './theme.js'
import { findMatches, lineSegs } from './editor-lines.js'
import { filterBuffers } from './buffer-utils.js'
import type { EditorBuffer, EditorMode, Panel, PromptState, SelBounds } from './types.js'
import { BufferPromptOverlay } from './BufferPrompt.js'
import { WorkflowTabBar } from './WorkflowTabBar.js'

export type EditorPaneProps = {
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
  completionStreaming: boolean
  thinkingTick: number
  mode: EditorMode
  scrollOffset: number
  paneHeight: number
  paneWidth?: number
  totalRows: number
  totalCols: number
  panel: Panel
  workspaceTab: WorkspaceTab
  sel: SelBounds | null
  searchQuery: string
  cmdBuf: string
  searchBuf: string
  aiModelLabel: string
  flashMessage?: string | null
}

export function EditorPane({
  filename, snapshot, status, bufferName, bufferIndex, bufferCount, buffers, prompt,
  activeBufferId, ghostText, completionStreaming, thinkingTick, mode, scrollOffset, paneWidth, panel, workspaceTab,
  paneHeight, sel, searchQuery, cmdBuf, searchBuf, aiModelLabel, flashMessage, totalRows, totalCols,
}: EditorPaneProps) {
  const lines  = snapshot?.lines  ?? ['']
  const cursor = snapshot?.cursor ?? { row: 0, col: 0 }
  const title  = snapshot?.filename ?? filename ?? bufferName
  const dirty  = snapshot?.dirty ?? false
  const diagnosticCount = snapshot?.diagnostics?.length ?? 0
  const matchCount = searchQuery ? findMatches(lines, searchQuery).length : 0

  const effectiveCols = paneWidth ?? totalCols
  const headerBarW = Math.max(24, effectiveCols - 4)
  const titleMax = Math.max(12, headerBarW - 46)
  const pathShown = editorHeaderPath(title, titleMax)
  const metaShown = editorHeaderMeta(status, searchQuery, matchCount, headerBarW)
  const visibleRows = Math.max(1, paneHeight - 3)
  const lineNumWidth = Math.max(2, String(Math.max(1, lines.length)).length)
  const lineGutterCols = lineNumWidth + 1
  const visibleCols = Math.max(20, effectiveCols - 4 - lineGutterCols)
  const visibleLines = lines.slice(scrollOffset, scrollOffset + visibleRows)

  const modeLabel = mode.toUpperCase()
  const modeColor = mode === 'insert' ? C.green
                  : mode === 'visual'  ? C.magenta
                  : mode === 'command' || mode === 'search' ? C.yellow
                  : C.cyan
  const borderColor = (panel?.type === 'shell' || panel?.type === 'dired')
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
  } else if (prompt?.type === 'model') {
    hintLine = `Select model: ${prompt.query}_  j/k=navigate  Ret=confirm  Esc=cancel`
  } else if (prompt?.type === 'configPick') {
    hintLine = `${prompt.title}: ${prompt.query}_  j/k=navigate  Ret=choose  Esc=cancel`
  } else if (prompt?.type === 'configInput') {
    hintLine = `${prompt.title}: ${prompt.value}_  paste: ⌘V/Ctrl+V`
  } else if (prompt?.type === 'configConfirm') {
    hintLine = `${prompt.title}  y=confirm  n/Esc=cancel`
  } else if (mode === 'command') {
    hintLine = `:${cmdBuf}_`
  } else if (mode === 'search') {
    hintLine = `/${searchBuf}_  Enter=normal  i/a/I/A/o/O=find & insert  Esc=cancel`
  } else if (mode === 'insert') {
    hintLine = 'Tab=complete  Esc=normal'
  } else if (mode === 'visual') {
    hintLine = 'SPC=menu (p s=eval)  y=yank  d=delete  v=expand  V=contract  hjkl=extend  Esc=normal'
  } else if (flashMessage) {
    hintLine = flashMessage
  } else {
    hintLine = 'SPC/C-SPC=menu  v=expand-region  V=line-visual  -=dired  [/]=block  i=insert  /=search  :=cmd'
  }

  const segFileBg = '#3e4452'
  const segInfoBg = '#21252b'
  const modelinePill = ` ${modeLabel} `
  const modelineFile = `  ${pathShown}${dirty ? ' ●' : ''}  `
  const modelineInfo = `  ${cursor.row + 1}:${cursor.col + 1}${diagnosticCount > 0 ? `  ⚠ ${diagnosticCount}` : ''}  `
  const modelineModel = `  ${aiModelLabel} `
  const modelinePadLen = Math.max(0, effectiveCols - modelinePill.length - modelineFile.length - modelineInfo.length - modelineModel.length)
  const modelinePad = ' '.repeat(modelinePadLen)

  const bufferPromptList = prompt?.type === 'buffer'
    ? filterBuffers(
        [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
        prompt.query,
      )
    : null

  return (
    <Box flexDirection="column" width={paneWidth} height={paneHeight}>
      <Box flexDirection="column">
        <WorkflowTabBar buffers={buffers} activeBufferId={activeBufferId} workspaceTab={workspaceTab} width={effectiveCols} />
        {prompt?.type === 'buffer' && bufferPromptList && (
          <BufferPromptOverlay
            buffers={bufferPromptList}
            activeBufferId={activeBufferId}
            query={prompt.query}
            selected={prompt.selected}
            totalCols={effectiveCols}
          />
        )}
        {prompt?.type === 'file' && (() => {
          const windowSize = 10
          const scrollStart = Math.max(0, Math.min(prompt.selectedIdx - Math.floor(windowSize / 2), prompt.ranked.length - windowSize))
          const visible = prompt.ranked.slice(scrollStart, scrollStart + windowSize)
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text backgroundColor={C.violet} color={C.bg}> find file </Text>
                <Text color={C.grey}>{`  ${prompt.query || '(type to filter)'}_  ↑↓=navigate  Enter=open  Esc=cancel`}</Text>
              </Box>
              {visible.length === 0
                ? <Text color={C.grey}>  no files match</Text>
                : visible.map((match, index) => {
                    const isSelected = scrollStart + index === prompt.selectedIdx
                    const chars = match.path.split('')
                    const indexSet = new Set(match.indices)
                    return (
                      <Box key={match.path} flexDirection="row">
                        <Text color={isSelected ? C.bg : C.grey} backgroundColor={isSelected ? C.violet : undefined}>{' '}</Text>
                        <Box flexDirection="row" backgroundColor={isSelected ? C.bg : undefined}>
                          {chars.map((ch, ci) => (
                            <Text key={ci} color={indexSet.has(ci) ? C.cyan : (isSelected ? C.fg : C.grey)}>{ch}</Text>
                          ))}
                        </Box>
                      </Box>
                    )
                  })}
              {scrollStart > 0 && <Text color={C.grey}>{`  ↑ ${scrollStart} more`}</Text>}
            </Box>
          )
        })()}
        {prompt?.type === 'model' && (() => {
          const q = prompt.query.toLowerCase()
          const filtered = prompt.candidates.filter(m => !q || m.toLowerCase().includes(q))
          const windowSize = 8
          const scrollStart = Math.max(0, Math.min(prompt.selected - Math.floor(windowSize / 2), filtered.length - windowSize))
          const visible = filtered.slice(scrollStart, scrollStart + windowSize)
          return (
            <Box flexDirection="column">
              {visible.length === 0
                ? <Text color={C.grey}>  no matching models</Text>
                : visible.map((m, index) => {
                    const isSelected = scrollStart + index === prompt.selected
                    return (
                      <Text key={m} color={isSelected ? C.bg : C.fg} backgroundColor={isSelected ? C.cyan : undefined}>
                        {`  ${m}`}
                      </Text>
                    )
                  })}
              <Text color={C.grey}>{scrollStart > 0 ? `  ↑ ${scrollStart} more` : ' '}</Text>
            </Box>
          )
        })()}
        {prompt?.type === 'configPick' && (() => {
          const q = prompt.query.toLowerCase()
          const filtered = prompt.items.filter(item =>
            !q || item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q),
          )
          const windowSize = 8
          const scrollStart = Math.max(0, Math.min(prompt.selected - Math.floor(windowSize / 2), filtered.length - windowSize))
          const visible = filtered.slice(scrollStart, scrollStart + windowSize)
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text backgroundColor={C.violet} color={C.bg}> pick </Text>
                <Text color={C.grey}>{`  ${prompt.title}: ${prompt.query || '(type to filter)'}_`}</Text>
              </Box>
              {visible.length === 0
                ? <Text color={C.grey}>  no items match</Text>
                : visible.map((item, index) => {
                    const isSelected = scrollStart + index === prompt.selected
                    const desc = item.description ? `  ${item.description}` : ''
                    return (
                      <Text key={`${item.value}:${index}`} color={isSelected ? C.bg : C.fg} backgroundColor={isSelected ? C.violet : undefined}>
                        {`  ${item.label}${desc}`}
                      </Text>
                    )
                  })}
            </Box>
          )
        })()}
        {prompt?.type === 'configConfirm' && (
          <Box flexDirection="column">
            <Text backgroundColor={C.yellow} color={C.bg}>{` confirm `}</Text>
            {prompt.body ? <Text color={C.grey}>{`  ${prompt.body}`}</Text> : null}
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
          const segs = lineSegs(
            cropped, actualRow, cursor, mode, clippedSel, searchQuery, ghostText,
            completionStreaming, thinkingTick, snapshot?.tokens,
          )

          return (
            <Box key={index} flexDirection="row">
              <Text color={isCursor ? modeColor : C.grey}>{`${lineNum} `}</Text>
              {segs.map((s, si) => (
                <Text key={si} color={s.fg} backgroundColor={s.bg}>{s.text}</Text>
              ))}
            </Box>
          )
        })}
        {Array.from({ length: Math.max(0, visibleRows - visibleLines.length) }, (_, i) => (
          <Box key={`~${i}`} flexDirection="row">
            <Text color={C.grey}>{' '.repeat(lineNumWidth - 1)}~</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="row">
        <Text backgroundColor={modeColor} color={C.bg}>{modelinePill}</Text>
        <Text backgroundColor={segFileBg} color={C.fg}>{modelineFile}</Text>
        <Text backgroundColor={segInfoBg} color={C.grey}>{modelineInfo}</Text>
        <Text backgroundColor={segInfoBg} color={C.grey}>{modelinePad}</Text>
        <Text backgroundColor={segFileBg} color={C.grey}>{modelineModel}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={prompt || flashMessage || mode === 'command' || mode === 'search' ? C.yellow : C.grey}>
          {hintLine}
        </Text>
      </Box>
    </Box>
  )
}
