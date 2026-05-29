import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  CONFIG_API_DIRECTIVE_TYPES,
  CONFIG_API_EXTRA_NAMES,
  CONFIG_API_HOOK_NAMES,
  CONFIG_API_PANEL_NAMES,
  configApiTemplate,
  starterConfigTemplate,
} from '../src/config-api-template.ts'

describe('generated config-api.ts template', () => {
  it('has no absolute local paths', () => {
    const text = `${configApiTemplate()}\n${starterConfigTemplate()}`
    assert.equal(text.includes('/Users/'), false)
    assert.equal(text.includes('qe-react-editor/app/src'), false)
    assert.equal(text.includes('file:///'), false)
  })

  it('contains the public config unions and defineConfig export', () => {
    const text = configApiTemplate()
    for (const name of CONFIG_API_DIRECTIVE_TYPES) assert.ok(text.includes(`'${name}'`), `missing directive ${name}`)
    for (const name of CONFIG_API_PANEL_NAMES) assert.ok(text.includes(`'${name}'`), `missing panel ${name}`)
    for (const name of CONFIG_API_EXTRA_NAMES) assert.ok(text.includes(`'${name}'`), `missing extra ${name}`)
    for (const name of CONFIG_API_HOOK_NAMES) assert.ok(text.includes(`${name}?: ConfigAction`), `missing hook ${name}`)
    assert.ok(text.includes('export function defineConfig'), 'missing defineConfig export')
  })

  it('loads a sample config.ts through tsx using ./config-api.ts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qe-config-api-template-'))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'config-api.ts'), `${configApiTemplate()}\n`, 'utf8')
    writeFileSync(join(root, 'config.ts'), [
      `import { defineConfig } from './config-api.ts'`,
      `export default defineConfig({`,
      `  preset: 'web',`,
      `  extras: ['typescript', 'git'],`,
      `  hooks: { onChange: { type: 'ui.notify', message: 'changed' } },`,
      `  leader: { g: { s: 'git.status' } },`,
      `})`,
    ].join('\n'), 'utf8')

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url'
      import { tsImport } from 'tsx/esm/api'
      const mod = await tsImport(pathToFileURL(${JSON.stringify(join(root, 'config.ts'))}).href, import.meta.url)
      const value = mod.default && 'default' in mod.default ? mod.default.default : mod.default
      if (value?.preset !== 'web') process.exit(2)
    `], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  })
})
