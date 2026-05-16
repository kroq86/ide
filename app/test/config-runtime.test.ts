import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CommandRegistry, registerConfigCommands, runConfigAction } from '../src/config-runtime.ts'
import type { EditorContext } from '../src/config.ts'

function makeCtx(events: string[]): EditorContext {
  return {
    filename: null,
    lines: [],
    cursor: { row: 0, col: 0 },
    save: () => events.push('save'),
    quit: () => events.push('quit'),
    insert: (text) => events.push(`insert:${text}`),
    move: (dir) => events.push(`move:${dir}`),
    shell: {
      run: (cmd) => events.push(`shell:${cmd}`),
      lines: () => [],
    },
    buffers: {
      list: () => [],
      current: () => null,
      switch: (id) => events.push(`buffer:${id}`),
      kill: () => events.push('kill'),
      next: () => events.push('next'),
      previous: () => events.push('previous'),
    },
    openFile: (path, jump) => events.push(`open:${path}:${jump?.row ?? '-'}:${jump?.col ?? '-'}`),
    commands: {
      run: async (id) => { events.push(`ctx-command:${id}`) },
    },
    ui: {
      pick: async () => null,
      input: async () => null,
      confirm: async () => false,
      notify: (message, level = 'info') => events.push(`notify:${level}:${message}`),
      panel: (name) => events.push(`panel:${name}`),
    },
    git: {
      status: () => events.push('git:status'),
      stageCurrentFile: () => events.push('git:stage-file'),
      stageHunk: () => events.push('git:stage-hunk'),
      previewHunk: () => events.push('git:preview-hunk'),
    },
    lsp: {
      hover: () => events.push('lsp:hover'),
      definition: () => events.push('lsp:definition'),
      format: () => events.push('lsp:format'),
    },
    diagnostics: {
      list: () => events.push('diagnostics:list'),
      next: () => events.push('diagnostics:next'),
      line: () => events.push('diagnostics:line'),
    },
  }
}

describe('CommandRegistry', () => {
  it('runs command IDs and passes args', async () => {
    const events: string[] = []
    const ctx = makeCtx(events)
    const registry = new CommandRegistry()
    registry.register('shell.echo', 'echo', (c, args) => c.shell.run(String(args?.command ?? '')))

    await runConfigAction({ command: 'shell.echo', args: { command: 'npm test' } }, ctx, registry)
    assert.deepEqual(events, ['shell:npm test'])
  })

  it('executes directive arrays in order', async () => {
    const events: string[] = []
    const ctx = makeCtx(events)
    const registry = new CommandRegistry()

    await runConfigAction([
      { type: 'shell.run', command: 'npm test' },
      { type: 'panel.open', panel: 'shell' },
      { type: 'editor.insert', text: 'done' },
      { type: 'openFile', path: 'src/main.ts', row: 2, col: 4 },
    ], ctx, registry)

    assert.deepEqual(events, ['shell:npm test', 'panel:shell', 'insert:done', 'open:src/main.ts:2:4'])
  })

  it('reports unknown commands through ctx.ui.notify', async () => {
    const events: string[] = []
    const ctx = makeCtx(events)
    const registry = new CommandRegistry()

    await runConfigAction('missing.command', ctx, registry)
    assert.deepEqual(events, ['notify:error:unknown command: missing.command'])
  })

  it('registers user commands from config', async () => {
    const events: string[] = []
    const ctx = makeCtx(events)
    const registry = new CommandRegistry()
    registerConfigCommands({
      commands: {
        'tasks.test': [
          { type: 'shell.run', command: 'npm test' },
          { type: 'panel.open', panel: 'shell' },
        ],
      },
    }, registry)

    await registry.run('tasks.test', ctx)
    assert.deepEqual(events, ['shell:npm test', 'panel:shell'])
  })
})
