import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { markBufferPermanent, shouldReplaceTemporaryBuffer } from '../src/temp-buffer.ts'

describe('temporary buffers', () => {
  it('replaces clean temporary file buffers', () => {
    assert.equal(shouldReplaceTemporaryBuffer({
      id: 'b1',
      filename: '/tmp/a.ts',
      temporary: true,
      snapshot: { dirty: false, filename: '/tmp/a.ts' },
    }), true)
  })

  it('keeps dirty or permanent buffers', () => {
    assert.equal(shouldReplaceTemporaryBuffer({
      id: 'b1',
      filename: '/tmp/a.ts',
      temporary: true,
      snapshot: { dirty: true, filename: '/tmp/a.ts' },
    }), false)

    const buffer = markBufferPermanent({ id: 'b2', filename: '/tmp/b.ts', temporary: true })
    assert.equal(buffer.temporary, false)
    assert.equal(shouldReplaceTemporaryBuffer(buffer), false)
  })
})
