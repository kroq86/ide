import React from 'react'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { AlternateScreen, Box, Text, render, type Instance } from 'terminal-react-core'
import { useEditorInput } from './ui/use-editor-input.js'
import { createEditorInputHandler } from './ui/editor-input-handler.js'
import { readClipboardText, normalizePromptPaste, promptPasteText } from './prompt-clipboard.js'
import { QeSidecar, type Diagnostic, type LspResponse, type Snapshot } from './protocol.js'
import { ShellSidecar, checkCommandDanger, type ShellLine, type ParsedLocation, type ShellRun } from './shell.js'
import { streamCompletion, streamChat, sanitizeInlineCompletion, type AiContext } from './ai.js'
import { getProviderLabel, setActiveModel, listAvailableModels, isOllamaActive } from './ai-registry.js'
import {
  REPO_ROOT, COMMAND_LABELS, NODE_LABELS,
  buildLeaderMap, flattenLeader, isLeafAction,
  findNearestTestScript, extractFirstCodeBlock, extractFirstLocation,
  printable, printableText, bufferName,
  type LeaderNode, type CmdItem,
} from './leader.js'
import {
  applyPatchProposal,
  assessPatchRisk,
  buildReviewDiffSnippet,
  buildReviewTrace,
  buildTrace,
  codeClawDir,
  collectGitContext,
  collectGitDiffForReview,
  generatePatchProposal,
  generateReviewProposal,
  loadCodeClawProject,
  loadCodeClawProjectForReview,
  loadTasks,
  makeReviewTraceId,
  makeTraceId,
  prepareReviewGitInput,
  readLatestTrace,
  writeReviewTrace,
  writeTrace,
  type FixContext,
  type PatchProposal,
  type PatchRiskAssessment,
  type ReviewFinding,
  type ReviewProposal,
  type TraceSummary,
} from './codeclaw.js'
import {
  loadConfig, reloadConfig, getConfigPath, CONFIG_PATHS, registerPlugins, loadPluginStartupActions,
  type BufferInfo, type ConfigAction, type ConfigNotifyLevel, type ConfigPanelName,
  type ConfigPickItem, type EditorContext, type LeaderTree, type QeConfig,
} from './config.js'
import { CommandRegistry, registerCommandActions, registerConfigCommands, runConfigAction } from './config-runtime.js'
import { configApiTemplate, starterConfigTemplate } from './config-api-template.js'
import { onChangeDecision } from './config-hooks.js'
import { createEditorContext, hookUiStubs } from './editor-context.js'
import {
  evalCurrentFile as evalCurrentFileAtPath,
  evalExpression as runEvalExpression,
  evalRegion as runEvalRegion,
} from './config-eval.js'
import { configPromptCancelValue, isConfigPromptType } from './config-ui.js'
import {
  loadGitStatus, loadFileHunks, getGitRepoRoot, hunkNewStartRow, resolveRepoFilePath, stageEntry, unstageEntry, commitGit, pullGit, pushGit,
  getGitLog, buildGitDisplayLines,
  type GitStatusData, type GitFileEntry, type GitHunk, type GitDisplayLine, type GitLogEntry, type GitPanelView, type GitSelectableLine,
} from './git.js'
import { readDiredEntries, type DiredEntry } from './dired.js'
import { debugLog, getDebugLogPath } from './debug-log.js'
import { detectProjectRoot } from './root.js'
import { diagnosticAtCursor, formatDiagnostic, nextDiagnostic, sortDiagnostics } from './diagnostics.js'
import { nearestIdentifierPosition } from './lsp-position.js'
import {
  normalizeTasks,
  normalizeWorkspaceTab,
  resolveHookTask,
  sessionFromBuffers,
  type WorkspaceTab,
  type WorkflowSession,
} from './workflow.js'

import {
  applyTheme,
  C,
  CmdPalettePanel,
  DiagnosticsPanel,
  LspPanel,
  ShellPane,
  SplashPanel,
  WhichKeyPanel,
  WorkflowTabBar,
  AiPanel,
  GitPanel,
  DiredPanel,
  EditorPane,
  findMatches,
  filterBuffers,
  toBufferInfo,
  isDirty,
  loadWorkflowSession,
  saveWorkflowSession,
  lspHoverLines,
  lspDefinitionTarget,
  lspUnavailableText,
  selectionBounds,
  getVisualText,
  expandRegionOnce,
  normalizePickItems,
  type EditorBuffer,
  type EditorMode,
  type Panel,
  type PromptState,
  type SelBounds,
  type AiMessage,
  type ChatStreamingState,
  type CodeClawFixState,
  type ReviewState,
  type LspOverlay,
  type FuzzyMatch,
  type NormalizedPickItem,
  type VisualSnap,
  type YankRegister,
  type LspTarget,
} from './ui/index.js'
import type { Theme } from './ui/theme.js'

type ConfigPromptState = Extract<PromptState, { type: 'configPick' | 'configInput' | 'configConfirm' }>

function isConfigPrompt(prompt: PromptState | null): prompt is ConfigPromptState {
  return Boolean(prompt && isConfigPromptType(prompt.type))
}

function writeClipboard(text: string): boolean {
  const commands =
    process.platform === 'darwin'
      ? [['pbcopy']]
      : process.platform === 'win32'
        ? [['clip']]
        : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]

  for (const command of commands) {
    const result = spawnSync(command[0]!, command.slice(1), {
      input: text,
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    if (result.status === 0) return true
  }
  return false
}

function getGitContext(): string {
  const cwd = process.cwd()
  try {
    const status = spawnSync('git', ['status', '--short'], { cwd, encoding: 'utf8', timeout: 800 })
    const diff   = spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd, encoding: 'utf8', timeout: 800 })
    const parts: string[] = []
    if (status.stdout?.trim()) parts.push(`git status:\n${status.stdout.trim()}`)
    if (diff.stdout?.trim())   parts.push(`git diff --stat:\n${diff.stdout.trim()}`)
    return parts.join('\n\n')
  } catch { return '' }
}

// ── Fuzzy file finder helpers ─────────────────────────────────────────────────

function fuzzyScore(needle: string, haystack: string): { score: number; indices: number[] } | null {
  const n = needle.toLowerCase(), h = haystack.toLowerCase()
  if (!n) return { score: 0, indices: [] }
  const indices: number[] = []
  let hi = 0
  for (let ni = 0; ni < n.length; ni++) {
    const found = h.indexOf(n[ni]!, hi)
    if (found === -1) return null
    indices.push(found)
    hi = found + 1
  }
  const span = indices[indices.length - 1]! - indices[0]!
  const prefixBonus = h.startsWith(n) ? -100 : 0
  return { score: span + prefixBonus, indices }
}

function fuzzyRank(needle: string, candidates: string[]): FuzzyMatch[] {
  return candidates
    .map(path => { const r = fuzzyScore(needle, path); return r ? { path, score: r.score, indices: r.indices } : null })
    .filter((x): x is FuzzyMatch => x !== null)
    .sort((a, b) => a.score - b.score)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '__pycache__', '.cache'])

async function collectFilesAsync(dir: string, depth: number, base: string): Promise<string[]> {
  if (depth > 4) return []
  let entries: import('node:fs').Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }) } catch { return [] }
  const results = await Promise.all(
    entries
      .filter(e => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map(async e => {
        if (e.isDirectory()) return collectFilesAsync(join(dir, e.name), depth + 1, base)
        return [join(dir, e.name).slice(base.length + 1)]
      }),
  )
  return results.flat()
}

// ── Main app component ────────────────────────────────────────────────────────

function withEvalNotifyTracking(ctx: EditorContext): { ctx: EditorContext; userNotified: () => boolean } {
  let notified = false
  return {
    ctx: {
      ...ctx,
      ui: {
        ...ctx.ui,
        notify: (message, level) => {
          notified = true
          ctx.ui.notify(message, level)
        },
      },
    },
    userNotified: () => notified,
  }
}

function App({
  buffers, activeId, bufferKey, sidecar, shell, shellLines, config, userLeader, lspOverlay, actions,
  initialPanel, workspaceTab, onWorkspaceTabChange,
}: {
  buffers: EditorBuffer[]
  activeId: string
  bufferKey: number
  sidecar: QeSidecar
  shell: ShellSidecar
  shellLines: ShellLine[]
  config: QeConfig
  userLeader: LeaderTree
  lspOverlay: LspOverlay | null
  initialPanel?: Panel
  workspaceTab: WorkspaceTab
  onWorkspaceTabChange: (tab: WorkspaceTab) => void
  actions: {
    openFile: (path: string, jump?: { row: number; col: number }) => void
    switchBuffer: (id: string) => void
    killBuffer: (id?: string) => void
    nextBuffer: () => void
    previousBuffer: () => void
    newScratch: () => void
    quitAll: () => void
    reloadConfig: () => Promise<void>
    applyConfig: (config: QeConfig) => void
    openConfig: () => void
    clearLspOverlay: () => void
    /** Mutates active buffer status + triggers rerender (for completion errors etc.). */
    setActiveBufferStatus: (status: string) => void
    registerShellPanelOpener: (open: () => void) => void
  }
}) {
  const activeIndex = Math.max(0, buffers.findIndex(buffer => buffer.id === activeId))
  const activeBuffer = buffers[activeIndex] ?? buffers[0]!
  const snapshot = activeBuffer.snapshot
  const status = activeBuffer.status
  const filename = activeBuffer.snapshot?.filename ?? activeBuffer.filename ?? undefined

  const [mode,           setMode]           = React.useState<EditorMode>('normal')
  const [ghostText,          setGhostText]          = React.useState<string | null>(null)
  /** Mirrors ghostText for input handlers — streaming updates must not lag one render behind Tab. */
  const ghostTextRef = React.useRef<string | null>(null)
  const setGhostTextSync = React.useCallback((value: string | null) => {
    ghostTextRef.current = value
    setGhostText(value)
  }, [])
  const [completionStreaming, setCompletionStreaming] = React.useState(false)
  const [scrollOffset,   setScrollOffset]   = React.useState(0)
  const [panel,          setPanel]          = React.useState<Panel>(initialPanel ?? null)
  React.useEffect(() => {
    actions.registerShellPanelOpener(() => setPanel({ type: 'shell' }))
  }, [actions])
  const setWorkspaceTab = React.useCallback((tab: WorkspaceTab) => {
    onWorkspaceTabChange(tab)
    if (tab === 'process' || tab === 'ai') setPanel(null)
  }, [onWorkspaceTabChange])
  const switchWorkflowTabByIndex = React.useCallback((index: number) => {
    if (index < 0) return
    if (index < buffers.length) {
      const target = buffers[index]
      if (!target) return
      setWorkspaceTab('code')
      if (target.id !== activeId) actions.switchBuffer(target.id)
      return
    }
    if (index === buffers.length) setWorkspaceTab('process')
    if (index === buffers.length + 1) setWorkspaceTab('ai')
  }, [actions, activeId, buffers, setWorkspaceTab])
  const cycleWorkflowTab = React.useCallback((delta: number) => {
    const total = buffers.length + 2
    if (total <= 1) return
    const current = workspaceTab === 'process'
      ? buffers.length
      : workspaceTab === 'ai'
        ? buffers.length + 1
        : Math.max(0, buffers.findIndex(b => b.id === activeId))
    switchWorkflowTabByIndex((current + delta + total) % total)
  }, [activeId, buffers, switchWorkflowTabByIndex, workspaceTab])
  const [visualAnchor,   setVisualAnchor]   = React.useState<{ row: number; col: number } | null>(null)
  const [visualLineMode, setVisualLineMode] = React.useState(false)
  /** Stack of selections before each expand (contract pops). Not react state — avoids stale handlers. */
  const visualExpandHistoryRef = React.useRef<VisualSnap[]>([])
  /** Last visual selection — kept after Esc so SPC p s can eval without staying in visual mode. */
  const lastVisualSelectionRef = React.useRef<{
    anchor: { row: number; col: number }
    cursor: { row: number; col: number }
    lineMode: boolean
    lines: string[]
  } | null>(null)
  const [cmdBuf,         setCmdBuf]         = React.useState('')
  const [searchBuf,      setSearchBuf]      = React.useState('')
  const [searchQuery,    setSearchQuery]    = React.useState('')
  const [commandEpoch,   setCommandEpoch]   = React.useState(0)
  const [evalCommands,   setEvalCommands]   = React.useState<Record<string, ConfigAction>>({})
  const [flashMessage,   setFlashMessage]   = React.useState<string | null>(null)
  const flashTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [prompt,         setPrompt]         = React.useState<PromptState | null>(null)
  const uiPromptIdRef = React.useRef(1)
  const uiPromptResolversRef = React.useRef(new Map<number, (value: unknown) => void>())
  const replacePrompt = React.useCallback((next: PromptState | null) => {
    setPrompt(prev => {
      if (isConfigPrompt(prev)) {
        const sameConfigPrompt = isConfigPrompt(next) && next.id === prev.id
        if (!sameConfigPrompt) {
          const resolver = uiPromptResolversRef.current.get(prev.id)
          uiPromptResolversRef.current.delete(prev.id)
          resolver?.(configPromptCancelValue(prev.type))
        }
      }
      return next
    })
  }, [])

  const [aiModelLabel,   setAiModelLabel]   = React.useState(() => getProviderLabel())
  const [aiMessages,     setAiMessages]     = React.useState<AiMessage[]>([])
  const [chatStreaming,  setChatStreaming]   = React.useState<ChatStreamingState | null>(null)
  const [aiInput,        setAiInput]        = React.useState('')
  const [aiStreaming,    setAiStreaming]     = React.useState(false)
  const [aiScrollOffset, setAiScrollOffset] = React.useState(0)
  const [fixState, setFixState] = React.useState<CodeClawFixState>({ status: 'idle' })
  const [clawProgressChars, setClawProgressChars] = React.useState(0)
  const [reviewState, setReviewState] = React.useState<ReviewState>({ status: 'idle' })
  const [thinkingTick, setThinkingTick] = React.useState(0)
  const [shellInput, setShellInput] = React.useState('')
  const [shellRunning, setShellRunning] = React.useState(false)
  const [shellScrollOffset, setShellScrollOffset] = React.useState(0)
  const [dangerPrompt, setDangerPrompt] = React.useState<{ cmd: string; reason: string } | null>(null)

  const aiPanelBusy =
    aiStreaming
    || fixState.status === 'generating'
    || fixState.status === 'applying'
    || reviewState.status === 'generating'
    || completionStreaming

  React.useEffect(() => {
    if (panel?.type !== 'shell') setDangerPrompt(null)
  }, [panel])

  React.useEffect(() => {
    if (!aiPanelBusy) return
    const id = setInterval(() => setThinkingTick(t => (t + 1) % 4096), 90)
    return () => clearInterval(id)
  }, [aiPanelBusy])

  const pendingKeyRef    = React.useRef<string | null>(null)
  /** Lone Esc before `[` / `]` (Option+[ / Option+] split across stdin reads). */
  const workflowTabBracketArmUntilRef = React.useRef(0)
  const yankRegisterRef  = React.useRef<YankRegister | null>(null)
  const leaderMapRef     = React.useRef<LeaderNode>({})
  const abortRef         = React.useRef<AbortController | null>(null)
  const aiAbortRef       = React.useRef<AbortController | null>(null)
  const searchQueryRef   = React.useRef('')
  const searchIdxRef     = React.useRef(0)

  const enterNormal = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setCompletionStreaming(false)
    setGhostTextSync(null)
    replacePrompt(null)
    pendingKeyRef.current = null
    setPanel(null)
    setMode('normal')
    setVisualAnchor(null)
    setVisualLineMode(false)
    visualExpandHistoryRef.current = []
    setCmdBuf('')
    setSearchBuf('')
  }, [replacePrompt, setGhostTextSync])

  const yankText = React.useCallback((text: string, lineWise: boolean) => {
    yankRegisterRef.current = { text, lineWise }
    const clipboardText = lineWise ? `${text}\n` : text
    const copied = writeClipboard(clipboardText)
    actions.setActiveBufferStatus(`yanked ${lineWise ? 'line' : 'selection'}${copied ? ' to clipboard' : ''}`)
  }, [actions])

  const saveCurrentBuffer = React.useCallback(() => {
    const path = snapshot?.filename ?? activeBuffer.filename ?? null
    if (path) {
      sidecar.save()
      return
    }
    enterNormal()
    replacePrompt({ type: 'saveAs', query: '', thenQuit: false })
  }, [activeBuffer.filename, enterNormal, replacePrompt, sidecar, snapshot?.filename])

  const saveBufferAndQuit = React.useCallback(() => {
    const path = snapshot?.filename ?? activeBuffer.filename ?? null
    if (path) {
      sidecar.save()
      actions.quitAll()
      return
    }
    enterNormal()
    replacePrompt({ type: 'saveAs', query: '', thenQuit: true })
  }, [actions, activeBuffer.filename, enterNormal, replacePrompt, sidecar, snapshot?.filename])

  // Reset editor state whenever the active buffer changes
  React.useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setCompletionStreaming(false)
    setGhostTextSync(null)
    replacePrompt(null)
    pendingKeyRef.current = null
    setMode('normal')
    setVisualAnchor(null)
    setVisualLineMode(false)
    visualExpandHistoryRef.current = []
    setCmdBuf('')
    setSearchBuf('')
    setSearchQuery('')
    searchQueryRef.current = ''
    searchIdxRef.current = 0
    setScrollOffset(0)
    setAiScrollOffset(0)
    setPanel(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferKey, replacePrompt])

  // Parse first navigable location from last AI response (recomputed when streaming ends)
  const aiNavLoc = React.useMemo<ParsedLocation | null>(() => {
    if (aiStreaming) return null
    const last = aiMessages[aiMessages.length - 1]
    if (last?.role === 'assistant' && last.content) return extractFirstLocation(last.content)
    return null
  }, [aiStreaming, aiMessages])

  // Parse first code block from last AI response — offered as a shell command via !
  const aiShellCmd = React.useMemo<string | null>(() => {
    if (aiStreaming) return null
    const last = aiMessages[aiMessages.length - 1]
    if (last?.role === 'assistant' && last.content) return extractFirstCodeBlock(last.content)
    return null
  }, [aiStreaming, aiMessages])

  const bufferInfos = React.useMemo(
    () => buffers.map(buffer => toBufferInfo(buffer, activeId)),
    [buffers, activeId],
  )

  const openFilePromptFromRoot = React.useCallback((root: string) => {
    enterNormal()
    replacePrompt({ type: 'file', query: '', candidates: [], ranked: [], selectedIdx: 0, base: root })
    collectFilesAsync(root, 0, root).then(candidates => {
      setPrompt(prev => {
        if (prev?.type !== 'file') return prev
        const ranked = prev.query
          ? fuzzyRank(prev.query, candidates).slice(0, 50)
          : candidates.slice(0, 50).map(path => ({ path, score: 0, indices: [] }))
        return { ...prev, candidates, ranked }
      })
    }).catch(() => {})
  }, [enterNormal, replacePrompt])

  const setStatus = React.useCallback((message: string) => {
    actions.setActiveBufferStatus(message)
  }, [actions])

  const jumpToDiagnostic = React.useCallback((diagnostic: Diagnostic | null) => {
    if (!diagnostic) {
      setStatus('diagnostics: none')
      return
    }
    sidecar.moveTo(diagnostic.row, diagnostic.startCol)
    setStatus(formatDiagnostic(diagnostic))
  }, [setStatus, sidecar])

  const openDiagnosticsPanel = React.useCallback((title = 'buffer') => {
    setPanel({
      type: 'diagnostics',
      diagnostics: sortDiagnostics(snapshot?.diagnostics ?? []),
      cursor: 0,
      title,
    })
  }, [snapshot?.diagnostics])

  const currentGitHunk = React.useCallback((
    sections: Array<GitFileEntry['section']>,
    movement: 'current' | 'next' | 'previous' = 'current',
  ): { entry: GitFileEntry; hunk: GitHunk; row: number } | null => {
    if (!snapshot?.filename) return null
    const root = getGitRepoRoot(process.cwd())
    const abs = resolvePath(snapshot.filename)
    const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : snapshot.filename
    const status = loadGitStatus(process.cwd())
    const entries = {
      untracked: status.untracked,
      unstaged: status.unstaged,
      staged: status.staged,
    }
    const entry = sections.flatMap(section => entries[section]).find(item => item.path === rel)
    if (!entry) return null
    const hunks = loadFileHunks(process.cwd(), entry.path, entry.section)
    const cursorRow = snapshot.cursor.row
    const hunkRows = hunks
      .map(hunk => ({ hunk, row: hunkNewStartRow(hunk.header) }))
      .filter((item): item is { hunk: GitHunk; row: number } => item.row != null)

    let target = hunkRows.find((candidate, index) => {
      const start = candidate.row
      const nextStart = hunkRows[index + 1]?.row
      return start != null && cursorRow >= start && (nextStart == null || cursorRow < nextStart)
    }) ?? hunkRows[0]

    if (movement === 'next') {
      target = hunkRows.find(candidate => candidate.row > cursorRow) ?? hunkRows[0]
    } else if (movement === 'previous') {
      target = [...hunkRows].reverse().find(candidate => candidate.row < cursorRow) ?? hunkRows[hunkRows.length - 1]
    }

    return target ? { entry: { ...entry, hunks }, hunk: target.hunk, row: target.row } : null
  }, [snapshot])

  const openGitPanelForHunk = React.useCallback((target: { entry: GitFileEntry; hunk: GitHunk }, note?: string) => {
    const data = loadGitStatus(process.cwd())
    const update = (entries: GitFileEntry[]) => entries.map(entry =>
      entry.path === target.entry.path && entry.section === target.entry.section
        ? { ...entry, expanded: true, hunks: target.entry.hunks }
        : entry,
    )
    const nextData: GitStatusData = {
      ...data,
      untracked: update(data.untracked),
      unstaged: update(data.unstaged),
      staged: update(data.staged),
    }
    const lines = buildGitDisplayLines(nextData)
    let selectableCursor = 0
    let seen = 0
    for (const line of lines) {
      if (!line.selectable) continue
      if (line.type === 'hunk' && line.entry.path === target.entry.path && line.entry.section === target.entry.section && line.hunk.header === target.hunk.header) {
        selectableCursor = seen
        break
      }
      seen++
    }
    setPanel({ type: 'git', data: nextData, cursor: selectableCursor, pendingKey: null, logEntries: null, gitError: note, view: 'status' })
  }, [])

  const resolveUiPrompt = React.useCallback((id: number, value: unknown) => {
    const resolver = uiPromptResolversRef.current.get(id)
    uiPromptResolversRef.current.delete(id)
    resolver?.(value)
  }, [])

  const uiPick = React.useCallback((title: string, items: ConfigPickItem[]): Promise<string | null> => {
    const id = uiPromptIdRef.current++
    const normalized = normalizePickItems(items)
    return new Promise(resolve => {
      uiPromptResolversRef.current.set(id, resolve as (value: unknown) => void)
      replacePrompt({ type: 'configPick', id, title, query: '', items: normalized, selected: 0 })
    })
  }, [replacePrompt])

  const uiInput = React.useCallback((title: string, initial = ''): Promise<string | null> => {
    const id = uiPromptIdRef.current++
    return new Promise(resolve => {
      uiPromptResolversRef.current.set(id, resolve as (value: unknown) => void)
      replacePrompt({ type: 'configInput', id, title, value: initial })
    })
  }, [replacePrompt])

  const uiConfirm = React.useCallback((title: string, body?: string): Promise<boolean> => {
    const id = uiPromptIdRef.current++
    return new Promise(resolve => {
      uiPromptResolversRef.current.set(id, resolve as (value: unknown) => void)
      replacePrompt({ type: 'configConfirm', id, title, body })
    })
  }, [replacePrompt])

  const openNamedPanel = React.useCallback((name: ConfigPanelName) => {
    if (name === 'shell') setPanel({ type: 'shell' })
    else if (name === 'ai') setWorkspaceTab('ai')
    else if (name === 'git') openGitPanel()
    else if (name === 'diagnostics') openDiagnosticsPanel('buffer')
    else if (name === 'commandPalette') setPanel({ type: 'cmdpalette', query: '', cursor: 0, items: flattenLeader(leaderMapRef.current) })
  }, [openDiagnosticsPanel, setWorkspaceTab])

  const openSplash = React.useCallback((options: { title: string; message?: string; hint?: string }) => {
    setPanel({ type: 'splash', title: options.title, message: options.message, hint: options.hint })
  }, [])

  React.useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [])

  const notify = React.useCallback((message: string, level: ConfigNotifyLevel = 'info') => {
    const text = level === 'info' ? message : `${level}: ${message}`
    setStatus(text)
    setFlashMessage(text)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashMessage(null), 8000)
    if (level !== 'info') process.stderr.write(`qe: ${text}\n`)
  }, [setStatus])

  const commandRegistry = React.useMemo(() => {
    const registry = new CommandRegistry()
    registry.register('file.find', 'file: find', () => openFilePromptFromRoot(detectProjectRoot({ filename: snapshot?.filename ?? activeBuffer.filename, cwd: process.cwd() })))
    registry.register('file.save', 'file: save', () => saveCurrentBuffer())
    registry.register('buffer.switch', 'buffer: switch', () => {
      const sorted = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const selected = Math.max(0, sorted.findIndex(buffer => buffer.id === activeId))
      replacePrompt({ type: 'buffer', query: '', selected })
    })
    registry.register('shell.run', 'shell: run command', (ctx, args) => {
      const command = typeof args?.command === 'string' ? args.command : ''
      if (command) ctx.shell.run(command)
    })
    registry.register('panel.open', 'panel: open', (ctx, args) => {
      const panel = typeof args?.panel === 'string' ? args.panel as ConfigPanelName : 'shell'
      ctx.ui.panel(panel, args)
    })
    registry.register('code.hover', 'code: hover', () => {
      const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
      sidecar.hover(cursor.row, cursor.col)
    })
    registry.register('code.definition', 'code: go to definition', () => {
      const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
      sidecar.goToDefinition(cursor.row, cursor.col)
    })
    registry.register('code.format', 'code: format', () => sidecar.format())
    registry.register('git.status', 'git: status', () => openGitPanel())
    registry.register('git.hunk.stage', 'git: stage hunk', () => {
      const target = currentGitHunk(['unstaged', 'untracked'])
      if (!target) { setStatus('git: no hunk at current file'); return }
      stageEntry(process.cwd(), target.entry, target.hunk)
      setStatus(`git: staged hunk in ${target.entry.path}`)
    })
    registry.register('git.hunk.preview', 'git: preview hunk', () => {
      const target = currentGitHunk(['unstaged', 'staged'])
      if (!target) { setStatus('git: no hunk at current file'); return }
      openGitPanelForHunk(target, `preview ${target.entry.path} ${target.hunk.header}`)
    })
    registry.register('diagnostics.list', 'diagnostics: list', () => openDiagnosticsPanel('buffer'))
    registry.register('diagnostics.next', 'diagnostics: next', () => jumpToDiagnostic(nextDiagnostic(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 }, 1)))
    registry.register('diagnostics.line', 'diagnostics: current line', () => jumpToDiagnostic(diagnosticAtCursor(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 })))
    registry.register('ai.chat', 'ai: chat', () => setWorkspaceTab('ai'))
    registry.register('workspace.code', 'workspace: code tab', () => setWorkspaceTab('code'))
    registry.register('workspace.process', 'workspace: process tab', () => setWorkspaceTab('process'))
    registry.register('workspace.ai', 'workspace: AI tab', () => setWorkspaceTab('ai'))
    registry.register('tasks.pickAndRun', 'tasks: pick and run', async (ctx) => {
      const tasks = normalizeTasks(config.tasks)
      if (tasks.length === 0) {
        ctx.ui.notify('tasks: no tasks configured', 'warn')
        return
      }
      const picked = await ctx.ui.pick('Run task', tasks.map(task => ({
        label: task.name,
        value: task.name,
        description: task.command,
      })))
      const task = tasks.find(candidate => candidate.name === picked)
      if (!task) return
      ctx.shell.run(task.command)
      if (task.tab === 'process') setWorkspaceTab('process')
      else setPanel({ type: 'shell' })
    })
    registerConfigCommands(config, registry)
    registerCommandActions(evalCommands, registry)
    return registry
  }, [
    activeBuffer.filename, activeId, buffers, commandEpoch, config, currentGitHunk, evalCommands, jumpToDiagnostic, openDiagnosticsPanel,
    openFilePromptFromRoot, openGitPanelForHunk, replacePrompt, saveCurrentBuffer, setStatus, setWorkspaceTab, sidecar, snapshot,
  ])

  const makeCtx = React.useCallback((): EditorContext => createEditorContext({
      mode: 'interactive',
      filename: snapshot?.filename ?? null,
      lines:    snapshot?.lines   ?? [],
      cursor:   snapshot?.cursor  ?? { row: 0, col: 0 },
      save:     saveCurrentBuffer,
      quit:     actions.quitAll,
      insert:   (text) => sidecar.insert(text),
      move:     (dir) => sidecar.move(dir as Parameters<QeSidecar['move']>[0]),
      shell:    { run: (cmd) => { void shell.runTracked(cmd) }, lines: () => shellLines.map(l => l.text) },
      buffers: {
        list: () => bufferInfos,
        current: () => bufferInfos.find(buffer => buffer.active) ?? null,
        switch: actions.switchBuffer,
        kill: actions.killBuffer,
        next: actions.nextBuffer,
        previous: actions.previousBuffer,
      },
      openFile: actions.openFile,
      commands: {
        run: async (id, args) => commandRegistry.run(id, makeCtx(), args),
      },
      ui: {
        pick: uiPick,
        input: uiInput,
        confirm: uiConfirm,
        notify,
        panel: openNamedPanel,
        splash: openSplash,
      },
      git: {
        status: openGitPanel,
        stageCurrentFile,
        stageHunk: () => {
          const target = currentGitHunk(['unstaged', 'untracked'])
          if (!target) { setStatus('git: no hunk at current file'); return }
          stageEntry(process.cwd(), target.entry, target.hunk)
          setStatus(`git: staged hunk in ${target.entry.path}`)
        },
        previewHunk: () => {
          const target = currentGitHunk(['unstaged', 'staged'])
          if (!target) { setStatus('git: no hunk at current file'); return }
          openGitPanelForHunk(target, `preview ${target.entry.path} ${target.hunk.header}`)
        },
      },
      lsp: {
        hover: () => {
          const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
          sidecar.hover(cursor.row, cursor.col)
        },
        definition: () => {
          const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
          sidecar.goToDefinition(cursor.row, cursor.col)
        },
        format: () => sidecar.format(),
      },
      diagnostics: {
        list: () => openDiagnosticsPanel('buffer'),
        next: () => jumpToDiagnostic(nextDiagnostic(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 }, 1)),
        line: () => jumpToDiagnostic(diagnosticAtCursor(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 })),
      },
    }), [
      actions, bufferInfos, commandRegistry, currentGitHunk, jumpToDiagnostic, notify, openDiagnosticsPanel,
      openGitPanelForHunk, openNamedPanel, openSplash, saveCurrentBuffer, setStatus, shell, shellLines, sidecar, snapshot,
      uiConfirm, uiInput, uiPick,
    ])

  const pluginStartupRanRef = React.useRef(false)

  React.useEffect(() => {
    void (async () => {
      await registerPlugins(commandRegistry)
      registerCommandActions(evalCommands, commandRegistry)
      if (pluginStartupRanRef.current) return
      const startups = await loadPluginStartupActions()
      if (startups.length === 0) return
      pluginStartupRanRef.current = true
      const ctx = makeCtx()
      for (const action of startups) {
        await runConfigAction(action, ctx, commandRegistry)
      }
    })()
  }, [commandRegistry, evalCommands, makeCtx])

  const bumpCommandEpoch = React.useCallback(() => {
    setCommandEpoch(n => n + 1)
  }, [])

  const evalCurrentFile = React.useCallback(async () => {
    enterNormal()
    setPanel(null)
    const baseCtx = makeCtx()
    const { ctx, userNotified } = withEvalNotifyTracking(baseCtx)
    const result = await evalCurrentFileAtPath(
      commandRegistry,
      ctx,
      snapshot?.filename ?? activeBuffer.filename,
      { lines: snapshot?.lines ?? null },
    )
    if (result.kind === 'config') {
      actions.applyConfig(result.config)
      setEvalCommands(result.config.commands ?? {})
      bumpCommandEpoch()
      notify(result.message, result.ok ? 'info' : 'error')
      return
    }
    if (result.ok && result.commands && Object.keys(result.commands).length > 0) {
      setEvalCommands(prev => ({ ...prev, ...result.commands! }))
    }
    if (result.ok && result.commandIds && result.commandIds.length > 0) {
      for (const id of result.commandIds) {
        await commandRegistry.run(id, ctx)
      }
    }
    bumpCommandEpoch()
    if (!result.ok) notify(result.message, 'error')
    else if (!userNotified()) notify(result.message, 'info')
  }, [
    actions, activeBuffer.filename, bumpCommandEpoch, commandRegistry, enterNormal, makeCtx, notify, snapshot?.filename, snapshot?.lines,
  ])

  const evalExpression = React.useCallback(async () => {
    enterNormal()
    setPanel(null)
    const body = await uiInput('Eval expression', '')
    if (body === null) return
    try {
      const baseCtx = makeCtx()
      const { ctx, userNotified } = withEvalNotifyTracking(baseCtx)
      const result = await runEvalExpression(commandRegistry, ctx, body)
      if (result.ok && result.commands && Object.keys(result.commands).length > 0) {
        setEvalCommands(prev => ({ ...prev, ...result.commands! }))
      }
      if (result.ok && result.commandIds && result.commandIds.length > 0) {
        for (const id of result.commandIds) {
          await commandRegistry.run(id, ctx)
        }
      }
      if (result.ok) bumpCommandEpoch()
      if (!result.ok) notify(result.message, 'error')
      else if (result.displayed && !userNotified()) notify(result.message, 'info')
      else if (!userNotified()) notify(result.message, 'info')
    } catch (error) {
      notify(`eval expression failed: ${String(error)}`, 'error')
    }
  }, [bumpCommandEpoch, commandRegistry, enterNormal, makeCtx, notify, uiInput])

  const evalRegion = React.useCallback(async () => {
    let sel: SelBounds | null = null
    let lines: string[] = []

    if (mode === 'visual' && visualAnchor && snapshot) {
      sel = selectionBounds(visualAnchor, snapshot.cursor, visualLineMode, snapshot.lines)
      lines = snapshot.lines
    } else {
      const stored = lastVisualSelectionRef.current
      if (stored) {
        sel = selectionBounds(stored.anchor, stored.cursor, stored.lineMode, stored.lines)
        lines = stored.lines
      }
    }

    if (!sel || lines.length === 0) {
      notify('eval selection: select text (v), then SPC p s', 'warn')
      return
    }

    const text = getVisualText(lines, sel)
    if (!text.trim()) {
      notify('eval selection: selection is empty', 'warn')
      return
    }

    enterNormal()
    setPanel(null)
    const baseCtx = makeCtx()
    const { ctx, userNotified } = withEvalNotifyTracking(baseCtx)
    const result = await runEvalRegion(commandRegistry, ctx, text)
    if (result.ok && result.commands && Object.keys(result.commands).length > 0) {
      setEvalCommands(prev => ({ ...prev, ...result.commands! }))
    }
    if (result.ok && result.commandIds && result.commandIds.length > 0) {
      for (const id of result.commandIds) {
        await commandRegistry.run(id, ctx)
      }
    }
    if (result.ok) bumpCommandEpoch()
    if (!result.ok) notify(result.message, 'error')
    else if (result.displayed && !userNotified()) notify(result.message, 'info')
    else if (!userNotified()) notify(result.message, 'info')
  }, [bumpCommandEpoch, commandRegistry, enterNormal, makeCtx, mode, notify, snapshot, visualAnchor, visualLineMode])

  const leaderMap = React.useMemo(() => buildLeaderMap(
    { save: saveCurrentBuffer, saveAndQuit: saveBufferAndQuit },
    setPanel as (v: unknown) => void,
    {
      openSwitcher: () => {
        enterNormal()
        const sorted = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        const selected = Math.max(0, sorted.findIndex(buffer => buffer.id === activeId))
        replacePrompt({ type: 'buffer', query: '', selected })
      },
      openFilePrompt: () => {
        openFilePromptFromRoot(detectProjectRoot({ filename: snapshot?.filename ?? activeBuffer.filename, cwd: process.cwd() }))
      },
      next: actions.nextBuffer,
      previous: actions.previousBuffer,
      kill: () => actions.killBuffer(activeId),
      newScratch: actions.newScratch,
      quitAll: actions.quitAll,
    },
    {
      openChat: () => setWorkspaceTab('ai'),
      triggerCompletion: () => triggerCompletion(),
      explainError: () => explainLastError(),
      fixFailure: () => runCodeClawFix(),
      showTrace: () => showLastTrace(),
      rerunLast: () => {
        const last = shell.lastRun
        if (!last) return
        void shell.runTracked(last.command)
        setPanel({ type: 'shell' })
      },
      review: () => runCodeClawReview(),
      clearChat: () => clearAiChat(),
      selectModel: () => openModelPicker(),
    },
    {
      open: openGitPanel,
      stage: stageCurrentFile,
      log: () => {
        const data = loadGitStatus(process.cwd())
        setPanel({ type: 'git', data, cursor: 0, pendingKey: null, logEntries: getGitLog(process.cwd()), gitError: undefined, view: 'log' })
      },
      nextHunk: () => {
        const target = currentGitHunk(['unstaged', 'staged'], 'next')
        if (!target) { setStatus('git: no next hunk for current file'); return }
        sidecar.moveTo(target.row, 0)
        setStatus(`git: next hunk ${target.entry.path}:${target.row + 1}`)
      },
      previousHunk: () => {
        const target = currentGitHunk(['unstaged', 'staged'], 'previous')
        if (!target) { setStatus('git: no previous hunk for current file'); return }
        sidecar.moveTo(target.row, 0)
        setStatus(`git: previous hunk ${target.entry.path}:${target.row + 1}`)
      },
      stageHunk: () => {
        const target = currentGitHunk(['unstaged', 'untracked'])
        if (!target) { setStatus('git: no hunk at current file'); return }
        stageEntry(process.cwd(), target.entry, target.hunk)
        setStatus(`git: staged hunk in ${target.entry.path}`)
      },
      unstageHunk: () => {
        const target = currentGitHunk(['staged'])
        if (!target) { setStatus('git: no staged hunk at current file'); return }
        unstageEntry(process.cwd(), target.entry, target.hunk)
        setStatus(`git: unstaged hunk in ${target.entry.path}`)
      },
      previewHunk: () => {
        const target = currentGitHunk(['unstaged', 'staged'])
        if (!target) { setStatus('git: no hunk at current file'); return }
        openGitPanelForHunk(target, `preview ${target.entry.path} ${target.hunk.header}`)
      },
      blameLine: () => {
        if (!snapshot?.filename) { setStatus('git: no file for blame'); return }
        void shell.runTracked(`git --no-pager blame -L ${snapshot.cursor.row + 1},${snapshot.cursor.row + 1} -- ${shellQuote(snapshot.filename)}`)
        setPanel({ type: 'shell' })
      },
      fileHistory: () => {
        if (!snapshot?.filename) { setStatus('git: no file history for scratch buffer'); return }
        void shell.runTracked(`git --no-pager log --stat --patch -- ${shellQuote(snapshot.filename)}`)
        setPanel({ type: 'shell' })
      },
    },
    {
      hover: () => {
        const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
        sidecar.hover(cursor.row, cursor.col)
      },
      definition: () => {
        const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
        sidecar.goToDefinition(cursor.row, cursor.col)
      },
      references: () => setStatus('LSP references: not supported by the sidecar yet'),
      rename: () => setStatus('LSP rename: not supported by the sidecar yet'),
      codeAction: () => setStatus('LSP code action: not supported by the sidecar yet'),
      format: () => sidecar.format(),
      toggleInlayHints: () => setStatus('inlay hints: not supported by the sidecar yet'),
    },
    {
      list: () => openDiagnosticsPanel('project'),
      buffer: () => openDiagnosticsPanel('buffer'),
      line: () => jumpToDiagnostic(diagnosticAtCursor(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 })),
      next: () => jumpToDiagnostic(nextDiagnostic(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 }, 1)),
      previous: () => jumpToDiagnostic(nextDiagnostic(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 }, -1)),
      nextError: () => jumpToDiagnostic(nextDiagnostic(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 }, 1, 'error')),
      nextWarning: () => jumpToDiagnostic(nextDiagnostic(snapshot?.diagnostics ?? [], snapshot?.cursor ?? { row: 0, col: 0 }, 1, 'warning')),
      toggle: () => setStatus('diagnostics display: inline count and diagnostics panel are enabled'),
    },
    {
      buffer: () => {
        visualExpandHistoryRef.current = []
        setVisualAnchor(null)
        setVisualLineMode(false)
        setMode('search')
        setSearchBuf('')
        pendingKeyRef.current = null
      },
      replace: () => setStatus('search replace: not implemented yet'),
    },
    {
      toggleWrap: () => setStatus('wrap: terminal renderer wraps by pane width'),
    },
    {
      code: () => setWorkspaceTab('code'),
      process: () => setWorkspaceTab('process'),
      ai: () => setWorkspaceTab('ai'),
    },
    {
      pickAndRun: () => {
        void commandRegistry.run('tasks.pickAndRun', makeCtx()).catch(error => {
          notify(`task failed: ${String(error)}`, 'error')
        })
      },
    },
    {
      open:   actions.openConfig,
      reload: () => { void actions.reloadConfig() },
      evalFile: () => { void evalCurrentFile() },
      evalExpression: () => { void evalExpression() },
      evalRegion: () => { void evalRegion() },
    },
    {
      testFile: () => {
        const file = snapshot?.filename ?? null
        const script = findNearestTestScript(file)
        if (!script) return
        void shell.runTracked(script)
        setPanel({ type: 'shell' })
      },
      testAll: () => {
        const script = findNearestTestScript(snapshot?.filename ?? null)
        if (!script) return
        void shell.runTracked(script)
        setPanel({ type: 'shell' })
      },
    },
    userLeader,
    makeCtx,
    (action: ConfigAction, ctx: EditorContext) => {
      void runConfigAction(action, ctx, commandRegistry).catch(error => {
        ctx.ui.notify(`config action failed: ${String(error)}`, 'error')
      })
    },
    commandRegistry.list().map(command => ({
      label: command.label,
      keys: command.id,
      action: () => {
        void commandRegistry.run(command.id, makeCtx()).catch(error => {
          notify(`command failed: ${String(error)}`, 'error')
        })
      },
    })),
  ), [actions, activeBuffer.filename, activeId, buffers, commandEpoch, commandRegistry, currentGitHunk, evalCurrentFile, evalExpression, evalRegion, jumpToDiagnostic, makeCtx, notify, openDiagnosticsPanel, openFilePromptFromRoot, openGitPanelForHunk, replacePrompt, saveBufferAndQuit, saveCurrentBuffer, setStatus, setWorkspaceTab, shell, sidecar, snapshot, userLeader])

  leaderMapRef.current = leaderMap

  React.useEffect(() => {
    if (mode !== 'visual' || !visualAnchor || !snapshot) return
    lastVisualSelectionRef.current = {
      anchor: { ...visualAnchor },
      cursor: { ...snapshot.cursor },
      lineMode: visualLineMode,
      lines: snapshot.lines,
    }
  }, [mode, visualAnchor, visualLineMode, snapshot])

  const totalRows  = process.stdout.rows    || 24
  const totalCols  = process.stdout.columns || 80
  const shellRows  = Math.floor(totalRows * 0.3)

  React.useEffect(() => {
    if (!snapshot) return
    const vh = Math.max(1, totalRows - 8)
    setScrollOffset(prev => {
      const row = snapshot.cursor.row
      if (row < prev) return row
      if (row >= prev + vh) return row - vh + 1
      return prev
    })
  }, [snapshot, totalRows])

  function sendAiMessage(overrideText?: string) {
    const text = (overrideText ?? aiInput).trim()
    if (!text || aiStreaming) return
    if (!overrideText) setAiInput('')

    setFixState(prev => {
      const t = prev.status
      if (t === 'done' || t === 'error' || t === 'trace') return { status: 'idle' }
      return prev
    })
    setReviewState({ status: 'idle' })

    const userMsg: AiMessage = { role: 'user', content: text }
    setAiMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setAiStreaming(true)
    setAiScrollOffset(0)

    aiAbortRef.current?.abort()
    const ctrl = new AbortController()
    aiAbortRef.current = ctrl

    const { rules, memory } = loadCodeClawProject(process.cwd())
    const ctx: AiContext = {
      filename:      snapshot?.filename ?? null,
      lines:         snapshot?.lines    ?? [],
      cursor:        snapshot?.cursor   ?? { row: 0, col: 0 },
      shellLines,
      shellSessions: shell.sessions,
      gitContext:    getGitContext(),
      openBuffers:   buffers.map(b => b.snapshot?.filename ?? b.filename ?? b.name),
      projectRules:  rules  || undefined,
      projectMemory: memory || undefined,
    }

    setChatStreaming({ committedLines: [], tail: '' })
    void (async () => {
      let fullContent = ''
      try {
        for await (const chunk of streamChat([...aiMessages, userMsg], ctx, ctrl.signal)) {
          fullContent += chunk
          setChatStreaming(prev => {
            const combined = (prev?.tail ?? '') + chunk
            const parts = combined.split('\n')
            const tail = parts.pop() ?? ''
            const newLines = parts.map(l => l + '\n')
            return { committedLines: [...(prev?.committedLines ?? []), ...newLines], tail }
          })
        }
        setAiMessages(prev => {
          const msgs = [...prev]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') msgs[msgs.length - 1] = { ...last, content: fullContent }
          return msgs
        })
      } catch (err) {
        if (ctrl.signal.aborted) {
          setAiMessages(prev => {
            const last = prev[prev.length - 1]
            return last?.role === 'assistant' && !last.content && !fullContent ? prev.slice(0, -1) : prev
          })
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          setAiMessages(prev => {
            const msgs = [...prev]
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant' && !last.content) {
              msgs[msgs.length - 1] = { role: 'assistant', content: `[Error: ${msg}]`, error: true }
            } else {
              msgs.push({ role: 'assistant', content: `[Error: ${msg}]`, error: true })
            }
            return msgs
          })
        }
      }
      setChatStreaming(null)
      setAiStreaming(false)
      setAiScrollOffset(0)
    })()
  }

  function clearAiChat() {
    aiAbortRef.current?.abort()
    aiAbortRef.current = null
    setAiStreaming(false)
    setChatStreaming(null)
    setAiMessages([])
    setAiScrollOffset(0)
    setAiInput('')
  }

  function openModelPicker() {
    enterNormal()
    const ctrl = new AbortController()
    listAvailableModels(ctrl.signal).then(candidates => {
      replacePrompt({ type: 'model', query: '', candidates, selected: 0 })
    }).catch(() => {
      replacePrompt({ type: 'model', query: '', candidates: [getProviderLabel().split('/').slice(1).join('/')], selected: 0 })
    })
  }

  function explainLastError() {
    const lastErr = shell.lastError ?? shell.lastFailedRun
    const text = lastErr
      ? [
          `Explain and fix this shell error:`,
          ``,
          `Command: \`${lastErr.command}\``,
          ``,
          `Errors:`,
          ...lastErr.stderr.split('\n').filter(Boolean),
          ``,
          `Output (last 20 lines):`,
          ...lastErr.stdout.split('\n').slice(-20),
        ].join('\n')
      : 'No shell error detected yet. What can I help with?'
    setWorkspaceTab('ai')
    sendAiMessage(text)
  }

  function syntheticReviewFindingRun(finding: ReviewFinding): ShellRun {
    const now = new Date().toISOString()
    const cwd = process.cwd()
    let locPath = finding.file.trim()
    if (locPath && !locPath.startsWith('/')) {
      try {
        locPath = resolvePath(cwd, locPath)
      } catch {
        /* keep locPath */
      }
    }
    const locations: ParsedLocation[] =
      finding.line != null && locPath
        ? [{ file: locPath, row: Math.max(0, finding.line - 1), col: 0, message: finding.title }]
        : []
    const rawPatch = finding.suggestedPatch?.trim() ?? ''
    const patchChunk = rawPatch.length > 12000 ? `${rawPatch.slice(0, 12000)}\n… [truncated ${rawPatch.length - 12000} chars]` : rawPatch
    const patchNote = patchChunk ? `\n\nSuggested unified diff:\n${patchChunk}` : ''
    return {
      id: `codeclaw-review-${now}`,
      command: 'codeclaw-review',
      cwd,
      startedAt: now,
      endedAt: now,
      exitCode: 1,
      stdout: '',
      stderr: `[${finding.severity.toUpperCase()}] ${finding.title}\n${finding.explanation}${finding.rule ? `\nRule: ${finding.rule}` : ''}${patchNote}`,
      locations,
    }
  }

  function buildFixContext(userRequest: string, previous?: FixContext, syntheticFailure?: ShellRun): FixContext | null {
    const lastFailedRun = syntheticFailure ?? shell.lastFailedRun ?? previous?.lastFailedRun
    if (!lastFailedRun) return null

    const project = loadCodeClawProject(process.cwd())
    const activePath = snapshot?.filename ?? activeBuffer.filename ?? '*scratch*'
    const activeContent = snapshot?.lines.join('\n') ?? ''

    return {
      activeFile: {
        path: activePath,
        content: activeContent,
        cursor: snapshot?.cursor
          ? { line: snapshot.cursor.row + 1, column: snapshot.cursor.col + 1 }
          : undefined,
      },
      openBuffers: buffers
        .filter(buffer => buffer.snapshot?.filename || buffer.filename)
        .map(buffer => ({
          path: buffer.snapshot?.filename ?? buffer.filename ?? buffer.name,
          content: buffer.snapshot?.lines.join('\n') ?? '',
        })),
      lastFailedRun,
      git: collectGitContext(process.cwd()),
      rules: project.rules,
      memory: project.memory,
      userRequest,
    }
  }

  function runCodeClawFix(
    userRequest = 'Fix this failure using current session context.',
    previous?: FixContext,
    reviewFinding?: ReviewFinding,
  ) {
    const synthetic = reviewFinding ? syntheticReviewFindingRun(reviewFinding) : undefined
    const context = buildFixContext(userRequest, previous, synthetic)
    if (!context) {
      setFixState({
        status: 'error',
        message: reviewFinding
          ? 'Could not build fix context from this finding (internal error).'
          : 'No failed tracked shell run yet. Run a command from the shell pane first.',
      })
      setWorkspaceTab('ai')
      return
    }

    const startedAt = new Date().toISOString()
    const traceId = makeTraceId(new Date(startedAt))
    setFixState({ status: 'generating', traceId, startedAt, context })
    setWorkspaceTab('ai')
    setAiStreaming(true)

    aiAbortRef.current?.abort()
    const ctrl = new AbortController()
    aiAbortRef.current = ctrl

    setClawProgressChars(0)
    void (async () => {
      try {
        const tasks = loadTasks(process.cwd())
        const proposal = await generatePatchProposal(
          context, ctrl.signal, tasks, process.cwd(), { traceId },
          (chars) => setClawProgressChars(chars),
        )
        setFixState({ status: 'proposal', traceId, startedAt, context, proposal, risk: assessPatchRisk(proposal), mediumConfirm: false })
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        const trace = buildTrace(traceId, startedAt, context, null, false, undefined, message)
        const tracePath = writeTrace(process.cwd(), trace)
        setFixState({ status: 'error', message, tracePath })
      } finally {
        setAiStreaming(false)
      }
    })()
  }

  function runCodeClawReview(opts?: { clearFixState?: boolean }) {
    const clearFixState = opts?.clearFixState ?? true
    const cwd = process.cwd()
    const gitCtx = collectGitContext(cwd)
    const activeFile = snapshot?.filename ?? ''
    const { rules } = loadCodeClawProjectForReview(cwd, activeFile)
    const openBuffers = buffers.map(b => b.filename ?? b.id)

    const traceId = makeReviewTraceId()
    const startedAt = new Date().toISOString()

    if (clearFixState) {
      setFixState(prev => {
        const t = prev.status
        if (t === 'done' || t === 'error' || t === 'trace') return { status: 'idle' }
        return prev
      })
    }

    setReviewState({ status: 'generating' })
    setWorkspaceTab('ai')
    setAiStreaming(true)

    aiAbortRef.current?.abort()
    const ctrl = new AbortController()
    aiAbortRef.current = ctrl

    void (async () => {
      const reviewGitBlob = prepareReviewGitInput(collectGitDiffForReview(cwd), gitCtx.status)
      try {
        const activeEditorBody =
          snapshot == null
            ? undefined
            : (snapshot.lines?.length ?? 0) === 0
              ? undefined
              : (snapshot.lines ?? []).join('\n')
        const proposal = await generateReviewProposal(reviewGitBlob, rules, activeFile, openBuffers, ctrl.signal, activeEditorBody, cwd, { traceId })
        const endedAt = new Date().toISOString()
        const trace = buildReviewTrace({
          id: traceId,
          startedAt,
          endedAt,
          gitBranch: gitCtx.branch,
          activeFile,
          openBuffers,
          diffChars: reviewGitBlob.length,
          gitDiffPreview: buildReviewDiffSnippet(reviewGitBlob, activeFile, 12000),
          status: 'ok',
          proposal,
        })
        const tracePath = writeReviewTrace(cwd, trace)
        setReviewState({ status: 'findings', proposal, cursor: 0, tracePath })
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        const endedAt = new Date().toISOString()
        const trace = buildReviewTrace({
          id: traceId,
          startedAt,
          endedAt,
          gitBranch: gitCtx.branch,
          activeFile,
          openBuffers,
          diffChars: reviewGitBlob.length,
          gitDiffPreview: buildReviewDiffSnippet(reviewGitBlob, activeFile, 12000),
          status: 'error',
          proposal: null,
          error: message,
        })
        const tracePath = writeReviewTrace(cwd, trace)
        setReviewState({ status: 'error', message, tracePath })
      } finally {
        setAiStreaming(false)
      }
    })()
  }

  function rejectCodeClawFix() {
    if (fixState.status !== 'proposal' && fixState.status !== 'editing') return
    const trace = buildTrace(fixState.traceId, fixState.startedAt, fixState.context, fixState.proposal, false)
    const tracePath = writeTrace(process.cwd(), trace)
    setFixState({ status: 'done', message: 'Patch rejected. No files changed.', tracePath })
  }

  function acceptCodeClawFix() {
    if (fixState.status !== 'proposal') return
    const { traceId, startedAt, context, proposal, risk } = fixState
    if (!risk.canAutoApply) return
    if (risk.requiresConfirm && !fixState.mediumConfirm) {
      setFixState({ ...fixState, mediumConfirm: true })
      return
    }
    setFixState({ status: 'applying', traceId, startedAt, context, proposal, risk })

    void (async () => {
      const applied = applyPatchProposal(process.cwd(), proposal)
      if (!applied.ok) {
        const trace = buildTrace(traceId, startedAt, context, proposal, true, undefined, applied.error)
        const tracePath = writeTrace(process.cwd(), trace)
        setFixState({ status: 'error', message: applied.error, tracePath })
        return
      }

      const activePath = snapshot?.filename ?? activeBuffer.filename
      if (activePath && proposal.files.some(file => resolvePath(file.path) === resolvePath(activePath))) {
        sidecar.open(activePath)
      }

      const trace = buildTrace(traceId, startedAt, context, proposal, true, undefined, undefined)
      writeTrace(process.cwd(), trace)
      setReviewState({ status: 'idle' })
      setFixState({ status: 'idle' })
      setPanel(null)
      actions.setActiveBufferStatus('CodeClaw fix applied.')
    })()
  }

  function showLastTrace() {
    setFixState({ status: 'trace', latest: readLatestTrace(process.cwd()) })
    setWorkspaceTab('ai')
  }

  function openGitPanel() {
    const data = loadGitStatus(process.cwd())
    setPanel({ type: 'git', data, cursor: 0, pendingKey: null, logEntries: null, gitError: undefined, view: 'status' })
  }

  function stageCurrentFile() {
    if (snapshot?.filename) {
      spawnSync('git', ['add', '--', snapshot.filename], { cwd: getGitRepoRoot(process.cwd()), timeout: 3000 })
      setPanel(prev => prev?.type === 'git'
        ? { ...prev, data: loadGitStatus(process.cwd()), cursor: 0 }
        : prev)
    }
  }

  function triggerCompletion() {
    // Native sidecar may not have sent snapshot yet — still offer completion on empty/scratch.
    const lines = snapshot?.lines ?? ['']
    const cursor = snapshot?.cursor ?? { row: 0, col: 0 }
    const fname = snapshot?.filename ?? activeBuffer.filename ?? null
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setCompletionStreaming(true)
    setGhostTextSync(null)
    debugLog('completion', 'trigger_begin', {
      logFile: getDebugLogPath(),
      filename: fname,
      cursor,
      lineCount: lines.length,
      bufferChars: lines.join('\n').length,
    })
    void (async () => {
      try {
        let acc = ''
        const loose = !isOllamaActive()
        for await (const chunk of streamCompletion(
          fname, lines, cursor, controller.signal, shellLines,
        )) {
          acc += chunk
          const cleaned = sanitizeInlineCompletion(acc, loose)
          setGhostTextSync(cleaned.length > 0 ? cleaned : null)
        }
        const finalClean = sanitizeInlineCompletion(acc, loose)
        debugLog('completion', 'trigger_finish', {
          aborted: controller.signal.aborted,
          rawChars: acc.length,
          cleanedChars: finalClean.length,
          rawPreview: acc.slice(0, 500),
          cleanedPreview: finalClean.slice(0, 240),
        })
      } catch (err) {
        setGhostTextSync(null)
        const msg = err instanceof Error ? err.message : String(err)
        debugLog('completion', 'trigger_error', {
          aborted: controller.signal.aborted,
          error: msg,
          stack: err instanceof Error ? err.stack?.slice(0, 1200) : undefined,
        })
        if (!/abort/i.test(msg)) {
          actions.setActiveBufferStatus(`completion failed: ${msg.slice(0, 80)}`)
        }
      } finally {
        setCompletionStreaming(false)
      }
    })()
  }

  function executeCommand(cmd: string) {
    const t = cmd.trim()
    if (t === 'w' || t === 'write')         { saveCurrentBuffer() }
    else if (t === 'q' || t === 'quit')     { actions.quitAll() }
    else if (t === 'wq' || t === 'x')       { saveBufferAndQuit() }
    else if (t === 'q!')                    { actions.quitAll() }
    else if (t.startsWith('e ') && t.length > 2) {
      actions.openFile(t.slice(2).trim())
    } else if (t.startsWith('!') && t.length > 1) {
      void shell.runTracked(t.slice(1))
      setPanel({ type: 'shell' })
    }
  }

  function jumpToMatch(delta: number) {
    const lines = snapshot?.lines ?? []
    const matches = findMatches(lines, searchQueryRef.current)
    if (!matches.length) return
    const idx = ((searchIdxRef.current + delta) % matches.length + matches.length) % matches.length
    searchIdxRef.current = idx
    const m = matches[idx]!
    sidecar.moveTo(m.row, m.col)
  }

  const clearSearchHighlights = React.useCallback(() => {
    setSearchQuery('')
    searchQueryRef.current = ''
    searchIdxRef.current = -1
  }, [])

  useEditorInput(createEditorInputHandler({
      acceptCodeClawFix: acceptCodeClawFix,
      actions: actions,
      activeBuffer: activeBuffer,
      aiAbortRef: aiAbortRef,
      aiInput: aiInput,
      aiNavLoc: aiNavLoc,
      aiShellCmd: aiShellCmd,
      aiStreaming: aiStreaming,
      buffers: buffers,
      clearAiChat: clearAiChat,
      clearSearchHighlights: clearSearchHighlights,
      cmdBuf: cmdBuf,
      completionStreaming: completionStreaming,
      dangerPrompt: dangerPrompt,
      enterNormal: enterNormal,
      executeCommand: executeCommand,
      filename: filename,
      fixState: fixState,
      ghostTextRef: ghostTextRef,
      jumpToMatch: jumpToMatch,
      leaderMap: leaderMap,
      lspOverlay: lspOverlay,
      mode: mode,
      openGitPanel: openGitPanel,
      panel: panel,
      pendingKeyRef: pendingKeyRef,
      workflowTabBracketArmUntilRef: workflowTabBracketArmUntilRef,
      prompt: prompt,
      rejectCodeClawFix: rejectCodeClawFix,
      replacePrompt: replacePrompt,
      resolveUiPrompt: resolveUiPrompt,
      reviewState: reviewState,
      runCodeClawFix: runCodeClawFix,
      saveCurrentBuffer: saveCurrentBuffer,
      searchBuf: searchBuf,
      searchIdxRef: searchIdxRef,
      searchQueryRef: searchQueryRef,
      sendAiMessage: sendAiMessage,
      setAiInput: setAiInput,
      setAiModelLabel: setAiModelLabel,
      setAiScrollOffset: setAiScrollOffset,
      setAiStreaming: setAiStreaming,
      setCmdBuf: setCmdBuf,
      setCompletionStreaming: setCompletionStreaming,
      setDangerPrompt: setDangerPrompt,
      setFixState: setFixState,
      setGhostTextSync: setGhostTextSync,
      setMode: setMode,
      setPanel: setPanel,
      setPrompt: setPrompt,
      setReviewState: setReviewState,
      setSearchBuf: setSearchBuf,
      setSearchQuery: setSearchQuery,
      setShellInput: setShellInput,
      setShellRunning: setShellRunning,
      setShellScrollOffset: setShellScrollOffset,
      setStatus: setStatus,
      setVisualAnchor: setVisualAnchor,
      setVisualLineMode: setVisualLineMode,
      setWorkspaceTab: setWorkspaceTab,
      shell: shell,
      shellInput: shellInput,
      shellRunning: shellRunning,
      showLastTrace: showLastTrace,
      sidecar: sidecar,
      snapshot: snapshot,
      status: status,
      switchWorkflowTabByIndex: switchWorkflowTabByIndex,
      cycleWorkflowTab: cycleWorkflowTab,
      triggerCompletion: triggerCompletion,
      visualAnchor: visualAnchor,
      visualExpandHistoryRef: visualExpandHistoryRef,
      visualLineMode: visualLineMode,
      workspaceTab: workspaceTab,
      yankRegisterRef: yankRegisterRef,
      yankText: yankText,
      fuzzyRank,
    }))

  const sel: SelBounds | null = (mode === 'visual' && visualAnchor && snapshot)
    ? selectionBounds(visualAnchor, snapshot.cursor, visualLineMode, snapshot.lines)
    : null

  const gitDisplayLines = panel?.type === 'git'
    ? buildGitDisplayLines(panel.data, panel.logEntries, panel.view)
    : null
  const diredEntries = panel?.type === 'dired' ? readDiredEntries(panel.path) : []

  if (panel?.type === 'splash') {
    return (
      <Box flexDirection="column" width={totalCols} height={totalRows}>
        <SplashPanel
          title={panel.title}
          message={panel.message}
          hint={panel.hint}
          totalRows={totalRows}
          totalCols={totalCols}
        />
      </Box>
    )
  }

  if (workspaceTab === 'process') {
    return (
      <Box flexDirection="column" width={totalCols} height={totalRows}>
        <WorkflowTabBar buffers={buffers} activeBufferId={activeId} workspaceTab={workspaceTab} width={totalCols} />
        <Box flexDirection="row">
          <Text backgroundColor={C.green} color={C.bg}> process </Text>
          <Text color={C.grey}>  Esc=code  Option+1..9 / Option+[/]=tabs  tracked shell output</Text>
        </Box>
        <ShellPane
          lines={shellLines}
          rows={Math.max(1, totalRows - 2)}
          focused={true}
          mode={shell.mode}
          input={shellInput}
          running={shellRunning}
          height={Math.max(1, totalRows - 2)}
          scrollOffset={shellScrollOffset}
          dangerPrompt={dangerPrompt}
        />
      </Box>
    )
  }

  if (workspaceTab === 'ai') {
    return (
      <Box flexDirection="column" width={totalCols} height={totalRows}>
        <WorkflowTabBar buffers={buffers} activeBufferId={activeId} workspaceTab={workspaceTab} width={totalCols} />
        <AiPanel
          messages={aiMessages}
          input={aiInput}
          streaming={aiStreaming}
          chatStreaming={chatStreaming}
          focused={fixState.status === 'idle' && reviewState.status === 'idle'}
          width={totalCols}
          height={Math.max(1, totalRows - 1)}
          navHint={aiNavLoc ? `${aiNavLoc.file}:${aiNavLoc.row + 1}` : undefined}
          shellHint={aiShellCmd ? aiShellCmd.split('\n')[0] : undefined}
          fixState={fixState}
          clawProgressChars={clawProgressChars}
          reviewState={reviewState}
          scrollOffset={aiScrollOffset}
          thinkingTick={thinkingTick}
        />
      </Box>
    )
  }

  if (panel?.type === 'git') {
    return (
      <Box flexDirection="column" width={totalCols} height={totalRows}>
        <GitPanel
          data={panel.data}
          cursor={panel.cursor}
          pendingKey={panel.pendingKey}
          logEntries={panel.logEntries}
          gitError={panel.gitError}
          view={panel.view}
          displayLines={gitDisplayLines!}
          totalRows={totalRows}
          totalCols={totalCols}
        />
      </Box>
    )
  }

  if (panel?.type === 'diagnostics') {
    return (
      <Box flexDirection="column" width={totalCols} height={totalRows}>
        <DiagnosticsPanel
          diagnostics={panel.diagnostics}
          cursor={panel.cursor}
          title={panel.title}
          totalRows={totalRows}
          totalCols={totalCols}
        />
      </Box>
    )
  }

  const lspOverlayRows = lspOverlay ? Math.min(10, lspOverlay.lines.length + 2) : 0
  const panelRows = (panel === null ? 0
    : panel.type === 'shell'      ? 3 + shellRows
    : panel.type === 'dired'      ? totalRows
    : panel.type === 'cmdpalette' ? Math.min(14, Math.max(5, totalRows - 4))
    : panel.type === 'lsp'        ? Math.min(10, panel.lines.length + 2)
    : 3 + Math.min(9, Math.ceil(Object.keys(panel.node).length / 4))) + lspOverlayRows
  const editorHeight = panel?.type === 'dired' ? 0 : Math.max(1, totalRows - panelRows)

  const editorPane = (
    <EditorPane
      filename={filename}
      snapshot={snapshot}
      status={status}
      bufferName={activeBuffer.name}
      bufferIndex={activeIndex}
      bufferCount={buffers.length}
      buffers={buffers}
      activeBufferId={activeId}
      prompt={prompt}
      ghostText={ghostText}
      completionStreaming={completionStreaming}
      thinkingTick={thinkingTick}
      mode={mode}
      scrollOffset={scrollOffset}
      paneHeight={editorHeight}
      panel={panel}
      workspaceTab={workspaceTab}
      sel={sel}
      searchQuery={searchQuery}
      cmdBuf={cmdBuf}
      searchBuf={searchBuf}
      aiModelLabel={aiModelLabel}
      flashMessage={flashMessage}
      totalRows={totalRows}
      totalCols={totalCols}
    />
  )

  return (
    <Box flexDirection="column" width={totalCols} height={totalRows}>
      {panel?.type !== 'dired' && editorPane}
      {panel?.type === 'whichkey' && (
        <WhichKeyPanel node={panel.node} path={panel.path} totalCols={totalCols} />
      )}
      {panel?.type === 'cmdpalette' && (
        <CmdPalettePanel items={panel.items} query={panel.query} cursor={panel.cursor} width={Math.min(70, totalCols - 4)} />
      )}
      {panel?.type === 'lsp' && (
        <LspPanel title={panel.title} lines={panel.lines} totalCols={totalCols} />
      )}
      {lspOverlay && (
        <LspPanel title={lspOverlay.title} lines={lspOverlay.lines} totalCols={totalCols} />
      )}
      {panel?.type === 'shell' && (
        <ShellPane
          lines={shellLines}
          rows={shellRows}
          focused={true}
          mode={shell.mode}
          input={shellInput}
          running={shellRunning}
          height={panelRows}
          scrollOffset={shellScrollOffset}
          dangerPrompt={dangerPrompt}
        />
      )}
      {panel?.type === 'dired' && (
        <DiredPanel
          path={panel.path}
          cursor={panel.cursor}
          entries={diredEntries}
          totalRows={panelRows}
          totalCols={totalCols}
        />
      )}
    </Box>
  )
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const codeclawTracesDir = join(codeClawDir(process.cwd()), 'traces')
  const logPath = getDebugLogPath()
  if (logPath) {
    console.error(`[qe-debug] logging to ${logPath}`)
    console.error(`[qe-debug] CodeClaw traces: ${codeclawTracesDir} | review: ${join(codeclawTracesDir, 'review')}`)
  }
  debugLog('process', 'boot', {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    gitRoot: getGitRepoRoot(process.cwd()),
    logFile: logPath,
    codeclawTracesDir,
    codeclawReviewTracesDir: join(codeclawTracesDir, 'review'),
    node: process.version,
  })
  const cwd  = process.cwd()
  const arg  = process.argv[2]
  let filename: string | undefined
  let initialDiredPath: string | undefined
  if (arg) {
    const resolved = resolvePath(cwd, arg)
    let isDir = false
    try { isDir = statSync(resolved).isDirectory() } catch { /* new file — fall through */ }
    if (isDir) initialDiredPath = resolved
    else filename = arg
  }
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows    || 24

  let cfg = await loadConfig()
  if (cfg.theme) applyTheme(cfg.theme as Partial<Theme>)
  const restoredSession = loadWorkflowSession(cwd)
  let workspaceTab: WorkspaceTab = normalizeWorkspaceTab(restoredSession?.workspaceTab)

  const shell = new ShellSidecar(cwd, cols, Math.floor(rows * 0.3))

  let nextBufferId = 1
  let activeId = ''
  let buffers: EditorBuffer[] = []
  let activeSidecar: QeSidecar | null = null
  let bufferSwitchCount = 0
  const sidecarMap = new Map<string, QeSidecar>()
  let shellLines: ShellLine[] = [...shell.lines]
  let instance: Instance | null = null
  let quitting = false
  let lspOverlay: LspOverlay | null = null
  const changeHookTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const changeHookRevisions = new Map<string, number>()

  const refresh = () => instance?.rerender(view())

  const bufferInfos = () => buffers.map(buffer => toBufferInfo(buffer, activeId))

  const persistSession = () => {
    saveWorkflowSession(cwd, sessionFromBuffers(bufferInfos(), workspaceTab))
  }

  const setWorkspaceTabMain = (tab: WorkspaceTab) => {
    workspaceTab = tab
    persistSession()
    refresh()
  }

  let openShellPanelFromHook: (() => void) | null = null

  const createHookRegistry = (): CommandRegistry => {
    const registry = new CommandRegistry()
    registry.register('file.save', 'file: save', () => activeSidecar?.save())
    registry.register('shell.run', 'shell: run command', (ctx, args) => {
      const command = typeof args?.command === 'string' ? args.command : ''
      if (command) ctx.shell.run(command)
    })
    registry.register('workspace.code', 'workspace: code tab', () => setWorkspaceTabMain('code'))
    registry.register('workspace.process', 'workspace: process tab', () => setWorkspaceTabMain('process'))
    registry.register('workspace.ai', 'workspace: AI tab', () => setWorkspaceTabMain('ai'))
    registry.register('tasks.pickAndRun', 'tasks: pick and run', async (ctx, args) => {
      const resolved = resolveHookTask(cfg.tasks, args)
      if ('error' in resolved) {
        ctx.ui.notify(resolved.error, 'warn')
        return
      }
      const { task } = resolved
      ctx.shell.run(task.command)
      if (task.tab === 'process') setWorkspaceTabMain('process')
      else openShellPanelFromHook?.()
    })
    registry.register('code.format', 'code: format', () => activeSidecar?.format())
    registry.register('openFile', 'file: open', (_ctx, args) => {
      const path = typeof args?.path === 'string' ? args.path : null
      if (path) openFile(path)
    })
    registerConfigCommands(cfg, registry)
    return registry
  }

  let hookRegistry = createHookRegistry()
  void registerPlugins(hookRegistry)

  const hookNotify = (buffer: EditorBuffer, message: string, level: ConfigNotifyLevel = 'info') => {
    buffer.status = level === 'info' ? message : `${level}: ${message}`
    refresh()
  }

  const makeCtx = (buffer: EditorBuffer, shellRun: ShellRun | null = null): EditorContext => createEditorContext({
    mode: 'hook',
    filename: buffer.snapshot?.filename ?? buffer.filename,
    lines:    buffer.snapshot?.lines   ?? [],
    cursor:   buffer.snapshot?.cursor  ?? { row: 0, col: 0 },
    lastShellRun: shellRun,
    save:     () => activeSidecar?.save(),
    quit:     quitAll,
    insert:   (text) => activeSidecar?.insert(text),
    move:     (dir) => activeSidecar?.move(dir as Parameters<QeSidecar['move']>[0]),
    shell:    { run: (cmd) => { void shell.runTracked(cmd) }, lines: () => shellLines.map(l => l.text) },
    buffers:  {
      list: bufferInfos,
      current: () => bufferInfos().find(info => info.active) ?? null,
      switch: switchBuffer,
      kill: killBuffer,
      next: nextBuffer,
      previous: previousBuffer,
    },
    openFile,
    commands: {
      run: async (id, args) => hookRegistry.run(id, makeCtx(buffer), args),
    },
    ui: hookUiStubs((message, level) => hookNotify(buffer, message, level)),
    git: {
      status: () => {},
      stageCurrentFile: () => {},
      stageHunk: () => {},
      previewHunk: () => {},
    },
    lsp: {
      hover: () => {
        const cursor = nearestIdentifierPosition(buffer.snapshot?.lines ?? [], buffer.snapshot?.cursor ?? { row: 0, col: 0 })
        activeSidecar?.hover(cursor.row, cursor.col)
      },
      definition: () => {
        const cursor = nearestIdentifierPosition(buffer.snapshot?.lines ?? [], buffer.snapshot?.cursor ?? { row: 0, col: 0 })
        activeSidecar?.goToDefinition(cursor.row, cursor.col)
      },
      format: () => activeSidecar?.format(),
    },
    diagnostics: {
      list: () => {},
      next: () => {},
      line: () => {},
    },
  })

  function runHookAction(action: ConfigAction, buffer: EditorBuffer, shellRun: ShellRun | null = null): void {
    const ctx = makeCtx(buffer, shellRun)
    void runConfigAction(action, ctx, hookRegistry).catch(error => {
      buffer.status = `config hook failed: ${String(error)}`
      refresh()
    })
  }

  function scheduleChangeHook(buffer: EditorBuffer): void {
    const action = cfg.hooks?.onChange
    if (!action) return
    const existing = changeHookTimers.get(buffer.id)
    if (existing) clearTimeout(existing)
    changeHookTimers.set(buffer.id, setTimeout(() => {
      changeHookTimers.delete(buffer.id)
      if (quitting || !buffers.some(candidate => candidate.id === buffer.id)) return
      runHookAction(action, buffer)
    }, 250))
  }

  function createSidecarForBuffer(buffer: EditorBuffer): QeSidecar {
    const sc = new QeSidecar(buffer.filename ?? undefined)
    sidecarMap.set(buffer.id, sc)

    sc.on('message', message => {
      if (activeSidecar !== sc) return  // stale, ignore
      switch (message.type) {
        case 'ready':
          buffer.status = 'ready'
          if (buffer.jumpTo) {
            sc.moveTo(buffer.jumpTo.row, buffer.jumpTo.col)
            buffer.jumpTo = undefined
          }
          break
        case 'snapshot':
          buffer.snapshot = message
          buffer.filename = message.filename
          buffer.name = bufferName(message.filename)
          buffer.status = message.status
          {
            const decision = onChangeDecision(changeHookRevisions.get(buffer.id), message.revision)
            if (decision.revision !== null) changeHookRevisions.set(buffer.id, decision.revision)
            if (decision.schedule) scheduleChangeHook(buffer)
          }
          if (!buffer.openHookFired) {
            buffer.openHookFired = true
            if (cfg.hooks?.onOpen) runHookAction(cfg.hooks.onOpen, buffer)
          }
          break
        case 'saved':
          buffer.status = 'saved'
          if (cfg.hooks?.onSave) runHookAction(cfg.hooks.onSave, buffer)
          break
        case 'error':
          buffer.status = message.message
          break
        case 'lspResponse':
          if (message.kind === 'definition') {
            const target = lspDefinitionTarget(message)
            if (target?.path) {
              openFile(target.path, { row: target.row ?? 0, col: target.col ?? 0 })
              buffer.status = `definition ${target.path}:${(target.row ?? 0) + 1}`
            } else {
              buffer.status = lspUnavailableText(message, 'definition unavailable')
              lspOverlay = { title: 'definition', lines: [buffer.status] }
            }
          } else if (message.kind === 'hover') {
            const lines = lspHoverLines(message)
            buffer.status = lines[0] ?? lspUnavailableText(message, 'hover unavailable')
            lspOverlay = { title: 'hover', lines }
          } else if (message.kind === 'completion') {
            const result = message.result as { available?: boolean; items?: Array<{ label: string; insertText: string; detail: string }> } | undefined
            const items = result?.items ?? []
            if (items.length > 0) {
              buffer.status = `completion: ${items.length} item${items.length === 1 ? '' : 's'} — Tab to accept`
            } else {
              buffer.status = message.status
            }
          } else {
            buffer.status = message.status
          }
          break
        case 'exit':
          buffer.status = 'exiting'
          break
      }
      buffers = [...buffers]
      refresh()
    })

    sc.on('exit', () => {
      if (activeSidecar === sc) activeSidecar = null
      sidecarMap.delete(buffer.id)
      // Don't auto-remove; the buffer record stays, user can re-open
    })

    const c = process.stdout.columns || 80
    const r = process.stdout.rows    || 24
    sc.resize(c, r)
    return sc
  }

  function createBuffer(file?: string | null): EditorBuffer {
    const id = `buffer-${nextBufferId++}`
    const buffer: EditorBuffer = {
      id,
      name: bufferName(file ?? null),
      filename: file ?? null,
      snapshot: null,
      status: 'starting',
      lastUsedAt: Date.now(),
    }
    buffers = [...buffers, buffer]
    return buffer
  }

  function activateBuffer(buffer: EditorBuffer): void {
    if (activeSidecar) { activeSidecar.kill(); activeSidecar = null }
    const previousId = activeId
    activeId = buffer.id
    buffer.lastUsedAt = Date.now()
    bufferSwitchCount++
    activeSidecar = createSidecarForBuffer(buffer)
    if (previousId !== buffer.id && cfg.hooks?.onBufEnter) {
      runHookAction(cfg.hooks.onBufEnter, buffer)
    }
  }

  function ensureScratch(): void {
    if (buffers.length > 0) return
    const scratch = createBuffer(null)
    activateBuffer(scratch)
  }

  function activeBuffer(): EditorBuffer {
    ensureScratch()
    return buffers.find(buffer => buffer.id === activeId) ?? buffers[0]!
  }

  function switchBuffer(id: string): void {
    const buffer = buffers.find(b => b.id === id)
    if (!buffer || buffer.id === activeId) return
    activateBuffer(buffer)
    refresh()
  }

  function orderedBuffers(): EditorBuffer[] {
    const num = (id: string) => parseInt(id.replace(/^.*-/, ''), 10) || 0
    return [...buffers].sort((a, b) => num(a.id) - num(b.id))
  }

  function cycleBuffer(delta: number): void {
    if (buffers.length <= 1) return
    const ordered = orderedBuffers()
    const index = Math.max(0, ordered.findIndex(b => b.id === activeId))
    const next = ordered[((index + delta) % ordered.length + ordered.length) % ordered.length]
    if (next) switchBuffer(next.id)
  }

  function nextBuffer(): void { cycleBuffer(1) }
  function previousBuffer(): void { cycleBuffer(-1) }

  function removeBuffer(id: string): void {
    if (!buffers.find(b => b.id === id)) return  // already gone — idempotent

    const timer = changeHookTimers.get(id)
    if (timer) clearTimeout(timer)
    changeHookTimers.delete(id)
    changeHookRevisions.delete(id)
    buffers = buffers.filter(b => b.id !== id)

    if (activeId === id) {
      if (activeSidecar) { activeSidecar.kill(); activeSidecar = null }
      const next = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
      if (next) {
        activateBuffer(next)
      } else {
        activeId = ''
      }
    }

    ensureScratch()
    refresh()
  }

  function killBuffer(id = activeId): void { removeBuffer(id) }

  function newScratch(): void {
    const buffer = createBuffer(null)
    activateBuffer(buffer)
    refresh()
  }

  function openFile(path: string, jump?: { row: number; col: number }): void {
    const resolved = resolvePath(path)
    const existing = buffers.find(b => {
      const bPath = b.snapshot?.filename ?? b.filename
      return bPath ? resolvePath(bPath) === resolved : false
    })
    if (existing) {
      if (jump) {
        if (existing.id === activeId && activeSidecar) {
          activeSidecar.moveTo(jump.row, jump.col)
          existing.status = `jump ${jump.row + 1}:${jump.col + 1}`
          buffers = [...buffers]
          refresh()
          return
        }
        existing.jumpTo = jump
      }
      switchBuffer(existing.id)
      return
    }
    const buffer = createBuffer(resolved)
    if (jump) buffer.jumpTo = jump
    activateBuffer(buffer)
    refresh()
  }

  function quitAll(): void {
    quitting = true
    persistSession()
    for (const timer of changeHookTimers.values()) clearTimeout(timer)
    changeHookTimers.clear()
    changeHookRevisions.clear()
    if (activeSidecar) { activeSidecar.kill(); activeSidecar = null }
    shell.kill()
    instance?.unmount()
    process.exit(0)
  }

  // Terminal resize — one handler, no React effect needed
  process.stdout.on('resize', () => {
    const c = process.stdout.columns || 80
    const r = process.stdout.rows    || 24
    for (const sc of sidecarMap.values()) sc.resize(c, r)
    shell.resize(c, Math.floor(r * 0.3))
    refresh()
  })

  // Initial buffers: explicit CLI target wins; otherwise restore the last light session.
  const restoredFiles = !filename && !initialDiredPath
    ? (restoredSession?.files ?? []).filter(file => existsSync(resolvePath(file)))
    : []
  if (filename || restoredFiles.length === 0) {
    const initial = createBuffer(filename ?? null)
    activateBuffer(initial)
  } else {
    const activeRestored = restoredSession?.activeFile
      ? resolvePath(restoredSession.activeFile)
      : resolvePath(restoredFiles[0]!)
    let activeBufferToOpen: EditorBuffer | null = null
    for (const file of restoredFiles) {
      const buffer = createBuffer(resolvePath(file))
      if (resolvePath(file) === activeRestored) activeBufferToOpen = buffer
    }
    activateBuffer(activeBufferToOpen ?? buffers[0]!)
    if ((restoredSession?.files.length ?? 0) !== restoredFiles.length) {
      activeBuffer().status = 'session restored; missing files skipped'
    }
  }

  function openConfig() {
    const existing = getConfigPath()
    if (existing) { openFile(existing); return }
    // Create the default config file with a starter template
    import('node:fs').then(({ existsSync, mkdirSync, writeFileSync }) => {
      import('node:path').then(({ dirname, join }) => {
        const target = CONFIG_PATHS[0]!
        const configDir = dirname(target)
        mkdirSync(configDir, { recursive: true })
        const apiTarget = join(configDir, 'config-api.ts')
        if (!existsSync(apiTarget)) {
          writeFileSync(apiTarget, `${configApiTemplate()}\n`, 'utf8')
        }
        writeFileSync(target, starterConfigTemplate(), 'utf8')
        openFile(target)
      })
    })
  }

  async function reloadCfg() {
    cfg = await reloadConfig()
    hookRegistry = createHookRegistry()
    await registerPlugins(hookRegistry)
    if (cfg.theme) applyTheme(cfg.theme as Partial<Theme>)
    refresh()
  }

  function applyCfg(next: QeConfig) {
    cfg = next
    hookRegistry = createHookRegistry()
    void registerPlugins(hookRegistry).then(() => refresh())
    if (cfg.theme) applyTheme(cfg.theme as Partial<Theme>)
    refresh()
  }

  const view = () => {
    const cur = shell.currentLine
    const displayLines = cur.trim()
      ? [...shellLines, { text: cur, isError: false }]
      : shellLines
    const current = activeBuffer()
    return (
      <AlternateScreen mouseTracking={false}>
        <App
          buffers={buffers}
          activeId={current.id}
          bufferKey={bufferSwitchCount}
          sidecar={activeSidecar!}
          shell={shell}
          shellLines={displayLines}
          config={cfg}
          userLeader={cfg.leader ?? {}}
          lspOverlay={lspOverlay}
          initialPanel={initialDiredPath ? { type: 'dired', path: initialDiredPath, cursor: 0 } : undefined}
          workspaceTab={workspaceTab}
          onWorkspaceTabChange={setWorkspaceTabMain}
          actions={{
            openFile,
            switchBuffer,
            killBuffer,
            nextBuffer,
            previousBuffer,
            newScratch,
            quitAll,
            reloadConfig: reloadCfg,
            applyConfig: applyCfg,
            openConfig,
            clearLspOverlay: () => {
              lspOverlay = null
              refresh()
            },
            setActiveBufferStatus: (status: string) => {
              const b = activeBuffer()
              if (!b) return
              b.status = status
              buffers = [...buffers]
              refresh()
            },
            registerShellPanelOpener: (open) => {
              openShellPanelFromHook = open
            },
          }}
        />
      </AlternateScreen>
    )
  }

  // Throttle shell redraws to ~60fps to avoid sticky editor feel
  let shellUpdateTimer: ReturnType<typeof setTimeout> | null = null
  shell.on('done', (run: ShellRun) => {
    if (!run.command.trim() || quitting) return
    if (cfg.hooks?.onShellDone) runHookAction(cfg.hooks.onShellDone, activeBuffer(), run)
  })
  shell.on('line', (line: ShellLine) => {
    shellLines = [...shellLines, line]
    if (shellLines.length > 500) shellLines = shellLines.slice(-500)
    refresh()
  })
  shell.on('update', () => {
    if (shellUpdateTimer) return
    shellUpdateTimer = setTimeout(() => { shellUpdateTimer = null; refresh() }, 16)
  })

  instance = await render(view())
}

void main()
