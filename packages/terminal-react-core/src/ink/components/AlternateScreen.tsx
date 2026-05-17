import {
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useInsertionEffect,
} from 'react'
import instances from '../instances.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from '../termio/dec.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import Box from './Box.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'

type Props = PropsWithChildren<{
  mouseTracking?: boolean
}>

export function AlternateScreen({
  children,
  mouseTracking = true,
}: Props): ReactNode {
  const size = useContext(TerminalSizeContext)
  const writeRaw = useContext(TerminalWriteContext)

  useInsertionEffect(() => {
    const ink = instances.get(process.stdout)

    if (!writeRaw) {
      return
    }

    writeRaw(
      ENTER_ALT_SCREEN +
        '\x1B[2J\x1B[H' +
        (mouseTracking ? ENABLE_MOUSE_TRACKING : ''),
    )
    ink?.setAltScreenActive(true, mouseTracking)

    return () => {
      ink?.setAltScreenActive(false)
      ink?.clearTextSelection()
      writeRaw(
        (mouseTracking ? DISABLE_MOUSE_TRACKING : '') + EXIT_ALT_SCREEN,
      )
    }
  }, [writeRaw, mouseTracking])

  return (
    <Box
      flexDirection="column"
      height={size?.rows ?? 24}
      width="100%"
      flexShrink={0}
    >
      {children}
    </Box>
  )
}
