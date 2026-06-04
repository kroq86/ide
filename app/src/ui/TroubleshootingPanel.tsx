import React from 'react'
import { Box, Text } from 'terminal-react-core'
import type { TroubleshootingRow } from '../troubleshooting.js'
import { C } from './theme.js'

export function TroubleshootingPanel({
  rows,
  totalCols,
}: {
  rows: TroubleshootingRow[]
  totalCols: number
}) {
  return (
    <Box flexDirection="column" width={Math.max(20, totalCols - 2)}>
      <Box flexDirection="row">
        <Text backgroundColor={C.violet} color={C.bg}> qe </Text>
        <Text color={C.fg}> troubleshooting</Text>
        <Text color={C.grey}>  Esc=close</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.map(row => (
          <Box key={row.label} flexDirection="row">
            <Text color={C.yellow}>{`${row.label.padEnd(18).slice(0, 18)} `}</Text>
            <Text color={C.fg}>{row.value.slice(0, Math.max(10, totalCols - 22))}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
