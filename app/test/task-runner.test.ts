import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { firstTaskLocation, runTaskProfile, taskSucceeded } from '../src/task-runner.ts'
import type { TrackedShellResult } from '../src/shell.ts'

describe('task runner', () => {
  it('runs build then runCommand only after success', async () => {
    const calls: Array<{ command: string; cwd?: string }> = []
    const shell = {
      async runTracked(command: string, options?: { cwd?: string }): Promise<TrackedShellResult> {
        calls.push({ command, cwd: options?.cwd })
        return {
          id: command,
          command,
          cwd: options?.cwd ?? process.cwd(),
          startedAt: '',
          endedAt: '',
          exitCode: 0,
          stdout: '',
          stderr: '',
          locations: command === 'build' ? [{ file: 'src/a.ts', row: 1, col: 2, message: 'bad' }] : [],
        }
      },
    }

    const result = await runTaskProfile({ name: 't', command: 'build', runCommand: 'run', cwd: 'app' }, shell)
    assert.deepEqual(calls, [{ command: 'build', cwd: 'app' }, { command: 'run', cwd: 'app' }])
    assert.equal(taskSucceeded(result), true)
    assert.deepEqual(firstTaskLocation(result), { file: 'src/a.ts', row: 1, col: 2, message: 'bad' })
  })

  it('skips runCommand after build failure', async () => {
    const calls: string[] = []
    const shell = {
      async runTracked(command: string): Promise<TrackedShellResult> {
        calls.push(command)
        return {
          id: command,
          command,
          cwd: process.cwd(),
          startedAt: '',
          endedAt: '',
          exitCode: 1,
          stdout: '',
          stderr: '',
          locations: [],
        }
      },
    }

    const result = await runTaskProfile({ name: 't', command: 'build', runCommand: 'run' }, shell)
    assert.deepEqual(calls, ['build'])
    assert.equal(taskSucceeded(result), false)
  })
})
