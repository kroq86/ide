import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { troubleshootingRows } from '../src/troubleshooting.ts'

describe('troubleshootingRows', () => {
  it('reports shell, index, command, buffer, and sidecar state', () => {
    const rows = troubleshootingRows({
      configPath: '/home/me/.config/qe/config.ts',
      projectRoot: '/repo',
      workspaceRoots: ['/repo', '/repo/app'],
      aiModelLabel: 'openai:gpt',
      shellMode: 'runner',
      shellSpawnError: 'pty unavailable',
      lastRun: null,
      lastFailedRun: {
        id: 'r1',
        command: 'npm test',
        cwd: '/repo',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        exitCode: 1,
        stdout: '',
        stderr: '',
        locations: [{ file: 'a.ts', row: 0, col: 0, message: 'bad' }],
      },
      indexedFileCount: 42,
      commandCounts: { builtin: 10, config: 2, plugin: 1, eval: 3 },
      openBufferCount: 4,
      temporaryBufferCount: 1,
      activeFile: '/repo/a.ts',
      mode: 'normal',
      sidecarBinaryPath: '/repo/native/editor-core/target/release/editor-core',
      sidecarStatus: 'active',
    })

    const byLabel = new Map(rows.map(row => [row.label, row.value]))
    assert.equal(byLabel.get('shell'), 'runner (pty unavailable)')
    assert.equal(byLabel.get('workspace index'), '42 files')
    assert.equal(byLabel.get('commands'), 'builtin:10 config:2 plugin:1 eval:3')
    assert.equal(byLabel.get('buffers'), '4 open, 1 temporary')
    assert.match(byLabel.get('last failed run') ?? '', /npm test \(exit 1, 1 location\)/)
    assert.match(byLabel.get('sidecar') ?? '', /active: .*editor-core/)
  })
})
