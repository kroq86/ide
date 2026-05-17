import {
  createContext,
  type ReactNode,
  useMemo,
  useSyncExternalStore,
} from 'react'
import {
  getTerminalFocused,
  getTerminalFocusState,
  subscribeTerminalFocus,
  type TerminalFocusState,
} from '../terminal-focus-state.js'

export type { TerminalFocusState }

export type TerminalFocusContextProps = {
  readonly isTerminalFocused: boolean
  readonly terminalFocusState: TerminalFocusState
}

const TerminalFocusContext = createContext<TerminalFocusContextProps>({
  isTerminalFocused: true,
  terminalFocusState: 'unknown',
})

TerminalFocusContext.displayName = 'TerminalFocusContext'

export function TerminalFocusProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const isTerminalFocused = useSyncExternalStore(
    subscribeTerminalFocus,
    getTerminalFocused,
  )
  const terminalFocusState = useSyncExternalStore(
    subscribeTerminalFocus,
    getTerminalFocusState,
  )

  const value = useMemo(
    () => ({ isTerminalFocused, terminalFocusState }),
    [isTerminalFocused, terminalFocusState],
  )

  return (
    <TerminalFocusContext.Provider value={value}>
      {children}
    </TerminalFocusContext.Provider>
  )
}

export default TerminalFocusContext
