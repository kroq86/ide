export type CursorHistoryLocation = {
  file: string | null
  row: number
  col: number
}

export type CursorHistoryState = {
  back: CursorHistoryLocation[]
  forward: CursorHistoryLocation[]
  current: CursorHistoryLocation | null
}

const MAX_HISTORY = 100
const MIN_LINE_DELTA = 5

export function createCursorHistoryState(): CursorHistoryState {
  return { back: [], forward: [], current: null }
}

export function noteCursorLocation(
  state: CursorHistoryState,
  location: CursorHistoryLocation,
): CursorHistoryState {
  if (!isMeaningfulTransition(state.current, location)) {
    return { ...state, current: location }
  }
  const back = state.current ? [...state.back, state.current].slice(-MAX_HISTORY) : state.back
  return { back, forward: [], current: location }
}

export function moveCursorHistoryBack(state: CursorHistoryState): { state: CursorHistoryState; target: CursorHistoryLocation | null } {
  const target = state.back[state.back.length - 1] ?? null
  if (!target) return { state, target: null }
  const back = state.back.slice(0, -1)
  const forward = state.current ? [state.current, ...state.forward].slice(0, MAX_HISTORY) : state.forward
  return { state: { back, forward, current: target }, target }
}

export function moveCursorHistoryForward(state: CursorHistoryState): { state: CursorHistoryState; target: CursorHistoryLocation | null } {
  const target = state.forward[0] ?? null
  if (!target) return { state, target: null }
  const forward = state.forward.slice(1)
  const back = state.current ? [...state.back, state.current].slice(-MAX_HISTORY) : state.back
  return { state: { back, forward, current: target }, target }
}

function isMeaningfulTransition(a: CursorHistoryLocation | null, b: CursorHistoryLocation): boolean {
  if (!a) return true
  if (a.file !== b.file) return true
  return Math.abs(a.row - b.row) >= MIN_LINE_DELTA
}
