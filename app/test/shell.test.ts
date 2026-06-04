import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  finalizeTimedOutRun,
  parseConfiguredErrorLine,
  parseErrorLine,
  parseErrorLineWithCompiledRegex,
  type ShellRun,
} from '../src/shell.ts'

describe('shell error parsing', () => {
  it('parses configured named groups into zero-indexed locations', () => {
    const loc = parseConfiguredErrorLine(
      'src/main.go:12:5: boom',
      '^(?<file>.*):(?<line>\\d+):(?<col>\\d+): (?<message>.*)$',
    )
    assert.deepEqual(loc, {
      file: 'src/main.go',
      row: 11,
      col: 4,
      message: 'boom',
    })
  })

  it('keeps built-in TypeScript parsing', () => {
    const parsed = parseErrorLine('src/app.ts(3,7): error TS2322: no')
    assert.equal(parsed.isError, true)
    assert.deepEqual(parsed.location, {
      file: 'src/app.ts',
      row: 2,
      col: 6,
      message: 'no',
    })
  })

  it('parses configured locations with a precompiled regex', () => {
    const parsed = parseErrorLineWithCompiledRegex(
      'src/main.go:12:5: boom',
      /^(?<file>.*):(?<line>\d+):(?<col>\d+): (?<message>.*)$/,
    )

    assert.equal(parsed.isError, true)
    assert.deepEqual(parsed.location, {
      file: 'src/main.go',
      row: 11,
      col: 4,
      message: 'boom',
    })
  })

  it('finalizes timed out runs consistently', () => {
    const run: ShellRun = {
      id: '1',
      command: 'sleep 10',
      cwd: '/repo',
      startedAt: '2026-01-01T00:00:00.000Z',
      stdout: '',
      stderr: '',
      locations: [],
    }

    finalizeTimedOutRun(run, 2)

    assert.equal(run.exitCode, 124)
    assert.match(run.endedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(run.stderr, 'command timed out after 2s')
  })
})
