import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'

export const DEFAULT_ROOT_MARKERS = [
  '.git',
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'README.md',
] as const

export type RootDetectionInput = {
  filename?: string | null
  cwd?: string
  lspRoot?: string | null
  markers?: readonly string[]
}

function normalizeRoot(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

function hasMarker(dir: string, marker: string): boolean {
  return existsSync(join(dir, marker))
}

function nearestMarkerRoot(startDir: string, markers: readonly string[]): string | null {
  let dir = normalizeRoot(startDir)
  for (;;) {
    if (markers.some(marker => hasMarker(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function detectProjectRoot(input: RootDetectionInput = {}): string {
  const cwd = normalizeRoot(input.cwd ?? process.cwd())
  const filename = input.filename ? normalizeRoot(resolvePath(input.filename)) : null
  const markers = input.markers ?? DEFAULT_ROOT_MARKERS

  if (input.lspRoot) {
    const lspRoot = normalizeRoot(input.lspRoot)
    if (!filename || filename.startsWith(`${lspRoot}/`) || filename === lspRoot) return lspRoot
  }

  const startDir = filename ? dirname(filename) : cwd
  return nearestMarkerRoot(startDir, markers) ?? nearestMarkerRoot(cwd, markers) ?? cwd
}
