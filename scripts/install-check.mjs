#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const appEntry = resolve(root, 'app/dist/main.js')
if (!existsSync(appEntry)) fail('Run npm run build first')

const sidecarCandidates = [
  resolve(root, 'native/editor-core/target/release/editor-core'),
  resolve(root, 'native/editor-core/target/debug/editor-core'),
]
if (!sidecarCandidates.some(path => existsSync(path))) fail('Run npm run build:native first')

const rootPackage = readJson(resolve(root, 'package.json'))
const workspaces = rootPackage.workspaces ?? []
if (!workspaces.includes('app') || !workspaces.includes('packages/terminal-react-core')) {
  fail('package.json must include app and packages/terminal-react-core workspaces')
}

const appPackage = readJson(resolve(root, 'app/package.json'))
if (appPackage.dependencies?.['terminal-react-core'] !== 'file:../packages/terminal-react-core') {
  fail('app/package.json must depend on terminal-react-core via file:../packages/terminal-react-core')
}

if (!existsSync(resolve(root, 'bin/qe.mjs'))) fail('missing bin/qe.mjs')

try {
  const resolved = await import.meta.resolve('terminal-react-core')
  if (!resolved.includes('terminal-react-core')) fail('terminal-react-core resolved to an unexpected package')
} catch {
  fail('Run npm install first')
}

const nodePty = resolve(root, 'app/node_modules/node-pty')
if (!existsSync(nodePty)) fail('Run npm install first (missing app/node_modules/node-pty)')

console.log('install check passed')
