import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findProjectContext,
  buildShellContext,
  buildProjectMemoryPart,
} from '../src/ai.ts'
import type { ShellSession } from '../src/shell.ts'

// ── findProjectContext ────────────────────────────────────────────────────────

describe('findProjectContext', () => {
  it('returns empty string for null path', () => {
    assert.equal(findProjectContext(null), '')
  })

  it('returns empty string when no package.json found', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qe-ai-ctx-'))
    const result = findProjectContext(join(tmp, 'src', 'index.ts'))
    assert.equal(result, '')
  })

  it('includes npm scripts when package.json has them', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qe-ai-ctx-'))
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc', test: 'vitest', dev: 'vite' },
    }))
    const result = findProjectContext(join(tmp, 'src', 'index.ts'))
    assert.ok(result.includes('build'), `missing 'build' in: ${result}`)
    assert.ok(result.includes('test'),  `missing 'test' in: ${result}`)
    assert.ok(result.includes('npm scripts'), `missing 'npm scripts' header in: ${result}`)
  })

  it('includes available runners from devDependencies', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qe-ai-ctx-'))
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest' },
      devDependencies: { vitest: '^1.0.0', tsx: '^4.0.0' },
    }))
    const result = findProjectContext(join(tmp, 'index.ts'))
    assert.ok(result.includes('vitest'), `missing 'vitest' runner in: ${result}`)
    assert.ok(result.includes('tsx'),    `missing 'tsx' runner in: ${result}`)
  })

  it('returns empty string when package.json has no scripts', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qe-ai-ctx-'))
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'myapp' }))
    const result = findProjectContext(join(tmp, 'index.ts'))
    assert.equal(result, '')
  })
})

// ── buildShellContext ─────────────────────────────────────────────────────────

describe('buildShellContext', () => {
  it('returns empty string when no sessions and no fallback', () => {
    assert.equal(buildShellContext(), '')
    assert.equal(buildShellContext([]), '')
  })

  it('returns empty string for empty session array', () => {
    assert.equal(buildShellContext([]), '')
  })

  it('includes the command prompt for each session', () => {
    const sessions: ShellSession[] = [{
      id: 's1', command: 'npm test',
      cwd: '/tmp', startedAt: new Date().toISOString(),
      stdout: 'ok\npassed', stderr: '', exitCode: 0, locations: [],
    }]
    const result = buildShellContext(sessions)
    assert.ok(result.includes('$ npm test'), `missing prompt in: ${result}`)
    assert.ok(result.includes('ok'),         `missing stdout in: ${result}`)
  })

  it('marks non-zero exit code', () => {
    const sessions: ShellSession[] = [{
      id: 's1', command: 'npm test',
      cwd: '/tmp', startedAt: new Date().toISOString(),
      stdout: 'FAIL', stderr: 'error', exitCode: 1, locations: [],
    }]
    const result = buildShellContext(sessions)
    assert.ok(result.includes('[exit 1]'), `missing exit mark in: ${result}`)
  })

  it('only uses last 3 sessions', () => {
    const sessions: ShellSession[] = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`, command: `cmd${i}`,
      cwd: '/tmp', startedAt: new Date().toISOString(),
      stdout: `out${i}`, stderr: '', exitCode: 0, locations: [],
    }))
    const result = buildShellContext(sessions)
    // Should include sessions 3, 4, 5 but not 0, 1, 2
    assert.ok(!result.includes('cmd0'), `too-old session cmd0 found in: ${result}`)
    assert.ok(!result.includes('cmd1'), `too-old session cmd1 found in: ${result}`)
    assert.ok(result.includes('cmd3'),  `session cmd3 missing from: ${result}`)
    assert.ok(result.includes('cmd5'),  `session cmd5 missing from: ${result}`)
  })

  it('caps each session output to 10 lines', () => {
    const longOutput = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const sessions: ShellSession[] = [{
      id: 's1', command: 'run',
      cwd: '/tmp', startedAt: new Date().toISOString(),
      stdout: longOutput, stderr: '', exitCode: 0, locations: [],
    }]
    const result = buildShellContext(sessions)
    // Only last 10 lines should appear → line10..line19
    assert.ok(!result.includes('line0'),  `early line0 leaked into: ${result}`)
    assert.ok(result.includes('line19'), `latest line19 missing from: ${result}`)
  })

  it('uses fallbackLines when no sessions', () => {
    const fallback = [
      { text: 'compiled OK', isError: false },
      { text: 'warning: unused var', isError: false },
    ]
    const result = buildShellContext([], fallback)
    assert.ok(result.includes('compiled OK'), `fallback line missing from: ${result}`)
  })
})

// ── buildProjectMemoryPart ────────────────────────────────────────────────────

describe('buildProjectMemoryPart', () => {
  it('returns empty string when both undefined', () => {
    assert.equal(buildProjectMemoryPart(undefined, undefined), '')
  })

  it('returns empty string when both empty/whitespace', () => {
    assert.equal(buildProjectMemoryPart('   ', '\n'), '')
  })

  it('includes rules section when rules provided', () => {
    const result = buildProjectMemoryPart('use strict TypeScript', undefined)
    assert.ok(result.includes('Project rules:'), `missing header in: ${result}`)
    assert.ok(result.includes('use strict TypeScript'), `missing rules in: ${result}`)
  })

  it('includes memory section when memory provided', () => {
    const result = buildProjectMemoryPart(undefined, 'last fix: bug in shell.ts')
    assert.ok(result.includes('Project memory:'), `missing header in: ${result}`)
    assert.ok(result.includes('last fix: bug in shell.ts'), `missing memory in: ${result}`)
  })

  it('includes both sections when both provided', () => {
    const result = buildProjectMemoryPart('rules text', 'memory text')
    assert.ok(result.includes('Project rules:'),  `missing rules header in: ${result}`)
    assert.ok(result.includes('Project memory:'), `missing memory header in: ${result}`)
    assert.ok(result.includes('rules text'),  `missing rules content in: ${result}`)
    assert.ok(result.includes('memory text'), `missing memory content in: ${result}`)
  })

  it('caps rules at 800 characters', () => {
    const long = 'x'.repeat(1200)
    const result = buildProjectMemoryPart(long, undefined)
    // The rules section text should be capped — result won't include the 801st char
    const idx = result.indexOf('Project rules:')
    const section = result.slice(idx)
    assert.ok(section.length < 900, `rules section not capped: ${section.length} chars`)
  })

  it('caps memory at 800 characters', () => {
    const long = 'y'.repeat(1200)
    const result = buildProjectMemoryPart(undefined, long)
    const idx = result.indexOf('Project memory:')
    const section = result.slice(idx)
    assert.ok(section.length < 900, `memory section not capped: ${section.length} chars`)
  })
})
