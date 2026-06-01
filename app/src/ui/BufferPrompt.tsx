import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { isDirty } from './buffer-utils.js'
import { C } from './theme.js'
import type { EditorBuffer } from './types.js'

export function BufferPromptOverlay({
  buffers, activeBufferId, query, selected, totalCols,
}: {
  buffers: EditorBuffer[]
  activeBufferId: string
  query: string
  selected: number
  totalCols: number
}) {
  const visibleBuffers = buffers.slice(0, 10)
  const titleRight = query ? `  /${query}_` : ''
  const titlePad = ' '.repeat(Math.max(0, totalCols - ' *buffers* '.length - titleRight.length))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text backgroundColor={C.cyan} color={C.bg}> *buffers* </Text>
        <Text backgroundColor='#21252b' color={C.grey}>{titlePad + titleRight}</Text>
      </Box>
      {visibleBuffers.length === 0
        ? <Text color={C.grey}>  no matching buffers</Text>
        : visibleBuffers.map((buffer) => {
            const actualIndex = buffers.indexOf(buffer)
            const isSelected = actualIndex === selected
            const filenameLabel = buffer.snapshot?.filename ?? buffer.filename ?? ''
            const mark = buffer.id === activeBufferId ? '>' : ' '
            const mod = isDirty(buffer) ? '*' : ' '
            return (
              <Text key={buffer.id} color={isSelected ? C.bg : C.fg} backgroundColor={isSelected ? C.cyan : undefined}>
                {`${mark}${mod} ${buffer.name}${filenameLabel ? `  ${filenameLabel}` : ''}`}
              </Text>
            )
          })}
    </Box>
  )
}
