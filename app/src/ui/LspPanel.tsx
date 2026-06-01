import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { C } from './theme.js'

export function LspPanel({ title, lines, totalCols }: {
  title: string
  lines: string[]
  totalCols: number
}) {
  const shown = lines.length > 0 ? lines.slice(0, 8) : ['(no LSP information)']
  const titleLeft = ` *${title}* `
  const hint = 'Esc/q=close'
  const titlePad = ' '.repeat(Math.max(0, totalCols - titleLeft.length - hint.length - 2))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text backgroundColor={C.blue} color={C.bg}>{titleLeft}</Text>
        <Text backgroundColor='#21252b' color={C.grey}>{titlePad + ' ' + hint}</Text>
      </Box>
      {shown.map((line, index) => (
        <Text key={index} color={index === 0 ? C.cyan : C.fg} wrap="truncate">{line || ' '}</Text>
      ))}
    </Box>
  )
}
