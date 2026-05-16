import './env-loader.js'
import { OllamaProvider } from './ollama-provider.js'
import { OpenAiCompatProvider } from './openai-compat-provider.js'
import type { AiProvider } from './ai-provider.js'

// Both providers are always instantiated so we can query both for model lists.
const _ollama = new OllamaProvider()
const _openai = new OpenAiCompatProvider()

let _active: AiProvider = (() => {
  const v = (process.env['AI_PROVIDER'] ?? 'ollama').toLowerCase()
  return v === 'openai' || v === 'openai-compat' ? _openai : _ollama
})()

export function getActiveProvider(): AiProvider {
  return _active
}

export function isOllamaActive(): boolean {
  return _active === _ollama
}

/** Returns "ollama/model-name" or "openai/model-name". */
export function getProviderLabel(): string {
  return _active === _openai
    ? `openai/${_active.model}`
    : `ollama/${_active.model}`
}

/**
 * Accept prefixed "ollama/..." or "openai/..." model names.
 * Switches the active provider automatically.
 */
export function setActiveModel(prefixed: string): void {
  if (prefixed.startsWith('openai/')) {
    _openai.setModel(prefixed.slice('openai/'.length))
    _active = _openai
  } else if (prefixed.startsWith('ollama/')) {
    _ollama.setModel(prefixed.slice('ollama/'.length))
    _active = _ollama
  } else {
    // No prefix — keep current provider, just update its model.
    _active.setModel(prefixed)
  }
}

/**
 * Returns all models from both providers, Ollama first.
 * Each entry is prefixed: "ollama/qwen2.5-coder:1.5b", "openai/gpt-4o", etc.
 */
export async function listAvailableModels(signal: AbortSignal): Promise<string[]> {
  const [ollamaResult, openaiResult] = await Promise.allSettled([
    _ollama.listModels(signal).then(ms => ms.map(m => `ollama/${m}`)),
    _openai.listModels(signal).then(ms => ms.map(m => `openai/${m}`)),
  ])
  return [
    ...(ollamaResult.status === 'fulfilled' ? ollamaResult.value : []),
    ...(openaiResult.status === 'fulfilled' ? openaiResult.value : []),
  ]
}
