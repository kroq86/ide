import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyPatchProposal,
  assessPatchRisk,
  buildReviewDiffSnippet,
  buildReviewTrace,
  buildTrace,
  collectGitDiffForReview,
  extractGitDiffForPath,
  filterReviewFindingsAgainstActiveBuffer,
  splitGitDiffIntoChunks,
  compactFixContextForPrompt,
  createFixContext,
  loadCodeClawProject,
  loadCodeClawProjectForReview,
  makeReviewTraceId,
  makeTraceId,
  isReviewNoiseDiffPath,
  normalizeProposalPath,
  normalizeUnifiedDiffForGitApply,
  parsePatchProposal,
  parseReviewProposal,
  prepareReviewGitInput,
  filterReviewGitStatusLines,
  repairUnifiedDiffHunkHeaders,
  sanitizeUnifiedDiffBareHunkLines,
  sanitizeUnifiedDiffBracketHunks,
  sanitizeUnifiedDiffGlue,
  sanitizeUnifiedDiffInterstitial,
  validateUnifiedDiffBody,
  readLatestTrace,
  writeReviewTrace,
  writeTrace,
  type PatchProposal,
} from '../src/codeclaw.ts'
import { ShellSidecar, type ShellRun } from '../src/shell.ts'

const missingProject = mkdtempSync(join(tmpdir(), 'codeclaw-missing-'))
const project = loadCodeClawProject(missingProject)
assert.match(project.rules, /Make the smallest safe change/)

const multiFileDiff = [
  'diff --git a/app/pkg.ts b/app/pkg.ts',
  '--- a/app/pkg.ts',
  '+++ b/app/pkg.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/examples/broken-counter/src/counter.ts b/examples/broken-counter/src/counter.ts',
  '--- a/examples/broken-counter/src/counter.ts',
  '+++ b/examples/broken-counter/src/counter.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n')
const bogusDup = filterReviewFindingsAgainstActiveBuffer(
  'examples/broken-counter/src/counter.ts',
  'export function sum(): number { return 1 }\n',
  [{ severity: 'blocker', file: 'examples/broken-counter/src/counter.ts', title: 'Duplicate export: sum(a, b): number', explanation: '' }],
)
assert.equal(bogusDup.length, 0)

const keptDup = filterReviewFindingsAgainstActiveBuffer(
  'src/x.ts',
  'export function sum(){return 1}\nexport function sum(){return 2}\n',
  [{ severity: 'blocker', file: 'src/x.ts', title: 'Duplicate export: sum', explanation: '' }],
)
assert.equal(keptDup.length, 1)

const bogusImport = filterReviewFindingsAgainstActiveBuffer(
  'src/x.ts',
  'export function x(){}\n',
  [{ severity: 'note', file: 'src/x.ts', title: 'Unused', explanation: 'imported from a module' }],
)
assert.equal(bogusImport.length, 0)

const bogusTwoNamedProse = filterReviewFindingsAgainstActiveBuffer(
  'src/counter.ts',
  'export function add() {}\nexport function sum() {}\n',
  [{
    severity: 'blocker',
    file: 'src/counter.ts',
    title: 'Duplicate',
    explanation: 'The file exports two functions named sum with the same parameters.',
  }],
)
assert.equal(bogusTwoNamedProse.length, 0)

const counterChunk = extractGitDiffForPath(multiFileDiff, 'examples/broken-counter/src/counter.ts')
assert.match(counterChunk, /counter\.ts/)
assert.match(counterChunk, /^diff --git/)
assert.ok(counterChunk.includes('+new'))
assert.ok(!counterChunk.includes('pkg.ts'))
const snippet = buildReviewDiffSnippet(multiFileDiff, 'examples/broken-counter/src/counter.ts', 400)
assert.ok(snippet.startsWith('diff --git'))
assert.ok(snippet.includes('counter.ts'))
assert.ok(snippet.includes('pkg.ts'), 'non-focused hunks follow focused chunk')

assert.equal(splitGitDiffIntoChunks(multiFileDiff).length, 2)

const noCounterHunk = ['diff --git a/app/z.ts b/app/z.ts', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
const hintSnippet = buildReviewDiffSnippet(noCounterHunk, 'examples/broken-counter/src/counter.ts', 500)
assert.match(hintSnippet, /No unstaged git diff entry/)
assert.ok(hintSnippet.includes('z.ts'))
assert.equal(project.memory, '')

assert.ok(isReviewNoiseDiffPath('app/package-lock.json'))
assert.ok(isReviewNoiseDiffPath('native/editor-core/Cargo.lock'))
assert.ok(isReviewNoiseDiffPath('api/go.sum'))
assert.ok(!isReviewNoiseDiffPath('app/src/main.tsx'))
assert.ok(isReviewNoiseDiffPath('.codeclaw/traces/2026-05-11T00-00-00-codeclaw-fix.json'))
assert.equal(
  filterReviewGitStatusLines('M app/src/x.ts\n?? .codeclaw/traces/foo.json'),
  'M app/src/x.ts',
)
assert.equal(
  filterReviewGitStatusLines(' M Cargo.lock\nM app/src/lib.rs'),
  'M app/src/lib.rs',
  'lockfile status lines dropped like trace dirs',
)

const lockNoiseDiff = [
  'diff --git a/app/package-lock.json b/app/package-lock.json',
  '--- a/app/package-lock.json',
  '+++ b/app/package-lock.json',
  '@@ -1 +1 @@',
  '-LOCK_OLD',
  '+LOCK_NEW',
  'diff --git a/examples/broken-counter/src/counter.ts b/examples/broken-counter/src/counter.ts',
  '--- a/examples/broken-counter/src/counter.ts',
  '+++ b/examples/broken-counter/src/counter.ts',
  '@@ -1 +1 @@',
  '-onlyCounter',
  '+counterFixed',
  '',
].join('\n')
const snippetNoLock = buildReviewDiffSnippet(lockNoiseDiff, 'examples/broken-counter/src/counter.ts', 20000)
assert.ok(!snippetNoLock.includes('LOCK_NEW'), 'package-lock chunk omitted when not focused')
assert.ok(snippetNoLock.includes('counterFixed'))

assert.match(
  prepareReviewGitInput('diff --git a/x b/x\n', '?? app/.codeclaw/traces/x.json\nM y.ts'),
  /diff --git/,
)
assert.equal(prepareReviewGitInput('', '?? .codeclaw/traces/x'), '')

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

// parsePatchProposal: unifiedDiff may be JSON array of strings (small models emit this)
const proposalDiffAsLines = parsePatchProposal(JSON.stringify({
  summary: 'array lines',
  rootCause: 'shape',
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
    ],
  }],
  verifyTask: 'npm test',
  risk: 'low',
}), missingProject)
assert.ok(proposalDiffAsLines.files[0]!.unifiedDiff.includes('-world'))

const proposalBlobLines = parsePatchProposal(JSON.stringify({
  summary: 'blobs',
  rootCause: 'multiline array elements',
  files: [{
    path: 'sample.txt',
    unifiedDiff: ['+first\n+second', '-third'],
  }],
  verifyTask: 'npm test',
  risk: 'low',
}), missingProject)
assert.ok(proposalBlobLines.files[0]!.unifiedDiff.includes('@@'))
assert.ok(proposalBlobLines.files[0]!.unifiedDiff.includes('diff --git'))

const wrapped = normalizeUnifiedDiffForGitApply('examples/foo.ts', '@@ -1,1 +1,1 @@\n-old\n+new\n')
assert.match(wrapped, /^diff --git a\/examples\/foo\.ts/)
assert.match(wrapped, /^--- a\/examples\/foo\.ts$/m)
assert.match(wrapped, /^\+\+\+ b\/examples\/foo\.ts$/m)

const barePlusMinus = normalizeUnifiedDiffForGitApply('examples/foo.ts', '-old\n+new')
assert.match(barePlusMinus, /^diff --git a\/examples\/foo\.ts/m)
assert.match(barePlusMinus, /@@ -1,1 \+1,1 @@/)

// Models emit `+ 9,5` (space after `+`) — git reports corrupt patch without normalization
const spacedHunkHeader = normalizeUnifiedDiffForGitApply(
  'examples/foo.ts',
  '@@ -1,2 + 1,2 @@\n hello\n-world\n+there\n',
)
assert.match(spacedHunkHeader, /@@ -1,2 \+1,2 @@/)
assert.ok(!spacedHunkHeader.includes('+ 1,'), 'hunk header must not keep space after +')

const hunkOnly = parsePatchProposal(JSON.stringify({
  summary: 'Fragment patch',
  rootCause: 'Model omitted git headers',
  files: [{
    path: 'sample.txt',
    unifiedDiff: '@@ -1,2 +1,2 @@\n hello\n-world\n+there\n',
  }],
  verifyCommand: 'npm test',
  risk: 'low',
}))
assert.match(hunkOnly.files[0]!.unifiedDiff, /^diff --git a\/sample\.txt/m)

const rawNoRisk = JSON.parse(JSON.stringify({
  summary: proposal.summary,
  rootCause: proposal.rootCause,
  files: proposal.files,
  verifyTask: proposal.verifyTask,
})) as Record<string, unknown>
delete rawNoRisk['risk']
assert.equal(parsePatchProposal(JSON.stringify(rawNoRisk)).risk, 'medium')
assert.equal(parsePatchProposal(JSON.stringify({ ...rawNoRisk, risk: 'LOW' })).risk, 'low')
assert.equal(parsePatchProposal(JSON.stringify({ ...rawNoRisk, risk: 'nonsense' })).risk, 'medium')
assert.equal(parsePatchProposal(JSON.stringify({ ...rawNoRisk, risk: 99 })).risk, 'medium')

assert.ok(sanitizeUnifiedDiffGlue('+++ b/foo@@ -1,2 +1,2 @@\n-x').includes('+++ b/foo\n@@'))

assert.match(sanitizeUnifiedDiffBracketHunks('[@@ -1,3 +1,3 @@]\n-old\n+new'), /^@@ -1,3 \+1,3 @@/)

const fakeRepo = mkdtempSync(join(tmpdir(), 'codeclaw-repo-'))
writeFileSync(join(fakeRepo, '.git'), '')
mkdirSync(join(fakeRepo, 'examples', 'broken-counter', 'src'), { recursive: true })
const fakeAppCwd = join(fakeRepo, 'app')
mkdirSync(fakeAppCwd, { recursive: true })
assert.equal(
  normalizeProposalPath(fakeAppCwd, '../examples/broken-counter/src/counter.ts'),
  'examples/broken-counter/src/counter.ts',
)

// sanitizeUnifiedDiffInterstitial: drop prose / echoed code between headers and @@ (git "garbage at line N")
const garbageBetweenPlusAndAt = [
  '--- a/sample.txt',
  '+++ b/sample.txt',
  'export function add(a: number, b: number): number {',
  '@@ -1,2 +1,2 @@',
  ' hello',
  '-world',
  '+there',
].join('\n')
assert.ok(!sanitizeUnifiedDiffInterstitial(garbageBetweenPlusAndAt).includes('export function add'))
const normalizedClean = normalizeUnifiedDiffForGitApply('sample.txt', garbageBetweenPlusAndAt)
assert.ok(!normalizedClean.includes('export function add'))
validateUnifiedDiffBody('sample.txt', normalizedClean)

const garbageBetweenMinusAndPlus = [
  '--- a/sample.txt',
  'NOTE FROM MODEL: fix add',
  '+++ b/sample.txt',
  '@@ -1,1 +1,1 @@',
  '-x',
  '+y',
].join('\n')
assert.ok(!sanitizeUnifiedDiffInterstitial(garbageBetweenMinusAndPlus).includes('NOTE FROM MODEL'))

// validateUnifiedDiffBody: well-formed diff passes silently
validateUnifiedDiffBody('sample.txt', [
  'diff --git a/sample.txt b/sample.txt',
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -1,2 +1,2 @@',
  ' hello',
  '-world',
  '+there',
  '',
].join('\n'))

// validateUnifiedDiffBody: prose between hunk lines is rejected with a clear, line-pointed message
assert.throws(() => validateUnifiedDiffBody('sample.txt', [
  'diff --git a/sample.txt b/sample.txt',
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -1,2 +1,2 @@',
  'Here is the fix:',
  '-world',
  '+there',
].join('\n')), /line 5 must start with/)

// validateUnifiedDiffBody: extra prose AFTER the declared hunk extent is rejected
assert.throws(() => validateUnifiedDiffBody('sample.txt', [
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  'and now some explanation',
].join('\n')), /extra content after hunk/)

// sanitizeUnifiedDiffBareHunkLines: models paste `}` without leading space inside hunks
const bareBraceInHunk = [
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+c',
  '}',
].join('\n')
assert.throws(() => validateUnifiedDiffBody('sample.txt', bareBraceInHunk), /extra content after hunk|must start with/)
assert.match(sanitizeUnifiedDiffBareHunkLines(bareBraceInHunk), /^\+c\n \}$/m)
validateUnifiedDiffBody('sample.txt', normalizeUnifiedDiffForGitApply('sample.txt', bareBraceInHunk))

// repairUnifiedDiffHunkHeaders: git rejects when declared hunk line counts ≠ body (models emit random `7,7`)
const miscountedHunk = [
  'diff --git a/sample.txt b/sample.txt',
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -2,9 +2,9 @@',
  '-one',
  '+ONE',
  ' ctx',
].join('\n')
assert.match(repairUnifiedDiffHunkHeaders(miscountedHunk), /@@ -2,2 \+2,2 @@/)

const skipsGarbageFiles = parsePatchProposal(JSON.stringify({
  summary: 'ok',
  rootCause: 'ok',
  files: [proposal.files[0], null, 'not-an-object', { path: 'nope.txt', unifiedDiff: '' }],
  verifyTask: proposal.verifyTask,
  risk: 'low',
}))
assert.equal(skipsGarbageFiles.files.length, 1)
assert.ok(skipsGarbageFiles.notes?.some(n => /Skipped invalid/.test(n)))

const gluedDiffProposal = parsePatchProposal(JSON.stringify({
  summary: 'glue',
  rootCause: 'glue',
  files: [{
    path: 'sample.txt',
    unifiedDiff: [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt@@ -1,2 +1,2 @@',
      ' hello',
      '-world',
      '+there',
      '',
    ].join('\n'),
  }],
  verifyTask: 'npm test',
  risk: 'low',
}))
assert.match(gluedDiffProposal.files[0]!.unifiedDiff, /\+\+\+ b\/sample\.txt\n@@/)

assert.throws(
  () => parsePatchProposal('{"summary":"missing fields"}'),
  /rootCause/,
)

assert.throws(
  () => parsePatchProposal(JSON.stringify({
    summary: 'x',
    rootCause: 'y',
    files: [null, null],
    verifyTask: 'npm test',
    risk: 'low',
  })),
  /no valid proposal files/,
)

assert.throws(
  () => parsePatchProposal(JSON.stringify({ version: 4, text: 'Fix this CodeClaw review finding…' })),
  /narrative JSON/,
)

assert.throws(
  () => parsePatchProposal(JSON.stringify({
    rules: ['- Make the smallest safe change.'],
    memory: '',
    userRequest: 'Fix finding',
    finding: { description: 'Bad constants' },
  })),
  /echoed session-shaped JSON/,
)

assert.throws(
  () =>
    parsePatchProposal(
      JSON.stringify({ summary: 'x', rootCause: 'y', verifyTask: 'npm test', risk: 'low' }),
    ),
  /files/,
)

assert.throws(
  () =>
    parsePatchProposal(
      JSON.stringify({
        summary: 'x',
        rootCause: 'y',
        files: [],
        verifyTask: 'npm test',
        risk: 'low',
      }),
    ),
  /files/,
)

assert.throws(
  () =>
    parsePatchProposal(
      JSON.stringify({
        summary: 'x',
        rootCause: 'y',
        files: [{
          path: 'sample.txt',
          unifiedDiff: [
            'diff --git a/sample.txt b/sample.txt',
            '--- a/sample.txt',
            '+++ b/sample.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
          ].join('\n'),
        }],
        verifyTask: 123,
        risk: 'low',
      }),
    ),
  /verifyTask|validation/i,
)

const reviewOk = parseReviewProposal(JSON.stringify({
  summary: 'Looks good',
  safeToCommit: true,
  findings: [{ severity: 'note', file: 'a.ts', title: 'Nit', explanation: 'Minor' }],
}))
assert.equal(reviewOk.summary, 'Looks good')
assert.equal(reviewOk.safeToCommit, true)
assert.equal(reviewOk.findings.length, 1)

const reviewBadFindingsShape = parseReviewProposal(JSON.stringify({
  summary: 'x',
  findings: 'not-an-array',
}))
assert.equal(reviewBadFindingsShape.summary, 'Invalid response shape')
assert.equal(reviewBadFindingsShape.findings.length, 0)

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

const pad = 'z'.repeat(50000)
const hugeCtx = createFixContext({
  ...context,
  rules: pad,
  userRequest: pad,
  git: { branch: 'x', status: pad, diff: pad },
  lastFailedRun: {
    ...context.lastFailedRun,
    stdout: pad,
    stderr: pad,
  },
})
const compact = compactFixContextForPrompt(hugeCtx)
assert.ok(compact.rules.length < 9000, 'rules capped for prompt')
assert.ok(compact.git.status.length < 4500, 'git status capped')
assert.ok(compact.git.diff.length < 12100, 'git diff capped')
assert.ok(compact.lastFailedRun.stdout.length < 6100)
assert.ok(compact.lastFailedRun.stderr.length < 6100)
assert.match(JSON.stringify(compact), /truncated/)

const traceId = makeTraceId(new Date('2026-05-10T18:42:11Z'))
assert.equal(traceId, '2026-05-10T18-42-11-codeclaw-fix')
assert.equal(makeReviewTraceId(new Date('2026-05-10T18:42:11Z')), '2026-05-10T18-42-11-codeclaw-review')
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

const traceReviewDelegation = buildTrace(traceId, '2026-05-10T18:42:11Z', context, proposal, true, undefined, undefined, 'codeclaw_review')
assert.equal(traceReviewDelegation.verifyDelegation, 'codeclaw_review')
assert.equal(traceReviewDelegation.verify, undefined)

const nestedRoot = mkdtempSync(join(tmpdir(), 'codeclaw-nested-'))
mkdirSync(join(nestedRoot, '.codeclaw'), { recursive: true })
writeFileSync(join(nestedRoot, '.codeclaw', 'rules.md'), 'ROOT RULE')
mkdirSync(join(nestedRoot, 'pkg', '.codeclaw'), { recursive: true })
writeFileSync(join(nestedRoot, 'pkg', '.codeclaw', 'rules.md'), 'PKG RULE')
const mergedRules = loadCodeClawProjectForReview(nestedRoot, 'pkg/src/foo.ts')
assert.match(mergedRules.rules, /^PKG RULE/)
assert.match(mergedRules.rules, /ROOT RULE/)

const reviewTrace = buildReviewTrace({
  id: 'review-1',
  startedAt: '2026-05-10T18:42:11Z',
  endedAt: '2026-05-10T18:42:12Z',
  activeFile: 'pkg/src/foo.ts',
  openBuffers: [],
  diffChars: 3,
  status: 'ok',
  proposal: { summary: 'ok', findings: [], safeToCommit: true },
})
assert.equal(reviewTrace.workflow, 'review')
const reviewPath = writeReviewTrace(nestedRoot, reviewTrace)
assert.match(reviewPath, /traces[/\\]review[/\\]review-1\.json$/)

assert.equal(assessPatchRisk(proposal).level, 'low')
assert.equal(assessPatchRisk({
  ...proposal,
  files: [...proposal.files, { path: 'extra.txt', unifiedDiff: proposal.files[0]!.unifiedDiff.replaceAll('sample.txt', 'extra.txt') }],
}).level, 'medium')
assert.equal(assessPatchRisk({ ...proposal, verifyTask: '' }).level, 'high')
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

const repoHunk = mkdtempSync(join(tmpdir(), 'codeclaw-hunk-'))
spawnSync('git', ['init'], { cwd: repoHunk, stdio: 'ignore' })
writeFileSync(join(repoHunk, 'sample.txt'), 'hello\nworld\n')
const okHunk = applyPatchProposal(repoHunk, hunkOnly)
assert.deepEqual(okHunk, { ok: true })
assert.equal(readFileSync(join(repoHunk, 'sample.txt'), 'utf8'), 'hello\nthere\n')

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

const repoRootForGit = join(new URL('../..', import.meta.url).pathname)
assert.equal(typeof collectGitDiffForReview(repoRootForGit), 'string')

console.log('codeclaw tests passed')
