import { spawnSync } from 'node:child_process'

export function readClipboardText(): string | null {
  const commands =
    process.platform === 'darwin'
      ? [['pbpaste']]
      : process.platform === 'win32'
        ? [['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw']]
        : [['wl-paste'], ['xclip', '-selection', 'clipboard', '-o'], ['xsel', '--clipboard', '--output']]

  for (const command of commands) {
    const result = spawnSync(command[0]!, command.slice(1), {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout
  }
  return null
}

export function normalizePromptPaste(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function promptPasteText(input: string): boolean {
  return input.length > 0 && /^[\x09\x0a\x20-\x7e]+$/.test(input)
}
