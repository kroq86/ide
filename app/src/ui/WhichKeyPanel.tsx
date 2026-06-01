import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { NODE_LABELS, type LeaderNode, whichKeyDesc } from '../leader.js'
import { C } from './theme.js'

export function WhichKeyPanel({ node, path, totalCols }: { node: LeaderNode; path: string; totalCols: number }) {
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

  const titleLeft = ` ${label} `
  const titleRight = ` ${category} `
  const titlePad = ' '.repeat(Math.max(0, totalCols - titleLeft.length - titleRight.length))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text backgroundColor={C.violet} color={C.bg}>{titleLeft}</Text>
        <Text backgroundColor='#21252b' color={C.grey}>{titlePad + titleRight}</Text>
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
