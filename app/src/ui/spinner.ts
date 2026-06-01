const THINKING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function thinkingSpinnerGlyph(tick: number): string {
  return THINKING_SPINNER_FRAMES[tick % THINKING_SPINNER_FRAMES.length]!
}

export function thinkingPrefixedLine(tick: number, rest: string): string {
  return `${thinkingSpinnerGlyph(tick)} ${rest}`
}
