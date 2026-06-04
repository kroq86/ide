import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Key } from 'terminal-react-core'
import { createEditorInputHandler } from '../src/ui/editor-input-handler.js'

const noop = () => {}

const tabKey: Key = { tab: true }

function makeHandler(overrides: {
  mode?: string
  ghostText?: string | null
  completionStreaming?: boolean
} = {}) {
  const inserts: string[] = []
  const ghostTextRef = { current: overrides.ghostText ?? null as string | null }
  let streaming = overrides.completionStreaming ?? false
  const completionAbortRef = { current: null as AbortController | null }
  const abortCalls: AbortController[] = []

  const controller = new AbortController()
  completionAbortRef.current = controller
  const origAbort = controller.abort.bind(controller)
  controller.abort = () => {
    abortCalls.push(controller)
    origAbort()
  }

  let dismissCount = 0
  const dismissInlineCompletion = () => {
    dismissCount++
    completionAbortRef.current?.abort()
    completionAbortRef.current = null
    ghostTextRef.current = null
    streaming = false
  }

  let triggerCount = 0

  const handler = createEditorInputHandler({
    acceptCodeClawFix: noop,
    actions: { quitAll: noop, clearLspOverlay: noop, openFile: noop, switchBuffer: noop },
    activeBuffer: { filename: null },
    aiAbortRef: { current: null },
    aiInput: '',
    aiNavLoc: null,
    aiShellCmd: null,
    aiStreaming: false,
    buffers: [],
    clearAiChat: noop,
    clearSearchHighlights: noop,
    cmdBuf: '',
    dismissInlineCompletion,
    completionStreaming: streaming,
    dangerPrompt: null,
    enterNormal: noop,
    executeCommand: noop,
    filename: undefined,
    fixState: { status: 'idle' },
    fuzzyRank: () => [],
    ghostTextRef,
    jumpToMatch: noop,
    leaderMap: {},
    lspOverlay: null,
    mode: overrides.mode ?? 'insert',
    openGitPanel: noop,
    panel: null,
    pendingKeyRef: { current: null },
    workflowTabBracketArmUntilRef: { current: 0 },
    prompt: null,
    rejectCodeClawFix: noop,
    replacePrompt: noop,
    resolveUiPrompt: noop,
    reviewState: { status: 'idle' },
    runCodeClawFix: noop,
    saveCurrentBuffer: noop,
    searchBuf: '',
    searchIdxRef: { current: 0 },
    searchQueryRef: { current: '' },
    sendAiMessage: noop,
    setAiInput: noop,
    setAiModelLabel: noop,
    setAiScrollOffset: noop,
    setAiStreaming: noop,
    setCmdBuf: noop,
    setCompletionStreaming: (value: boolean) => { streaming = value },
    setDangerPrompt: noop,
    setFixState: noop,
    setGhostTextSync: (value: string | null) => { ghostTextRef.current = value },
    setMode: noop,
    setPanel: noop,
    setPrompt: noop,
    setReviewState: noop,
    setSearchBuf: noop,
    setSearchQuery: noop,
    setShellInput: noop,
    setShellRunning: noop,
    setShellScrollOffset: noop,
    setStatus: noop,
    setVisualAnchor: noop,
    setVisualLineMode: noop,
    setWorkspaceTab: noop,
    shell: { write: noop, runTracked: async () => {}, cancelRunner: noop, mode: 'pty', lastLocation: null },
    shellInput: '',
    shellRunning: false,
    showLastTrace: noop,
    sidecar: { insert: (text: string) => { inserts.push(text) }, move: noop, deleteBackward: noop },
    snapshot: { lines: [''], cursor: { row: 0, col: 0 }, filename: null },
    status: '',
    switchWorkflowTabByIndex: noop,
    cycleWorkflowTab: noop,
    triggerCompletion: () => { triggerCount++ },
    suggestConfigDirectiveCompletion: () => false,
    applyDirectivePick: noop,
    visualAnchor: null,
    visualExpandHistoryRef: { current: [] },
    visualLineMode: false,
    workspaceTab: 'code',
    yankRegisterRef: { current: null },
    yankText: noop,
  })

  return {
    handler,
    inserts,
    get ghost() { return ghostTextRef.current },
    get streaming() { return streaming },
    get triggerCount() { return triggerCount },
    get dismissCount() { return dismissCount },
    abortCalls,
    completionAbortRef,
  }
}

describe('createEditorInputHandler inline completion (insert)', () => {
  it('Tab with ghost accepts text, aborts stream, clears ghost and streaming flag', () => {
    const h = makeHandler({ ghostText: 'ack' })
    h.handler('\t', tabKey)

    assert.deepEqual(h.inserts, ['ack'])
    assert.equal(h.ghost, null)
    assert.equal(h.streaming, false)
    assert.equal(h.abortCalls.length, 1)
    assert.equal(h.dismissCount, 1)
    assert.equal(h.completionAbortRef.current, null)
    assert.equal(h.triggerCount, 0)
  })

  it('Shift+Tab inserts a literal tab without triggering completion', () => {
    const h = makeHandler({ ghostText: null, completionStreaming: false })
    h.handler('\t', { tab: true, shift: true })

    assert.equal(h.triggerCount, 0)
    assert.deepEqual(h.inserts, ['\t'])
  })

  it('Tab with no ghost triggers completion once', () => {
    const h = makeHandler({ ghostText: null, completionStreaming: false })
    h.handler('\t', tabKey)

    assert.equal(h.triggerCount, 1)
    assert.equal(h.dismissCount, 0)
    assert.deepEqual(h.inserts, [])
  })

  it('Tab with no ghost while streaming dismisses without re-triggering', () => {
    const h = makeHandler({ ghostText: null, completionStreaming: true })
    h.handler('\t', tabKey)

    assert.equal(h.triggerCount, 0)
    assert.equal(h.dismissCount, 1)
    assert.equal(h.streaming, false)
    assert.equal(h.abortCalls.length, 1)
    assert.deepEqual(h.inserts, [])
  })

  it('Tab with empty ghost while streaming dismisses without insert or trigger', () => {
    const h = makeHandler({ ghostText: '', completionStreaming: true })
    h.handler('\t', tabKey)

    assert.equal(h.triggerCount, 0)
    assert.equal(h.dismissCount, 1)
    assert.deepEqual(h.inserts, [])
    assert.equal(h.streaming, false)
  })

  it('double Tab after accept: same handler closure still streaming ignores second trigger', () => {
    const h = makeHandler({ ghostText: 'ack', completionStreaming: true })
    h.handler('\t', tabKey)
    assert.deepEqual(h.inserts, ['ack'])

    // Same handler instance: completionStreaming still true in closure; ghost cleared by dismiss.
    // Production rebuilds the handler each render with fresh completionStreaming.
    h.handler('\t', tabKey)

    assert.equal(h.triggerCount, 0)
    assert.equal(h.dismissCount, 2)
    assert.deepEqual(h.inserts, ['ack'])
  })

  it('typing dismisses ghost and aborts completion', () => {
    const h = makeHandler({ ghostText: 'ack', completionStreaming: true })
    h.handler('x', {})

    assert.equal(h.ghost, null)
    assert.equal(h.streaming, false)
    assert.equal(h.dismissCount, 1)
    assert.equal(h.abortCalls.length, 1)
    assert.deepEqual(h.inserts, ['x'])
  })
})

describe('createEditorInputHandler inline completion (normal)', () => {
  it('Tab with ghost accepts and dismisses like insert mode', () => {
    const h = makeHandler({ mode: 'normal', ghostText: 'foo' })
    h.handler('\t', tabKey)

    assert.deepEqual(h.inserts, ['foo'])
    assert.equal(h.ghost, null)
    assert.equal(h.streaming, false)
    assert.equal(h.dismissCount, 1)
    assert.equal(h.abortCalls.length, 1)
  })

  it('Tab while streaming without ghost dismisses stream', () => {
    const h = makeHandler({ mode: 'normal', completionStreaming: true })
    h.handler('\t', tabKey)
    assert.equal(h.triggerCount, 0)
    assert.equal(h.dismissCount, 1)
    assert.equal(h.streaming, false)
  })
})
