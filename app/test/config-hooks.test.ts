import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { onChangeDecision } from '../src/config-hooks.ts'

describe('onChange revision contract', () => {
  it('does not fire for the initial snapshot', () => {
    assert.deepEqual(onChangeDecision(undefined, 1), { revision: 1, schedule: false })
  })

  it('does not fire for cursor, resize, save, or diagnostics snapshots with the same revision', () => {
    assert.deepEqual(onChangeDecision(1, 1), { revision: 1, schedule: false })
  })

  it('fires when insert/delete/format/undo/redo produces a new revision', () => {
    assert.deepEqual(onChangeDecision(1, 2), { revision: 2, schedule: true })
  })

  it('ignores snapshots without a numeric revision', () => {
    assert.deepEqual(onChangeDecision(3, undefined), { revision: 3, schedule: false })
    assert.deepEqual(onChangeDecision(3, '4'), { revision: 3, schedule: false })
  })
})
