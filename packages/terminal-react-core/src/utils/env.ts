function detectTerminal(): string | null {
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM
  if (process.env.KITTY_WINDOW_ID) return 'kitty'
  if (process.env.TMUX) return 'tmux'
  if (process.env.WT_SESSION) return 'windows-terminal'
  if (process.env.TERM) return process.env.TERM
  return null
}

export const env = {
  terminal: detectTerminal(),
}
