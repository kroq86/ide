import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyPatchProposal,
  assessPatchRisk,
  buildTrace,
  createFixContext,
  loadCodeClawProject,
  makeTraceId,
  parsePatchProposal,
  readLatestTrace,
  writeTrace,
  type PatchProposal,
} from '../src/codeclaw.ts'
import { ShellSidecar, type ShellRun } from '../src/shell.ts'

const missingProject = mkdtempSync(join(tmpdir(), 'codeclaw-missing-'))
const project = loadCodeClawProject(missingProject)
assert.match(project.rules, /Make the smallest safe change/)
assert.equal(project.memory, '')

const proposal = parsePatchProposal(JSON.stringify({
  summary: 'Fix greeting',
  rootCause: 'The expected word changed.',
  files: [{
    path: 'sample.txt',
    unifiedDiff: [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1,2 +1,2 @@',
      ' hello',
      '-world',
      '+there',
      '',
    ].join('\n'),
  }],
  verifyCommand: 'npm test',
  risk: 'low',
}))
assert.equal(proposal.files[0]?.path, 'sample.txt')

assert.throws(
  () => parsePatchProposal('{"summary":"missing fields"}'),
  /rootCause/,
)

const context = createFixContext({
  activeFile: { path: 'sample.txt', content: 'hello\nworld\n', cursor: { line: 1, column: 1 } },
  openBuffers: [{ path: 'sample.txt', content: 'hello\nworld\n' }],
  lastFailedRun: {
    id: 'run-1',
    command: 'npm test',
    cwd: missingProject,
    startedAt: '2026-05-10T18:41:00Z',
    endedAt: '2026-05-10T18:41:02Z',
    exitCode: 1,
    stderr: 'Expected there',
    stdout: 'FAILED sample',
    locations: [{ file: 'sample.txt', row: 1, col: 0, message: 'mismatch' }],
  },
  git: { branch: 'main', status: ' M sample.txt', diff: '' },
  rules: project.rules,
  memory: project.memory,
  userRequest: 'Fix this failure using current session context.',
})
assert.equal(context.lastFailedRun.locations[0]?.row, 1)

const traceId = makeTraceId(new Date('2026-05-10T18:42:11Z'))
assert.equal(traceId, '2026-05-10T18-42-11-codeclaw-fix')
const trace = buildTrace(traceId, '2026-05-10T18:42:11Z', context, proposal, true, {
  run: {
    id: 'run-2',
    command: 'npm test',
    cwd: missingProject,
    startedAt: '2026-05-10T18:42:12Z',
    endedAt: '2026-05-10T18:42:13Z',
    stdout: 'ok',
    stderr: '',
    locations: [],
    exitCode: 0,
  },
})
const tracePath = writeTrace(missingProject, trace)
const savedTrace = JSON.parse(readFileSync(tracePath, 'utf8')) as { verify?: { passed?: boolean } }
assert.equal(savedTrace.verify?.passed, true)
assert.equal(readLatestTrace(missingProject)?.trace.id, traceId)

assert.equal(assessPatchRisk(proposal).level, 'low')
assert.equal(assessPatchRisk({
  ...proposal,
  files: [...proposal.files, { path: 'extra.txt', unifiedDiff: proposal.files[0]!.unifiedDiff.replaceAll('sample.txt', 'extra.txt') }],
}).level, 'medium')
assert.equal(assessPatchRisk({ ...proposal, verifyCommand: '' }).level, 'high')
assert.equal(assessPatchRisk({
  ...proposal,
  files: [{ path: 'package-lock.json', unifiedDiff: proposal.files[0]!.unifiedDiff.replaceAll('sample.txt', 'package-lock.json') }],
}).canAutoApply, false)

const repo = mkdtempSync(join(tmpdir(), 'codeclaw-patch-'))
spawnSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
writeFileSync(join(repo, 'sample.txt'), 'hello\nworld\n')

const ok = applyPatchProposal(repo, proposal)
assert.deepEqual(ok, { ok: true })
assert.equal(readFileSync(join(repo, 'sample.txt'), 'utf8'), 'hello\nthere\n')

const badProposal: PatchProposal = {
  ...proposal,
  files: [{
    path: 'sample.txt',
    unifiedDiff: [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1,2 +1,2 @@',
      ' hello',
      '-missing',
      '+broken',
      '',
    ].join('\n'),
  }],
}
const beforeBadApply = readFileSync(join(repo, 'sample.txt'), 'utf8')
const bad = applyPatchProposal(repo, badProposal)
assert.equal(bad.ok, false)
assert.equal(readFileSync(join(repo, 'sample.txt'), 'utf8'), beforeBadApply)

const highRisk = applyPatchProposal(repo, {
  ...proposal,
  files: [{ path: 'package-lock.json', unifiedDiff: proposal.files[0]!.unifiedDiff.replaceAll('sample.txt', 'package-lock.json') }],
})
assert.equal(highRisk.ok, false)

const fixtureResult = spawnSync('npm', ['--prefix', 'examples/broken-counter', 'test'], {
  cwd: join(new URL('../..', import.meta.url).pathname),
  encoding: 'utf8',
})
assert.notEqual(fixtureResult.status, 0)
assert.match(`${fixtureResult.stdout}\n${fixtureResult.stderr}`, /2 !== 5|Expected values to be strictly equal/)

const shell = new ShellSidecar(missingProject, 80, 20, { forceRunner: true })
const run: ShellRun = await shell.runTracked('node -e "console.error(\'src/foo.ts(2,3): error TS1234: bad\'); process.exit(7)"')
assert.equal(shell.mode, 'runner')
assert.equal(run.exitCode, 7)
assert.ok(run.startedAt)
assert.ok(run.endedAt)
assert.match(run.stderr, /TS1234/)
assert.match(shell.lines.map(line => line.text).join('\n'), /TS1234/)
assert.equal(run.locations[0]?.file, 'src/foo.ts')
assert.equal(shell.lastFailedRun?.id, run.id)
shell.kill()

console.log('codeclaw tests passed')
