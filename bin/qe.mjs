#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appEntry = resolve(packageRoot, 'app/dist/main.js')
const sidecarCandidates = [
  resolve(packageRoot, 'native/editor-core/target/release/editor-core'),
  resolve(packageRoot, 'native/editor-core/target/debug/editor-core'),
]

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
  console.error('qe requires Node.js 22+')
  process.exit(1)
}

if (!existsSync(appEntry)) {
  console.error('Run npm run build first')
  process.exit(1)
}

if (!sidecarCandidates.some(path => existsSync(path))) {
  console.error('Run npm run build:native first')
  process.exit(1)
}

const result = spawnSync(process.execPath, [appEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`failed to launch qe: ${result.error.message}`)
  process.exit(1)
}

if (result.signal) {
  process.kill(process.pid, result.signal)
}

process.exit(result.status ?? 0)
