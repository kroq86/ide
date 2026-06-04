import type { ConfigPickItem } from '../config.js'
import type {
  FixContext,
  PatchProposal,
  PatchRiskAssessment,
  ReviewFinding,
  ReviewProposal,
  TraceSummary,
} from '../codeclaw.js'
import type { Diagnostic, Snapshot } from '../protocol.js'
import type { GitDisplayLine, GitLogEntry, GitPanelView, GitStatusData } from '../git.js'
import type { CmdItem, LeaderNode } from '../leader.js'
import type { BuildPanelState } from '../build-panel.js'
import type { TroubleshootingRow } from '../troubleshooting.js'

export type EditorMode = 'normal' | 'insert' | 'visual' | 'command' | 'search'

export type EditorBuffer = {
  id: string
  name: string
  filename: string | null
  snapshot: Snapshot | null
  status: string
  lastUsedAt: number
  temporary?: boolean
  jumpTo?: { row: number; col: number }
  openHookFired?: boolean
}

export type FuzzyMatch = { path: string; score: number; indices: number[] }

export type NormalizedPickItem = {
  label: string
  value: string
  description?: string
}

export function normalizePickItems(items: ConfigPickItem[]): NormalizedPickItem[] {
  return items.map(item => typeof item === 'string'
    ? { label: item, value: item }
    : { label: item.label, value: item.value ?? item.label, description: item.description })
}

export type PromptState =
  | { type: 'buffer'; query: string; selected: number }
  | { type: 'file'; query: string; candidates: string[]; ranked: FuzzyMatch[]; selectedIdx: number; base: string }
  | { type: 'saveAs'; query: string; thenQuit?: boolean }
  | { type: 'commit'; message: string }
  | { type: 'model'; query: string; candidates: string[]; selected: number }
  | { type: 'configPick'; id: number; title: string; query: string; items: NormalizedPickItem[]; selected: number }
  | {
    type: 'directivePick'
    row: number
    col: number
    quote: string
    partial: string
    replaceStartCol: number
    query: string
    items: NormalizedPickItem[]
    selected: number
  }
  | { type: 'configInput'; id: number; title: string; value: string }
  | { type: 'configConfirm'; id: number; title: string; body?: string }

export type AiMessage = { role: 'user' | 'assistant'; content: string; error?: boolean }

export type ChatStreamingState = { committedLines: string[]; tail: string }

export type LspTarget = { path?: string; row?: number; col?: number }

export type CodeClawFixState =
  | { status: 'idle' }
  | { status: 'generating'; traceId: string; startedAt: string; context: FixContext }
  | { status: 'proposal'; traceId: string; startedAt: string; context: FixContext; proposal: PatchProposal; risk: PatchRiskAssessment; mediumConfirm: boolean }
  | { status: 'editing'; traceId: string; startedAt: string; context: FixContext; proposal: PatchProposal }
  | { status: 'applying'; traceId: string; startedAt: string; context: FixContext; proposal: PatchProposal; risk: PatchRiskAssessment }
  | { status: 'trace'; latest: TraceSummary | null }
  | { status: 'done'; message: string; tracePath: string }
  | { status: 'error'; message: string; tracePath?: string }

export type ReviewState =
  | { status: 'idle' }
  | { status: 'generating' }
  | { status: 'findings'; proposal: ReviewProposal; cursor: number; tracePath: string }
  | { status: 'error'; message: string; tracePath?: string }

export type Panel =
  | null
  | { type: 'shell' }
  | { type: 'whichkey'; node: LeaderNode; path: string }
  | { type: 'cmdpalette'; query: string; cursor: number; items: CmdItem[] }
  | { type: 'troubleshooting'; rows: TroubleshootingRow[] }
  | { type: 'build'; state: BuildPanelState; cursor: number }
  | { type: 'diagnostics'; diagnostics: Diagnostic[]; cursor: number; title: string }
  | { type: 'lsp'; title: string; lines: string[] }
  | { type: 'git'; data: GitStatusData; cursor: number; pendingKey: string | null; logEntries: GitLogEntry[] | null; gitError?: string; view: GitPanelView }
  | { type: 'dired'; path: string; cursor: number }
  | { type: 'splash'; title: string; message?: string; hint?: string }

export type SelBounds = {
  startRow: number; startCol: number
  endRow: number;   endCol: number
  lineMode: boolean
}

export type VisualSnap = {
  anchor: { row: number; col: number }
  cursor: { row: number; col: number }
  lineMode: boolean
}

export type YankRegister = {
  text: string
  lineWise: boolean
}

export type LspOverlay = {
  title: string
  lines: string[]
}

export const PROCESS_TAB_ID = '__qe_process__'
export const AI_TAB_ID = '__qe_ai__'

export type { GitDisplayLine }
