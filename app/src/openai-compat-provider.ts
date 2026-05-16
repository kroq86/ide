import './env-loader.js'
import type { AiProvider, ChatMessage, CompleteOptions } from './ai-provider.js'
import { debugLog } from './debug-log.js'

const AI_BASE_URL = (process.env['AI_BASE_URL'] ?? 'https://api.openai.com').replace(/\/$/, '')
const AI_API_KEY  = process.env['AI_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? ''
const INITIAL_MODEL = process.env['AI_MODEL'] ?? process.env['OAPENAI_MODEL'] ?? 'gpt-4o-mini'

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (AI_API_KEY) h['Authorization'] = `Bearer ${AI_API_KEY}`
  return h
}

function parseSseLine(line: string): { delta: string; done: boolean } | null {
  const t = line.trim()
  if (!t.startsWith('data:')) return null
  const payload = t.slice(5).trimStart()
  if (payload === '[DONE]') return { delta: '', done: true }
  try {
    const msg = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
    }
    const choice = msg.choices?.[0]
    if (!choice) return null
    const delta = typeof choice.delta?.content === 'string' ? choice.delta.content : ''
    const done = choice.finish_reason != null && choice.finish_reason !== 'null'
    return { delta, done }
  } catch { return null }
}

export class OpenAiCompatProvider implements AiProvider {
  private _model: string = INITIAL_MODEL

  get model(): string { return this._model }
  setModel(m: string): void { this._model = m }

  async listModels(signal: AbortSignal): Promise<string[]> {
    try {
      const res = await fetch(`${AI_BASE_URL}/v1/models`, { headers: authHeaders(), signal })
      if (!res.ok) return [this._model]
      const json = await res.json() as { data?: Array<{ id: string }> }
      return json.data?.map(m => m.id).sort() ?? [this._model]
    } catch { return [this._model] }
  }

  async *streamChatMessages(
    system: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const allMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages

    debugLog('openai', 'chat_begin', {
      model: this._model, base: AI_BASE_URL,
      turns: messages.length, systemChars: system.length,
    })

    let response: Response
    try {
      response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ model: this._model, messages: allMessages, stream: true }),
        signal,
      })
    } catch (err) {
      debugLog('openai', 'chat_fetch_failed', { error: String(err) })
      throw err
    }

    if (!response.ok || !response.body) {
      const text = await response.text()
      debugLog('openai', 'chat_bad_response', { status: response.status, bodyPreview: text.slice(0, 1200) })
      throw new Error(`openai-compat ${response.status}: ${text}`)
    }

    let deltaChunks = 0
    let deltaChars = 0
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of response.body) {
        buf += decoder.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const parsed = parseSseLine(line)
          if (!parsed) continue
          if (parsed.delta) { deltaChunks++; deltaChars += parsed.delta.length; yield parsed.delta }
          if (parsed.done) return
        }
      }
      // flush remaining buffer
      if (buf.trim()) {
        const parsed = parseSseLine(buf)
        if (parsed?.delta) yield parsed.delta
      }
    } finally {
      debugLog('openai', 'chat_stream_end', { deltaChunks, deltaChars })
    }
  }

  async *streamInlineCompletion(
    prefix: string,
    suffix: string,
    filename: string | null,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const system =
      'You are a code autocomplete engine. The user sends a file with a [CURSOR] marker. ' +
      'Reply with ONLY the raw characters that should replace [CURSOR]. ' +
      'No prose, no markdown, no quotes, no explanation, no language tag. ' +
      'Do not repeat the [CURSOR] marker itself.'
    const user =
      `File: ${filename ?? 'untitled'}\n${prefix}[CURSOR]${suffix}\n` +
      '(Output only the text that replaces [CURSOR]; never repeat the marker.)'
    yield* this.streamChatMessages(system, [{ role: 'user', content: user }], signal)
  }

  async complete(
    system: string,
    messages: ChatMessage[],
    options: CompleteOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const allMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages

    const body: Record<string, unknown> = {
      model: this._model,
      messages: allMessages,
      stream: false,
    }
    if (options.temperature !== undefined) body['temperature'] = options.temperature
    if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens
    if (options.format === 'json') body['response_format'] = { type: 'json_object' }

    const response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`openai-compat ${response.status}: ${errBody}`)
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    return payload.choices?.[0]?.message?.content ?? ''
  }
}
