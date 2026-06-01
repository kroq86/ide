import { useInput, type InputEvent } from 'terminal-react-core'
import type { Key } from 'terminal-react-core'

export type EditorInputHandler = (input: string, key: Key, event?: InputEvent) => void

/** Terminal keyboard routing (wraps terminal-react-core useInput). */
export function useEditorInput(handler: EditorInputHandler): void {
  useInput(handler)
}
