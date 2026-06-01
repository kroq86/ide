import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { codeClawFixLines, fixOverlayCoversMessages, reviewLines } from './ai-overlay-lines.js'
import { thinkingSpinnerGlyph } from './spinner.js'
import { C } from './theme.js'
import type { AiMessage, ChatStreamingState, CodeClawFixState, ReviewState } from './types.js'

export function AiPanel({
  messages, input, streaming, chatStreaming, focused, width, height, navHint, shellHint, fixState, clawProgressChars, reviewState, scrollOffset, thinkingTick,
}: {
  messages: AiMessage[]
  input: string
  streaming: boolean
  chatStreaming: ChatStreamingState | null
  focused: boolean
  width: number
  height: number
  navHint?: string
  shellHint?: string
  fixState: CodeClawFixState
  clawProgressChars: number
  reviewState: ReviewState
  scrollOffset: number
  /** Incremented on an interval while the AI panel is busy (stream / CodeClaw). */
  thinkingTick: number
}) {
  const msgAreaRows = Math.max(3, height - 6)
  const clampedOffset = Math.min(scrollOffset, Math.max(0, messages.length - msgAreaRows))
  const sliceEnd = clampedOffset === 0 ? undefined : -clampedOffset
  const visible = messages.slice(-msgAreaRows - clampedOffset, sliceEnd)
  const hiddenAbove = Math.max(0, messages.length - msgAreaRows - clampedOffset)
  const fixLines = codeClawFixLines(fixState, msgAreaRows, thinkingTick, clawProgressChars)
  const reviewLns = reviewLines(reviewState, msgAreaRows, thinkingTick)
  const fixOverlay = fixOverlayCoversMessages(fixState)
  /** Active fix/review overlays beat chat; terminal success (`done`) does not — `error` uses fix overlay so it isn’t hidden by stale review. */
  const overlayLines = fixOverlay ? fixLines : reviewLns.length > 0 ? reviewLns : []
  /** Focused prompt = composing a chat message — don't bury it under CodeClaw review/fix UI (user expects “hi” to be a normal chat turn). */
  const overlayLinesForDisplay = focused ? [] : overlayLines

  const scrollHint = clampedOffset > 0 ? `  ↑${clampedOffset} scrolled  j/k=scroll` : !focused && messages.length > msgAreaRows ? '  k=scroll up' : ''
  const overlayActive = fixOverlay || reviewState.status !== 'idle'
  const aiPanelBusy =
    streaming
    || fixState.status === 'generating'
    || fixState.status === 'applying'
    || reviewState.status === 'generating'
  const clearHint = focused && messages.length > 0 ? '  Ctrl+L=clear' : ''
  const hint = aiPanelBusy
    ? `${thinkingSpinnerGlyph(thinkingTick)} …`
    : focused
      ? `Enter=send  Esc=focus editor${clearHint}`
      : overlayActive ? 'x=dismiss  SPC a p=focus' : 'SPC a p=focus'

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row">
        <Text backgroundColor={focused ? C.green : '#21252b'} color={focused ? C.bg : C.grey}> *AI* </Text>
        <Text color={C.grey}>{`  ${hint}${scrollHint}`}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {overlayLinesForDisplay.length > 0
          ? overlayLinesForDisplay.map((line, i) => (
              <Text key={i} color={line.color} wrap={line.wrap ?? 'truncate'}>{line.text || ' '}</Text>
            ))
          : visible.length === 0
          ? <Text color={C.grey}>Ask anything about the current file...</Text>
          : <>
              {hiddenAbove > 0 && (
                <Text color={C.grey}>{`  ↑ ${hiddenAbove} more message${hiddenAbove === 1 ? '' : 's'}`}</Text>
              )}
              {(() => {
                const sepLen = Math.max(12, Math.min(Math.max(4, width - 6), 72))
                const sepLine = '─'.repeat(sepLen)
                const isLastMsg = (i: number) => i === visible.length - 1
                return visible.map((msg, i) => {
                  const isLast = isLastMsg(i)
                  const isStreamingLast = isLast && streaming && chatStreaming !== null && msg.role === 'assistant'
                  return (
                    <React.Fragment key={i}>
                      <Box flexDirection="column" marginBottom={1}>
                        <Text bold color={msg.role === 'user' ? C.cyan : msg.error ? C.red : C.green}>
                          {msg.role === 'user' ? 'You' : msg.error ? 'Error' : 'AI'}
                        </Text>
                        {isStreamingLast ? (
                          <Box flexDirection="column">
                            {chatStreaming.committedLines.map((line, li) => (
                              <Text key={li} color={C.fg} wrap="wrap">{line}</Text>
                            ))}
                            <Text color={C.fg} wrap="wrap">
                              {chatStreaming.tail}{chatStreaming.tail ? ` ${thinkingSpinnerGlyph(thinkingTick)}` : `${thinkingSpinnerGlyph(thinkingTick)} ▋`}
                            </Text>
                          </Box>
                        ) : (
                          <Text color={msg.error ? C.red : C.fg} wrap="wrap">
                            {msg.content}
                            {streaming && isLast && !chatStreaming
                              ? (msg.content ? ` ${thinkingSpinnerGlyph(thinkingTick)}` : `${thinkingSpinnerGlyph(thinkingTick)} ▋`)
                              : ''}
                          </Text>
                        )}
                      </Box>
                      {msg.role === 'assistant' && visible[i + 1] !== undefined && (
                        <Text color={C.grey}>{sepLine}</Text>
                      )}
                    </React.Fragment>
                  )
                })
              })()}
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
