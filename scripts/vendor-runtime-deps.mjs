#!/usr/bin/env node
/**
 * Copy native/runtime npm deps next to libexec/main.js for packaged tarballs.
 * esbuild leaves createRequire('node-pty') as a runtime require.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function vendorRuntimeDeps(libexecDir) {
  const sources = [
    resolve(root, 'app/node_modules/node-pty'),
    resolve(root, 'node_modules/node-pty'),
  ]
  const src = sources.find(path => existsSync(path))
  if (!src) {
    throw new Error(
      'node-pty not found. Run npm install at the repo root before packaging.',
    )
  }

  const dest = resolve(libexecDir, 'node_modules/node-pty')
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  return dest
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const libexec = process.argv[2]
  if (!libexec) {
    console.error('Usage: node scripts/vendor-runtime-deps.mjs <libexec-dir>')
    process.exit(1)
  }
  const dest = vendorRuntimeDeps(libexec)
  console.log(`Vendored node-pty -> ${dest}`)
}
