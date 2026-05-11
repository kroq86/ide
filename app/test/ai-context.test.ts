import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findProjectContext,
  buildShellContext,
  buildProjectMemoryPart,
  sanitizeInlineCompletion,
  buildFimPrompt,
  isFimCapableModel,
  shouldUseOllamaFimPrompt,
  parseOllamaChatLine,
  parseOllamaGenerateLine,
  buildCompletionAffixes,
  tightenCompletionAffixes,
  lineLooksLikeCodeLine,
  ollamaModelBase,
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

describe('lineLooksLikeCodeLine', () => {
  it('accepts common TS and tiny gap fragments', () => {
    assert.equal(lineLooksLikeCodeLine('export function x() {}'), true)
    assert.equal(lineLooksLikeCodeLine('  return a + b'), true)
    assert.equal(lineLooksLikeCodeLine('+ b'), true)
    assert.equal(lineLooksLikeCodeLine('b'), true)
  })

  it('rejects pasted tutorial sentences', () => {
    assert.equal(lineLooksLikeCodeLine('The code you provided is a simple function that subtracts x'), false)
    assert.equal(lineLooksLikeCodeLine('It looks The code you provided'), false)
  })
})

describe('sanitizeInlineCompletion', () => {
  it('passes through plain code', () => {
    assert.equal(sanitizeInlineCompletion('const n = 1'), 'const n = 1')
  })

  it('removes opening fence with language line', () => {
    assert.equal(sanitizeInlineCompletion('```typescript\nconst x = 1'), 'const x = 1')
    assert.equal(sanitizeInlineCompletion('``` typescript\nfoo'), 'foo')
    assert.equal(sanitizeInlineCompletion('```\nfoo'), 'foo')
  })

  it('returns empty while fence line is incomplete', () => {
    assert.equal(sanitizeInlineCompletion(''), '')
    assert.equal(sanitizeInlineCompletion('`'), '`')
    assert.equal(sanitizeInlineCompletion('```'), '')
    assert.equal(sanitizeInlineCompletion('```typescript'), '')
  })

  it('handles same-line fence open', () => {
    assert.equal(sanitizeInlineCompletion('```ts const a = 2'), 'const a = 2')
  })

  it('strips trailing fence', () => {
    assert.equal(sanitizeInlineCompletion('ok\n```'), 'ok')
    assert.equal(sanitizeInlineCompletion('line```'), 'line')
  })

  it('keeps only first fenced block when model wraps tutorial prose', () => {
    const raw =
      'It looks like you have two functions.\n\n```typescript\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nThese functions are straightforward.'
    assert.equal(
      sanitizeInlineCompletion(raw),
      'export function add(a: number, b: number): number {\n  return a + b;\n}',
    )
  })

  it('strips leading tutorial lines before code when no fence', () => {
    assert.equal(
      sanitizeInlineCompletion('Here is the fix:\n\nreturn a + b'),
      'return a + b',
    )
  })

  it('truncates mid-stream tutorial markdown (numbered **Function bullets)', () => {
    const junk =
      '\nexport function sum(a: number, b: number): number {\n return a + b\n}\n\n1. **Function `add`:**\n   - Subtracts.\n'
    assert.ok(!sanitizeInlineCompletion(junk).includes('**Function'))
    assert.ok(sanitizeInlineCompletion(junk).includes('export function sum'))
  })

  it('caps oversized completions', () => {
    const long = `${'// x\n'.repeat(40)}done()`
    assert.ok(sanitizeInlineCompletion(long).split('\n').length <= 19)
    assert.ok(sanitizeInlineCompletion(long).length <= 820)
  })

  it('drops essay wall before a trailing export (LLM repetition glitch)', () => {
    const blob = [
      ' It looks The code you provided is a simple function.',
      'The code you provided is a simple function that subtracts the second argument from the first. However, there are a few issues with it:',
      '1. The function name `add` should be `subtract`.',
      '',
      'Here\'s the corrected version of your code:',
      '',
      'export function sum(a: number, b: number): number {',
      '  return a + b',
      '}',
    ].join('\n')
    const out = sanitizeInlineCompletion(blob)
    assert.match(out, /^export function sum/)
    assert.ok(!out.includes('The code you provided'))
  })
})

describe('ollamaModelBase', () => {
  it('strips tag after colon', () => {
    assert.equal(ollamaModelBase('qwen2.5-coder:1.5b'), 'qwen2.5-coder')
    assert.equal(ollamaModelBase('llama3.2:latest'), 'llama3.2')
  })
})

describe('isFimCapableModel', () => {
  it('detects qwen coder and deepseek-coder', () => {
    assert.equal(isFimCapableModel('qwen2.5-coder:1.5b'), true)
    assert.equal(isFimCapableModel('deepseek-coder:6.7b'), true)
  })

  it('returns false for general chat models', () => {
    assert.equal(isFimCapableModel('llama3.2:latest'), false)
    assert.equal(isFimCapableModel('mistral:latest'), false)
  })
})

describe('shouldUseOllamaFimPrompt', () => {
  it('skips FIM for qwen2.5-coder:1.5b (tutorial-only middle)', () => {
    assert.equal(shouldUseOllamaFimPrompt('qwen2.5-coder:1.5b'), false)
  })

  it('uses FIM for larger qwen coder tags and other code families', () => {
    assert.equal(shouldUseOllamaFimPrompt('qwen2.5-coder:7b'), true)
    assert.equal(shouldUseOllamaFimPrompt('deepseek-coder:6.7b'), true)
  })
})

describe('buildFimPrompt', () => {
  it('wraps prefix and suffix with FIM tokens', () => {
    assert.equal(
      buildFimPrompt('const x = ', '\nconsole.log(x)'),
      '<|fim_prefix|>const x = <|fim_suffix|>\nconsole.log(x)<|fim_middle|>',
    )
  })
})

describe('parseOllamaChatLine', () => {
  it('parses done:true with empty content (qwen 1.5b does this for minimal CURSOR prompts)', () => {
    const line =
      '{"model":"qwen2.5-coder:1.5b","message":{"role":"assistant","content":""},"done":true}'
    assert.deepEqual(parseOllamaChatLine(line), { delta: '', done: true })
  })

  it('parses streamed deltas', () => {
    assert.deepEqual(parseOllamaChatLine('{"message":{"content":"+"},"done":false}'), {
      delta: '+',
      done: false,
    })
  })

  it('strips optional data: prefix', () => {
    assert.deepEqual(parseOllamaChatLine('data: {"message":{"content":"z"},"done":false}'), {
      delta: 'z',
      done: false,
    })
  })
})

describe('parseOllamaGenerateLine', () => {
  it('parses generate stream chunks', () => {
    assert.deepEqual(parseOllamaGenerateLine('{"response":"foo","done":false}'), {
      delta: 'foo',
      done: false,
    })
  })
})

describe('buildCompletionAffixes', () => {
  it('collapses blank runs so CURSOR sits between previous and next code (broken-counter gap)', () => {
    const lines = [
      'export function add(a: number, b: number): number {',
      '  return a - b',
      '}',
      '',
      '',
      'export function sum(a: number, b:number): number {',
      ' return a + b',
      '}',
    ]
    const { prefix, suffix, gapCollapsed } = buildCompletionAffixes(lines, { row: 4, col: 0 })
    assert.equal(gapCollapsed, true)
    assert.ok(prefix.endsWith('}'), `prefix should end with brace: ${JSON.stringify(prefix.slice(-20))}`)
    assert.ok(suffix.startsWith('export function sum'), `suffix head: ${JSON.stringify(suffix.slice(0, 24))}`)
  })

  it('does not collapse when cursor is on a code line', () => {
    const lines = ['const x = 1', '']
    const r = buildCompletionAffixes(lines, { row: 0, col: 11 })
    assert.equal(r.gapCollapsed, false)
    assert.ok(r.prefix.includes('const x ='))
  })
})

describe('tightenCompletionAffixes', () => {
  it('strips leading newlines between brace and next declaration (cursor after })', () => {
    const prefix = 'export function add(a: number, b: number): number {\n  return a - b\n}'
    const suffix = '\n\n\n\n\nexport function sum(a: number, b:number): number {\n return a + b\n}'
    const r = tightenCompletionAffixes(prefix, suffix)
    assert.equal(r.tightened, true)
    assert.ok(r.suffix.startsWith('export function sum'), r.suffix.slice(0, 40))
  })

  it('no-op when suffix does not start with newline', () => {
    const r = tightenCompletionAffixes('foo', 'bar')
    assert.equal(r.tightened, false)
    assert.equal(r.suffix, 'bar')
  })
})
