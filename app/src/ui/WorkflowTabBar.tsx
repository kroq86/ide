import React from 'react'
import { Box, Text } from 'terminal-react-core'
import { buildBufferTabSegments, type WorkspaceTab } from '../workflow.js'
import { isDirty } from './buffer-utils.js'
import { AI_TAB_ID, PROCESS_TAB_ID, type EditorBuffer } from './types.js'
import { C } from './theme.js'

export function WorkflowTabBar({
  buffers, activeBufferId, workspaceTab, width,
}: {
  buffers: EditorBuffer[]
  activeBufferId: string
  workspaceTab: WorkspaceTab
  width: number
}) {
  const processActive = workspaceTab === 'process'
  const aiActive = workspaceTab === 'ai'
  const tabSegments = buildBufferTabSegments(
    [
      ...buffers.map(buffer => ({
        id: buffer.id,
        name: buffer.name,
        filename: buffer.snapshot?.filename ?? buffer.filename,
        dirty: isDirty(buffer),
        active: !processActive && !aiActive && buffer.id === activeBufferId,
        lastUsedAt: buffer.lastUsedAt,
      })),
      {
        id: PROCESS_TAB_ID,
        name: 'process',
        filename: null,
        dirty: false,
        active: processActive,
        lastUsedAt: Number.MIN_SAFE_INTEGER,
      },
      {
        id: AI_TAB_ID,
        name: 'ai',
        filename: null,
        dirty: false,
        active: aiActive,
        lastUsedAt: Number.MIN_SAFE_INTEGER,
      },
    ],
    Math.max(8, width),
  )

  return (
    <Box flexDirection="row">
      {tabSegments.length === 0
        ? <Text backgroundColor="#21252b" color={C.grey}>{' tabs '}</Text>
        : tabSegments.map((segment, index) => {
            if (segment.kind === 'overflow') {
              return <Text key={`overflow-${index}`} backgroundColor="#21252b" color={C.grey}>{segment.label}</Text>
            }
            const isProcess = segment.id === PROCESS_TAB_ID
            const isAi = segment.id === AI_TAB_ID
            const bg = segment.active ? C.cyan : '#21252b'
            const fg = segment.active ? C.bg : isAi ? C.magenta : isProcess ? C.green : segment.dirty ? C.yellow : C.grey
            return <Text key={segment.id} backgroundColor={bg} color={fg}>{segment.label}</Text>
          })}
    </Box>
  )
}
