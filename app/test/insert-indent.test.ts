import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { newlineInsertText } from '../src/insert-indent.js'

describe('newlineInsertText', () => {
  it('keeps same indent after a property line inside an object', () => {
    const lines = [
      'export const onStartup = () => ({',
      "  type: 'command.run',",
    ]
    const text = newlineInsertText(lines, { row: 1, col: lines[1]!.length })
    assert.equal(text, '\n  ')
  })

  it('adds one indent level after an opening brace line', () => {
    const lines = ['export const onStartup = () => ({']
    const text = newlineInsertText(lines, { row: 0, col: lines[0]!.length })
    assert.equal(text, '\n  ')
  })

  it('outdents after a closing brace line', () => {
    const lines = ['    }']
    const text = newlineInsertText(lines, { row: 0, col: lines[0]!.length })
    assert.equal(text, '\n  ')
  })
})
