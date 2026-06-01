import React from 'react'
import { Box, Text } from 'terminal-react-core'
import type { DiredEntry } from '../dired.js'
import { C } from './theme.js'

export function DiredPanel({ path, cursor, totalRows, totalCols, entries }: {
  path: string
  cursor: number
  totalRows: number
  totalCols: number
  entries: DiredEntry[]
}) {
  const maxIdx = Math.max(0, entries.length - 1)
  const safeCursor = Math.min(cursor, maxIdx)
  const contentRows = Math.max(1, totalRows - 2)
  const idealOffset = Math.max(0, safeCursor - Math.floor(contentRows / 2))
  const scrollOffset = Math.min(idealOffset, Math.max(0, entries.length - contentRows))
  const visible = entries.slice(scrollOffset, scrollOffset + contentRows)

  return (
    <Box flexDirection="column" width={totalCols} height={totalRows}>
      <Box flexDirection="row">
        <Text backgroundColor={C.cyan} color={C.bg}> *dired* </Text>
        <Text color={C.grey}>{`  ${path}`}</Text>
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
