#!/usr/bin/env node
/**
 * Print top contributors from an esbuild --metafile JSON.
 * Usage: node scripts/bundle-report.mjs [path-to-meta.json] [--top N]
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const metaPath = resolve(process.argv[2] ?? 'app/dist/meta.json')
const topArg = process.argv.indexOf('--top')
const topN = topArg === -1 ? 25 : Number.parseInt(process.argv[topArg + 1] ?? '25', 10)

let meta
try {
  meta = JSON.parse(readFileSync(metaPath, 'utf8'))
} catch (err) {
  console.error(`Failed to read metafile: ${metaPath}`)
  console.error(err instanceof Error ? err.message : err)
  console.error('Run: npm run build:analyze --workspace qe-react-editor-app')
  process.exit(1)
}

const inputs = Object.entries(meta.inputs ?? {})
  .map(([file, info]) => ({ file, bytes: info.bytes ?? 0 }))
  .sort((a, b) => b.bytes - a.bytes)

const outputs = Object.entries(meta.outputs ?? {})
const outLine = outputs.map(([file, info]) => `${file}  ${formatBytes(info.bytes ?? 0)}`).join('\n')

function formatBytes(n) {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(2)}mb`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}kb`
  return `${n}b`
}

console.log(`Metafile: ${metaPath}`)
if (outLine) console.log(`\nOutputs:\n${outLine}`)
console.log(`\nTop ${topN} inputs by source size:\n`)
for (const row of inputs.slice(0, topN)) {
  console.log(`  ${formatBytes(row.bytes).padStart(8)}  ${row.file}`)
}
if (inputs.length > topN) {
  const rest = inputs.slice(topN).reduce((sum, r) => sum + r.bytes, 0)
  console.log(`  ${formatBytes(rest).padStart(8)}  … ${inputs.length - topN} more files`)
}
const totalIn = inputs.reduce((sum, r) => sum + r.bytes, 0)
console.log(`\n${'─'.repeat(40)}`)
console.log(`  ${formatBytes(totalIn).padStart(8)}  total input bytes (${inputs.length} files)`)
try {
  const bundleBytes = statSync(resolve(metaPath, '..', 'main.js')).size
  console.log(`  ${formatBytes(bundleBytes).padStart(8)}  dist/main.js on disk`)
} catch {
  /* meta only */
}
