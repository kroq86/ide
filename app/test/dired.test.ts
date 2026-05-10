import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readDiredEntries } from '../src/dired.ts'

describe('readDiredEntries', () => {
  it('lists .. then dirs then files sorted', () => {
    const root = join(process.cwd(), '.tmp-dired-test-' + Date.now())
    mkdirSync(join(root, 'b-dir'), { recursive: true })
    mkdirSync(join(root, 'a-dir'), { recursive: true })
    writeFileSync(join(root, 'z.txt'), 'z')
    writeFileSync(join(root, 'm.txt'), 'm')

    try {
      const entries = readDiredEntries(root)
      const names = entries.map(e => e.name)
      assert.ok(names.includes('..'), 'has parent')
      assert.equal(names.indexOf('..'), 0, '.. first')
      const rest = names.slice(1)
      assert.deepEqual(rest, ['a-dir', 'b-dir', 'm.txt', 'z.txt'])
      assert.ok(entries.find(e => e.name === 'a-dir')!.isDir)
      assert.ok(entries.find(e => e.name === 'm.txt')!.isDir === false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
