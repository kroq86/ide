import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { C } from './theme.js'

export function SplashPanel({
  title, message, hint, totalRows, totalCols,
}: {
  title: string
  message?: string
  hint?: string
  totalRows: number
  totalCols: number
}) {
  const hintText = hint ?? 'Press Enter to continue'
  const titlePad = Math.max(0, Math.floor((totalCols - title.length) / 2))
  const messagePad = message ? Math.max(0, Math.floor((totalCols - message.length) / 2)) : 0
  const hintPad = Math.max(0, Math.floor((totalCols - hintText.length) / 2))
  const topPad = Math.max(0, Math.floor(totalRows / 2) - (message ? 3 : 2))

  return (
    <Box flexDirection="column" width={totalCols} height={totalRows}>
      {Array.from({ length: topPad }, (_, i) => <Box key={i} />)}
      <Box flexDirection="row">
        <Text>{' '.repeat(titlePad)}</Text>
        <Text bold color={C.cyan}>{title}</Text>
      </Box>
      {message && (
        <Box flexDirection="row" marginTop={1}>
          <Text>{' '.repeat(messagePad)}</Text>
          <Text color={C.fg}>{message}</Text>
        </Box>
      )}
      <Box flexDirection="row" marginTop={2}>
        <Text>{' '.repeat(hintPad)}</Text>
        <Text color={C.yellow}>{hintText}</Text>
      </Box>
    </Box>
  )
}
