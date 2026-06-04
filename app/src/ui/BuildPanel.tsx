import React from 'react'
import { Box, Text } from 'terminal-react-core'
import type { BuildPanelState } from '../build-panel.js'
import { C } from './theme.js'

export function BuildPanel({
  state,
  cursor,
  totalCols,
}: {
  state: BuildPanelState
  cursor: number
  totalCols: number
}) {
  const exit = typeof state.exitCode === 'number' ? `exit ${state.exitCode}` : 'running'
  const elapsed = state.elapsedMs === null ? '' : `  ${(state.elapsedMs / 1000).toFixed(1)}s`
  const errors = state.errors.slice(0, 12)
  return (
    <Box flexDirection="column" width={Math.max(20, totalCols - 2)}>
      <Box flexDirection="row">
        <Text backgroundColor={state.succeeded ? C.green : C.red} color={C.bg}> build </Text>
        <Text color={C.fg}>{` ${state.taskName}  ${exit}${elapsed}`}</Text>
      </Box>
      <Text color={C.grey}>{`${state.cwd}  ${state.command}`.slice(0, Math.max(10, totalCols - 2))}</Text>
      <Box flexDirection="column" marginTop={1}>
        {errors.length === 0
          ? <Text color={C.grey}>no parsed build errors</Text>
          : errors.map((error, i) => {
              const active = i === cursor % errors.length
              const loc = `${error.file}:${error.row + 1}:${error.col + 1}`
              return (
                <Box key={`${error.runId}:${i}`} flexDirection="row">
                  <Text color={active ? C.bg : C.grey} backgroundColor={active ? C.violet : undefined}>{' '}</Text>
                  <Text color={active ? C.cyan : C.yellow} backgroundColor={active ? C.bg : undefined} bold={active}>
                    {` ${loc.padEnd(34).slice(0, 34)} `}
                  </Text>
                  <Text color={active ? C.fg : C.grey} backgroundColor={active ? C.bg : undefined}>
                    {(error.message || error.command).slice(0, Math.max(10, totalCols - 42))}
                  </Text>
                </Box>
              )
            })
        }
      </Box>
    </Box>
  )
}
