export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

export function logForDebugging(
  _message: string,
  _options: { level: DebugLogLevel } = { level: 'debug' },
): void {}
