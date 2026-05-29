import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('config plugins', () => {
  it('merges exported commands from plugin files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-plugins-'))
    const pluginDir = join(root, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'demo.ts'), [
      `export const commands = {`,
      `  'plugin.hello': { type: 'ui.notify', message: 'from plugin' },`,
      `}`,
    ].join('\n'), 'utf8')

    const prev = process.env['QE_PLUGIN_DIR']
    process.env['QE_PLUGIN_DIR'] = pluginDir
    try {
      const { loadPluginCommands } = await import('../src/config-plugins.js')
      const commands = await loadPluginCommands()
      assert.ok(commands['plugin.hello'])
    } finally {
      if (prev === undefined) delete process.env['QE_PLUGIN_DIR']
      else process.env['QE_PLUGIN_DIR'] = prev
    }
  })

  it('collects onStartup actions from plugin files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-plugins-startup-'))
    const pluginDir = join(root, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'hello.ts'), [
      `export const onStartup = () => ({ type: 'ui.splash', title: 'Hi' })`,
    ].join('\n'), 'utf8')

    const prev = process.env['QE_PLUGIN_DIR']
    process.env['QE_PLUGIN_DIR'] = pluginDir
    try {
      const { loadPluginStartupActions } = await import('../src/config-plugins.js')
      const actions = await loadPluginStartupActions()
      assert.equal(actions.length, 1)
      const result = await (actions[0] as () => { type: string; title: string })()
      assert.equal(result.type, 'ui.splash')
      assert.equal(result.title, 'Hi')
    } finally {
      if (prev === undefined) delete process.env['QE_PLUGIN_DIR']
      else process.env['QE_PLUGIN_DIR'] = prev
    }
  })

  it('runs setup(registry) from a default export function', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-plugins-setup-'))
    const pluginDir = join(root, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'setup.ts'), [
      `export default function setup(registry) {`,
      `  registry.register('plugin.setup', 'plugin setup', () => {})`,
      `}`,
    ].join('\n'), 'utf8')

    const prev = process.env['QE_PLUGIN_DIR']
    process.env['QE_PLUGIN_DIR'] = pluginDir
    try {
      const { registerPlugins } = await import('../src/config-plugins.js')
      const { CommandRegistry } = await import('../src/config-runtime.js')
      const registry = new CommandRegistry()
      await registerPlugins(registry)
      assert.ok(registry.has('plugin.setup'))
    } finally {
      if (prev === undefined) delete process.env['QE_PLUGIN_DIR']
      else process.env['QE_PLUGIN_DIR'] = prev
    }
  })
})
