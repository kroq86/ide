import type { AiProvider, ChatMessage, CompleteOptions } from './ai-provider.js'

export class DisabledAiProvider implements AiProvider {
  readonly model = 'disabled'

  setModel(_model: string): void {
    // AI_PROVIDER=none is explicit; model selections do not re-enable network providers.
  }

  async listModels(_signal: AbortSignal): Promise<string[]> {
    return ['disabled']
  }

  async *streamChatMessages(
    _system: string,
    _messages: ChatMessage[],
    _signal: AbortSignal,
  ): AsyncGenerator<string> {
    throw new Error('AI disabled')
  }

  async *streamInlineCompletion(
    _prefix: string,
    _suffix: string,
    _filename: string | null,
    _signal: AbortSignal,
  ): AsyncGenerator<string> {
    throw new Error('AI disabled')
  }

  async complete(
    _system: string,
    _messages: ChatMessage[],
    _options: CompleteOptions,
    _signal: AbortSignal,
  ): Promise<string> {
    throw new Error('AI disabled')
  }
}
