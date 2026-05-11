import { spawnSync } from 'node:child_process'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { debugLog, getDebugLogPath, resetDebugLogPathForTests } from '../src/debug-log.ts'

describe('debug-log', () => {
  let tmp: string
  let logPath: string
  const prevLog = process.env['QE_DEBUG_LOG']
  const prevDbg = process.env['QE_DEBUG']

  beforeEach(() => {
    resetDebugLogPathForTests()
    tmp = mkdtempSync(join(tmpdir(), 'qe-debug-log-'))
    logPath = join(tmp, 'out.log')
    process.env['QE_DEBUG_LOG'] = logPath
    delete process.env['QE_DEBUG']
    resetDebugLogPathForTests()
  })

  afterEach(() => {
    resetDebugLogPathForTests()
    if (prevLog !== undefined) process.env['QE_DEBUG_LOG'] = prevLog
    else delete process.env['QE_DEBUG_LOG']
    if (prevDbg !== undefined) process.env['QE_DEBUG'] = prevDbg
    else delete process.env['QE_DEBUG']
    try {
      rmSync(tmp, { recursive: true })
    } catch {
      /* ignore */
    }
  })

  it('writes one JSON line per debugLog call', () => {
    assert.equal(getDebugLogPath(), logPath)
    debugLog('test', 'hello', { n: 1 })
    const raw = readFileSync(logPath, 'utf8').trimEnd().split('\n')
    assert.equal(raw.length, 1)
    const row = JSON.parse(raw[0]!) as { scope: string; message: string; n?: number }
    assert.equal(row.scope, 'test')
    assert.equal(row.message, 'hello')
    assert.equal(row.n, 1)
    assert.ok(typeof (row as { ts: string }).ts === 'string')
  })

  it('QE_DEBUG=1 resolves log path to git worktree root (not cwd under monorepo app/)', () => {
    const prevDbg = process.env['QE_DEBUG']
    const prevLog = process.env['QE_DEBUG_LOG']
    delete process.env['QE_DEBUG_LOG']
    process.env['QE_DEBUG'] = '1'

    const tmp = mkdtempSync(join(tmpdir(), 'qe-debug-git-'))
    const init = spawnSync('git', ['init'], { cwd: tmp, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)

    const sub = join(tmp, 'app')
    mkdirSync(sub, { recursive: true })
    const prevCwd = process.cwd()
    try {
      process.chdir(sub)
      resetDebugLogPathForTests()
      const actual = getDebugLogPath()
      assert.ok(actual)
      assert.equal(basename(actual!), 'qe-debug.log')
      assert.equal(basename(dirname(actual!)), '.qe')
      assert.equal(realpathSync(dirname(dirname(actual!))), realpathSync(tmp))
    } finally {
      process.chdir(prevCwd)
      rmSync(tmp, { recursive: true, force: true })
      resetDebugLogPathForTests()
      if (prevLog !== undefined) process.env['QE_DEBUG_LOG'] = prevLog
      else delete process.env['QE_DEBUG_LOG']
      if (prevDbg !== undefined) process.env['QE_DEBUG'] = prevDbg
      else delete process.env['QE_DEBUG']
      resetDebugLogPathForTests()
    }
  })
})
