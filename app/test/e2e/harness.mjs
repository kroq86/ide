import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const repoRoot = resolve(appRoot, '..')
export const qeEntry = join(appRoot, 'dist/main.js')
export const qeCli = join(repoRoot, 'bin/qe.mjs')
const bridgePath = join(appRoot, 'test/e2e/pty-bridge.py')

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '')
}

export function spawnQe(args = [], options = {}) {
  assert.ok(existsSync(qeEntry), `Missing ${qeEntry}. Run npm --prefix app run build first.`)
  return spawnCommand(process.execPath, [qeEntry, ...args], options)
}

export function spawnQeCli(args = [], options = {}) {
  assert.ok(existsSync(qeCli), `Missing ${qeCli}.`)
  return spawnCommand(process.execPath, [qeCli, ...args], options)
}

export function spawnCommand(file, args = [], options = {}) {
  const cwd = options.cwd ?? repoRoot
  const home = options.home ?? cwd
  const cols = options.cols ?? 100
  const rows = options.rows ?? 32
  const timeoutMs = options.timeoutMs ?? 5000
  const keys = []
  let raw = ''

  const term = createPtyProcess(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      HOME: home,
      TERM: 'xterm-256color',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  })

  term.onData(chunk => { raw += chunk })

  function clean() {
    return stripAnsi(raw).replace(/\r/g, '')
  }

  async function sendKeys(sequence, delayMs = 60) {
    keys.push(sequence)
    for (const ch of sequence) {
      term.write(ch)
      if (delayMs > 0) await sleep(delayMs)
    }
  }

  function diagnostic(label) {
    const text = clean()
    return [
      label,
      `keys: ${keys.map(JSON.stringify).join(' ')}`,
      '--- screen tail ---',
      text.slice(-3000),
      '--- raw tail ---',
      raw.slice(-1200),
    ].join('\n')
  }

  async function waitForText(pattern, label = String(pattern), waitMs = timeoutMs) {
    const started = Date.now()
    for (;;) {
      const text = clean()
      const ok = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
      if (ok) return text
      if (Date.now() - started > waitMs) throw new Error(diagnostic(`Timed out waiting for ${label}`))
      await sleep(25)
    }
  }

  async function waitForFile(path, predicate = () => true, waitMs = timeoutMs) {
    const started = Date.now()
    for (;;) {
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8')
        if (predicate(text)) return text
      }
      if (Date.now() - started > waitMs) throw new Error(diagnostic(`Timed out waiting for file ${path}`))
      await sleep(25)
    }
  }

  async function waitForExit(waitMs = timeoutMs) {
    const started = Date.now()
    for (;;) {
      if (term.exitCode !== undefined) return term.exitCode
      if (Date.now() - started > waitMs) throw new Error(diagnostic('Timed out waiting for qe exit'))
      await sleep(25)
    }
  }

  async function quitQe() {
    await sendKeys('\x1b')
    await sendKeys(' qq')
    const started = Date.now()
    for (;;) {
      if (term.exitCode !== undefined) return term.exitCode
      if (Date.now() - started > 1000) break
      await sleep(25)
    }
    await sendKeys('\x11')
    await waitForExit()
  }

  function kill() {
    try { term.kill() } catch {}
  }

  return { term, clean, sendKeys, waitForText, waitForFile, waitForExit, quitQe, kill, diagnostic }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createPtyProcess(file, args, options) {
  try {
    return pty.spawn(file, args, options)
  } catch (error) {
    if (!String(error?.message ?? error).includes('posix_spawnp failed')) throw error
    return spawnWithScript(file, args, options)
  }
}

function spawnWithScript(file, args, options) {
  const python = process.env.PYTHON ?? process.env.PYTHON3 ?? 'python3'
  const child = spawn(python, [bridgePath, String(options.cols ?? 100), String(options.rows ?? 32), '--', file, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const dataHandlers = []
  const term = {
    exitCode: undefined,
    onData(handler) {
      dataHandlers.push(handler)
    },
    write(data) {
      child.stdin.write(data)
    },
    kill() {
      child.kill()
    },
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => dataHandlers.forEach(handler => handler(String(chunk))))
  child.stderr.on('data', chunk => dataHandlers.forEach(handler => handler(String(chunk))))
  child.on('exit', code => { term.exitCode = code ?? 0 })
  return term
}
