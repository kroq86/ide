import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { CONFIG_PATHS } from '../src/config.ts'
import { CommandRegistry } from '../src/config-runtime.js'
import {
  evalCurrentFile,
  evalExpression,
  evalRegion,
  evalTypeScriptBody,
  formatEvalValue,
  isConfigFilePath,
  isModuleShapedEvalBody,
  isPluginFilePath,
  wrapEvalExpressionBody,
} from '../src/config-eval.ts'
import { getPluginDir } from '../src/config-plugins.ts'

describe('config eval paths', () => {
  it('detects config and plugin paths', () => {
    assert.equal(isConfigFilePath(CONFIG_PATHS[0]!), true)
    assert.equal(isPluginFilePath(join(getPluginDir(), 'hello.ts')), true)
    assert.equal(isPluginFilePath(join(homedir(), '.config', 'qe', 'config.ts')), false)
  })
})

describe('evalTypeScriptBody', () => {
  it('runs notify directive from expression body', async () => {
    const registry = new CommandRegistry()
    const messages: string[] = []
    const ctx = {
      filename: null,
      lines: [],
      cursor: { row: 0, col: 0 },
      lastShellRun: null,
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: { run: () => {}, lines: () => [] },
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
        pick: async () => null,
        input: async () => null,
        confirm: async () => false,
        notify: (message: string) => { messages.push(message) },
        panel: () => {},
      },
      git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
    }

    const result = await evalTypeScriptBody(
      registry,
      ctx,
      "return { type: 'ui.notify', message: 'eval ok' }",
      'eval expression',
    )
    assert.equal(result.ok, true)
    assert.deepEqual(messages, ['eval ok'])
  })
})

describe('evalCurrentFile plugin', () => {
  it('registers commands from plugin file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-eval-plugin-'))
    const pluginDir = join(root, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'hello.ts'), [
      `export const commands = {`,
      `  'plugin.hello': { type: 'ui.notify', message: 'from disk' },`,
      `}`,
    ].join('\n'), 'utf8')

    const prev = process.env['QE_PLUGIN_DIR']
    process.env['QE_PLUGIN_DIR'] = pluginDir
    try {
      const registry = new CommandRegistry()
      const path = join(pluginDir, 'hello.ts')
      const result = await evalCurrentFile(registry, {
        filename: path,
        lines: [],
        cursor: { row: 0, col: 0 },
        lastShellRun: null,
        save: () => {},
        quit: () => {},
        insert: () => {},
        move: () => {},
        shell: { run: () => {}, lines: () => [] },
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
          pick: async () => null,
          input: async () => null,
          confirm: async () => false,
          notify: () => {},
          panel: () => {},
        },
        git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
        lsp: { hover: () => {}, definition: () => {}, format: () => {} },
        diagnostics: { list: () => {}, next: () => {}, line: () => {} },
      }, path)
      assert.equal(result.kind, 'module')
      assert.equal(result.ok, true)
      assert.ok(registry.has('plugin.hello'))
    } finally {
      if (prev === undefined) delete process.env['QE_PLUGIN_DIR']
      else process.env['QE_PLUGIN_DIR'] = prev
    }
  })

  it('runs onStartup and commands when evaling full plugin file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-eval-plugin-full-'))
    const pluginDir = join(root, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    const path = join(pluginDir, 'hello.ts')
    writeFileSync(path, [
      `export const onStartup = () => ({`,
      `  type: 'ui.splash',`,
      `  title: 'Hello from file!',`,
      `})`,
      `export const commands = {`,
      `  'plugin.hello': { type: 'ui.notify', message: 'from file eval' },`,
      `}`,
    ].join('\n'), 'utf8')

    const prev = process.env['QE_PLUGIN_DIR']
    process.env['QE_PLUGIN_DIR'] = pluginDir
    try {
      const registry = new CommandRegistry()
      const splashes: string[] = []
      const messages: string[] = []
      const ctx = {
        filename: path,
        lines: [],
        cursor: { row: 0, col: 0 },
        lastShellRun: null,
        save: () => {},
        quit: () => {},
        insert: () => {},
        move: () => {},
        shell: { run: () => {}, lines: () => [] },
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
          pick: async () => null,
          input: async () => null,
          confirm: async () => false,
          notify: (message: string) => { messages.push(message) },
          panel: () => {},
          splash: (opts: { title: string }) => { splashes.push(opts.title) },
        },
        git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
        lsp: { hover: () => {}, definition: () => {}, format: () => {} },
        diagnostics: { list: () => {}, next: () => {}, line: () => {} },
      }
      const result = await evalCurrentFile(registry, ctx, path)
      assert.equal(result.kind, 'module')
      assert.equal(result.ok, true)
      assert.match(result.message, /plugin\.hello/)
      assert.match(result.message, /onStartup/)
      assert.deepEqual(splashes, ['Hello from file!'])
      assert.ok(registry.has('plugin.hello'))
    } finally {
      if (prev === undefined) delete process.env['QE_PLUGIN_DIR']
      else process.env['QE_PLUGIN_DIR'] = prev
    }
  })

  it('evaluates unsaved buffer text instead of on-disk plugin file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-eval-buffer-'))
    const pluginDir = join(root, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    const path = join(pluginDir, 'hello.ts')
    writeFileSync(path, [
      `export const commands = {`,
      `  'plugin.hello': { type: 'ui.notify', message: 'from disk' },`,
      `}`,
    ].join('\n'), 'utf8')

    const prev = process.env['QE_PLUGIN_DIR']
    process.env['QE_PLUGIN_DIR'] = pluginDir
    try {
      const registry = new CommandRegistry()
      const bufferLines = [
        `export const commands = {`,
        `  'plugin.hello': () => ({ type: 'ui.notify', message: 'from NEW plugin', level: 'info' }),`,
        `}`,
      ]
      const result = await evalCurrentFile(
        registry,
        {
          filename: path,
          lines: bufferLines,
          cursor: { row: 0, col: 0 },
          lastShellRun: null,
          save: () => {},
          quit: () => {},
          insert: () => {},
          move: () => {},
          shell: { run: () => {}, lines: () => [] },
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
            pick: async () => null,
            input: async () => null,
            confirm: async () => false,
            notify: () => {},
            panel: () => {},
          },
          git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
          lsp: { hover: () => {}, definition: () => {}, format: () => {} },
          diagnostics: { list: () => {}, next: () => {}, line: () => {} },
        },
        path,
        { lines: bufferLines },
      )
      assert.equal(result.kind, 'module')
      assert.equal(result.ok, true)
      assert.deepEqual(result.commandIds, ['plugin.hello'])
      assert.ok(registry.has('plugin.hello'))
    } finally {
      if (prev === undefined) delete process.env['QE_PLUGIN_DIR']
      else process.env['QE_PLUGIN_DIR'] = prev
    }
  })
})

describe('evalRegion', () => {
  function mockCtx(messages: string[] = [], splashes: string[] = []) {
    return {
      filename: null,
      lines: [],
      cursor: { row: 0, col: 0 },
      lastShellRun: null,
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: { run: () => {}, lines: () => [] },
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
        pick: async () => null,
        input: async () => null,
        confirm: async () => false,
        notify: (message: string) => { messages.push(message) },
        panel: () => {},
        splash: (opts: { title: string }) => { splashes.push(opts.title) },
      },
      git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
    }
  }

  it('imports module-shaped selection with export commands', async () => {
    const registry = new CommandRegistry()
    const ctx = mockCtx()
    const body = [
      `export const commands = {`,
      `  'plugin.hello': { type: 'ui.notify', message: 'from selection' },`,
      `}`,
    ].join('\n')
    assert.equal(isModuleShapedEvalBody(body), true)
    const result = await evalRegion(registry, ctx, body)
    assert.equal(result.ok, true)
    assert.ok(registry.has('plugin.hello'))
  })

  it('runs onStartup export from selection', async () => {
    const registry = new CommandRegistry()
    const splashes: string[] = []
    const ctx = mockCtx([], splashes)
    const body = [
      `export const onStartup = () => ({`,
      `  type: 'ui.splash',`,
      `  title: 'Hello from selection!',`,
      `})`,
    ].join('\n')
    const result = await evalRegion(registry, ctx, body)
    assert.equal(result.ok, true)
    assert.match(result.message, /onStartup/)
    assert.deepEqual(splashes, ['Hello from selection!'])
  })

  it('runs expression-shaped selection without export', async () => {
    const registry = new CommandRegistry()
    const messages: string[] = []
    const ctx = mockCtx(messages)
    assert.equal(isModuleShapedEvalBody("ctx.ui.notify('hi')"), false)
    const result = await evalRegion(registry, ctx, "ctx.ui.notify('selection ok')")
    assert.equal(result.ok, true)
    assert.deepEqual(messages, ['selection ok'])
  })
})

describe('evalExpression', () => {
  it('evaluates module-shaped expression with export commands', async () => {
    const registry = new CommandRegistry()
    const messages: string[] = []
    const ctx = {
      filename: null,
      lines: [],
      cursor: { row: 0, col: 0 },
      lastShellRun: null,
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: { run: () => {}, lines: () => [] },
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
        pick: async () => null,
        input: async () => null,
        confirm: async () => false,
        notify: (message: string) => { messages.push(message) },
        panel: () => {},
        splash: () => {},
      },
      git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
    }
    const body = [
      `export const commands = {`,
      `  'plugin.hello': { type: 'ui.notify', message: 'from expression' },`,
      `}`,
    ].join('\n')
    const result = await evalExpression(registry, ctx, body)
    assert.equal(result.ok, true)
    assert.ok(registry.has('plugin.hello'))
    assert.match(result.message, /plugin\.hello/)
  })

  it('prints primitive expression values like Emacs eval-expression', async () => {
    const registry = new CommandRegistry()
    const messages: string[] = []
    const ctx = {
      filename: null,
      lines: [],
      cursor: { row: 0, col: 0 },
      lastShellRun: null,
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: { run: () => {}, lines: () => [] },
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
        pick: async () => null,
        input: async () => null,
        confirm: async () => false,
        notify: (message: string) => { messages.push(message) },
        panel: () => {},
      },
      git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
    }
    const result = await evalExpression(registry, ctx, '1+1')
    assert.equal(result.ok, true)
    assert.equal(result.message, '2')
    assert.deepEqual(messages, ['2'])
  })

  it('wrapEvalExpressionBody treats bare expressions as return values', () => {
    assert.equal(wrapEvalExpressionBody('1+1'), 'return (1+1)')
    assert.equal(wrapEvalExpressionBody('return 3'), 'return 3')
    assert.equal(wrapEvalExpressionBody('ctx.ui.notify("x")'), 'return (ctx.ui.notify("x"))')
    assert.match(
      wrapEvalExpressionBody('((n) => { let a=0,b=1; for (let i=0;i<n;i++) [a,b]=[b,a+b]; return a })(10)'),
      /^return \(\(\(n\)/,
    )
  })

  it('evaluates pasted fib one-liner with semicolons', async () => {
    const registry = new CommandRegistry()
    const messages: string[] = []
    const ctx = {
      filename: null,
      lines: [],
      cursor: { row: 0, col: 0 },
      lastShellRun: null,
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: { run: () => {}, lines: () => [] },
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
        pick: async () => null,
        input: async () => null,
        confirm: async () => false,
        notify: (message: string) => { messages.push(message) },
        panel: () => {},
      },
      git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
    }
    const fib = '((n) => { let a = 0, b = 1; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a })(10)'
    const result = await evalExpression(registry, ctx, fib)
    assert.equal(result.ok, true)
    assert.equal(result.message, '55')
    assert.equal(result.displayed, true)
    assert.deepEqual(messages, ['55'])
  })

  it('formatEvalValue stringifies values for display', () => {
    assert.equal(formatEvalValue(2), '2')
    assert.equal(formatEvalValue(null), 'null')
    assert.equal(formatEvalValue(undefined), 'undefined')
  })

  it('runs ctx.ui.notify side effect from expression body', async () => {
    const registry = new CommandRegistry()
    const messages: string[] = []
    const ctx = {
      filename: null,
      lines: [],
      cursor: { row: 0, col: 0 },
      lastShellRun: null,
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: { run: () => {}, lines: () => [] },
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
        pick: async () => null,
        input: async () => null,
        confirm: async () => false,
        notify: (message: string) => { messages.push(message) },
        panel: () => {},
      },
      git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
    }
    const result = await evalExpression(registry, ctx, "ctx.ui.notify('eval ok')")
    assert.equal(result.ok, true)
    assert.deepEqual(messages, ['eval ok'])
  })

  it('rejects empty body', async () => {
    const registry = new CommandRegistry()
    const ctx = {
      filename: null,
      lines: [],
      cursor: { row: 0, col: 0 },
      lastShellRun: null,
      save: () => {},
      quit: () => {},
      insert: () => {},
      move: () => {},
      shell: { run: () => {}, lines: () => [] },
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
        pick: async () => null,
        input: async () => null,
        confirm: async () => false,
        notify: () => {},
        panel: () => {},
      },
      git: { status: () => {}, stageCurrentFile: () => {}, stageHunk: () => {}, previewHunk: () => {} },
      lsp: { hover: () => {}, definition: () => {}, format: () => {} },
      diagnostics: { list: () => {}, next: () => {}, line: () => {} },
    }
    const result = await evalExpression(registry, ctx, '   ')
    assert.equal(result.ok, false)
  })
})
