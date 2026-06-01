import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBufferTabSegments,
  isWorkflowTabNextInput,
  isWorkflowTabPrevInput,
  shouldArmWorkflowTabBracket,
  normalizeTasks,
  normalizeWorkspaceTab,
  parseWorkflowSession,
  resolveHookTask,
  sessionFromBuffers,
} from '../src/workflow.ts'

describe('workflow tab keys', () => {
  it('recognizes meta brackets and macOS option glyphs', () => {
    assert.equal(isWorkflowTabPrevInput('[', { meta: true }), true)
    assert.equal(isWorkflowTabNextInput(']', { meta: true }), true)
    assert.equal(isWorkflowTabPrevInput('[', { meta: false }), false)
    assert.equal(isWorkflowTabPrevInput('«', { meta: false }), true)
    assert.equal(isWorkflowTabNextInput('»', { meta: false }), true)
    assert.equal(isWorkflowTabPrevInput('', { ctrl: true, pageUp: true }), true)
    assert.equal(isWorkflowTabNextInput('', { ctrl: true, pageDown: true }), true)
    assert.equal(isWorkflowTabPrevInput('[', { meta: false }, '\x1b['), true)
    assert.equal(shouldArmWorkflowTabBracket({ escape: true }, ''), true)
    assert.equal(shouldArmWorkflowTabBracket({ escape: true }, 'q'), false)
  })
})

describe('workflow buffer tabs', () => {
  it('keeps the active buffer visible and marks dirty buffers', () => {
    const tabs = buildBufferTabSegments([
      { id: 'a', name: 'a.ts', filename: '/tmp/a.ts', dirty: false, active: false, lastUsedAt: 1 },
      { id: 'b', name: 'b.ts', filename: '/tmp/b.ts', dirty: true, active: true, lastUsedAt: 2 },
      { id: 'c', name: 'c.ts', filename: '/tmp/c.ts', dirty: false, active: false, lastUsedAt: 3 },
    ], 80)

    const active = tabs.find(tab => tab.kind === 'tab' && tab.active)
    assert.equal(active?.kind === 'tab' ? active.id : '', 'b')
    assert.match(active?.label ?? '', /⌥2/)
    assert.match(active?.label ?? '', /\*/)
  })

  it('numbers permanent process and AI tabs after file buffers', () => {
    const tabs = buildBufferTabSegments([
      { id: 'file-1', name: 'one.ts', filename: '/tmp/one.ts', dirty: false, active: false, lastUsedAt: 1 },
      { id: 'file-2', name: 'two.ts', filename: '/tmp/two.ts', dirty: false, active: false, lastUsedAt: 2 },
      { id: 'process', name: 'process', filename: null, dirty: false, active: false, lastUsedAt: 0 },
      { id: 'ai', name: 'ai', filename: null, dirty: false, active: true, lastUsedAt: 0 },
    ], 120)

    assert.deepEqual(tabs.filter(tab => tab.kind === 'tab').map(tab => tab.label.trim().split(/\s+/)[0]), [
      '⌥1',
      '⌥2',
      '⌥3',
      '⌥4',
    ])
    assert.equal(tabs[2]?.kind === 'tab' ? tabs[2].id : '', 'process')
    assert.equal(tabs[3]?.kind === 'tab' ? tabs[3].id : '', 'ai')
  })

  it('adds overflow when the terminal is narrow', () => {
    const tabs = buildBufferTabSegments([
      { id: 'a', name: 'alpha.ts', filename: '/tmp/alpha.ts', dirty: false, active: true, lastUsedAt: 1 },
      { id: 'b', name: 'beta.ts', filename: '/tmp/beta.ts', dirty: false, active: false, lastUsedAt: 4 },
      { id: 'c', name: 'gamma.ts', filename: '/tmp/gamma.ts', dirty: false, active: false, lastUsedAt: 3 },
      { id: 'd', name: 'delta.ts', filename: '/tmp/delta.ts', dirty: false, active: false, lastUsedAt: 2 },
    ], 22)

    assert.equal(tabs.some(tab => tab.kind === 'overflow'), true)
    assert.equal(tabs[0]?.kind === 'tab' ? tabs[0].id : '', 'a')
  })

  it('keeps the active permanent tab visible when later tabs overflow', () => {
    const tabs = buildBufferTabSegments([
      { id: 'a', name: 'alpha.ts', filename: '/tmp/alpha.ts', dirty: false, active: false, lastUsedAt: 1 },
      { id: 'b', name: 'beta.ts', filename: '/tmp/beta.ts', dirty: false, active: false, lastUsedAt: 2 },
      { id: 'c', name: 'gamma.ts', filename: '/tmp/gamma.ts', dirty: false, active: false, lastUsedAt: 3 },
      { id: 'process', name: 'process', filename: null, dirty: false, active: false, lastUsedAt: 0 },
      { id: 'ai', name: 'ai', filename: null, dirty: false, active: true, lastUsedAt: 0 },
    ], 28)

    assert.equal(tabs.some(tab => tab.kind === 'tab' && tab.id === 'ai' && tab.active), true)
    assert.equal(tabs.some(tab => tab.kind === 'overflow'), true)
  })
})

describe('workflow workspace tabs', () => {
  it('normalizes the persistent AI workspace tab', () => {
    assert.equal(normalizeWorkspaceTab('ai'), 'ai')
    assert.equal(normalizeWorkspaceTab('process'), 'process')
    assert.equal(normalizeWorkspaceTab('bogus'), 'code')
  })
})

describe('workflow tasks', () => {
  it('normalizes configured tasks and drops empty entries', () => {
    const tasks = normalizeTasks([
      { name: ' dev ', command: ' npm run dev ', tab: 'process' },
      { name: '', command: 'npm test' },
      { name: 'bad', command: '   ' },
    ])

    assert.deepEqual(tasks, [
      { name: 'dev', command: 'npm run dev', tab: 'process' },
    ])
  })
})

describe('workflow session', () => {
  it('stores only file buffers and preserves the active file', () => {
    const session = sessionFromBuffers([
      { filename: '/tmp/a.ts', active: false },
      { filename: null, active: false },
      { filename: '/tmp/b.ts', active: true },
      { filename: '/tmp/a.ts', active: false },
    ], 'ai')

    assert.deepEqual(session.files, ['/tmp/a.ts', '/tmp/b.ts'])
    assert.equal(session.activeFile, '/tmp/b.ts')
    assert.equal(session.workspaceTab, 'ai')
  })

  it('parses old or malformed session input defensively', () => {
    const session = parseWorkflowSession({
      files: ['/tmp/a.ts', 42, '/tmp/a.ts'],
      activeFile: '',
      workspaceTab: 'unknown',
    })

    assert.deepEqual(session?.files, ['/tmp/a.ts'])
    assert.equal(session?.activeFile, null)
    assert.equal(session?.workspaceTab, 'code')
  })

  it('parses restored AI workspace sessions', () => {
    const session = parseWorkflowSession({ files: [], activeFile: null, workspaceTab: 'ai' })
    assert.equal(session?.workspaceTab, 'ai')
  })
})

describe('resolveHookTask', () => {
  const tasks = [
    { name: 'dev', command: 'npm run dev', tab: 'process' as const },
    { name: 'test', command: 'npm test', tab: 'shell' as const },
  ]

  it('resolves by args.task', () => {
    const result = resolveHookTask(tasks, { task: 'test' })
    assert.ok('task' in result)
    assert.equal(result.task.name, 'test')
  })

  it('uses the only task when args omitted', () => {
    const single = [{ name: 'only', command: 'echo hi' }]
    const result = resolveHookTask(single, {})
    assert.ok('task' in result)
    assert.equal(result.task.name, 'only')
  })

  it('requires args.task when multiple tasks configured', () => {
    const result = resolveHookTask(tasks, {})
    assert.ok('error' in result)
    assert.match(result.error, /args\.task/)
  })

  it('reports unknown task name', () => {
    const result = resolveHookTask(tasks, { task: 'missing' })
    assert.ok('error' in result)
    assert.match(result.error, /unknown task/)
  })
})
