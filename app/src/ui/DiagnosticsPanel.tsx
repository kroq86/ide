import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { sortDiagnostics } from '../diagnostics.js'
import type { Diagnostic } from '../protocol.js'
import { C } from './theme.js'

export function DiagnosticsPanel({ diagnostics, cursor, title, totalRows, totalCols }: {
  diagnostics: Diagnostic[]
  cursor: number
  title: string
  totalRows: number
  totalCols: number
}) {
  const sorted = sortDiagnostics(diagnostics)
  const safeCursor = Math.min(cursor, Math.max(0, sorted.length - 1))
  const contentRows = Math.max(1, totalRows - 2)
  const idealOffset = Math.max(0, safeCursor - Math.floor(contentRows / 2))
  const scrollOffset = Math.min(idealOffset, Math.max(0, sorted.length - contentRows))
  const visible = sorted.slice(scrollOffset, scrollOffset + contentRows)
  const titleLeft = ` *diagnostics*  ${title} `
  const hint = 'j/k  Ret=open  q/Esc=close'
  const titlePad = ' '.repeat(Math.max(0, totalCols - titleLeft.length - hint.length - 2))

  return (
    <Box flexDirection="column" width={totalCols} height={totalRows}>
      <Box flexDirection="row">
        <Text backgroundColor={C.red} color={C.bg}>{titleLeft}</Text>
        <Text backgroundColor='#21252b' color={C.grey}>{titlePad + ' ' + hint}</Text>
      </Box>
      {visible.length === 0
        ? <Text color={C.grey}>  no diagnostics</Text>
        : visible.map((diagnostic, index) => {
            const actual = scrollOffset + index
            const selected = actual === safeCursor
            const sevColor = diagnostic.severity === 'error' ? C.red
              : diagnostic.severity === 'warning' ? C.yellow
              : diagnostic.severity === 'hint' ? C.cyan
              : C.blue
            const line = `${diagnostic.row + 1}:${diagnostic.startCol + 1}  ${diagnostic.severity.padEnd(7)}  ${diagnostic.message}`
            return (
              <Box key={`${actual}:${diagnostic.row}:${diagnostic.startCol}:${diagnostic.message}`} flexDirection="row">
                <Text color={selected ? C.cyan : C.grey}>{selected ? '>' : ' '}</Text>
                <Text color={selected ? C.bg : sevColor} backgroundColor={selected ? C.violet : undefined} wrap="truncate">
                  {line}
                </Text>
              </Box>
            )
          })}
    </Box>
  )
}
