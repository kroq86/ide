import './env-loader.js'

/** Single source of truth for Ollama defaults (read once at import). */
export const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434'
export const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen2.5-coder:1.5b'
