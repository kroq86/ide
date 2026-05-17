import type { PropsWithChildren, ReactNode } from 'react'
import Box, { type Props as BoxProps } from './Box.js'

type Props = Omit<BoxProps, 'noSelect'> & {
  fromLeftEdge?: boolean
}

export function NoSelect({
  children,
  fromLeftEdge,
  ...boxProps
}: PropsWithChildren<Props>): ReactNode {
  return (
    <Box {...boxProps} noSelect={fromLeftEdge ? 'from-left-edge' : true}>
      {children}
    </Box>
  )
}
