// @ts-nocheck
import type { Key } from 'terminal-react-core'
import process from 'node:process'
import { dirname, resolve as resolvePath } from 'node:path'
import { realpathSync } from 'node:fs'
import { checkCommandDanger } from '../shell.js'
import { setActiveModel, getProviderLabel } from '../ai-registry.js'
import { printable, printableText, isLeafAction, flattenLeader, bufferName } from '../leader.js'
import {
  buildGitDisplayLines, getGitLog, loadFileHunks, hunkNewStartRow, resolveRepoFilePath,
  stageEntry, unstageEntry, commitGit, pullGit, pushGit, updateGitEntry,
} from '../git.js'
import { readDiredEntries } from '../dired.js'
import { formatDiagnostic, sortDiagnostics } from '../diagnostics.js'
import { nearestIdentifierPosition } from '../lsp-position.js'
import {
  isWorkflowTabNextInput,
  isWorkflowTabPrevInput,
  shouldArmWorkflowTabBracket,
} from '../workflow.js'
import { filterBuffers, selectionBounds, getVisualText, expandRegionOnce } from './index.js'
import { readClipboardText, normalizePromptPaste, promptPasteText } from '../prompt-clipboard.js'

export type EditorInputDeps = {
  acceptCodeClawFix: unknown
  actions: unknown
  activeBuffer: unknown
  aiAbortRef: unknown
  aiInput: unknown
  aiNavLoc: unknown
  aiShellCmd: unknown
  aiStreaming: unknown
  buffers: unknown
  clearAiChat: unknown
  clearSearchHighlights: unknown
  cmdBuf: unknown
  completionStreaming: unknown
  dangerPrompt: unknown
  enterNormal: unknown
  executeCommand: unknown
  filename: unknown
  fixState: unknown
  fuzzyRank: unknown
  ghostTextRef: unknown
  jumpToMatch: unknown
  leaderMap: unknown
  lspOverlay: unknown
  mode: unknown
  openGitPanel: unknown
  panel: unknown
  pendingKeyRef: unknown
  workflowTabBracketArmUntilRef: unknown
  prompt: unknown
  rejectCodeClawFix: unknown
  replacePrompt: unknown
  resolveUiPrompt: unknown
  reviewState: unknown
  runCodeClawFix: unknown
  saveCurrentBuffer: unknown
  searchBuf: unknown
  searchIdxRef: unknown
  searchQueryRef: unknown
  sendAiMessage: unknown
  setAiInput: unknown
  setAiModelLabel: unknown
  setAiScrollOffset: unknown
  setAiStreaming: unknown
  setCmdBuf: unknown
  setCompletionStreaming: unknown
  setDangerPrompt: unknown
  setFixState: unknown
  setGhostTextSync: unknown
  setMode: unknown
  setPanel: unknown
  setPrompt: unknown
  setReviewState: unknown
  setSearchBuf: unknown
  setSearchQuery: unknown
  setShellInput: unknown
  setShellRunning: unknown
  setShellScrollOffset: unknown
  setStatus: unknown
  setVisualAnchor: unknown
  setVisualLineMode: unknown
  setWorkspaceTab: unknown
  shell: unknown
  shellInput: unknown
  shellRunning: unknown
  showLastTrace: unknown
  sidecar: unknown
  snapshot: unknown
  status: unknown
  switchWorkflowTabByIndex: unknown
  cycleWorkflowTab: unknown
  triggerCompletion: unknown
  visualAnchor: unknown
  visualExpandHistoryRef: unknown
  visualLineMode: unknown
  workspaceTab: unknown
  yankRegisterRef: unknown
  yankText: unknown
}

export function createEditorInputHandler(
  deps: EditorInputDeps,
): (input: string, key: Key, event?: import('terminal-react-core').InputEvent) => void {
  const {
    acceptCodeClawFix,
    actions,
    activeBuffer,
    aiAbortRef,
    aiInput,
    aiNavLoc,
    aiShellCmd,
    aiStreaming,
    buffers,
    clearAiChat,
    clearSearchHighlights,
    cmdBuf,
    completionStreaming,
    dangerPrompt,
    enterNormal,
    executeCommand,
    filename,
    fixState,
    fuzzyRank,
    ghostTextRef,
    jumpToMatch,
    leaderMap,
    lspOverlay,
    mode,
    openGitPanel,
    panel,
    pendingKeyRef,
    workflowTabBracketArmUntilRef,
    prompt,
    rejectCodeClawFix,
    replacePrompt,
    resolveUiPrompt,
    reviewState,
    runCodeClawFix,
    saveCurrentBuffer,
    searchBuf,
    searchIdxRef,
    searchQueryRef,
    sendAiMessage,
    setAiInput,
    setAiModelLabel,
    setAiScrollOffset,
    setAiStreaming,
    setCmdBuf,
    setCompletionStreaming,
    setDangerPrompt,
    setFixState,
    setGhostTextSync,
    setMode,
    setPanel,
    setPrompt,
    setReviewState,
    setSearchBuf,
    setSearchQuery,
    setShellInput,
    setShellRunning,
    setShellScrollOffset,
    setStatus,
    setVisualAnchor,
    setVisualLineMode,
    setWorkspaceTab,
    shell,
    shellInput,
    shellRunning,
    showLastTrace,
    sidecar,
    snapshot,
    status,
    switchWorkflowTabByIndex,
    cycleWorkflowTab,
    triggerCompletion,
    visualAnchor,
    visualExpandHistoryRef,
    visualLineMode,
    workspaceTab,
    yankRegisterRef,
    yankText,
  } = deps

  return (input, key, event) => {
    const sequence = event?.keypress?.sequence

    if (shouldArmWorkflowTabBracket(key, input)) {
      workflowTabBracketArmUntilRef.current = Date.now() + 150
    }
    if ((input === '[' || input === '{') && !key.meta && !key.ctrl && !key.super) {
      if (Date.now() < workflowTabBracketArmUntilRef.current) {
        workflowTabBracketArmUntilRef.current = 0
        cycleWorkflowTab(-1)
        return
      }
    }
    if ((input === ']' || input === '}') && !key.meta && !key.ctrl && !key.super) {
      if (Date.now() < workflowTabBracketArmUntilRef.current) {
        workflowTabBracketArmUntilRef.current = 0
        cycleWorkflowTab(1)
        return
      }
    }

    if (key.ctrl && input === 'q') { actions.quitAll(); return }
    if (key.meta && /^[1-9]$/.test(input)) {
      switchWorkflowTabByIndex(Number(input) - 1)
      return
    }
    if (isWorkflowTabPrevInput(input, key, sequence)) {
      cycleWorkflowTab(-1)
      return
    }
    if (isWorkflowTabNextInput(input, key, sequence)) {
      cycleWorkflowTab(1)
      return
    }
    // Space opens the leader menu in the editor, but Space is also typed into the AI chat — use Ctrl+Space anytime.
    if (key.ctrl && input === ' ') {
      pendingKeyRef.current = null
      setPanel({ type: 'whichkey', node: leaderMap, path: '' })
      return
    }
    if (key.ctrl && input === 't') {
      setPanel(prev => prev?.type === 'shell' ? null : { type: 'shell' })
      return
    }
    if (lspOverlay && (key.escape || input === 'q')) {
      actions.clearLspOverlay()
      return
    }

    // Config UI prompts must run before panels (AI/shell otherwise steal keystrokes).
    if (prompt?.type === 'configPick') {
      if (key.escape) {
        resolveUiPrompt(prompt.id, null)
        enterNormal()
        return
      }
      const q = prompt.query.toLowerCase()
      const filtered = prompt.items.filter(item =>
        !q || item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q),
      )
      const selected = Math.min(prompt.selected, Math.max(0, filtered.length - 1))
      if (key.return) {
        resolveUiPrompt(prompt.id, filtered[selected]?.value ?? null)
        enterNormal()
        return
      }
      if (key.upArrow || input === 'k') {
        setPrompt(prev => prev?.type === 'configPick'
          ? { ...prev, selected: Math.max(0, prev.selected - 1) }
          : prev)
        return
      }
      if (key.downArrow || input === 'j') {
        setPrompt(prev => prev?.type === 'configPick'
          ? { ...prev, selected: Math.min(Math.max(0, filtered.length - 1), prev.selected + 1) }
          : prev)
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'configPick' ? { ...prev, query: prev.query.slice(0, -1), selected: 0 } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'configPick' ? { ...prev, query: prev.query + input, selected: 0 } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'configInput') {
      if (key.escape) {
        resolveUiPrompt(prompt.id, null)
        enterNormal()
        return
      }
      if (key.return) {
        resolveUiPrompt(prompt.id, prompt.value)
        enterNormal()
        return
      }
      if ((key.ctrl || key.meta || key.super) && (input === 'v' || input === 'V')) {
        const clip = readClipboardText()
        if (clip) {
          const pasted = normalizePromptPaste(clip)
          setPrompt(prev => prev?.type === 'configInput' ? { ...prev, value: prev.value + pasted } : prev)
        }
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'configInput' ? { ...prev, value: prev.value.slice(0, -1) } : prev)
        return
      }
      if (!key.ctrl && !key.meta && promptPasteText(input)) {
        setPrompt(prev => prev?.type === 'configInput' ? { ...prev, value: prev.value + input } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'configConfirm') {
      if (key.escape || input === 'n' || input === 'N') {
        resolveUiPrompt(prompt.id, false)
        enterNormal()
        return
      }
      if (input === 'y' || input === 'Y' || key.return) {
        resolveUiPrompt(prompt.id, true)
        enterNormal()
        return
      }
      return
    }

    // ── Splash panel (startup welcome) ────────────────────────────────────────
    if (panel?.type === 'splash') {
      if (key.return || key.escape) { setPanel(null); return }
      return
    }

    // ── Command palette ───────────────────────────────────────────────────────
    if (panel?.type === 'cmdpalette') {
      if (key.escape) { setPanel(null); return }
      if (key.return) {
        const { items, query, cursor } = panel
        const filtered = query
          ? items.filter(it => it.label.toLowerCase().includes(query.toLowerCase()) || it.keys.includes(query))
          : items
        const item = filtered[cursor % Math.max(1, filtered.length)]
        if (item) { item.action(); setPanel(null) }
        return
      }
      if (input === 'j' && !panel.query) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: prev.cursor + 1 } : prev)
        return
      }
      if (input === 'k' && !panel.query) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : prev)
        return
      }
      if (key.downArrow) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: prev.cursor + 1 } : prev)
        return
      }
      if (key.upArrow) {
        setPanel(prev => prev?.type === 'cmdpalette' ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : prev)
        return
      }
      if (key.backspace || key.delete) {
        setPanel(prev => prev?.type === 'cmdpalette'
          ? { ...prev, query: prev.query.slice(0, -1), cursor: 0 }
          : prev)
        return
      }
      if (!key.ctrl && !key.meta && printableText(input)) {
        setPanel(prev => prev?.type === 'cmdpalette'
          ? { ...prev, query: prev.query + input, cursor: 0 }
          : prev)
        return
      }
      return
    }

    // ── Which-key panel ──────────────────────────────────────────────────────
    if (panel?.type === 'whichkey') {
      if (key.escape) { setPanel(null); return }
      const entry = panel.node[input]
      if (!entry) { setPanel(null); return }
      if (isLeafAction(entry)) { setPanel(null); entry(); return }
      setPanel({ type: 'whichkey', node: entry as LeaderNode, path: panel.path + input + ' ' })
      return
    }

    // ── AI workspace — review findings navigation ───────────────────────────
    if (workspaceTab === 'ai' && reviewState.status === 'findings') {
      if (input === 'j') {
        setReviewState(s => s.status === 'findings' ? { ...s, cursor: Math.min(s.cursor + 1, s.proposal.findings.length - 1) } : s)
        return
      }
      if (input === 'k') {
        setReviewState(s => s.status === 'findings' ? { ...s, cursor: Math.max(s.cursor - 1, 0) } : s)
        return
      }
      if (input === 'i') {
        setReviewState(s => s.status === 'findings' ? { ...s, cursor: Math.min(s.cursor + 1, s.proposal.findings.length - 1) } : s)
        return
      }
      if (input === 'f') {
        const finding = reviewState.proposal.findings[reviewState.cursor]
        if (!finding) return
        const request = [
          'Fix this CodeClaw review finding using the current buffers and git context.',
          finding.suggestedPatch?.trim()
            ? `Prefer applying or refining this suggested unified diff:\n${finding.suggestedPatch}`
            : `Finding: ${finding.title}`,
          finding.explanation,
          finding.rule ? `Rule reference: ${finding.rule}` : '',
        ].filter(Boolean).join('\n\n')
        runCodeClawFix(request, undefined, finding)
        return
      }
      if (input === 't') { showLastTrace(); return }
      if (input === 'x') { setReviewState({ status: 'idle' }); return }
    }

    // ── AI workspace — dismiss overlays + scroll chat ───────────────────────
    if (workspaceTab === 'ai') {
      if (input === 'x' && (fixState.status !== 'idle' || reviewState.status !== 'idle')) {
        setFixState({ status: 'idle' })
        setReviewState({ status: 'idle' })
        return
      }
      if (input === '!' && aiShellCmd) {
        if (shell.mode === 'runner') {
          setShellInput(aiShellCmd)
        } else {
          shell.write(aiShellCmd)
        }
        setWorkspaceTab('process')
        return
      }
      if (reviewState.status === 'idle') {
        if (input === 'j') {
          setAiScrollOffset(prev => Math.max(0, prev - 1))
          return
        }
        if (input === 'k') {
          setAiScrollOffset(prev => prev + 1)
          return
        }
      }
    }

    // ── AI workspace input ───────────────────────────────────────────────────
    if (workspaceTab === 'ai' && fixState.status === 'proposal' && !aiStreaming) {
      if (input === 'a') { acceptCodeClawFix(); return }
      if (input === 'r') { rejectCodeClawFix(); return }
      if (input === 'e') {
        setFixState({ ...fixState, status: 'editing' })
        setAiInput(fixState.context.userRequest)
        setWorkspaceTab('ai')
        return
      }
    }

    if (workspaceTab === 'ai') {
      if (key.escape) {
        setWorkspaceTab('code')
        return
      }
      if (key.ctrl && input === 'c')                   { aiAbortRef.current?.abort(); setAiStreaming(false); return }
      if (key.ctrl && input === 'l')                   { clearAiChat(); return }
      if (input === '!' && !aiInput && aiShellCmd) {
        if (shell.mode === 'runner') {
          setShellInput(aiShellCmd)
        } else {
          shell.write(aiShellCmd)
        }
        setWorkspaceTab('process')
        return
      }
      if (key.tab && aiNavLoc) {
        actions.openFile(aiNavLoc.file, { row: aiNavLoc.row, col: aiNavLoc.col })
        setWorkspaceTab('code')
        return
      }
      if (key.return) {
        if (fixState.status === 'editing') {
          const request = aiInput.trim() || fixState.context.userRequest
          setAiInput('')
          runCodeClawFix(request, fixState.context)
        } else {
          sendAiMessage()
        }
        return
      }
      if (key.backspace || key.delete)                 { setAiInput(prev => prev.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && printable(input))  { setAiInput(prev => prev + input); return }
      return
    }

    // ── Git panel ────────────────────────────────────────────────────────────
    if (panel?.type === 'git') {
      const displayLines = buildGitDisplayLines(panel.data, panel.logEntries, panel.view)
      const selectables: Array<{ line: GitSelectableLine; i: number }> = []
      for (let i = 0; i < displayLines.length; i++) {
        const l = displayLines[i]!
        if (l.selectable) selectables.push({ line: l, i })
      }
      const cursorEntry = selectables[Math.min(panel.cursor, Math.max(0, selectables.length - 1))]?.line ?? null

      if (panel.pendingKey !== null) {
        const pk = panel.pendingKey
        setPanel(prev => prev?.type === 'git' ? { ...prev, pendingKey: null } : prev)
        if (pk === 'c' && input === 'c') {
          setPanel(null)
          replacePrompt({ type: 'commit', message: '' })
          return
        }
        if (pk === 'l' && input === 'l') {
          const logEntries = getGitLog(process.cwd())
          setPanel(prev =>
            prev?.type === 'git'
              ? { ...prev, logEntries, view: 'log', cursor: 0, pendingKey: null }
              : prev,
          )
          return
        }
        return
      }

      if (key.escape || input === 'q') { setPanel(null); return }
      if (input === 'g' || input === 'r') { openGitPanel(); return }
      if (input === 'b' && panel.view === 'log') {
        setPanel(prev =>
          prev?.type === 'git'
            ? { ...prev, view: 'status', logEntries: null, cursor: 0 }
            : prev,
        )
        return
      }

      if (input === 'j') {
        setPanel(prev => prev?.type === 'git'
          ? { ...prev, cursor: Math.min(Math.max(0, selectables.length - 1), prev.cursor + 1) }
          : prev)
        return
      }
      if (input === 'k') {
        setPanel(prev => prev?.type === 'git'
          ? { ...prev, cursor: Math.max(0, prev.cursor - 1) }
          : prev)
        return
      }

      if (key.tab) {
        if (panel.view === 'log') return
        if (cursorEntry?.type === 'file') {
          const entry = cursorEntry.entry
          const hunks = (!entry.expanded && entry.hunks.length === 0)
            ? loadFileHunks(process.cwd(), entry.path, entry.section)
            : entry.hunks
          setPanel(prev => {
            if (prev?.type !== 'git') return prev
            const update = (es: GitFileEntry[]) =>
              updateGitEntry(es, entry.path, e => ({ ...e, expanded: !e.expanded, hunks }))
            return { ...prev, data: { ...prev.data, untracked: update(prev.data.untracked), unstaged: update(prev.data.unstaged), staged: update(prev.data.staged) } }
          })
        }
        return
      }

      if (key.return) {
        const cwd = process.cwd()
        if (cursorEntry?.type === 'log-entry') {
          void shell.runTracked(`git --no-pager show --stat --patch --color=never ${cursorEntry.logEntry.hash}`)
          setPanel(null)
          return
        }
        if (cursorEntry?.type === 'file') {
          actions.openFile(resolveRepoFilePath(cwd, cursorEntry.entry.path))
          setPanel(null)
          return
        }
        if (cursorEntry?.type === 'hunk') {
          const abs = resolveRepoFilePath(cwd, cursorEntry.entry.path)
          const row = hunkNewStartRow(cursorEntry.hunk.header)
          actions.openFile(abs, row != null ? { row, col: 0 } : undefined)
          setPanel(null)
          return
        }
        return
      }

      if (input === 's') {
        if (panel.view === 'log') return
        if (cursorEntry?.type === 'file')  stageEntry(process.cwd(), cursorEntry.entry)
        else if (cursorEntry?.type === 'hunk') stageEntry(process.cwd(), cursorEntry.entry, cursorEntry.hunk)
        if (cursorEntry) openGitPanel()
        return
      }
      if (input === 'u') {
        if (panel.view === 'log') return
        if (cursorEntry?.type === 'file')  unstageEntry(process.cwd(), cursorEntry.entry)
        else if (cursorEntry?.type === 'hunk') unstageEntry(process.cwd(), cursorEntry.entry, cursorEntry.hunk)
        if (cursorEntry) openGitPanel()
        return
      }
      if (input === 'c') { setPanel(prev => prev?.type === 'git' ? { ...prev, pendingKey: 'c' } : prev); return }
      if (input === 'l') { setPanel(prev => prev?.type === 'git' ? { ...prev, pendingKey: 'l' } : prev); return }
      if (input === 'F') {
        const result = pullGit(process.cwd())
        if (result.ok) { openGitPanel() } else { setPanel(prev => prev?.type === 'git' ? { ...prev, gitError: result.error } : prev) }
        return
      }
      if (input === 'P') {
        const result = pushGit(process.cwd())
        openGitPanel()
        if (!result.ok) { setPanel(prev => prev?.type === 'git' ? { ...prev, gitError: result.error } : prev) }
        return
      }
      return
    }

    // ── Diagnostics panel ───────────────────────────────────────────────────
    if (panel?.type === 'diagnostics') {
      const diagnostics = sortDiagnostics(panel.diagnostics)
      const maxIdx = Math.max(0, diagnostics.length - 1)
      const cursor = Math.min(panel.cursor, maxIdx)
      if (key.escape || input === 'q') { setPanel(null); return }
      if (input === 'j' || key.downArrow) {
        setPanel(prev => prev?.type === 'diagnostics' ? { ...prev, cursor: Math.min(maxIdx, cursor + 1) } : prev)
        return
      }
      if (input === 'k' || key.upArrow) {
        setPanel(prev => prev?.type === 'diagnostics' ? { ...prev, cursor: Math.max(0, cursor - 1) } : prev)
        return
      }
      if (key.return) {
        const diagnostic = diagnostics[cursor]
        if (diagnostic) {
          sidecar.moveTo(diagnostic.row, diagnostic.startCol)
          setStatus(formatDiagnostic(diagnostic))
        }
        setPanel(null)
        return
      }
      return
    }

    // ── LSP result panel ────────────────────────────────────────────────────
    if (panel?.type === 'lsp') {
      if (key.escape || input === 'q') { setPanel(null); return }
      return
    }

    // ── Dired panel (directory browser; mirrors Evil dired + h / l) ───────────
    if (panel?.type === 'dired') {
      const entries = readDiredEntries(panel.path)
      const maxIdx = Math.max(0, entries.length - 1)
      const cur = Math.min(panel.cursor, maxIdx)

      if (key.escape || input === 'q') {
        setPanel(null)
        return
      }
      if (input === 'h') {
        const parent = dirname(panel.path)
        if (parent !== panel.path) {
          setPanel({ type: 'dired', path: resolvePath(parent), cursor: 0 })
        }
        return
      }
      if (input === 'j' || key.downArrow) {
        setPanel({ ...panel, cursor: Math.min(maxIdx, cur + 1) })
        return
      }
      if (input === 'k' || key.upArrow) {
        setPanel({ ...panel, cursor: Math.max(0, cur - 1) })
        return
      }
      if (input === 'l' || key.return) {
        const e = entries[cur]
        if (!e) return
        if (e.isDir) {
          setPanel({ type: 'dired', path: resolvePath(e.fullPath), cursor: 0 })
        } else {
          actions.openFile(e.fullPath)
          setPanel(null)
        }
        return
      }
      return
    }

    // Shell: panel strip under editor OR full-screen process tab (see docs/workspace-ui.md).
    if (panel?.type === 'shell' || workspaceTab === 'process') {
      if (key.escape) {
        if (dangerPrompt) { setDangerPrompt(null); return }
        setShellScrollOffset(0)
        if (workspaceTab === 'process') setWorkspaceTab('code')
        else setPanel(null)
        return
      }
      if (shell.mode === 'runner') {
        if (key.upArrow)   { setShellScrollOffset(prev => prev + 1); return }
        if (key.downArrow) { setShellScrollOffset(prev => Math.max(0, prev - 1)); return }
        if (key.return) {
          if (dangerPrompt) {
            const cmd = dangerPrompt.cmd
            setDangerPrompt(null)
            setShellScrollOffset(0)
            setShellRunning(true)
            void shell.runTracked(cmd).finally(() => setShellRunning(false))
            return
          }
          const cmd = shellInput.trim()
          if (!cmd || shellRunning) return
          const danger = checkCommandDanger(cmd)
          if (danger.dangerous) { setDangerPrompt({ cmd, reason: danger.reason }); return }
          setShellInput('')
          setShellScrollOffset(0)
          setShellRunning(true)
          void shell.runTracked(cmd).finally(() => setShellRunning(false))
          return
        }
        if (!dangerPrompt) {
          if (key.backspace || key.delete) { setShellInput(prev => prev.slice(0, -1)); return }
          if (key.ctrl && input === 'c') { shell.cancelRunner(); setShellRunning(false); return }
          if (!key.ctrl && !key.meta && printableText(input)) { setShellInput(prev => prev + input); return }
        }
        return
      }
      if (input === 'o') {
        // jump to first parsed error location
        const loc = shell.lastLocation
        if (loc) {
          actions.openFile(loc.file, { row: loc.row, col: loc.col })
          setWorkspaceTab('code')
          setPanel(null)
        }
        return
      }
      if (key.shift && key.upArrow)   { setShellScrollOffset(prev => prev + 1); return }
      if (key.shift && key.downArrow) { setShellScrollOffset(prev => Math.max(0, prev - 1)); return }
      if (key.return)                                  { void shell.submitCurrentInput(); return }
      if (key.backspace || key.delete)                 { shell.write('\x7f'); return }
      if (key.upArrow)                                 { shell.write('\x1b[A'); return }
      if (key.downArrow)                               { shell.write('\x1b[B'); return }
      if (key.leftArrow)                               { shell.write('\x1b[D'); return }
      if (key.rightArrow)                              { shell.write('\x1b[C'); return }
      if (key.ctrl && input === 'c')                   { shell.write('\x03'); return }
      if (key.ctrl && input === 'l')                   { shell.write('\x0c'); return }
      if (key.ctrl && input === 'd')                   { shell.write('\x04'); return }
      if (!key.ctrl && !key.meta && printableText(input))  { shell.write(input); return }
      return
    }

    // ── Commit prompt ────────────────────────────────────────────────────────
    if (prompt?.type === 'commit') {
      if (key.escape) { replacePrompt(null); return }
      if (key.return) {
        const msg = prompt.message.trim()
        if (msg) {
          const result = commitGit(process.cwd(), msg)
          replacePrompt(null)
          openGitPanel()
          if (!result.ok) {
            setPanel(prev => prev?.type === 'git' ? { ...prev, gitError: result.error } : prev)
          }
        } else {
          replacePrompt(null)
        }
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'commit' ? { ...prev, message: prev.message.slice(0, -1) } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'commit' ? { ...prev, message: prev.message + input } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'saveAs') {
      if (key.escape) { enterNormal(); return }
      if (key.return) {
        const raw = prompt.query.trim()
        if (!raw) {
          enterNormal()
          return
        }
        sidecar.saveAs(resolvePath(raw))
        const thenQuit = Boolean(prompt.thenQuit)
        enterNormal()
        if (thenQuit) actions.quitAll()
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'saveAs' ? { ...prev, query: prev.query.slice(0, -1) } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'saveAs' ? { ...prev, query: prev.query + input } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'file') {
      if (key.escape) { enterNormal(); return }
      if (key.return) {
        const chosen = prompt.ranked[prompt.selectedIdx]?.path ?? prompt.query.trim()
        if (chosen) actions.openFile(resolvePath(prompt.base, chosen))
        enterNormal()
        return
      }
      if (key.upArrow) {
        setPrompt(prev => prev?.type === 'file' ? { ...prev, selectedIdx: Math.max(0, prev.selectedIdx - 1) } : prev)
        return
      }
      if (key.downArrow) {
        setPrompt(prev => prev?.type === 'file'
          ? { ...prev, selectedIdx: Math.min(Math.max(0, prev.ranked.length - 1), prev.selectedIdx + 1) }
          : prev)
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => {
          if (prev?.type !== 'file') return prev
          const query = prev.query.slice(0, -1)
          const ranked = query ? fuzzyRank(query, prev.candidates).slice(0, 50) : prev.candidates.slice(0, 50).map(p => ({ path: p, score: 0, indices: [] }))
          return { ...prev, query, ranked, selectedIdx: 0 }
        })
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => {
          if (prev?.type !== 'file') return prev
          const query = prev.query + input
          const ranked = fuzzyRank(query, prev.candidates).slice(0, 50)
          return { ...prev, query, ranked, selectedIdx: 0 }
        })
        return
      }
      return
    }

    if (prompt?.type === 'buffer') {
      if (key.escape) { enterNormal(); return }
      const sorted = [...buffers].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const filtered = filterBuffers(sorted, prompt.query)
      const selected = Math.min(prompt.selected, Math.max(0, filtered.length - 1))
      if (key.return) {
        const target = filtered[selected]
        if (target) actions.switchBuffer(target.id)
        enterNormal()
        return
      }
      if (key.upArrow || input === 'k') {
        setPrompt(prev => prev?.type === 'buffer'
          ? { ...prev, selected: Math.max(0, Math.min(prev.selected, filtered.length - 1) - 1) }
          : prev)
        return
      }
      if (key.downArrow || input === 'j') {
        setPrompt(prev => prev?.type === 'buffer'
          ? { ...prev, selected: Math.min(Math.max(0, filtered.length - 1), prev.selected + 1) }
          : prev)
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'buffer' ? { ...prev, query: prev.query.slice(0, -1), selected: 0 } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'buffer' ? { ...prev, query: prev.query + input, selected: 0 } : prev)
        return
      }
      return
    }

    if (prompt?.type === 'model') {
      if (key.escape) { enterNormal(); return }
      const q = prompt.query.toLowerCase()
      const filtered = prompt.candidates.filter(m => !q || m.toLowerCase().includes(q))
      const selected = Math.min(prompt.selected, Math.max(0, filtered.length - 1))
      if (key.return) {
        const chosen = filtered[selected] ?? prompt.query.trim()
        if (chosen) {
          setActiveModel(chosen)
          setAiModelLabel(getProviderLabel())
        }
        enterNormal()
        return
      }
      if (key.upArrow || input === 'k') {
        setPrompt(prev => prev?.type === 'model'
          ? { ...prev, selected: Math.max(0, Math.min(prev.selected, filtered.length - 1) - 1) }
          : prev)
        return
      }
      if (key.downArrow || input === 'j') {
        setPrompt(prev => prev?.type === 'model'
          ? { ...prev, selected: Math.min(Math.max(0, filtered.length - 1), prev.selected + 1) }
          : prev)
        return
      }
      if (key.backspace || key.delete) {
        setPrompt(prev => prev?.type === 'model' ? { ...prev, query: prev.query.slice(0, -1), selected: 0 } : prev)
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        setPrompt(prev => prev?.type === 'model' ? { ...prev, query: prev.query + input, selected: 0 } : prev)
        return
      }
      return
    }

    if (key.escape) { enterNormal(); return }

    // ── Command mode ─────────────────────────────────────────────────────────
    if (mode === 'command') {
      if (key.return) { executeCommand(cmdBuf); enterNormal(); return }
      if (key.backspace || key.delete) {
        setCmdBuf(prev => { if (prev.length <= 0) { enterNormal(); return prev } return prev.slice(0, -1) })
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) { setCmdBuf(prev => prev + input); return }
      return
    }

    // ── Search mode ───────────────────────────────────────────────────────────
    if (mode === 'search') {
      const commitSearchFromPrompt = (keepHighlights: boolean) => {
        const q = searchBuf
        searchQueryRef.current = q
        searchIdxRef.current = -1
        visualExpandHistoryRef.current = []
        setVisualAnchor(null)
        setVisualLineMode(false)
        setSearchBuf('')
        jumpToMatch(1)
        if (keepHighlights) {
          setSearchQuery(q)
        } else {
          setSearchQuery('')
          searchQueryRef.current = ''
        }
      }

      if (key.return) {
        commitSearchFromPrompt(true)
        setMode('normal')
        return
      }
      if (!key.ctrl && !key.meta && input === 'i') {
        commitSearchFromPrompt(false)
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'a') {
        commitSearchFromPrompt(false)
        sidecar.move('right')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'I') {
        commitSearchFromPrompt(false)
        sidecar.move('home')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'A') {
        commitSearchFromPrompt(false)
        sidecar.move('end')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'o') {
        commitSearchFromPrompt(false)
        sidecar.move('end')
        sidecar.insert('\n')
        setMode('insert')
        return
      }
      if (!key.ctrl && !key.meta && input === 'O') {
        commitSearchFromPrompt(false)
        sidecar.move('home')
        sidecar.insert('\n')
        sidecar.move('up')
        setMode('insert')
        return
      }
      if (key.backspace || key.delete) { setSearchBuf(prev => prev.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && printable(input)) { setSearchBuf(prev => prev + input); return }
      return
    }

    // ── Insert mode ───────────────────────────────────────────────────────────
    if (mode === 'insert') {
      if (key.upArrow)                { sidecar.move('up');    return }
      if (key.downArrow)              { sidecar.move('down');  return }
      if (key.leftArrow)              { sidecar.move('left');  return }
      if (key.rightArrow)             { sidecar.move('right'); return }
      if (key.backspace || key.delete){ sidecar.deleteBackward(); return }
      if (key.return)                 { sidecar.insert('\n'); return }
      if (key.ctrl && input === 's')  { saveCurrentBuffer(); return }
      if (key.tab || input === '\t') {
        const g = ghostTextRef.current
        if (g !== null && g.length > 0) {
          // Already sanitized each chunk while streaming — second full pass was stripping valid gaps to ''.
          sidecar.insert(g)
          setGhostTextSync(null)
          abortRef.current = null
        } else {
          triggerCompletion()
        }
        return
      }
      if (!key.ctrl && !key.meta && printable(input)) {
        if (ghostTextRef.current !== null || completionStreaming) {
          abortRef.current?.abort()
          abortRef.current = null
          setGhostTextSync(null)
          setCompletionStreaming(false)
        }
        sidecar.insert(input)
      }
      return
    }

    // ── Visual mode ───────────────────────────────────────────────────────────
    if (mode === 'visual') {
      if (input === ' ' && !key.ctrl && !key.meta) {
        pendingKeyRef.current = null
        setPanel({ type: 'whichkey', node: leaderMap, path: '' })
        return
      }

      if (input === '/') {
        visualExpandHistoryRef.current = []
        setVisualAnchor(null)
        setVisualLineMode(false)
        setMode('search')
        setSearchBuf('')
        pendingKeyRef.current = null
        return
      }

      if (input === 'v' && snapshot && visualAnchor) {
        const curSnap: VisualSnap = {
          anchor: { ...visualAnchor },
          cursor: { ...snapshot.cursor },
          lineMode: visualLineMode,
        }
        const next = expandRegionOnce(snapshot.lines, visualAnchor, snapshot.cursor, visualLineMode)
        if (next) {
          visualExpandHistoryRef.current.push(curSnap)
          setVisualAnchor(next.anchor)
          setVisualLineMode(next.lineMode)
          sidecar.moveTo(next.cursor.row, next.cursor.col)
        }
        return
      }

      if (input === 'V' && snapshot && visualAnchor) {
        const h = visualExpandHistoryRef.current
        if (h.length > 0) {
          const prev = h.pop()!
          setVisualAnchor(prev.anchor)
          setVisualLineMode(prev.lineMode)
          sidecar.moveTo(prev.cursor.row, prev.cursor.col)
        }
        return
      }

      // movement extends selection (hjkl + arrows) — clears expand/contract stack
      if (input === 'h' || key.leftArrow)  { visualExpandHistoryRef.current = []; sidecar.move('left');  return }
      if (input === 'j' || key.downArrow)  { visualExpandHistoryRef.current = []; sidecar.move('down');  return }
      if (input === 'k' || key.upArrow)    { visualExpandHistoryRef.current = []; sidecar.move('up');    return }
      if (input === 'l' || key.rightArrow) { visualExpandHistoryRef.current = []; sidecar.move('right'); return }
      if (input === 'w') { visualExpandHistoryRef.current = []; sidecar.move('wordForward'); return }
      if (input === 'b') { visualExpandHistoryRef.current = []; sidecar.move('wordBackward'); return }
      if (input === '0') { visualExpandHistoryRef.current = []; sidecar.move('home'); return }
      if (input === '$') { visualExpandHistoryRef.current = []; sidecar.move('end');  return }
      if (input === 'G') { visualExpandHistoryRef.current = []; sidecar.move('fileEnd'); return }
      if (input === 'g') { visualExpandHistoryRef.current = []; sidecar.move('fileStart'); return }

      if (input === 'o' && snapshot && visualAnchor) {
        visualExpandHistoryRef.current = []
        const ar = visualAnchor.row
        const ac = visualAnchor.col
        const cr = snapshot.cursor.row
        const cc = snapshot.cursor.col
        setVisualAnchor({ row: cr, col: cc })
        sidecar.moveTo(ar, ac)
        return
      }

      if (input === 'y' && snapshot && visualAnchor) {
        const sel = selectionBounds(visualAnchor, snapshot.cursor, visualLineMode, snapshot.lines)
        yankText(getVisualText(snapshot.lines, sel), sel.lineMode)
        enterNormal()
        return
      }

      if ((input === 'd' || input === 'c') && snapshot && visualAnchor) {
        const sel = selectionBounds(visualAnchor, snapshot.cursor, visualLineMode, snapshot.lines)
        yankText(getVisualText(snapshot.lines, sel), sel.lineMode)
        if (sel.lineMode) {
          sidecar.deleteRange(sel.startRow, 0, sel.endRow, 999999)
        } else {
          sidecar.deleteRange(sel.startRow, sel.startCol, sel.endRow, sel.endCol)
        }
        if (input === 'c') { clearSearchHighlights(); setMode('insert') } else { enterNormal() }
        return
      }
      return
    }

    // ── Normal mode ───────────────────────────────────────────────────────────
    if (input === '-' && !key.ctrl && !key.meta) {
      const fp = snapshot?.filename ?? activeBuffer.filename ?? null
      const dir = fp ? dirname(resolvePath(fp)) : process.cwd()
      let path = resolvePath(dir)
      try {
        path = realpathSync(path)
      } catch {
        /* stay with resolved path */
      }
      setPanel({ type: 'dired', path, cursor: 0 })
      return
    }
    if (input === '[' || input === '{') {
      sidecar.move('paragraphBackward')
      return
    }
    if (input === ']' || input === '}') {
      sidecar.move('paragraphForward')
      return
    }
    if (key.ctrl && input === 's') { saveCurrentBuffer(); return }
    if (key.ctrl && input === 'r') { sidecar.redo(); return }
    if (key.upArrow)    { sidecar.move('up');    return }
    if (key.downArrow)  { sidecar.move('down');  return }
    if (key.leftArrow)  { sidecar.move('left');  return }
    if (key.rightArrow) { sidecar.move('right'); return }

    // Inline completion (same as insert mode — works after SPC a c while still in normal)
    if (key.tab || input === '\t') {
      const g = ghostTextRef.current
      if (g !== null && g.length > 0) {
        sidecar.insert(g)
        setGhostTextSync(null)
        abortRef.current = null
      } else {
        triggerCompletion()
      }
      return
    }

    // Enter command mode
    if (input === ':') { setMode('command'); setCmdBuf(''); pendingKeyRef.current = null; return }

    // Enter search mode (clear any stale visual — should already be empty in normal)
    if (input === '/') {
      visualExpandHistoryRef.current = []
      setVisualAnchor(null)
      setVisualLineMode(false)
      setMode('search')
      setSearchBuf('')
      pendingKeyRef.current = null
      return
    }

    // Clear search highlight
    if (key.ctrl && input === 'h') { setSearchQuery(''); searchQueryRef.current = ''; return }

    // SPC opens which-key menu
    if (input === ' ') {
      setPanel({ type: 'whichkey', node: leaderMap, path: '' })
      pendingKeyRef.current = null
      return
    }

    // ── Two-key sequences ────────────────────────────────────────────────────
    const pending = pendingKeyRef.current
    pendingKeyRef.current = null

    if (pending === 'g') {
      if (input === 'g') {
        sidecar.move('fileStart')
        return
      }
      if (input === 'd') {
        const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
        sidecar.goToDefinition(cursor.row, cursor.col)
        return
      }
      /* incomplete `gg` — fall through so e.g. `n` still runs search-next */
    } else if (pending === 'd') {
      if (input === 'd' && snapshot) {
        yankText(snapshot.lines[snapshot.cursor.row] ?? '', true)
        sidecar.deleteLine()
      }
      return
    } else if (pending === 'y') {
      if (input === 'y' && snapshot)
        yankText(snapshot.lines[snapshot.cursor.row] ?? '', true)
      return
    }

    if (input === 'n') { jumpToMatch(1); return }
    if (input === 'N') { jumpToMatch(-1); return }

    // ── Single-key normal mode ────────────────────────────────────────────────
    switch (input) {
      case 'h': sidecar.move('left');        break
      case 'j': sidecar.move('down');        break
      case 'k': sidecar.move('up');          break
      case 'l': sidecar.move('right');       break
      case 'w': sidecar.move('wordForward'); break
      case 'b': sidecar.move('wordBackward');break
      case '0': sidecar.move('home');        break
      case '$': sidecar.move('end');         break
      case 'G': sidecar.move('fileEnd');     break
      case 'K': {
        const cursor = nearestIdentifierPosition(snapshot?.lines ?? [], snapshot?.cursor ?? { row: 0, col: 0 })
        sidecar.hover(cursor.row, cursor.col)
        break
      }
      case 'g': pendingKeyRef.current = 'g'; break
      case 'd': pendingKeyRef.current = 'd'; break
      case 'y': pendingKeyRef.current = 'y'; break
      case 'u': sidecar.undo();              break
      case 'x': sidecar.deleteForward();     break
      case 'X': sidecar.deleteBackward();    break
      case 'p':
        if (yankRegisterRef.current !== null) {
          const yank = yankRegisterRef.current
          if (yank.lineWise) {
            // line-wise yank → paste as new line below
            sidecar.move('end'); sidecar.insert('\n' + yank.text)
          } else {
            // char-wise yank → paste after cursor
            sidecar.move('right'); sidecar.insert(yank.text)
          }
        }
        break
      case 'P':
        if (yankRegisterRef.current !== null) {
          const yank = yankRegisterRef.current
          if (yank.lineWise) {
            // line-wise → paste as new line above
            sidecar.move('home'); sidecar.insert(yank.text + '\n'); sidecar.move('up')
          } else {
            // char-wise → paste before cursor
            sidecar.insert(yank.text)
          }
        }
        break
      case 'v':
        if (snapshot) {
          const cur = snapshot.cursor
          visualExpandHistoryRef.current = []
          setVisualAnchor({ ...cur })
          setVisualLineMode(false)
          setMode('visual')
          const next = expandRegionOnce(snapshot.lines, cur, cur, false)
          if (next) {
            visualExpandHistoryRef.current.push({ anchor: { ...cur }, cursor: { ...cur }, lineMode: false })
            setVisualAnchor(next.anchor)
            setVisualLineMode(next.lineMode)
            sidecar.moveTo(next.cursor.row, next.cursor.col)
          }
        }
        break
      case 'V':
        if (snapshot) {
          visualExpandHistoryRef.current = []
          setVisualAnchor({ row: snapshot.cursor.row, col: 0 })
          setVisualLineMode(true)
          setMode('visual')
        }
        break
      case 'i': clearSearchHighlights(); setMode('insert'); break
      case 'I': sidecar.move('home'); clearSearchHighlights(); setMode('insert'); break
      case 'a': sidecar.move('right'); clearSearchHighlights(); setMode('insert'); break
      case 'A': sidecar.move('end');   clearSearchHighlights(); setMode('insert'); break
      case 'o':
        sidecar.move('end'); sidecar.insert('\n'); clearSearchHighlights(); setMode('insert'); break
      case 'O':
        sidecar.move('home'); sidecar.insert('\n'); sidecar.move('up'); clearSearchHighlights(); setMode('insert'); break
    }
  }
}
