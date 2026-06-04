import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildErrorAt, buildPanelState, moveBuildErrorCursor, type LastTaskRunState } from '../src/build-panel.ts'

describe('build panel model', () => {
  it('collects parsed locations from build and run phases', () => {
    const lastRun: LastTaskRunState = {
      task: { name: 'typecheck', command: 'npm run typecheck', runCommand: 'npm test' },
      result: {
        build: {
          id: '1',
          command: 'npm run typecheck',
          cwd: '/repo',
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          exitCode: 0,
          stdout: '',
          stderr: '',
          locations: [{ file: 'src/a.ts', row: 1, col: 2, message: 'bad a' }],
        },
        run: {
          id: '2',
          command: 'npm test',
          cwd: '/repo/app',
          startedAt: '2026-01-01T00:00:01.000Z',
          endedAt: '2026-01-01T00:00:03.000Z',
          exitCode: 1,
          stdout: '',
          stderr: '',
          locations: [{ file: 'test/a.test.ts', row: 3, col: 4, message: 'bad test' }],
        },
        final: {
          id: '2',
          command: 'npm test',
          cwd: '/repo/app',
          startedAt: '2026-01-01T00:00:01.000Z',
          endedAt: '2026-01-01T00:00:03.000Z',
          exitCode: 1,
          stdout: '',
          stderr: '',
          locations: [{ file: 'test/a.test.ts', row: 3, col: 4, message: 'bad test' }],
        },
      },
    }

    const state = buildPanelState(lastRun)
    assert.equal(state?.taskName, 'typecheck')
    assert.equal(state?.elapsedMs, 2000)
    assert.equal(state?.succeeded, false)
    assert.deepEqual(state?.errors.map(error => `${error.cwd}:${error.file}:${error.row}:${error.col}`), [
      '/repo:src/a.ts:1:2',
      '/repo/app:test/a.test.ts:3:4',
    ])
  })

  it('wraps build error cursor movement', () => {
    const state = {
      taskName: 't',
      command: 'cmd',
      cwd: '/repo',
      elapsedMs: null,
      exitCode: 1,
      succeeded: false,
      errors: [
        { file: 'a.ts', row: 0, col: 0, message: '', cwd: '/repo', command: 'cmd', runId: '1' },
        { file: 'b.ts', row: 1, col: 0, message: '', cwd: '/repo', command: 'cmd', runId: '1' },
      ],
    }

    assert.equal(moveBuildErrorCursor(state, 0, -1), 1)
    assert.equal(moveBuildErrorCursor(state, 1, 1), 0)
    assert.equal(buildErrorAt(state, -1)?.file, 'b.ts')
  })
})
