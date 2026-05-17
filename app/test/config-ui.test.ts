import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { configPromptCancelValue, isConfigPromptType } from '../src/config-ui.ts'

describe('config prompt cancellation contract', () => {
  it('recognizes config prompt kinds', () => {
    assert.equal(isConfigPromptType('configPick'), true)
    assert.equal(isConfigPromptType('configInput'), true)
    assert.equal(isConfigPromptType('configConfirm'), true)
    assert.equal(isConfigPromptType('file'), false)
  })

  it('uses null for pick/input cancellation and false for confirm cancellation', () => {
    assert.equal(configPromptCancelValue('configPick'), null)
    assert.equal(configPromptCancelValue('configInput'), null)
    assert.equal(configPromptCancelValue('configConfirm'), false)
  })
})
