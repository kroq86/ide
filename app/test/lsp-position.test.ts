import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nearestIdentifierPosition } from '../src/lsp-position.ts'

describe('nearestIdentifierPosition', () => {
  const lines = ['add(2,4)']

  it('keeps positions inside the identifier but avoids the first character for TypeScript LSP', () => {
    assert.deepEqual(nearestIdentifierPosition(lines, { row: 0, col: 0 }), { row: 0, col: 1 })
    assert.deepEqual(nearestIdentifierPosition(lines, { row: 0, col: 2 }), { row: 0, col: 1 })
  })

  it('uses the previous identifier when the cursor is on punctuation or end of call', () => {
    assert.deepEqual(nearestIdentifierPosition(lines, { row: 0, col: 3 }), { row: 0, col: 1 })
    assert.deepEqual(nearestIdentifierPosition(lines, { row: 0, col: 8 }), { row: 0, col: 1 })
  })

  it('uses the next identifier when no previous identifier exists', () => {
    assert.deepEqual(nearestIdentifierPosition(['  add(2,4)'], { row: 0, col: 0 }), { row: 0, col: 3 })
  })

  it('falls back to the original cursor when no identifier exists on the line', () => {
    assert.deepEqual(nearestIdentifierPosition(['---'], { row: 0, col: 2 }), { row: 0, col: 2 })
  })
})
