import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCursorHistoryState,
  moveCursorHistoryBack,
  moveCursorHistoryForward,
  noteCursorLocation,
} from '../src/cursor-history.ts'

describe('cursor history', () => {
  it('skips tiny same-file moves and records meaningful jumps', () => {
    let state = createCursorHistoryState()
    state = noteCursorLocation(state, { file: 'a.ts', row: 1, col: 0 })
    state = noteCursorLocation(state, { file: 'a.ts', row: 2, col: 0 })
    state = noteCursorLocation(state, { file: 'a.ts', row: 10, col: 0 })
    assert.equal(state.back.length, 1)

    const moved = moveCursorHistoryBack(state)
    assert.deepEqual(moved.target, { file: 'a.ts', row: 2, col: 0 })
  })

  it('clears forward history after a new jump', () => {
    let state = createCursorHistoryState()
    state = noteCursorLocation(state, { file: 'a.ts', row: 1, col: 0 })
    state = noteCursorLocation(state, { file: 'b.ts', row: 1, col: 0 })
    let moved = moveCursorHistoryBack(state)
    state = moved.state
    assert.equal(state.forward.length, 1)
    state = noteCursorLocation(state, { file: 'c.ts', row: 1, col: 0 })
    moved = moveCursorHistoryForward(state)
    assert.equal(moved.target, null)
  })
})
