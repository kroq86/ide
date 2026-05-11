import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const lines = readFileSync(join(root, 'examples/broken-counter/src/counter.ts'), 'utf8').split(/\r?\n/)
const row = 1
const col = 12 // after '-' before ' b'
const prefix =
  lines.slice(0, row).join('\n') +
  (row > 0 ? '\n' : '') +
  (lines[row]?.slice(0, col) ?? '')
const suffix =
  (lines[row]?.slice(col) ?? '') +
  (row + 1 < lines.length ? '\n' : '') +
  lines.slice(row + 1).join('\n')
const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`

// Default stays 1.5b — ~1GB class; 7B+ needs far more unified memory (avoid on 8GB RAM machines unless you opt in).
const model = process.argv[2] ?? 'qwen2.5-coder:1.5b'
const body = JSON.stringify({
  model,
  prompt,
  stream: false,
  options: {
    temperature: 0.2,
    num_predict: 220,
    stop: ['<|endoftext|>', '<|fim_pad|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '```'],
  },
})

const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const res = await fetch(`${base.replace(/\/$/, '')}/api/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
})
const j = await res.json()
console.log('prefix tail:', JSON.stringify(prefix.slice(-50)))
console.log('suffix head:', JSON.stringify(suffix.slice(0, 80)))
console.log('model:', model)
console.log('middle:', JSON.stringify((j.response ?? '').slice(0, 800)))
