/*
 * Line-level diff using the Myers O(ND) algorithm.
 *
 * Ported to TypeScript from the JetBrains IntelliJ Community Edition source
 * (Apache License 2.0):
 *   platform/util/diff/src/com/intellij/util/diff/{Diff,MyersLCS,Reindexer,
 *   LCSBuilder,DiffConfig,FilesTooBigForDiffException}.kt
 *   platform/util/base/multiplatform/src/com/intellij/openapi/util/text/LineTokenizer.kt
 *
 * Algorithm: E.W. Myers, "An O(ND) Difference Algorithm and Its Variations" (1986).
 *
 * Intentional simplifications vs upstream (kept for the first port):
 *   - Myers only (Patience LCS not included).
 *   - Returns a flat `LineChange[]` instead of a linked-list `Change`.
 *   - Uses `Uint8Array` as a bitset (one byte per line) instead of a packed bitset.
 *   - Uses a `Set<number>` for "is this line interned-id present in the other side?"
 *     instead of a sorted-array + binarySearch; same O(N) discard pass.
 */

export type LineChange = {
  /** First changed line in "before" (0-based, in splitLines() space). */
  line0: number
  /** First changed line in "after" (0-based, in splitLines() space). */
  line1: number
  /** Lines removed at `line0` in "before". */
  deleted: number
  /** Lines inserted at `line1` in "after". */
  inserted: number
}

export class FilesTooBigForDiffError extends Error {
  constructor() {
    super('FilesTooBigForDiff')
    this.name = 'FilesTooBigForDiffError'
  }
}

/** Default Myers difference threshold; mirrors IntelliJ's DiffConfig.DELTA_THRESHOLD_SIZE. */
const DELTA_THRESHOLD_SIZE = 20_000

export type BuildLineChangesOptions = {
  /**
   * Override the Myers difference threshold. If Myers cannot bound the edit
   * distance under this value, {@link FilesTooBigForDiffError} is thrown
   * rather than running to completion.
   *
   * Default: `max(20000 + 10 * floor(sqrt(N+M)), 20000)`.
   */
  threshold?: number
}

/**
 * Build line-level changes between two texts.
 *
 * Line splitting follows IntelliJ's `Diff.splitLines`: a trailing line
 * separator produces an explicit empty trailing line, so `'a\n'` is two
 * lines (`['a', '']`) while `'a'` is one (`['a']`). This is important so
 * that adding/removing a trailing newline shows up as a real change.
 *
 * @throws FilesTooBigForDiffError if the edit distance exceeds the threshold.
 */
export function buildLineChanges(
  before: string,
  after: string,
  options?: BuildLineChangesOptions,
): LineChange[] {
  return buildChangesFromLines(splitLines(before), splitLines(after), options)
}

/** As {@link buildLineChanges} but takes already-split line arrays. */
export function buildChangesFromLines(
  lines1: ReadonlyArray<string>,
  lines2: ReadonlyArray<string>,
  options?: BuildLineChangesOptions,
): LineChange[] {
  const startShift = commonPrefixLength(lines1, lines2)
  const endCut = commonSuffixLength(lines1, lines2, startShift)

  const trimmed1 = lines1.length - startShift - endCut
  const trimmed2 = lines2.length - startShift - endCut

  if (trimmed1 === 0 && trimmed2 === 0) return []
  if (trimmed1 === 0 || trimmed2 === 0) {
    return [{ line0: startShift, line1: startShift, deleted: trimmed1, inserted: trimmed2 }]
  }

  const { ints1, ints2 } = enumerate(lines1, lines2, startShift, endCut)
  return runMyersAndCollect(ints1, ints2, startShift, options?.threshold)
}

/**
 * Split text into lines, matching IntelliJ's `Diff.splitLines`
 * (i.e. `LineTokenizer.tokenize(s, includeSeparators=false, skipLastEmptyLine=false)`
 * with the empty-string special case from `Diff.splitLines`).
 *
 * Examples:
 *   ''        -> ['']
 *   'a'       -> ['a']
 *   'a\n'     -> ['a', '']
 *   'a\nb'    -> ['a', 'b']
 *   'a\nb\n'  -> ['a', 'b', '']
 *   '\n'      -> ['', '']
 *   '\r\n'    -> ['', '']
 *   'a\r\nb'  -> ['a', 'b']
 */
export function splitLines(s: string): string[] {
  if (s.length === 0) return ['']
  const lines: string[] = []
  const n = s.length
  let i = 0
  let lastSepLen = 0
  while (i < n) {
    const start = i
    while (i < n) {
      const c = s.charCodeAt(i)
      if (c === 10 || c === 13) break
      i++
    }
    lines.push(s.slice(start, i))
    if (i >= n) {
      lastSepLen = 0
      break
    }
    if (s.charCodeAt(i) === 13 && i + 1 < n && s.charCodeAt(i + 1) === 10) {
      i += 2
      lastSepLen = 2
    } else {
      i += 1
      lastSepLen = 1
    }
  }
  if (lastSepLen > 0) lines.push('')
  return lines
}

/**
 * Turn Myers {@link LineChange} records into unified-diff-shaped hunks (only `-` / `+` lines; no context).
 * Headers follow gnu-ish line numbers: pure insert at file start uses `-0,0 +1,N`.
 */
export function lineChangesToSyntheticHunks(
  linesBefore: ReadonlyArray<string>,
  linesAfter: ReadonlyArray<string>,
  changes: ReadonlyArray<LineChange>,
): Array<{ header: string; lines: string[] }> {
  return changes.map(c => {
    const oldStart = c.deleted === 0 ? c.line0 : c.line0 + 1
    const newStart = c.line1 + 1
    const header = `@@ -${oldStart},${c.deleted} +${newStart},${c.inserted} @@`
    const body: string[] = []
    for (let i = 0; i < c.deleted; i++) body.push(`-${linesBefore[c.line0 + i]!}`)
    for (let i = 0; i < c.inserted; i++) body.push(`+${linesAfter[c.line1 + i]!}`)
    return { header, lines: body }
  })
}

/**
 * Human-readable Myers diff: `-` / `+` lines separated by `====================` between change regions
 * (same spirit as IntelliJ {@code Diff.linesDiff}).
 */
export function formatMyersLineDiffSnippet(
  before: string,
  after: string,
  opts?: { maxLines?: number },
): string {
  const maxLines = opts?.maxLines ?? 400
  try {
    const changes = buildLineChanges(before, after)
    if (changes.length === 0) return ''
    const l1 = splitLines(before)
    const l2 = splitLines(after)
    const parts: string[] = []
    let n = 0
    for (const ch of changes) {
      if (n >= maxLines) {
        parts.push('… [truncated by maxLines]')
        break
      }
      if (parts.length > 0) parts.push('====================')
      for (let i = 0; i < ch.deleted && n < maxLines; i++) {
        parts.push(`-${l1[ch.line0 + i]!}`)
        n++
      }
      for (let i = 0; i < ch.inserted && n < maxLines; i++) {
        parts.push(`+${l2[ch.line1 + i]!}`)
        n++
      }
    }
    return parts.join('\n')
  } catch (e) {
    if (e instanceof FilesTooBigForDiffError) {
      return '(Myers line diff skipped: edit distance too large for in-memory threshold)'
    }
    throw e
  }
}

function commonPrefixLength(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

function commonSuffixLength(a: ReadonlyArray<string>, b: ReadonlyArray<string>, startShift: number): number {
  const n = Math.min(a.length, b.length) - startShift
  let i = 0
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

function enumerate(
  lines1: ReadonlyArray<string>,
  lines2: ReadonlyArray<string>,
  startShift: number,
  endCut: number,
): { ints1: Int32Array; ints2: Int32Array } {
  const ids = new Map<string, number>()
  const intern = (s: string): number => {
    const existing = ids.get(s)
    if (existing !== undefined) return existing
    const id = ids.size
    ids.set(s, id)
    return id
  }

  const len1 = lines1.length - startShift - endCut
  const len2 = lines2.length - startShift - endCut

  const ints1 = new Int32Array(len1)
  const ints2 = new Int32Array(len2)
  for (let i = 0; i < len1; i++) ints1[i] = intern(lines1[startShift + i]!)
  for (let i = 0; i < len2; i++) ints2[i] = intern(lines2[startShift + i]!)
  return { ints1, ints2 }
}

/* --- Reindexer: drop lines that cannot match anything on the other side. --- */

type DiscardResult = {
  discarded1: Int32Array
  discarded2: Int32Array
  oldIndices1: Int32Array
  oldIndices2: Int32Array
}

function discardUnique(ints1: Int32Array, ints2: Int32Array): DiscardResult {
  // Pass A: keep elements of ints1 that appear anywhere in ints2.
  // Pass B: keep elements of ints2 that appear in the survivors of pass A.
  // This mirrors IntelliJ Reindexer.discardUnique; the asymmetry is harmless
  // because anything missing from one side is a guaranteed change anyway.
  const inInts2 = new Set<number>()
  for (let i = 0; i < ints2.length; i++) inInts2.add(ints2[i]!)
  const buf1: number[] = []
  const idx1: number[] = []
  for (let i = 0; i < ints1.length; i++) {
    const v = ints1[i]!
    if (inInts2.has(v)) {
      buf1.push(v)
      idx1.push(i)
    }
  }
  const discarded1 = Int32Array.from(buf1)
  const oldIndices1 = Int32Array.from(idx1)

  const inDiscarded1 = new Set<number>()
  for (let i = 0; i < discarded1.length; i++) inDiscarded1.add(discarded1[i]!)
  const buf2: number[] = []
  const idx2: number[] = []
  for (let i = 0; i < ints2.length; i++) {
    const v = ints2[i]!
    if (inDiscarded1.has(v)) {
      buf2.push(v)
      idx2.push(i)
    }
  }
  const discarded2 = Int32Array.from(buf2)
  const oldIndices2 = Int32Array.from(idx2)

  return { discarded1, discarded2, oldIndices1, oldIndices2 }
}

/* --- Myers LCS --- */

class MyersLCS {
  /** changes1[i] === 1 means line i of `first` is part of an edit (not in LCS). */
  readonly changes1: Uint8Array
  /** Likewise for `second`. */
  readonly changes2: Uint8Array
  private readonly first: Int32Array
  private readonly second: Int32Array
  private readonly count1: number
  private readonly count2: number
  // Forward and backward V-arrays from Myers' paper, shifted by newLength so
  // diagonal indices are non-negative. Reused across the recursive divide.
  private readonly VForward: Int32Array
  private readonly VBackward: Int32Array

  constructor(first: Int32Array, second: Int32Array) {
    this.first = first
    this.second = second
    this.count1 = first.length
    this.count2 = second.length
    this.changes1 = new Uint8Array(first.length).fill(1)
    this.changes2 = new Uint8Array(second.length).fill(1)
    const total = this.count1 + this.count2
    this.VForward = new Int32Array(total + 1)
    this.VBackward = new Int32Array(total + 1)
  }

  /** Run Myers; throw FilesTooBigForDiffError if differences exceed `threshold`. */
  executeWithThreshold(threshold?: number): void {
    const n = this.count1 + this.count2
    if (this.count1 === 0 || this.count2 === 0) return
    const computed = 20_000 + 10 * Math.floor(Math.sqrt(n))
    const baseThreshold = threshold !== undefined
      ? threshold
      : Math.max(computed, DELTA_THRESHOLD_SIZE)
    this.executeRange(0, this.count1, 0, this.count2, Math.min(baseThreshold, n), true)
  }

  private executeRange(
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number,
    differenceEstimate: number,
    throwOnExcess: boolean,
  ): void {
    if (oldStart >= oldEnd || newStart >= newEnd) return

    const oldLength = oldEnd - oldStart
    const newLength = newEnd - newStart
    const VF = this.VForward
    const VB = this.VBackward

    VF[newLength + 1] = 0
    VB[newLength + 1] = 0

    const halfD = (differenceEstimate + 1) >> 1
    let xx = -1
    let kk = -1
    let td = -1

    outer: for (let d = 0; d <= halfD; d++) {
      const L = newLength + Math.max(-d, -newLength + ((d ^ newLength) & 1))
      const R = newLength + Math.min(d, oldLength - ((d ^ oldLength) & 1))

      for (let k = L; k <= R; k += 2) {
        let x: number
        if (k === L || (k !== R && VF[k - 1]! < VF[k + 1]!)) {
          x = VF[k + 1]!
        } else {
          x = VF[k - 1]! + 1
        }
        const y = x - k + newLength
        x += this.commonForward(
          oldStart + x,
          newStart + y,
          Math.min(oldEnd - oldStart - x, newEnd - newStart - y),
        )
        VF[k] = x
      }

      if ((oldLength - newLength) % 2 !== 0) {
        for (let k = L; k <= R; k += 2) {
          if (oldLength - (d - 1) <= k && k <= oldLength + (d - 1)) {
            if (VF[k]! + VB[newLength + oldLength - k]! >= oldLength) {
              xx = VF[k]!
              kk = k
              td = 2 * d - 1
              break outer
            }
          }
        }
      }

      for (let k = L; k <= R; k += 2) {
        let x: number
        if (k === L || (k !== R && VB[k - 1]! < VB[k + 1]!)) {
          x = VB[k + 1]!
        } else {
          x = VB[k - 1]! + 1
        }
        const y = x - k + newLength
        x += this.commonBackward(
          oldEnd - 1 - x,
          newEnd - 1 - y,
          Math.min(oldEnd - oldStart - x, newEnd - newStart - y),
        )
        VB[k] = x
      }

      if ((oldLength - newLength) % 2 === 0) {
        for (let k = L; k <= R; k += 2) {
          if (oldLength - d <= k && k <= oldLength + d) {
            if (VF[oldLength + newLength - k]! + VB[k]! >= oldLength) {
              xx = oldLength - VB[k]!
              kk = oldLength + newLength - k
              td = 2 * d
              break outer
            }
          }
        }
      }
    }

    if (td > 1) {
      const yy = xx - kk + newLength
      const oldDiff = (td + 1) >> 1
      if (0 < xx && 0 < yy) {
        this.executeRange(oldStart, oldStart + xx, newStart, newStart + yy, oldDiff, throwOnExcess)
      }
      if (oldStart + xx < oldEnd && newStart + yy < newEnd) {
        this.executeRange(oldStart + xx, oldEnd, newStart + yy, newEnd, td - oldDiff, throwOnExcess)
      }
    } else if (td >= 0) {
      // td == 0 (trivial snake) or td == 1 (single edit). The remaining range
      // is small enough that a greedy snake-walk gives the right answer.
      let x = oldStart
      let y = newStart
      while (x < oldEnd && y < newEnd) {
        const cl = this.commonForward(x, y, Math.min(oldEnd - x, newEnd - y))
        if (cl > 0) {
          this.markUnchanged(x, y, cl)
          x += cl
          y += cl
        } else if (oldEnd - oldStart > newEnd - newStart) {
          x++
        } else {
          y++
        }
      }
    } else {
      if (throwOnExcess) throw new FilesTooBigForDiffError()
    }
  }

  private markUnchanged(start1: number, start2: number, count: number): void {
    this.changes1.fill(0, start1, start1 + count)
    this.changes2.fill(0, start2, start2 + count)
  }

  private commonForward(oldIndex: number, newIndex: number, maxLength: number): number {
    const len = Math.min(maxLength, Math.min(this.count1 - oldIndex, this.count2 - newIndex))
    let x = oldIndex
    let y = newIndex
    while (x - oldIndex < len && this.first[x] === this.second[y]) {
      x++
      y++
    }
    return x - oldIndex
  }

  private commonBackward(oldIndex: number, newIndex: number, maxLength: number): number {
    const len = Math.min(maxLength, Math.min(oldIndex, newIndex) + 1)
    let x = oldIndex
    let y = newIndex
    while (oldIndex - x < len && this.first[x] === this.second[y]) {
      x--
      y--
    }
    return oldIndex - x
  }
}

/* --- Driver: discard unique lines, run Myers, lift bitset back, emit changes. --- */

function runMyersAndCollect(
  ints1: Int32Array,
  ints2: Int32Array,
  startShift: number,
  threshold: number | undefined,
): LineChange[] {
  const { discarded1, discarded2, oldIndices1, oldIndices2 } = discardUnique(ints1, ints2)

  // No shared lines at all after enumeration: everything is a single replace.
  if (discarded1.length === 0 && discarded2.length === 0) {
    return [{ line0: startShift, line1: startShift, deleted: ints1.length, inserted: ints2.length }]
  }

  const myers = new MyersLCS(discarded1, discarded2)
  myers.executeWithThreshold(threshold)

  // Lift Myers' verdicts from discarded-index space to the full original-index space.
  // Lines dropped by discardUnique can never match anything on the other side -> stay 1 (changed).
  const fullChanges1 = new Uint8Array(ints1.length).fill(1)
  const fullChanges2 = new Uint8Array(ints2.length).fill(1)
  for (let i = 0; i < discarded1.length; i++) fullChanges1[oldIndices1[i]!] = myers.changes1[i]!
  for (let i = 0; i < discarded2.length; i++) fullChanges2[oldIndices2[i]!] = myers.changes2[i]!

  const result: LineChange[] = []
  let x = 0
  let y = 0
  const n1 = ints1.length
  const n2 = ints2.length
  while (x < n1 && y < n2) {
    while (x < n1 && y < n2 && !fullChanges1[x] && !fullChanges2[y]) {
      x++
      y++
    }
    const x0 = x
    const y0 = y
    let dx = 0
    while (x < n1 && fullChanges1[x]) {
      dx++
      x++
    }
    let dy = 0
    while (y < n2 && fullChanges2[y]) {
      dy++
      y++
    }
    if (dx !== 0 || dy !== 0) {
      result.push({ line0: startShift + x0, line1: startShift + y0, deleted: dx, inserted: dy })
    }
  }
  if (x !== n1 || y !== n2) {
    result.push({ line0: startShift + x, line1: startShift + y, deleted: n1 - x, inserted: n2 - y })
  }
  return result
}
