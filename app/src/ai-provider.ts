export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export type CompleteOptions = {
  format?: 'json'
  temperature?: number
  maxTokens?: number
}

export interface AiProvider {
  readonly model: string
  setModel(model: string): void
  listModels(signal: AbortSignal): Promise<string[]>

  streamChatMessages(
    system: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<string>

  streamInlineCompletion(
    prefix: string,
    suffix: string,
    filename: string | null,
    signal: AbortSignal,
  ): AsyncGenerator<string>

  complete(
    system: string,
    messages: ChatMessage[],
    options: CompleteOptions,
    signal: AbortSignal,
  ): Promise<string>
}
