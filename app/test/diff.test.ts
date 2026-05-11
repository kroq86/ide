import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildLineChanges,
  buildChangesFromLines,
  splitLines,
  FilesTooBigForDiffError,
  type LineChange,
} from '../src/diff.ts'

/* --- splitLines: match IntelliJ's Diff.splitLines / LineTokenizer(false, false) --- */

test('splitLines: empty string is one empty line', () => {
  assert.deepEqual(splitLines(''), [''])
})

test('splitLines: trailing newline produces an explicit empty trailing line', () => {
  assert.deepEqual(splitLines('a\n'), ['a', ''])
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b', ''])
})

test('splitLines: no trailing newline keeps last line whole', () => {
  assert.deepEqual(splitLines('a'), ['a'])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
})

test('splitLines: CRLF, CR alone, and lone CR/LF separators', () => {
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b'])
  assert.deepEqual(splitLines('a\rb'), ['a', 'b'])
  assert.deepEqual(splitLines('\n'), ['', ''])
  assert.deepEqual(splitLines('\r\n'), ['', ''])
  assert.deepEqual(splitLines('\r'), ['', ''])
  assert.deepEqual(splitLines('a\r'), ['a', ''])
})

/* --- buildLineChanges: small canonical cases (exact expected shape) --- */

test('buildLineChanges: identical strings -> empty change list', () => {
  assert.deepEqual(buildLineChanges('a\nb\nc', 'a\nb\nc'), [])
  assert.deepEqual(buildLineChanges('', ''), [])
})

test('buildLineChanges: pure middle replace', () => {
  assert.deepEqual(
    buildLineChanges('a\nb\nc', 'a\nX\nc'),
    [{ line0: 1, line1: 1, deleted: 1, inserted: 1 }],
  )
})

test('buildLineChanges: pure middle insertion', () => {
  assert.deepEqual(
    buildLineChanges('a\nc', 'a\nb\nc'),
    [{ line0: 1, line1: 1, deleted: 0, inserted: 1 }],
  )
})

test('buildLineChanges: pure middle deletion', () => {
  assert.deepEqual(
    buildLineChanges('a\nb\nc', 'a\nc'),
    [{ line0: 1, line1: 1, deleted: 1, inserted: 0 }],
  )
})

test('buildLineChanges: prefix change only', () => {
  assert.deepEqual(
    buildLineChanges('a\nb\nc', 'X\nb\nc'),
    [{ line0: 0, line1: 0, deleted: 1, inserted: 1 }],
  )
})

test('buildLineChanges: suffix change only', () => {
  assert.deepEqual(
    buildLineChanges('a\nb\nc', 'a\nb\nZ'),
    [{ line0: 2, line1: 2, deleted: 1, inserted: 1 }],
  )
})

test('buildLineChanges: multiple non-adjacent edits', () => {
  // before: a, b, c, d, e
  // after:  a, X, c, Y, e
  assert.deepEqual(
    buildLineChanges('a\nb\nc\nd\ne', 'a\nX\nc\nY\ne'),
    [
      { line0: 1, line1: 1, deleted: 1, inserted: 1 },
      { line0: 3, line1: 3, deleted: 1, inserted: 1 },
    ],
  )
})

test('buildLineChanges: empty before becomes [""]; one-line "delete" plus N inserts', () => {
  // splitLines('') === [''] -> 1 line. splitLines('a\nb') === ['a', 'b'] -> 2 lines.
  // Documented behavior: empty file is one empty line, not zero lines.
  assert.deepEqual(
    buildLineChanges('', 'a\nb'),
    [{ line0: 0, line1: 0, deleted: 1, inserted: 2 }],
  )
})

test('buildLineChanges: non-empty before, empty after', () => {
  assert.deepEqual(
    buildLineChanges('a\nb', ''),
    [{ line0: 0, line1: 0, deleted: 2, inserted: 1 }],
  )
})

test('buildLineChanges: trailing newline difference is reported as a change', () => {
  // 'a' -> ['a'] (1 line); 'a\n' -> ['a', ''] (2 lines).
  assert.deepEqual(
    buildLineChanges('a', 'a\n'),
    [{ line0: 1, line1: 1, deleted: 0, inserted: 1 }],
  )
})

/* --- buildLineChanges: round-trip property (changes correctly reconstruct after) --- */

test('buildLineChanges: round-trip on swap of head and tail', () => {
  const before = 'a\nb\nc'
  const after = 'X\nb\nY'
  assertRoundtrip(before, after)
})

test('buildLineChanges: round-trip on whole-file replace', () => {
  assertRoundtrip('a\nb\nc', 'x\ny\nz')
})

test('buildLineChanges: round-trip on randomized small inputs', () => {
  const rng = mulberry32(0x5EED1234)
  for (let trial = 0; trial < 50; trial++) {
    const a = randomLines(rng, 5 + Math.floor(rng() * 30))
    const b = mutate(rng, a)
    const changes = buildChangesFromLines(a, b)
    const reconstructed = applyChanges(a, b, changes)
    assert.deepEqual(reconstructed, b, `trial ${trial}: a=${JSON.stringify(a)} b=${JSON.stringify(b)} changes=${JSON.stringify(changes)}`)
  }
})

/* --- buildLineChanges: threshold throw path --- */

test('buildLineChanges: throws FilesTooBigForDiffError when threshold is exceeded', () => {
  // 100 lines reversed: every line appears on the other side (so discardUnique
  // keeps everything) but the edit distance is ~2*N-2, well above a tight threshold.
  const N = 100
  const a = Array.from({ length: N }, (_, i) => `line${i}`).join('\n')
  const b = Array.from({ length: N }, (_, i) => `line${N - 1 - i}`).join('\n')
  assert.throws(
    () => buildLineChanges(a, b, { threshold: 4 }),
    FilesTooBigForDiffError,
  )
})

test('buildLineChanges: default threshold succeeds on moderate input', () => {
  const N = 200
  const a = Array.from({ length: N }, (_, i) => `line${i}`).join('\n')
  const b = Array.from({ length: N }, (_, i) => `line${N - 1 - i}`).join('\n')
  // Should not throw at the default threshold.
  const changes = buildLineChanges(a, b)
  // Sanity: at least one change exists.
  assert.ok(changes.length > 0)
})

/* --- helpers --- */

/** Apply `changes` to `a` (using lines from `b` for insertions); compare with splitLines(targetText). */
function applyChanges(a: ReadonlyArray<string>, b: ReadonlyArray<string>, changes: ReadonlyArray<LineChange>): string[] {
  const out: string[] = []
  let aPos = 0
  for (const c of changes) {
    while (aPos < c.line0) out.push(a[aPos++]!)
    for (let i = 0; i < c.inserted; i++) out.push(b[c.line1 + i]!)
    aPos += c.deleted
  }
  while (aPos < a.length) out.push(a[aPos++]!)
  return out
}

function assertRoundtrip(before: string, after: string): void {
  const a = splitLines(before)
  const b = splitLines(after)
  const changes = buildChangesFromLines(a, b)
  assert.deepEqual(applyChanges(a, b, changes), b)
}

/** Deterministic PRNG so test failures are reproducible. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) | 0
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function randomLines(rng: () => number, n: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(`L${Math.floor(rng() * 10)}`)
  }
  return lines
}

function mutate(rng: () => number, src: ReadonlyArray<string>): string[] {
  const out: string[] = []
  for (const line of src) {
    const r = rng()
    if (r < 0.15) continue
    if (r < 0.30) {
      out.push(`I${Math.floor(rng() * 10)}`)
      out.push(line)
      continue
    }
    if (r < 0.40) {
      out.push(`R${Math.floor(rng() * 10)}`)
      continue
    }
    out.push(line)
  }
  if (rng() < 0.5) out.push(`T${Math.floor(rng() * 10)}`)
  return out
}
