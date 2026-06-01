export { render, renderSync, createRoot } from './ink/root.js'
export type {
  Instance,
  RenderOptions,
  Root,
} from './ink/root.js'

export { AlternateScreen } from './ink/components/AlternateScreen.js'
/** @deprecated Not used by qe-react-editor-app; prefer Box/Text. */
export { Ansi } from './ink/Ansi.js'
export type { Props as AppProps } from './ink/components/AppContext.js'
export type { Props as BoxProps } from './ink/components/Box.js'
export { default as Box } from './ink/components/Box.js'
export type {
  ButtonState,
  Props as ButtonProps,
} from './ink/components/Button.js'
/** @deprecated Not used by qe-react-editor-app. */
export { default as Button } from './ink/components/Button.js'
/** @deprecated Not used by qe-react-editor-app. */
export type { Props as LinkProps } from './ink/components/Link.js'
/** @deprecated Not used by qe-react-editor-app. */
export { default as Link } from './ink/components/Link.js'
/** @deprecated Not used by qe-react-editor-app. */
export type { Props as NewlineProps } from './ink/components/Newline.js'
/** @deprecated Not used by qe-react-editor-app. */
export { default as Newline } from './ink/components/Newline.js'
/** @deprecated Not used by qe-react-editor-app. */
export { NoSelect } from './ink/components/NoSelect.js'
/** @deprecated Not used by qe-react-editor-app. */
export { RawAnsi } from './ink/components/RawAnsi.js'
export type { Props as StdinProps } from './ink/components/StdinContext.js'
/** @deprecated Not used by qe-react-editor-app. */
export { default as Spacer } from './ink/components/Spacer.js'
export type { Props as TextProps } from './ink/components/Text.js'
export { default as Text } from './ink/components/Text.js'
export type { DOMElement } from './ink/dom.js'
export { ClickEvent } from './ink/events/click-event.js'
export { EventEmitter } from './ink/events/emitter.js'
export { Event } from './ink/events/event.js'
export type { Key } from './ink/events/input-event.js'
export { InputEvent } from './ink/events/input-event.js'
export type {
  TerminalFocusEventType,
} from './ink/events/terminal-focus-event.js'
export { TerminalFocusEvent } from './ink/events/terminal-focus-event.js'
export { FocusManager } from './ink/focus.js'
export type { FlickerReason } from './ink/frame.js'
export { useAnimationFrame } from './ink/hooks/use-animation-frame.js'
/** @deprecated Not used by qe-react-editor-app. */
export { default as useApp } from './ink/hooks/use-app.js'
export { default as useInput } from './ink/hooks/use-input.js'
export { useAnimationTimer, useInterval } from './ink/hooks/use-interval.js'
/** @deprecated Not used by qe-react-editor-app. */
export { useSelection } from './ink/hooks/use-selection.js'
/** @deprecated Not used by qe-react-editor-app (useInput uses it internally). */
export { default as useStdin } from './ink/hooks/use-stdin.js'
export { useTabStatus } from './ink/hooks/use-tab-status.js'
export { useTerminalFocus } from './ink/hooks/use-terminal-focus.js'
export { useTerminalTitle } from './ink/hooks/use-terminal-title.js'
export { useTerminalViewport } from './ink/hooks/use-terminal-viewport.js'
export { default as measureElement } from './ink/measure-element.js'
export { supportsTabStatus } from './ink/termio/osc.js'
export { default as wrapText } from './ink/wrap-text.js'
