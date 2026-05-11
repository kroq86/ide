import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** When `CODECLAW_TRACE_RAW=1`, CodeClaw writes append-only NDJSON under `.codeclaw/traces/events/` and full Ollama text under `.codeclaw/traces/payloads/` (Codex rollout-trace–style split, TS-sized). */
export function isCodeClawTraceRawEnabled(): boolean {
  const v = process.env['CODECLAW_TRACE_RAW']?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export type CodeClawTraceWorkflow = 'fix' | 'review'

export type CodeClawTraceEventLine = {
  ts: string
  traceId: string
  workflow: CodeClawTraceWorkflow
  kind: string
  payloadRef?: string
  detail?: Record<string, unknown>
}

function tracesRoot(cwd: string): string {
  return join(cwd, '.codeclaw', 'traces')
}

function safeTraceFilePart(traceId: string): string {
  return traceId.replace(/[^\w.-]+/g, '_')
}

/**
 * Append one JSON line to `.codeclaw/traces/events/<traceId>.jsonl`.
 * (`traceId` already ends with `-codeclaw-fix` or `-codeclaw-review` — do not append `workflow` again.)
 * No-op unless `CODECLAW_TRACE_RAW` is enabled.
 */
export function appendCodeClawTraceEvent(
  cwd: string,
  traceId: string,
  workflow: CodeClawTraceWorkflow,
  kind: string,
  extra?: { payloadRef?: string; detail?: Record<string, unknown> },
): void {
  if (!isCodeClawTraceRawEnabled()) return
  const eventsDir = join(tracesRoot(cwd), 'events')
  mkdirSync(eventsDir, { recursive: true })
  const safe = safeTraceFilePart(traceId)
  const path = join(eventsDir, `${safe}.jsonl`)
  const line: CodeClawTraceEventLine = {
    ts: new Date().toISOString(),
    traceId,
    workflow,
    kind,
    ...(extra?.payloadRef ? { payloadRef: extra.payloadRef } : {}),
    ...(extra?.detail && Object.keys(extra.detail).length > 0 ? { detail: extra.detail } : {}),
  }
  appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8')
}

/**
 * Write full raw model text; return repo-relative path for `payloadRef` (under `.codeclaw/traces/`).
 * No-op string return when raw tracing is off (caller should not append payloadRef then — still call only when enabled).
 */
export function writeCodeClawTracePayload(
  cwd: string,
  traceId: string,
  _workflow: CodeClawTraceWorkflow,
  suffix: 'ollama_raw' | 'ollama_error',
  body: string,
): string | null {
  if (!isCodeClawTraceRawEnabled()) return null
  const payloadsDir = join(tracesRoot(cwd), 'payloads')
  mkdirSync(payloadsDir, { recursive: true })
  const safe = safeTraceFilePart(traceId)
  const name = `${safe}-${suffix}.txt`
  const abs = join(payloadsDir, name)
  writeFileSync(abs, body, 'utf8')
  return `payloads/${name}`
}
