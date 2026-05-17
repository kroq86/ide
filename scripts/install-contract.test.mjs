import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { spawnCommand } from '../app/test/e2e/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const openTerms = new Set()

afterEach(() => {
  for (const app of openTerms) app.kill()
  openTerms.clear()
})

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180_000,
    stdio: options.stdio ?? 'pipe',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (options.expectSuccess !== false && result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.status}`,
      output.slice(-4000),
    ].join('\n'))
  }
  return { ...result, output }
}

function copyRepo() {
  const root = mkdtempSync(join(tmpdir(), 'qe-install-contract-'))
  const checkout = join(root, 'checkout')
  run('rsync', [
    '-a',
    '--delete',
    '--exclude', '.git',
    '--exclude', 'node_modules',
    '--exclude', 'app/node_modules',
    '--exclude', 'app/dist',
    '--exclude', 'packages/terminal-react-core/node_modules',
    '--exclude', 'native/editor-core/target',
    `${repoRoot}/`,
    `${checkout}/`,
  ])
  return { root, checkout }
}

function installEnv(root) {
  const prefix = join(root, 'npm-global')
  mkdirSync(prefix, { recursive: true })
  return {
    ...process.env,
    NPM_CONFIG_PREFIX: prefix,
    HOME: join(root, 'home'),
    PATH: `${join(prefix, 'bin')}:${process.env.PATH ?? ''}`,
    CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
    AI_PROVIDER: 'none',
  }
}

describe('installability contract', () => {
  it('fresh clone installs, builds, links, launches qe, and reports missing outputs clearly', async () => {
    const { root, checkout } = copyRepo()
    const env = installEnv(root)
    mkdirSync(env.HOME, { recursive: true })
    const fixture = join(checkout, 'fixture.ts')
    writeFileSync(fixture, 'export const installContract = true\n')

    const missingApp = run(process.execPath, ['bin/qe.mjs', fixture], {
      cwd: checkout,
      env,
      expectSuccess: false,
    })
    assert.notEqual(missingApp.status, 0)
    assert.match(missingApp.output, /Run npm run build first/)

    run('npm', ['install'], { cwd: checkout, env, timeoutMs: 240_000 })
    run('npm', ['run', 'build'], { cwd: checkout, env, timeoutMs: 300_000 })
    run('npm', ['link'], { cwd: checkout, env, timeoutMs: 180_000 })
    run('npm', ['run', 'install:check'], { cwd: checkout, env })

    const app = spawnCommand('qe', [fixture], {
      cwd: checkout,
      home: env.HOME,
      env,
      timeoutMs: 10_000,
    })
    openTerms.add(app)
    await app.waitForText('fixture.ts')
    await app.waitForText('exportconstinstallContract')
    await app.waitForText(/AI\s*disabled/)
    await app.quitQe()
    openTerms.delete(app)

    for (const sidecar of [
      join(checkout, 'native/editor-core/target/release/editor-core'),
      join(checkout, 'native/editor-core/target/debug/editor-core'),
    ]) {
      if (existsSync(sidecar)) renameSync(sidecar, `${sidecar}.bak`)
    }

    const missingNative = run('qe', [fixture], {
      cwd: checkout,
      env,
      expectSuccess: false,
    })
    assert.notEqual(missingNative.status, 0)
    assert.match(missingNative.output, /Run npm run build:native first/)
  })
})
