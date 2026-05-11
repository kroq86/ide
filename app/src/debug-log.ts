/**
 * File debug logging (JSON Lines). Opt-in — does nothing unless enabled.
 *
 * Enable:
 *   QE_DEBUG=1              → writes to `<git-worktree-root>/.qe/qe-debug.log`
 *                             (running from `app/` still logs at repo root — not under `app/.qe/`)
 *   npm run dev:debug -- <file>  → build + run with QE_DEBUG=1 (macOS/Linux)
 *   QE_DEBUG_LOG=/abs/path  → writes to that file (relative paths resolved from cwd)
 * Disable explicitly:       QE_DEBUG=0 (and no QE_DEBUG_LOG)
 *
 * Non-git cwd: falls back to `<cwd>/.qe/qe-debug.log`.
 *
 * `*.log` is gitignored in this repo; `.qe/` may appear locally.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getGitRepoRoot } from './git.js'

let resolvedPath: string | null | undefined
let writeErrorLogged = false

function defaultQeDebugLogPath(): string {
  const root = getGitRepoRoot(process.cwd())
  return join(root, '.qe', 'qe-debug.log')
}

function resolveLogFilePath(): string | null {
  const explicit = process.env['QE_DEBUG_LOG']?.trim()
  if (explicit === '0' || explicit === 'false') return null
  if (explicit) {
    if (explicit.startsWith('/') || /^[A-Za-z]:[\\/]/.test(explicit)) return explicit
    return resolve(process.cwd(), explicit)
  }
  const flag = process.env['QE_DEBUG']?.trim().toLowerCase()
  if (flag === '1' || flag === 'true' || flag === 'yes')
    return defaultQeDebugLogPath()
  return null
}

export function getDebugLogPath(): string | null {
  if (resolvedPath !== undefined) return resolvedPath
  resolvedPath = resolveLogFilePath()
  return resolvedPath
}

/** Reset cached path (tests only). */
export function resetDebugLogPathForTests(): void {
  resolvedPath = undefined
}

type DebugExtra = Record<string, unknown>

export function debugLog(scope: string, message: string, extra?: DebugExtra): void {
  const path = getDebugLogPath()
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const rec: Record<string, unknown> = {
      ts: new Date().toISOString(),
      scope,
      message,
    }
    if (extra && Object.keys(extra).length) Object.assign(rec, extra)
    appendFileSync(path, `${JSON.stringify(rec)}\n`, 'utf8')
  } catch (err) {
    /* never break the editor — surface once so QE_DEBUG isn't a silent no-op */
    if (!writeErrorLogged) {
      writeErrorLogged = true
      console.error('[qe-debug] failed to write log file:', path, err)
    }
  }
}
