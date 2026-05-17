import type { ReactNode, Ref } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Except } from 'type-fest'
import type { DOMElement } from '../dom.js'
import type { ClickEvent } from '../events/click-event.js'
import type { FocusEvent } from '../events/focus-event.js'
import type { KeyboardEvent } from '../events/keyboard-event.js'
import type { Styles } from '../styles.js'
import Box from './Box.js'

type ButtonState = {
  focused: boolean
  hovered: boolean
  active: boolean
}

export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>
  onAction: () => void
  tabIndex?: number
  autoFocus?: boolean
  children: ((state: ButtonState) => ReactNode) | ReactNode
}

function Button({
  onAction,
  tabIndex = 0,
  autoFocus,
  children,
  ref,
  ...style
}: Props): ReactNode {
  const [isFocused, setIsFocused] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const activeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (activeTimer.current) {
        clearTimeout(activeTimer.current)
      }
    }
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'return' || event.key === ' ') {
        event.preventDefault()
        setIsActive(true)
        onAction()

        if (activeTimer.current) {
          clearTimeout(activeTimer.current)
        }

        activeTimer.current = setTimeout(() => setIsActive(false), 100)
      }
    },
    [onAction],
  )

  const handleClick = useCallback(
    (_event: ClickEvent) => {
      onAction()
    },
    [onAction],
  )

  const handleFocus = useCallback((_event: FocusEvent) => {
    setIsFocused(true)
  }, [])

  const handleBlur = useCallback((_event: FocusEvent) => {
    setIsFocused(false)
  }, [])

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
  }, [])

  const state: ButtonState = {
    focused: isFocused,
    hovered: isHovered,
    active: isActive,
  }

  const content = typeof children === 'function' ? children(state) : children

  return (
    <Box
      ref={ref}
      tabIndex={tabIndex}
      autoFocus={autoFocus}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...style}
    >
      {content}
    </Box>
  )
}

export default Button
export type { ButtonState }
