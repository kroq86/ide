import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { commandPaletteMatch, type CmdItem } from '../leader.js'
import { C } from './theme.js'

export function CmdPalettePanel({
  items, query, cursor, width,
}: {
  items: CmdItem[]
  query: string
  cursor: number
  width: number
}) {
  const filtered = items.filter(it => commandPaletteMatch(it, query))
  const visible = filtered.slice(0, 12)

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row">
        <Text backgroundColor={C.violet} color={C.bg}> M-x </Text>
        <Text color={C.grey}>{query ? `  ${query}  Enter=run  Esc=close` : '  j/k=navigate  Enter=run  Esc=close'}</Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text color={C.yellow}>{'> '}</Text>
        <Text color={C.fg}>{query}</Text>
        <Text color={C.grey}>{'_'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0
          ? <Text color={C.grey}>no commands match</Text>
          : visible.map((item, i) => {
              const active = i === cursor % visible.length
              return (
                <Box key={`${item.id ?? item.keys}:${item.label}`} flexDirection="row">
                  <Text color={active ? C.bg : C.grey} backgroundColor={active ? C.violet : undefined}>{' '}</Text>
                  <Text color={active ? C.cyan : C.fg} backgroundColor={active ? C.bg : undefined} bold={active}>
                    {` ${item.label.padEnd(28).slice(0, 28)} `}
                  </Text>
                  <Text color={C.grey} backgroundColor={active ? C.bg : undefined}>
                    {`${(item.id ?? '').padEnd(24).slice(0, 24)} `}
                  </Text>
                  <Text color={C.yellow} backgroundColor={active ? C.bg : undefined}>
                    {`${(item.keys || '-').padEnd(12).slice(0, 12)} `}
                  </Text>
                  <Text color={C.grey} backgroundColor={active ? C.bg : undefined}>{item.source ?? 'keymap'}</Text>
                </Box>
              )
            })
        }
      </Box>
    </Box>
  )
}
