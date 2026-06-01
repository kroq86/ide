import { assessPatchRisk } from '../codeclaw.js'
import type { ReviewFinding } from '../codeclaw.js'
import { C, type ThemeColor } from './theme.js'
import { thinkingPrefixedLine } from './spinner.js'
import type { CodeClawFixState, ReviewState } from './types.js'

export type OverlayLine = { text: string; color: ThemeColor; wrap?: 'wrap' | 'truncate' }

/** When true, CodeClaw fix UI replaces the chat transcript area. */
export function fixOverlayCoversMessages(fixState: CodeClawFixState): boolean {
  const s = fixState.status
  return s === 'generating' || s === 'proposal' || s === 'editing' || s === 'applying' || s === 'trace' || s === 'error'
}

export function codeClawFixLines(
  state: CodeClawFixState,
  maxRows: number,
  thinkingTick: number,
  progressChars = 0,
): OverlayLine[] {
  if (state.status === 'idle') return []
  if (state.status === 'generating') {
    const prog = progressChars > 0 ? `  ${progressChars} chars streamed…` : ''
    return [
      { text: thinkingPrefixedLine(thinkingTick, 'CodeClaw fix'), color: C.cyan },
      { text: thinkingPrefixedLine(thinkingTick, `Streaming AI response…${prog}`), color: C.grey, wrap: 'wrap' },
    ]
  }
  if (state.status === 'applying') {
    return [
      { text: thinkingPrefixedLine(thinkingTick, 'CodeClaw fix'), color: C.cyan },
      { text: thinkingPrefixedLine(thinkingTick, 'Applying patch…'), color: C.grey, wrap: 'wrap' },
    ]
  }
  if (state.status === 'trace') {
    if (!state.latest) {
      return [
        { text: 'CodeClaw trace', color: C.cyan },
        { text: 'No trace entries yet. Run SPC a f, accept or reject a proposal, then come back here.', color: C.grey, wrap: 'wrap' },
      ]
    }
    const { trace, path } = state.latest
    const lines: OverlayLine[] = [
      { text: 'CodeClaw trace last', color: C.cyan },
      { text: `Workflow: ${trace.workflow}`, color: C.fg },
      { text: `Failure command: ${trace.input?.command ?? '(unknown)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Root cause: ${trace.proposal?.rootCause ?? '(none recorded)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Files changed: ${trace.proposal?.filesChanged?.join(', ') || '(none)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Accepted: ${trace.accepted ? 'yes' : 'no'}`, color: trace.accepted ? C.green : C.yellow },
      { text: `Risk: ${trace.proposal?.assessedRisk?.level ?? trace.proposal?.risk ?? '(unknown)'}`, color: C.yellow },
      { text: `Verify task: ${trace.verify?.command ?? '(not run)'}`, color: C.fg, wrap: 'wrap' },
      { text: `Verify result: ${trace.verify ? (trace.verify.passed ? 'passed' : 'failed') : '(not run)'}`, color: trace.verify?.passed ? C.green : C.red },
      { text: `Trace file: ${path}`, color: C.grey, wrap: 'wrap' },
    ]
    return lines.slice(0, maxRows)
  }
  if (state.status === 'done') {
    return [
      { text: 'CodeClaw fix complete', color: C.green },
      { text: state.message, color: C.fg, wrap: 'wrap' },
      { text: `Trace: ${state.tracePath}`, color: C.grey, wrap: 'wrap' },
    ]
  }
  if (state.status === 'error') {
    return [
      { text: 'CodeClaw fix failed', color: C.red },
      { text: state.message, color: C.fg, wrap: 'wrap' },
      ...(state.tracePath ? [{ text: `Trace: ${state.tracePath}`, color: C.grey as ThemeColor, wrap: 'wrap' as const }] : []),
    ]
  }

  const proposal = state.proposal
  const risk = state.status === 'proposal' ? state.risk : assessPatchRisk(proposal)
  const lines: OverlayLine[] = [
    { text: 'Root cause:', color: C.cyan },
    { text: proposal.rootCause, color: C.fg, wrap: 'wrap' },
    { text: 'Summary:', color: C.cyan },
    { text: proposal.summary, color: C.fg, wrap: 'wrap' },
    { text: 'Patch:', color: C.cyan },
  ]

  for (const file of proposal.files) {
    lines.push({ text: file.path, color: C.yellow })
    for (const diffLine of file.unifiedDiff.split('\n').slice(0, Math.max(6, maxRows - 12))) {
      const color = diffLine.startsWith('+') && !diffLine.startsWith('+++') ? C.green
        : diffLine.startsWith('-') && !diffLine.startsWith('---') ? C.red
        : diffLine.startsWith('@@') ? C.magenta
        : C.grey
      lines.push({ text: diffLine, color })
    }
  }

  lines.push({ text: 'Verify:', color: C.cyan })
  lines.push({ text: proposal.verifyTask, color: C.fg, wrap: 'wrap' })
  lines.push({ text: `Risk: ${risk.level} (${risk.reasons.join('; ')})`, color: risk.level === 'high' ? C.red : risk.level === 'medium' ? C.yellow : C.green, wrap: 'wrap' })
  if (proposal.notes?.length) {
    lines.push({ text: `Notes: ${proposal.notes.join(' ')}`, color: C.grey, wrap: 'wrap' })
  }
  if (state.status === 'editing') {
    lines.push({ text: 'Edit request, then press Enter to regenerate. Esc cancels edit.', color: C.yellow, wrap: 'wrap' })
  } else if (risk.level === 'high') {
    lines.push({ text: 'High risk: manual patch only. [r] reject  [e] edit prompt', color: C.red, wrap: 'wrap' })
  } else if (risk.requiresConfirm && state.status === 'proposal' && state.mediumConfirm) {
    lines.push({ text: 'Medium risk: press [a] again to confirm apply. [r] reject  [e] edit prompt', color: C.yellow, wrap: 'wrap' })
  } else if (risk.requiresConfirm) {
    lines.push({ text: 'Medium risk: [a] review confirm  [r] reject  [e] edit prompt', color: C.yellow, wrap: 'wrap' })
  } else {
    lines.push({ text: 'Accept? [a] apply  [r] reject  [e] edit prompt', color: C.yellow, wrap: 'wrap' })
  }
  return lines.slice(0, maxRows)
}

export function reviewLines(
  state: ReviewState,
  maxRows: number,
  thinkingTick: number,
): OverlayLine[] {
  if (state.status === 'idle') return []
  if (state.status === 'generating') {
    return [{ text: thinkingPrefixedLine(thinkingTick, 'CodeClaw Review — generating…'), color: C.cyan }]
  }
  if (state.status === 'error') {
    const lines: OverlayLine[] = [
      { text: 'CodeClaw Review failed', color: C.red },
      { text: state.message, color: C.fg, wrap: 'wrap' },
    ]
    if (state.tracePath) lines.push({ text: `Trace: ${state.tracePath}`, color: C.grey, wrap: 'truncate' })
    return lines
  }

  const { proposal, cursor } = state
  const severityColor = (s: ReviewFinding['severity']): ThemeColor =>
    s === 'blocker' ? C.red : s === 'warning' ? C.yellow : C.cyan

  const lines: OverlayLine[] = [
    {
      text: `CodeClaw Review — ${proposal.safeToCommit ? '✓ safe to commit' : '✗ not safe to commit'}  (${proposal.findings.length} finding${proposal.findings.length !== 1 ? 's' : ''})`,
      color: proposal.safeToCommit ? C.green : C.red,
    },
    { text: proposal.summary, color: C.fg, wrap: 'wrap' },
  ]

  for (let i = 0; i < proposal.findings.length; i++) {
    const f = proposal.findings[i]!
    const prefix = i === cursor ? '▶ ' : '  '
    const loc = f.line != null ? `${f.file}:${f.line}` : f.file
    lines.push({ text: `${prefix}[${f.severity.toUpperCase()}] ${loc} — ${f.title}`, color: severityColor(f.severity) })
    if (i === cursor) {
      lines.push({ text: `    ${f.explanation}`, color: C.fg, wrap: 'wrap' })
      if (f.rule) lines.push({ text: `    rule: ${f.rule}`, color: C.grey, wrap: 'wrap' })
    }
  }

  lines.push({ text: `Trace: ${state.tracePath}`, color: C.grey, wrap: 'truncate' })
  lines.push({
    text: 'j/k=navigate  f=CodeClaw fix (uses finding text; suggestedPatch optional)  i=ignore  t=trace  x=dismiss',
    color: C.grey,
    wrap: 'wrap',
  })
  return lines.slice(0, maxRows)
}
