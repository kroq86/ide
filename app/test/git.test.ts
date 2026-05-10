import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  loadGitStatus,
  commitGit,
  pushGit,
  getGitLog,
  buildGitDisplayLines,
  type GitStatusData,
} from '../src/git.ts'

// Create a clean git repo once for the whole suite
let repo = ''
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'qe-git-test-'))
  spawnSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name',  'Test'],          { cwd: repo, stdio: 'ignore' })
})

describe('loadGitStatus', () => {
  it('returns a GitStatusData shape on a fresh repo', () => {
    const status = loadGitStatus(repo)
    assert.ok(typeof status.branch === 'string')
    assert.ok(Array.isArray(status.untracked))
    assert.ok(Array.isArray(status.unstaged))
    assert.ok(Array.isArray(status.staged))
    assert.equal(typeof status.ahead,  'number')
    assert.equal(typeof status.behind, 'number')
  })

  it('detects untracked files', () => {
    writeFileSync(join(repo, 'untracked.txt'), 'hello')
    const status = loadGitStatus(repo)
    const names = status.untracked.map(e => e.path)
    assert.ok(names.includes('untracked.txt'), `untracked.txt not in ${JSON.stringify(names)}`)
  })
})

describe('commitGit', () => {
  it('returns ok:false when nothing is staged', () => {
    const result = commitGit(repo, 'empty commit')
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
  })

  it('returns ok:true after staging and committing', () => {
    writeFileSync(join(repo, 'hello.txt'), 'hello')
    spawnSync('git', ['add', 'hello.txt'], { cwd: repo, stdio: 'ignore' })
    const result = commitGit(repo, 'add hello')
    assert.equal(result.ok, true, `commit failed: ${result.error ?? ''}`)
    assert.equal(result.error, undefined)
  })
})

describe('pushGit', () => {
  it('returns ok:false when there is no remote', () => {
    const result = pushGit(repo)
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
  })
})

describe('getGitLog', () => {
  it('returns an array of typed log entries', () => {
    const entries = getGitLog(repo)
    assert.ok(Array.isArray(entries))
    if (entries.length > 0) {
      const e = entries[0]!
      assert.ok(typeof e.hash === 'string')
      assert.ok(typeof e.msg  === 'string')
      assert.ok(typeof e.date === 'string')
    }
  })

  it('respects the n limit', () => {
    // add a couple commits first
    writeFileSync(join(repo, 'file2.txt'), 'a')
    spawnSync('git', ['add', 'file2.txt'], { cwd: repo, stdio: 'ignore' })
    commitGit(repo, 'second commit')
    writeFileSync(join(repo, 'file3.txt'), 'b')
    spawnSync('git', ['add', 'file3.txt'], { cwd: repo, stdio: 'ignore' })
    commitGit(repo, 'third commit')

    const all = getGitLog(repo, 100)
    const limited = getGitLog(repo, 1)
    assert.ok(limited.length <= 1)
    assert.ok(all.length >= limited.length)
  })
})

describe('buildGitDisplayLines', () => {
  it('returns an array of display lines', () => {
    const mockStatus: GitStatusData = {
      branch: 'main', ahead: 0, behind: 0,
      untracked: [], unstaged: [], staged: [],
    }
    const lines = buildGitDisplayLines(mockStatus)
    assert.ok(Array.isArray(lines))
    assert.ok(lines.length > 0)
  })

  it('includes file entries when status has staged files', () => {
    const mockStatus: GitStatusData = {
      branch: 'feature', ahead: 1, behind: 0,
      untracked: [],
      unstaged: [],
      staged: [{
        path: 'foo.ts', xy: 'M ', section: 'staged', expanded: false, hunks: [],
      }],
    }
    const lines = buildGitDisplayLines(mockStatus)
    const fileLines = lines.filter(l => l.type === 'file')
    assert.ok(fileLines.length >= 1)
    const fileLine = fileLines.find(l => l.type === 'file' && 'entry' in l && l.entry.path === 'foo.ts')
    assert.ok(fileLine, 'staged foo.ts not represented in display lines')
  })

  it('includes log entries when logEntries provided', () => {
    const mockStatus: GitStatusData = {
      branch: 'main', ahead: 0, behind: 0,
      untracked: [], unstaged: [], staged: [],
    }
    const logEntries = [
      { hash: 'abc1234', msg: 'initial commit', date: '2026-05-10' },
    ]
    const lines = buildGitDisplayLines(mockStatus, logEntries)
    const logLine = lines.find(l => l.type === 'log-entry')
    assert.ok(logLine, 'no log-entry line found')
  })
})
