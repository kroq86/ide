import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectProjectRoot } from '../src/root.ts'
import { resolveExtras } from '../src/config.ts'

describe('detectProjectRoot', () => {
  it('prefers an LSP root that contains the active file', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-root-lsp-'))
    const nested = join(root, 'src')
    mkdirSync(nested)
    const file = join(nested, 'main.ts')
    writeFileSync(file, 'export {}\n')
    assert.equal(detectProjectRoot({ filename: file, cwd: nested, lspRoot: root }), realpathSync(root))
  })

  it('walks upward to package.json / tsconfig roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-root-pkg-'))
    mkdirSync(join(root, 'packages/app/src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    const file = join(root, 'packages/app/src/index.ts')
    writeFileSync(file, 'export {}\n')
    assert.equal(detectProjectRoot({ filename: file, cwd: join(root, 'packages/app/src') }), realpathSync(root))
  })

  it('supports Cargo.toml roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-root-rust-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "demo"\n')
    const file = join(root, 'src/lib.rs')
    writeFileSync(file, 'pub fn demo() {}\n')
    assert.equal(detectProjectRoot({ filename: file, cwd: join(root, 'src') }), realpathSync(root))
  })
})

describe('resolveExtras', () => {
  it('defaults to the web preset and deduplicates user extras', () => {
    assert.deepEqual(
      resolveExtras({ extras: ['git', 'rust'] }),
      ['typescript', 'git', 'ai', 'formatting', 'debug', 'rust'],
    )
  })

  it('uses explicit presets', () => {
    assert.deepEqual(resolveExtras({ preset: 'minimal', extras: ['ai'] }), ['git', 'ai'])
  })
})
