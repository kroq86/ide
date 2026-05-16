import type { AiProvider, ChatMessage, CompleteOptions } from './ai-provider.js'
import { OLLAMA_MODEL, OLLAMA_URL } from './ollama-env.js'
import { readOllamaNdjsonLines } from './ollama-ndjson.js'
import { debugLog } from './debug-log.js'

// ── Private copies of Ollama wire-protocol helpers ────────────────────────────
// These mirror the tested exports in ai.ts but live here to keep the dep graph
// acyclic (ai.ts → ai-registry.ts → ollama-provider.ts, never back to ai.ts).

function parseChatLine(line: string): { delta: string; done: boolean } | null {
  const t = line.trim().startsWith('data:') ? line.trim().slice(5).trimStart() : line.trim()
  if (!t) return null
  try {
    const msg = JSON.parse(t) as { message?: { content?: string }; done?: boolean }
    return { delta: typeof msg.message?.content === 'string' ? msg.message.content : '', done: Boolean(msg.done) }
  } catch { return null }
}

function parseGenerateLine(line: string): { delta: string; done: boolean } | null {
  const t = line.trim().startsWith('data:') ? line.trim().slice(5).trimStart() : line.trim()
  if (!t) return null
  try {
    const msg = JSON.parse(t) as { response?: string; done?: boolean }
    return { delta: typeof msg.response === 'string' ? msg.response : '', done: Boolean(msg.done) }
  } catch { return null }
}

const FIM_MODEL_FAMILY_RE = /^(qwen.*coder|deepseek-coder|starcoder|codellama)/i

function modelBase(name: string): string {
  const i = name.indexOf(':')
  return (i >= 0 ? name.slice(0, i) : name).trim()
}

function isFimCapable(name: string): boolean {
  return FIM_MODEL_FAMILY_RE.test(modelBase(name))
}

function useFim(name: string): boolean {
  if (!isFimCapable(name)) return false
  const base = modelBase(name).toLowerCase()
  if (!/^qwen/.test(base) || !base.includes('coder')) return true
  return !/(^|:)1\.5b\b/i.test(name)
}

function buildFim(prefix: string, suffix: string): string {
  return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
}

const FIM_STOPS = [
  '<|endoftext|>', '<|fim_pad|>', '<|fim_prefix|>', '<|fim_suffix|>',
  '<|fim_middle|>', '<|repo_name|>', '<|file_sep|>', '<|im_end|>', '<|im_start|>', '```',
] as const

function keepAliveField(): { keep_alive?: string } {
  const v = process.env['OLLAMA_CODECLAW_KEEP_ALIVE']
  if (v === '') return {}
  return { keep_alive: v ?? '0' }
}

// ── OllamaProvider ────────────────────────────────────────────────────────────

export class OllamaProvider implements AiProvider {
  private _model: string = OLLAMA_MODEL

  get model(): string { return this._model }
  setModel(m: string): void { this._model = m }

  async listModels(signal: AbortSignal): Promise<string[]> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal })
      if (!res.ok) return [this._model]
      const json = await res.json() as { models?: Array<{ name: string }> }
      return json.models?.map(m => m.name) ?? [this._model]
    } catch { return [this._model] }
  }

  async *streamChatMessages(
    system: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    debugLog('ollama', 'ai_chat_begin', {
      model: this._model, url: OLLAMA_URL,
      userTurns: messages.length, systemChars: system.length, aborted: signal.aborted,
    })

    let response: Response
    try {
      response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this._model,
          messages: [{ role: 'system', content: system }, ...messages],
          stream: true,
        }),
        signal,
      })
    } catch (err) {
      debugLog('ollama', 'ai_chat_fetch_failed', { error: String(err) })
      throw err
    }

    if (!response.ok || !response.body) {
      const text = await response.text()
      debugLog('ollama', 'ai_chat_bad_response', { status: response.status, bodyPreview: text.slice(0, 1200) })
      throw new Error(`ollama ${response.status}: ${text}`)
    }

    let deltaChunks = 0
    let deltaChars = 0
    try {
      for await (const line of readOllamaNdjsonLines(response.body)) {
        const parsed = parseChatLine(line)
        if (!parsed) continue
        if (parsed.delta) { deltaChunks++; deltaChars += parsed.delta.length; yield parsed.delta }
        if (parsed.done) return
      }
    } finally {
      debugLog('ollama', 'ai_chat_stream_end', { deltaChunks, deltaChars })
    }
  }

  async *streamInlineCompletion(
    prefix: string,
    suffix: string,
    filename: string | null,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    if (useFim(this._model)) {
      yield* this._streamGenerate(buildFim(prefix, suffix), signal, {
        temperature: 0.2, num_predict: 220, stop: FIM_STOPS,
      })
      return
    }

    const system =
      'You are a code autocomplete engine. The user sends a file with a [CURSOR] marker. ' +
      'Reply with ONLY the raw characters that should replace [CURSOR]. ' +
      'No prose, no markdown, no quotes, no explanation, no language tag. ' +
      'Do not repeat the [CURSOR] marker itself.'
    const user =
      `File: ${filename ?? 'untitled'}\n${prefix}[CURSOR]${suffix}\n` +
      '(Output only the text that replaces [CURSOR]; never repeat the marker.)'

    debugLog('ollama', 'inline_chat_begin', {
      model: this._model, url: OLLAMA_URL,
      systemChars: system.length, userChars: user.length, userTail: user.slice(-160),
    })

    let response: Response
    try {
      response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this._model,
          options: { temperature: 0.2, num_predict: 220 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          stream: true,
        }),
        signal,
      })
    } catch (err) {
      debugLog('ollama', 'inline_chat_fetch_failed', { error: String(err) })
      throw err
    }

    if (!response.ok || !response.body) {
      const text = await response.text()
      debugLog('ollama', 'inline_chat_bad_response', { status: response.status, bodyPreview: text.slice(0, 1200) })
      throw new Error(`ollama ${response.status}: ${text}`)
    }

    let deltaChunks = 0
    let deltaChars = 0
    const rawLineSamples: string[] = []
    try {
      for await (const line of readOllamaNdjsonLines(response.body)) {
        const tr = line.trim()
        if (tr && rawLineSamples.length < 3) rawLineSamples.push(tr.slice(0, 1200))
        const parsed = parseChatLine(line)
        if (!parsed) continue
        if (parsed.delta) { deltaChunks++; deltaChars += parsed.delta.length; yield parsed.delta }
        if (parsed.done) return
      }
    } finally {
      debugLog('ollama', 'inline_chat_stream_end', {
        deltaChunks, deltaChars,
        ...(deltaChunks === 0 ? { rawLineSamples } : {}),
      })
    }
  }

  async complete(
    system: string,
    messages: ChatMessage[],
    options: CompleteOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const numPredict = (() => {
      const v = process.env['OLLAMA_CODECLAW_NUM_PREDICT']?.trim()
      if (v && /^\d+$/.test(v)) return Math.min(8192, Math.max(512, parseInt(v, 10)))
      return 2560
    })()

    const allMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this._model,
        stream: false,
        format: options.format === 'json' ? 'json' : undefined,
        options: {
          temperature: options.temperature ?? 0.05,
          num_predict: options.maxTokens ?? numPredict,
        },
        messages: allMessages,
        ...keepAliveField(),
      }),
      signal,
    })

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`ollama ${response.status}: ${errBody}`)
    }

    const payload = await response.json() as { message?: { content?: string } }
    return payload.message?.content ?? ''
  }

  private async *_streamGenerate(
    prompt: string,
    signal: AbortSignal,
    genOptions: { temperature: number; num_predict: number; stop?: readonly string[] },
  ): AsyncGenerator<string> {
    debugLog('ollama', 'generate_begin', {
      model: this._model, url: OLLAMA_URL,
      promptChars: prompt.length, numPredict: genOptions.num_predict,
    })

    let response: Response
    try {
      response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this._model,
          prompt,
          stream: true,
          options: {
            temperature: genOptions.temperature,
            num_predict: genOptions.num_predict,
            ...(genOptions.stop?.length ? { stop: [...genOptions.stop] } : {}),
          },
        }),
        signal,
      })
    } catch (err) {
      debugLog('ollama', 'generate_fetch_failed', { error: String(err) })
      throw err
    }

    if (!response.ok || !response.body) {
      const text = await response.text()
      debugLog('ollama', 'generate_bad_response', { status: response.status, bodyPreview: text.slice(0, 1200) })
      throw new Error(`ollama ${response.status}: ${text}`)
    }

    let deltaChunks = 0
    let deltaChars = 0
    try {
      for await (const line of readOllamaNdjsonLines(response.body)) {
        const parsed = parseGenerateLine(line)
        if (!parsed) continue
        if (parsed.delta) { deltaChunks++; deltaChars += parsed.delta.length; yield parsed.delta }
        if (parsed.done) return
      }
    } finally {
      debugLog('ollama', 'generate_stream_end', { deltaChunks, deltaChars })
    }
  }
}
