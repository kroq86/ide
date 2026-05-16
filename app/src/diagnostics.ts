import type { Diagnostic } from './protocol.js'

export type DiagnosticSeverity = Diagnostic['severity']

const SEVERITY_RANK: Record<string, number> = {
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
}

function rank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 99
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) =>
    a.row - b.row
    || a.startCol - b.startCol
    || rank(a.severity) - rank(b.severity)
    || a.message.localeCompare(b.message),
  )
}

export function diagnosticAtCursor(
  diagnostics: readonly Diagnostic[],
  cursor: { row: number; col: number },
): Diagnostic | null {
  const sorted = sortDiagnostics(diagnostics)
  return sorted.find(diagnostic =>
    diagnostic.row === cursor.row
    && cursor.col >= diagnostic.startCol
    && cursor.col <= Math.max(diagnostic.startCol, diagnostic.endCol),
  ) ?? sorted.find(diagnostic => diagnostic.row === cursor.row) ?? null
}

export function nextDiagnostic(
  diagnostics: readonly Diagnostic[],
  cursor: { row: number; col: number },
  direction: 1 | -1,
  severity?: DiagnosticSeverity,
): Diagnostic | null {
  const sorted = sortDiagnostics(
    severity ? diagnostics.filter(diagnostic => diagnostic.severity === severity) : diagnostics,
  )
  if (sorted.length === 0) return null

  if (direction > 0) {
    return sorted.find(diagnostic =>
      diagnostic.row > cursor.row
      || (diagnostic.row === cursor.row && diagnostic.startCol > cursor.col),
    ) ?? sorted[0]!
  }

  for (let i = sorted.length - 1; i >= 0; i--) {
    const diagnostic = sorted[i]!
    if (diagnostic.row < cursor.row || (diagnostic.row === cursor.row && diagnostic.startCol < cursor.col)) {
      return diagnostic
    }
  }
  return sorted[sorted.length - 1]!
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const source = diagnostic.source ? ` ${diagnostic.source}` : ''
  return `${diagnostic.severity}${source}: ${diagnostic.message}`
}
