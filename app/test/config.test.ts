import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, loadConfigFromPaths, reloadConfig, type EditorContext } from '../src/config.ts'

describe('defineConfig', () => {
  it('returns the same config object and accepts old function leader leaves', () => {
    const config = defineConfig({
      preset: 'web',
      leader: {
        z: { r: (ctx: EditorContext) => ctx.shell.run('cargo test') },
      },
    })
    assert.equal(config.preset, 'web')
    assert.equal(typeof config.leader?.z, 'object')
  })

  it('accepts command IDs, command objects, and directive arrays', () => {
    const config = defineConfig({
      leader: {
        p: { t: 'tasks.pickAndRun' },
        x: { t: [{ type: 'shell.run', command: 'npm test' }] },
        f: { f: { command: 'file.find' } },
      },
    })
    assert.equal(config.leader?.p && typeof config.leader.p, 'object')
  })
})

describe('config loader', () => {
  it('loads the first existing config by priority', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qe-config-priority-'))
    const first = join(dir, 'config.ts')
    const second = join(dir, 'config.js')
    writeFileSync(first, 'export default { preset: "minimal" }', 'utf8')
    writeFileSync(second, 'export default { preset: "rust" }', 'utf8')

    const config = await loadConfigFromPaths([first, second])
    assert.equal(config.preset, 'minimal')
  })

  it('falls back after a broken config and can reload the chosen file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qe-config-fallback-'))
    const broken = join(dir, 'broken.ts')
    const good = join(dir, 'config.mjs')
    writeFileSync(broken, 'export default {', 'utf8')
    writeFileSync(good, 'export default { preset: "minimal" }', 'utf8')

    const config = await loadConfigFromPaths([broken, good])
    assert.equal(config.preset, 'minimal')

    writeFileSync(good, 'export default { preset: "rust" }', 'utf8')
    const reloaded = await reloadConfig()
    assert.equal(reloaded.preset, 'rust')
  })
})
