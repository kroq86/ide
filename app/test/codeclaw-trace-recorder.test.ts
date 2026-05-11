import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCodeClawTraceEvent,
  isCodeClawTraceRawEnabled,
  writeCodeClawTracePayload,
} from '../src/codeclaw-trace-recorder.ts'

const dir = mkdtempSync(join(tmpdir(), 'cc-tr-'))
const cwd = join(dir, 'proj')
const traceId = '2026-05-11T12-00-00-codeclaw-fix'

function withRaw<T>(fn: () => T): T {
  const prev = process.env['CODECLAW_TRACE_RAW']
  process.env['CODECLAW_TRACE_RAW'] = '1'
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env['CODECLAW_TRACE_RAW']
    else process.env['CODECLAW_TRACE_RAW'] = prev
  }
}

assert.equal(isCodeClawTraceRawEnabled(), false)

withRaw(() => {
  assert.ok(isCodeClawTraceRawEnabled())
  const ref = writeCodeClawTracePayload(cwd, traceId, 'fix', 'ollama_raw', 'model output here')
  assert.equal(ref, `payloads/${traceId}-ollama_raw.txt`)
  const payloadPath = join(cwd, '.codeclaw', 'traces', ref!)
  assert.ok(existsSync(payloadPath))
  assert.equal(readFileSync(payloadPath, 'utf8'), 'model output here')

  appendCodeClawTraceEvent(cwd, traceId, 'fix', 'ollama_response', { payloadRef: ref!, detail: { rawChars: 17 } })
  appendCodeClawTraceEvent(cwd, traceId, 'fix', 'parse_ok', { detail: { fileCount: 1 } })

  const eventsPath = join(cwd, '.codeclaw', 'traces', 'events', `${traceId}.jsonl`)
  assert.ok(existsSync(eventsPath))
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const e0 = JSON.parse(lines[0]!) as { kind: string; payloadRef?: string; traceId: string }
  assert.equal(e0.kind, 'ollama_response')
  assert.equal(e0.payloadRef, ref)
  assert.equal(e0.traceId, traceId)
})

rmSync(dir, { recursive: true, force: true })
