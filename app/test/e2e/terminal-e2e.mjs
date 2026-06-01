import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { spawnQe, spawnQeCli, sleep } from './harness.mjs'

const openTerms = new Set()

function tempWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), `qe-e2e-${name}-`))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { root, home, cwd }
}

function launch(args, options) {
  const app = spawnQe(args, options)
  openTerms.add(app)
  return app
}

function launchCli(args, options) {
  const app = spawnQeCli(args, options)
  openTerms.add(app)
  return app
}

afterEach(() => {
  for (const app of openTerms) app.kill()
  openTerms.clear()
})

describe('terminal e2e', () => {
  it('boots through the qe CLI wrapper', async () => {
    const { home, cwd } = tempWorkspace('cli')
    const file = join(cwd, 'cli.ts')
    writeFileSync(file, 'export const launched = true\n')

    const app = launchCli([file], { cwd, home })
    await app.waitForText('cli.ts')
    await app.waitForText('exportconstlaunched')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('boots, renders a file, and quits through leader keys', async () => {
    const { home, cwd } = tempWorkspace('boot')
    const file = join(cwd, 'fixture.ts')
    writeFileSync(file, 'export const value = 42\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('fixture.ts')
    await app.waitForText('exportconstvalue')
    await app.waitForText('NORMAL')

    await app.sendKeys(' qq')
    assert.equal(await app.waitForExit(), 0)
    openTerms.delete(app)
  })

  it('yanks a visual line, pastes it, and saves to disk', async () => {
    const { home, cwd } = tempWorkspace('edit')
    const file = join(cwd, 'edit.txt')
    writeFileSync(file, 'alpha\nbeta\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('alpha')
    await app.sendKeys('V')
    await app.waitForText('y=yank')
    await app.sendKeys('y')
    await app.waitForText('NORMAL')
    await app.sendKeys('p')
    await app.waitForText('alpha', 'render after paste')
    await app.sendKeys(' ')
    await app.waitForText('SPC')
    await app.sendKeys('f')
    await app.waitForText('file:save')
    await app.sendKeys('s')

    const text = await app.waitForFile(file, value => value === 'alpha\nalpha\nbeta\n')
    assert.equal(text, 'alpha\nalpha\nbeta\n')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('shows leader hints and command palette command IDs', async () => {
    const { home, cwd } = tempWorkspace('leader')
    const file = join(cwd, 'leader.ts')
    writeFileSync(file, 'const n = 1\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('leader.ts')
    await app.sendKeys(' ')
    await app.waitForText('leader')
    await app.waitForText('+file/find')
    await app.sendKeys('\x1b')
    await app.waitForText('NORMAL')

    await app.sendKeys(' :')
    await app.waitForText('M-x')
    await app.sendKeys('file.find')
    await app.waitForText('file.find')
    await app.sendKeys('\x1b')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('creates portable starter config files from SPC p e', async () => {
    const { home, cwd } = tempWorkspace('config-create')
    const file = join(cwd, 'src.ts')
    writeFileSync(file, 'const ok = true\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('src.ts')
    await app.sendKeys(' pe')

    const configPath = join(home, '.config/qe/config.ts')
    const apiPath = join(home, '.config/qe/config-api.ts')
    await app.waitForFile(configPath, text => text.includes('defineConfig'))
    const api = await app.waitForFile(apiPath, text => text.includes('export function defineConfig'))
    assert.equal(api.includes('/Users/'), false)
    assert.equal(api.includes('qe-react-editor/app/src'), false)
    await app.waitForText('config.ts')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('runs programmable config leader directives', async () => {
    const { home, cwd } = tempWorkspace('config-command')
    const configDir = join(home, '.config/qe')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config-api.ts'), 'export function defineConfig(config) { return config }\n')
    writeFileSync(join(configDir, 'config.ts'), [
      `import { defineConfig } from './config-api.ts'`,
      `export default defineConfig({`,
      `  leader: { x: { n: [`,
      `    { type: 'ui.notify', message: 'hello e2e' },`,
      `    { type: 'editor.insert', text: 'hello_e2e' },`,
      `  ] } },`,
      `})`,
    ].join('\n'))
    const file = join(cwd, 'config.ts')
    writeFileSync(file, 'const configured = true\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('config.ts')
    await app.sendKeys(' xn')
    await app.waitForText('hello_e2e')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('cancels config prompts and allows later config commands to run', async () => {
    const { home, cwd } = tempWorkspace('prompt')
    const configDir = join(home, '.config/qe')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config-api.ts'), 'export function defineConfig(config) { return config }\n')
    writeFileSync(join(configDir, 'config.ts'), [
      `import { defineConfig } from './config-api.ts'`,
      `export default defineConfig({`,
      `  commands: {`,
      `    'pick.e2e': async (ctx) => {`,
      `      const choice = await ctx.ui.pick('Pick action', ['one', 'two'])`,
      `      return { type: 'ui.notify', message: choice ?? 'cancelled pick' }`,
      `    },`,
      `  },`,
      `  leader: { x: { p: 'pick.e2e', n: { type: 'editor.insert', text: 'after_cancel' } } },`,
      `})`,
    ].join('\n'))
    const file = join(cwd, 'prompt.ts')
    writeFileSync(file, 'const prompt = true\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('prompt.ts')
    await app.sendKeys(' xp')
    await app.waitForText('Pickaction')
    await app.sendKeys('\x1b')
    await app.waitForText('NORMAL')
    await app.sendKeys(' xn')
    await app.waitForText('after_cancel')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('opens the git panel for a modified repo', async () => {
    const { home, cwd } = tempWorkspace('git')
    spawnSync('git', ['init'], { cwd, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' })
    const file = join(cwd, 'tracked.txt')
    writeFileSync(file, 'before\n')
    spawnSync('git', ['add', 'tracked.txt'], { cwd, stdio: 'ignore' })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'ignore' })
    writeFileSync(file, 'before\nafter\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('tracked.txt')
    await app.sendKeys(' gg')
    await app.waitForText('*git*')
    await app.waitForText('tracked.txt')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('boots, edits, saves, and opens git with AI_PROVIDER=none', async () => {
    const { home, cwd } = tempWorkspace('no-ai')
    spawnSync('git', ['init'], { cwd, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' })
    const file = join(cwd, 'no-ai.ts')
    writeFileSync(file, 'const before = true\n')
    spawnSync('git', ['add', 'no-ai.ts'], { cwd, stdio: 'ignore' })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'ignore' })

    const app = launchCli([file], { cwd, home, env: { AI_PROVIDER: 'none' } })
    await app.waitForText('no-ai.ts')
    await app.waitForText(/AI\s*disabled/)
    await app.sendKeys('o')
    await app.sendKeys('const after = true')
    await app.sendKeys('\x1b')
    await app.sendKeys(' fs')
    await app.waitForFile(file, text => text.includes('const after = true'))
    await app.sendKeys(' gg')
    await app.waitForText('*git*')
    await app.waitForText('no-ai.ts')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('opens AI workspace tab via SPC t a and returns to editor on Esc', async () => {
    const { home, cwd } = tempWorkspace('workspace-ai')
    const file = join(cwd, 'tabs.ts')
    writeFileSync(file, 'export const tabs = true\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('tabs.ts')
    await app.sendKeys(' ')
    await app.waitForText('terminal')
    await app.sendKeys('ta')
    await app.waitForText('*AI*')
    await app.sendKeys('\x1b')
    await app.waitForText('NORMAL')
    await app.waitForText('exportconsttabs')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('opens process workspace tab via SPC t p and returns to code on Esc', async () => {
    const { home, cwd } = tempWorkspace('workspace-process')
    const file = join(cwd, 'proc.ts')
    writeFileSync(file, 'export const proc = true\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('proc.ts')
    await app.sendKeys(' ')
    await app.waitForText('terminal')
    await app.sendKeys('tp')
    await app.waitForText('*shell*')
    await app.waitForText('process')
    await app.sendKeys('\x1b')
    await app.waitForText('NORMAL')
    await app.waitForText('exportconstproc')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('cycles workflow tabs with Option+[ (meta or macOS «)', async () => {
    const { home, cwd } = tempWorkspace('tab-cycle')
    const file = join(cwd, 'cycle.ts')
    writeFileSync(file, 'export const cycle = true\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('cycle.ts')
    await app.sendKeys(' tp')
    await app.waitForText('*shell*')
    await app.sendKeys('\u00ab')
    await app.waitForText('exportconstcycle')
    await app.sendKeys(' tp')
    await app.waitForText('*shell*')
    await app.sendKeys('\x1b[')
    await sleep(80)
    await app.waitForText('exportconstcycle')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('toggles shell panel with Ctrl+t and closes it on Esc', async () => {
    const { home, cwd } = tempWorkspace('shell-panel')
    const file = join(cwd, 'shell.ts')
    writeFileSync(file, 'export const shell = true\n')

    const app = launch([file], { cwd, home })
    await app.waitForText('shell.ts')
    await app.sendKeys('\x14')
    await app.waitForText('*shell*')
    await app.waitForText('exportconstshell')
    await app.sendKeys('\x1b')
    await app.waitForText('NORMAL')
    await app.quitQe()
    openTerms.delete(app)
  })

  it('routes hover and definition keys without hanging when LSP is unavailable', async () => {
    const { home, cwd } = tempWorkspace('lsp')
    const file = join(cwd, 'lsp.ts')
    writeFileSync(file, [
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      'add(1, 2)',
      '',
    ].join('\n'))

    const app = launch([file], { cwd, home, timeoutMs: 7000 })
    await app.waitForText('lsp.ts')
    await app.sendKeys('K')
    await sleep(250)
    await app.waitForText(/hover|unavailable/i, 'hover routing result')
    await app.sendKeys('\x1b')
    await app.sendKeys('gd')
    await sleep(250)
    await app.waitForText(/definition|unavailable|lsp\.ts/i, 'definition routing result')
    await app.quitQe()
    openTerms.delete(app)
  })
})
