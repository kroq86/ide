import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  directivePickItems,
  insertTextForDirective,
  isConfigOrPluginSourceFile,
  parseConfigDirectiveContext,
} from '../src/config-completion.js'
import { CONFIG_API_DIRECTIVE_TYPES } from '../src/config-api-template.js'

describe('parseConfigDirectiveContext', () => {
  it('parses ui. prefix and lists full directive catalog', () => {
    const line = "  type: 'ui."
    const ctx = parseConfigDirectiveContext(line, line.length)
    assert.ok(ctx)
    assert.equal(ctx.partial, 'ui.')
    assert.deepEqual(ctx.candidates, CONFIG_API_DIRECTIVE_TYPES)
    assert.equal(ctx.replaceStartCol, line.length - 'ui.'.length)
  })

  it('parses empty partial after opening quote', () => {
    const line = "  type: '"
    const ctx = parseConfigDirectiveContext(line, line.length)
    assert.ok(ctx)
    assert.equal(ctx.partial, '')
    assert.equal(ctx.candidates.length, CONFIG_API_DIRECTIVE_TYPES.length)
  })

  it('returns null outside type literal', () => {
    assert.equal(parseConfigDirectiveContext("export const x = 'ui.", 24), null)
  })
})

describe('directivePickItems', () => {
  it('includes every catalog entry with hints', () => {
    const items = directivePickItems(CONFIG_API_DIRECTIVE_TYPES)
    assert.equal(items.length, CONFIG_API_DIRECTIVE_TYPES.length)
    assert.ok(items.some(i => i.value === 'ui.notify' && i.description))
  })
})

describe('insertTextForDirective', () => {
  it('closes the string literal', () => {
    assert.equal(insertTextForDirective('ui.notify', "'"), "ui.notify'")
  })
})

describe('isConfigOrPluginSourceFile', () => {
  it('recognizes plugin and config paths', () => {
    assert.equal(isConfigOrPluginSourceFile('/Users/x/.config/qe/plugins/hello.ts'), true)
    assert.equal(isConfigOrPluginSourceFile('/Users/x/.config/qe/config.ts'), true)
    assert.equal(isConfigOrPluginSourceFile('/proj/src/foo.ts'), false)
  })
})
