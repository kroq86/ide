import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  loadGitStatus,
  commitGit,
  pushGit,
  getGitLog,
  GIT_LOG_MAGIT_COUNT,
  buildGitDisplayLines,
  loadFileHunks,
  getGitRepoRoot,
  hunkNewStartRow,
  resolveRepoFilePath,
  buildMyersGitHunks,
  formatEditorVsDiskMyersSnippet,
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

describe('getGitLog', () => {
  it('returns author and subject after at least one commit', () => {
    const path = 'logged-file.txt'
    writeFileSync(join(repo, path), 'v1')
    spawnSync('git', ['add', '--', path], { cwd: repo, stdio: 'ignore' })
    const msg = `log-parse ${Date.now()}`
    assert.equal(commitGit(repo, msg).ok, true)
    const entries = getGitLog(repo, 8)
    assert.ok(entries.length >= 1)
    assert.ok(entries.some(e => e.msg === msg))
    const hit = entries.find(e => e.msg === msg)
    assert.ok(hit?.hash && hit.author.length > 0 && hit.date.length > 0)
  })

  it('defaults to GIT_LOG_MAGIT_COUNT max', () => {
    assert.ok(GIT_LOG_MAGIT_COUNT >= 40)
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

describe('getGitRepoRoot', () => {
  it('returns top-level from a nested cwd', () => {
    const nested = join(repo, 'rootprobe-nested')
    mkdirSync(nested, { recursive: true })
    assert.equal(realpathSync(getGitRepoRoot(nested)), realpathSync(repo))
  })
})

describe('hunkNewStartRow', () => {
  it('parses unified diff @@ line for new-file side', () => {
    assert.equal(hunkNewStartRow('@@ -10,7 +22,9 @@ fn foo'), 21)
    assert.equal(hunkNewStartRow('@@ -0,0 +1,5 @@'), 0)
    assert.equal(hunkNewStartRow('bad'), null)
  })
})

describe('resolveRepoFilePath', () => {
  it('joins repo root with relative path', () => {
    assert.equal(
      resolveRepoFilePath(repo, 'x/y.txt'),
      resolvePath(join(getGitRepoRoot(repo), 'x/y.txt')),
    )
  })
})

describe('loadFileHunks', () => {
  it('loads unstaged diff when cwd is a subdirectory (pathspecs are repo-relative)', () => {
    const deepDir = join(repo, 'diff-from-subdir')
    mkdirSync(deepDir, { recursive: true })
    const rel = 'diff-from-subdir/watched.txt'
    writeFileSync(join(repo, rel), 'line1\n')
    spawnSync('git', ['add', '--', rel], { cwd: repo, stdio: 'ignore' })
    commitGit(repo, 'add watched')
    writeFileSync(join(repo, rel), 'line1\nline2\n')
    const hunks = loadFileHunks(deepDir, rel, 'unstaged')
    assert.ok(hunks.length > 0, 'diff should not be empty when git runs from repo root')
    assert.ok(
      hunks.some(h => h.lines.some(l => l.startsWith('+') || l.startsWith('-'))),
      'expected +/- diff lines',
    )
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

  it('status view hints ll for log; log view lists selectable commits', () => {
    const mockStatus: GitStatusData = {
      branch: 'main', ahead: 0, behind: 0,
      untracked: [], unstaged: [], staged: [],
    }
    const hint = buildGitDisplayLines(mockStatus, null, 'status').find(l => l.type === 'log-header')
    assert.ok(hint?.text.includes('l l'), 'status should hint Magit-style ll')

    const logEntries = [
      { hash: 'abc1234', author: 'Ada', msg: 'initial commit', date: '2026-05-10' },
    ]
    const lines = buildGitDisplayLines(mockStatus, logEntries, 'log')
    const logLine = lines.find(l => l.type === 'log-entry')
    assert.ok(logLine && logLine.selectable, 'log view should have selectable log-entry lines')
    assert.ok(logLine.logEntry.author.includes('Ada'))
  })
})

describe('buildMyersGitHunks', () => {
  it('produces -/+ lines and @@ headers (display-only; not for git apply)', () => {
    const hunks = buildMyersGitHunks('a\nb\nc', 'a\nY\nc')
    assert.equal(hunks.length, 1)
    assert.match(hunks[0]!.header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    assert.ok(hunks[0]!.lines.some(l => l.startsWith('-b')))
    assert.ok(hunks[0]!.lines.some(l => l.startsWith('+Y')))
  })
})

describe('formatEditorVsDiskMyersSnippet', () => {
  it('returns empty when disk matches editor', () => {
    const path = 'myers-disk-match.txt'
    writeFileSync(join(repo, path), 'one\ntwo\n')
    assert.equal(formatEditorVsDiskMyersSnippet(repo, path, 'one\ntwo\n'), '')
  })

  it('returns Myers +/- snippet when buffer differs from disk', () => {
    const path = 'myers-disk-diff.txt'
    writeFileSync(join(repo, path), 'one\ntwo\n')
    const s = formatEditorVsDiskMyersSnippet(repo, path, 'one\nTWO\n')
    assert.match(s, /^-two/)
    assert.match(s, /^\+TWO/m)
  })
})
