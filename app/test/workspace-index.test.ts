import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkspaceIndex, buildWorkspaceIndexAsync, workspaceIndexCandidates } from '../src/workspace-index.ts'

describe('workspace index', () => {
  it('indexes roots and respects ignore with allow override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-workspace-index-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'src', 'main.ts'), 'export const x = 1\n')
    writeFileSync(join(root, 'dist', 'hidden.ts'), 'hidden\n')
    writeFileSync(join(root, 'dist', 'keep.ts'), 'keep\n')

    const index = await buildWorkspaceIndexAsync(root, {
      roots: ['.'],
      allow: ['dist/keep.ts'],
    })
    const candidates = workspaceIndexCandidates(index)

    assert.ok(candidates.includes('src/main.ts'))
    assert.ok(candidates.includes('dist/keep.ts'))
    assert.equal(candidates.includes('dist/hidden.ts'), false)
  })

  it('reuses unchanged entries from a previous index', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-workspace-index-'))
    writeFileSync(join(root, 'a.ts'), 'alpha\n')
    const first = buildWorkspaceIndex(root)
    const second = buildWorkspaceIndex(root, undefined, first)
    assert.deepEqual(second.entries[0], first.entries[0])
  })

  it('dedupes overlapping roots and candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-workspace-index-'))
    mkdirSync(join(root, 'app', 'src'), { recursive: true })
    writeFileSync(join(root, 'app', 'src', 'main.ts'), 'export const x = 1\n')

    const index = await buildWorkspaceIndexAsync(root, { roots: ['.', 'app'] })
    const candidates = workspaceIndexCandidates(index)

    assert.deepEqual(index.roots, ['.'])
    assert.equal(candidates.filter(path => path === 'app/src/main.ts').length, 1)
  })
})
