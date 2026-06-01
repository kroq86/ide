import React from 'react'
import { Box, Text } from 'terminal-react-core'
import type { ShellLine } from '../shell.js'
import { C } from './theme.js'

export function ShellPane({
  lines, rows, focused, mode, input, running, height, scrollOffset, dangerPrompt,
}: {
  lines: ShellLine[]
  rows: number
  focused: boolean
  mode: 'pty' | 'runner'
  input: string
  running: boolean
  height: number
  scrollOffset: number
  dangerPrompt: { cmd: string; reason: string } | null
}) {
  const maxVisible = Math.max(1, rows - 1)
  const clampedOffset = Math.min(scrollOffset, Math.max(0, lines.length - maxVisible))
  const sliceEnd = clampedOffset > 0 ? lines.length - clampedOffset : undefined
  const visible = lines.slice(Math.max(0, lines.length - maxVisible - clampedOffset), sliceEnd)
  const scrollHint = clampedOffset > 0 ? `  ↑${clampedOffset} lines  ↑↓=scroll` : mode === 'runner' ? '  ↑↓=scroll' : '  Shift+↑↓=scroll'
  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="row">
        <Text backgroundColor={focused ? C.green : '#21252b'} color={focused ? C.bg : C.grey}> *shell* </Text>
        <Text color={C.grey}>{`  mode: ${mode}${running ? '  running...' : ''}${scrollHint}`}</Text>
      </Box>
      {visible.length === 0
        ? <Text color={C.grey}>  (no output yet)</Text>
        : visible.map((l, i) => (
            <Text key={i} color={l.isError ? C.red : C.fg} wrap="truncate">{l.text || ' '}</Text>
          ))
      }
      {mode === 'runner' && !dangerPrompt && (
        <Box flexDirection="row">
          <Text color={C.cyan}>{'$ '}</Text>
          <Text color={C.fg}>{input}</Text>
          {focused && <Text color={C.grey}>_</Text>}
        </Box>
      )}
      {mode === 'runner' && dangerPrompt && (
        <Box flexDirection="row">
          <Text backgroundColor={C.red} color={C.bg}>{` Dangerous: ${dangerPrompt.reason} `}</Text>
          <Text color={C.grey}>{`  Enter=run  Esc=cancel`}</Text>
        </Box>
      )}
      {mode === 'pty' && focused && <Text color={C.grey}>Enter=tracked run  Esc=editor</Text>}
    </Box>
  )
}
