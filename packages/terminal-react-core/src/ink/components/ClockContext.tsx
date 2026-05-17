import { createContext, useEffect, useState, type ReactNode } from 'react'
import { FRAME_INTERVAL_MS } from '../constants.js'
import { useTerminalFocus } from '../hooks/use-terminal-focus.js'

export type Clock = {
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void
  now: () => number
  setTickInterval: (ms: number) => void
}

export function createClock(tickIntervalMs: number): Clock {
  const subscribers = new Map<() => void, boolean>()
  let interval: ReturnType<typeof setInterval> | null = null
  let currentTickIntervalMs = tickIntervalMs
  let startTime = 0
  let tickTime = 0

  function tick(): void {
    tickTime = Date.now() - startTime
    for (const onChange of subscribers.keys()) {
      onChange()
    }
  }

  function updateInterval(): void {
    const anyKeepAlive = [...subscribers.values()].some(Boolean)

    if (anyKeepAlive) {
      if (interval) {
        clearInterval(interval)
        interval = null
      }

      if (startTime === 0) {
        startTime = Date.now()
      }

      interval = setInterval(tick, currentTickIntervalMs)
      return
    }

    if (interval) {
      clearInterval(interval)
      interval = null
    }
  }

  return {
    subscribe(onChange, keepAlive) {
      subscribers.set(onChange, keepAlive)
      updateInterval()

      return () => {
        subscribers.delete(onChange)
        updateInterval()
      }
    },
    now() {
      if (startTime === 0) {
        startTime = Date.now()
      }

      if (interval && tickTime) {
        return tickTime
      }

      return Date.now() - startTime
    },
    setTickInterval(ms) {
      if (ms === currentTickIntervalMs) {
        return
      }

      currentTickIntervalMs = ms
      updateInterval()
    },
  }
}

export const ClockContext = createContext<Clock | null>(null)

const BLURRED_TICK_INTERVAL_MS = FRAME_INTERVAL_MS * 2

export function ClockProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const [clock] = useState(() => createClock(FRAME_INTERVAL_MS))
  const focused = useTerminalFocus()

  useEffect(() => {
    clock.setTickInterval(
      focused ? FRAME_INTERVAL_MS : BLURRED_TICK_INTERVAL_MS,
    )
  }, [clock, focused])

  return (
    <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
  )
}
