import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEditorContext } from '../src/editor-context.js'
import type { ShellRun } from '../src/shell.js'

function baseDeps(overrides: Partial<Parameters<typeof createEditorContext>[0]> = {}) {
  const shellRuns: string[] = []
  const notifications: string[] = []
  return {
    deps: {
      mode: 'interactive' as const,
      filename: 'foo.ts',
      lines: ['a'],
      cursor: { row: 0, col: 0 },
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: {
        run: (cmd: string) => { shellRuns.push(cmd) },
        lines: () => ['line'],
      },
      buffers: {
        list: () => [],
        current: () => null,
        switch: () => {},
        kill: () => {},
        next: () => {},
        previous: () => {},
      },
      openFile: () => {},
      commands: { run: async () => {} },
      ui: {
        pick: async () => 'picked',
        input: async () => 'typed',
        confirm: async () => true,
        notify: (message: string) => { notifications.push(message) },
        panel: () => {},
      },
      git: {
        status: () => {},
        stageCurrentFile: () => {},
        stageHunk: () => {},
        previewHunk: () => {},
      },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
      ...overrides,
    },
    shellRuns,
    notifications,
  }
}

describe('createEditorContext', () => {
  it('interactive mode exposes full UI helpers', async () => {
    const { deps } = baseDeps()
    const ctx = createEditorContext(deps)
    assert.equal(await ctx.ui.pick('t', ['a']), 'picked')
    assert.equal(await ctx.ui.input('t'), 'typed')
    assert.equal(await ctx.ui.confirm('t'), true)
    assert.equal(ctx.lastShellRun, null)
  })

  it('hook mode disables prompts but keeps notify and shell', async () => {
    const { deps, shellRuns, notifications } = baseDeps({ mode: 'hook' })
    const ctx = createEditorContext(deps)
    assert.equal(await ctx.ui.pick('t', ['a']), null)
    assert.equal(await ctx.ui.input('t'), null)
    assert.equal(await ctx.ui.confirm('t'), false)
    ctx.ui.panel('shell')
    ctx.shell.run('npm test')
    ctx.ui.notify('hello')
    assert.deepEqual(shellRuns, ['npm test'])
    assert.deepEqual(notifications, ['hello'])
  })

  it('hook mode exposes lastShellRun when provided', () => {
    const run: ShellRun = {
      id: '1',
      command: 'false',
      cwd: '/tmp',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
      exitCode: 1,
      stdout: '',
      stderr: 'err',
      locations: [],
    }
    const { deps } = baseDeps({ mode: 'hook', lastShellRun: run })
    const ctx = createEditorContext(deps)
    assert.equal(ctx.lastShellRun?.command, 'false')
    assert.equal(ctx.lastShellRun?.exitCode, 1)
  })
})
