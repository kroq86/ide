#!/usr/bin/env node
/**
 * Creates a distributable tarball for qe.
 *
 * Usage:
 *   node scripts/package.mjs <version> <platform>
 *
 * Examples:
 *   node scripts/package.mjs v0.1.0 darwin-arm64
 *   node scripts/package.mjs v0.1.0 linux-x86_64
 *
 * Output layout inside the tarball:
 *   qe-VERSION-PLATFORM/
 *     bin/qe          shell wrapper (requires node in PATH)
 *     libexec/main.js       esbuild bundle
 *     libexec/editor-core   native Rust binary
 */

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vendorRuntimeDeps } from './vendor-runtime-deps.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]
const platform = process.argv[3]

if (!version || !platform) {
  console.error('Usage: node scripts/package.mjs <version> <platform>')
  console.error('  e.g. node scripts/package.mjs v0.1.0 darwin-arm64')
  process.exit(1)
}

const name = `qe-${version}-${platform}`
const stagingRoot = resolve(root, 'release-staging')
const outDir = resolve(stagingRoot, name)

mkdirSync(`${outDir}/bin`, { recursive: true })
mkdirSync(`${outDir}/libexec`, { recursive: true })

// Shell wrapper — requires node in PATH, finds libexec relative to itself.
const wrapper = [
  '#!/bin/sh',
  'SELF="$(cd "$(dirname "$0")" && pwd)"',
  'LIBEXEC="$SELF/../libexec"',
  '',
  'if ! command -v node >/dev/null 2>&1; then',
  '  echo "qe requires Node.js 22+" >&2; exit 1',
  'fi',
  '',
  'NODE_MAJOR="$(node -e \'process.stdout.write(process.versions.node.split(".")[0])\')"',
  'if [ "${NODE_MAJOR:-0}" -lt 22 ] 2>/dev/null; then',
  '  echo "qe requires Node.js 22+ (current: $(node --version))" >&2; exit 1',
  'fi',
  '',
  'exec node "$LIBEXEC/main.js" "$@"',
].join('\n') + '\n'

writeFileSync(`${outDir}/bin/qe`, wrapper, 'utf8')
chmodSync(`${outDir}/bin/qe`, 0o755)

// App bundle
copyFileSync(resolve(root, 'app/dist/main.js'), `${outDir}/libexec/main.js`)

// Native Node deps (node-pty) — not bundled by esbuild
vendorRuntimeDeps(`${outDir}/libexec`)

// Native binary
copyFileSync(
  resolve(root, 'native/editor-core/target/release/editor-core'),
  `${outDir}/libexec/editor-core`,
)
chmodSync(`${outDir}/libexec/editor-core`, 0o755)

// Strip native binary on Linux to reduce size
if (platform.startsWith('linux')) {
  try {
    execSync(`strip "${outDir}/libexec/editor-core"`, { stdio: 'inherit' })
  } catch {
    // strip may not be available; non-fatal
  }
}

// Create tarball at repo root
const tarball = `${name}.tar.gz`
execSync(`tar -czf "${resolve(root, tarball)}" -C "${stagingRoot}" "${name}"`, {
  cwd: root,
  stdio: 'inherit',
})

console.log(`Created: ${tarball}`)
