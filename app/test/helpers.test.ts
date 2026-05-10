import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractFirstCodeBlock,
  extractFirstLocation,
  findNearestTestScript,
  printable,
  printableText,
  bufferName,
} from '../src/leader.ts'

// ── extractFirstCodeBlock ─────────────────────────────────────────────────────

describe('extractFirstCodeBlock', () => {
  it('extracts a plain code fence', () => {
    const text = 'Run this:\n```\nnpm test\n```'
    assert.equal(extractFirstCodeBlock(text), 'npm test')
  })

  it('strips language tag', () => {
    const text = '```bash\nnpm run build\n```'
    assert.equal(extractFirstCodeBlock(text), 'npm run build')
  })

  it('handles typescript tag', () => {
    const text = '```typescript\nconst x = 1\n```'
    assert.equal(extractFirstCodeBlock(text), 'const x = 1')
  })

  it('returns null when there is no code block', () => {
    assert.equal(extractFirstCodeBlock('just plain text'), null)
  })

  it('returns null for empty code block', () => {
    assert.equal(extractFirstCodeBlock('```\n```'), null)
  })

  it('picks the first block when multiple exist', () => {
    const text = '```\nfirst\n```\n```\nsecond\n```'
    assert.equal(extractFirstCodeBlock(text), 'first')
  })
})

// ── extractFirstLocation ─────────────────────────────────────────────────────

describe('extractFirstLocation', () => {
  it('parses backtick-wrapped location', () => {
    const loc = extractFirstLocation('See `src/main.tsx:47:12` for details')
    assert.ok(loc)
    assert.equal(loc!.file, 'src/main.tsx')
    assert.equal(loc!.row, 46)   // 1-indexed → 0-indexed
    assert.equal(loc!.col, 11)
  })

  it('parses bare location without column', () => {
    const loc = extractFirstLocation('error in foo.ts:10')
    assert.ok(loc)
    assert.equal(loc!.file, 'foo.ts')
    assert.equal(loc!.row, 9)
    assert.equal(loc!.col, 0)
  })

  it('returns null when no location found', () => {
    assert.equal(extractFirstLocation('no file references here'), null)
  })

  it('handles rust files', () => {
    const loc = extractFirstLocation('error at src/main.rs:5:3')
    assert.ok(loc)
    assert.equal(loc!.file, 'src/main.rs')
    assert.equal(loc!.row, 4)
    assert.equal(loc!.col, 2)
  })
})

// ── findNearestTestScript ─────────────────────────────────────────────────────

describe('findNearestTestScript', () => {
  it('returns "npm test" when package.json has a "test" script', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-find-test-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
    const result = findNearestTestScript(join(root, 'src', 'index.ts'), root)
    assert.equal(result, 'npm test')
  })

  it('falls back to "npm run <key>" for test:unit style script', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-find-test-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'vitest' } }))
    const result = findNearestTestScript(join(root, 'src', 'index.ts'), root)
    assert.equal(result, 'npm run test:unit')
  })

  it('walks up to parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-find-test-'))
    const sub = join(root, 'packages', 'core')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }))
    // No package.json in sub — should walk up and find root
    const result = findNearestTestScript(join(sub, 'src', 'index.ts'), root)
    assert.equal(result, 'npm test')
  })

  it('returns null when no test script exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-find-test-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }))
    const result = findNearestTestScript(join(root, 'src', 'index.ts'), root)
    assert.equal(result, null)
  })

  it('returns null when no package.json at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-find-test-'))
    const result = findNearestTestScript(join(root, 'index.ts'), root)
    assert.equal(result, null)
  })

  it('uses root when filePath is null', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-find-test-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'mocha' } }))
    const result = findNearestTestScript(null, root)
    assert.equal(result, 'npm test')
  })

  it('handles absolute filePath inside root', () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-find-test-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'tap' } }))
    const result = findNearestTestScript(join(root, 'index.ts'), root)
    assert.equal(result, 'npm test')
  })
})

// ── printable / printableText ─────────────────────────────────────────────────

describe('printable', () => {
  it('returns true for regular printable ASCII', () => {
    assert.ok(printable('a'))
    assert.ok(printable('Z'))
    assert.ok(printable('0'))
    assert.ok(printable(' '))
    assert.ok(printable('~'))
  })

  it('returns false for multi-char strings', () => {
    assert.equal(printable('ab'), false)
  })

  it('returns false for control characters', () => {
    assert.equal(printable('\x00'), false)
    assert.equal(printable('\x1b'), false)
    assert.equal(printable('\n'), false)
  })

  it('returns false for empty string', () => {
    assert.equal(printable(''), false)
  })
})

describe('printableText', () => {
  it('returns true for printable ASCII strings', () => {
    assert.ok(printableText('hello world'))
    assert.ok(printableText('npm test'))
    assert.ok(printableText('~!@#$%'))
  })

  it('returns false for empty string', () => {
    assert.equal(printableText(''), false)
  })

  it('returns false for strings with control characters', () => {
    assert.equal(printableText('hello\x1bworld'), false)
    assert.equal(printableText('line\nbreak'), false)
  })
})

// ── bufferName ────────────────────────────────────────────────────────────────

describe('bufferName', () => {
  it('returns *scratch* for null', () => {
    assert.equal(bufferName(null), '*scratch*')
  })

  it('returns basename for a file path', () => {
    assert.equal(bufferName('/home/user/project/src/main.tsx'), 'main.tsx')
  })

  it('returns filename itself when no directory separator', () => {
    assert.equal(bufferName('counter.ts'), 'counter.ts')
  })
})
