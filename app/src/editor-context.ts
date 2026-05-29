import type { BufferInfo, ConfigNotifyLevel, ConfigPanelName, ConfigPickItem, EditorContext } from './config.js'
import type { ShellRun } from './shell.js'

export type EditorContextMode = 'interactive' | 'hook'

export type EditorContextUi = {
  pick: (title: string, items: ConfigPickItem[]) => Promise<string | null>
  input: (title: string, initial?: string) => Promise<string | null>
  confirm: (title: string, body?: string) => Promise<boolean>
  notify: (message: string, level?: ConfigNotifyLevel) => void
  panel: (name: ConfigPanelName, options?: Record<string, unknown>) => void
  splash: (options: { title: string; message?: string; hint?: string }) => void
}

export type EditorContextGit = {
  status: () => void
  stageCurrentFile: () => void
  stageHunk: () => void
  previewHunk: () => void
}

export type EditorContextDiagnostics = {
  list: () => void
  next: () => void
  line: () => void
}

export type EditorContextLsp = {
  hover: () => void
  definition: () => void
  format: () => void
}

export type EditorContextDeps = {
  mode: EditorContextMode
  filename: string | null
  lines: string[]
  cursor: { row: number; col: number }
  save: () => void
  quit: () => void
  insert: (text: string) => void
  move: (dir: string) => void
  shell: { run: (cmd: string) => void; lines: () => string[] }
  buffers: EditorContext['buffers']
  openFile: (path: string, jump?: { row: number; col: number }) => void
  commands: { run: (id: string, args?: Record<string, unknown>) => Promise<void> }
  ui: EditorContextUi
  git: EditorContextGit
  lsp: EditorContextLsp
  diagnostics: EditorContextDiagnostics
  lastShellRun?: ShellRun | null
}

const HOOK_UI: EditorContextUi = {
  pick: async () => null,
  input: async () => null,
  confirm: async () => false,
  notify: () => {},
  panel: () => {},
  splash: () => {},
}

export function createEditorContext(deps: EditorContextDeps): EditorContext {
  const ui = deps.mode === 'interactive'
    ? deps.ui
    : {
        ...HOOK_UI,
        notify: deps.ui.notify,
      }

  return {
    filename: deps.filename,
    lines: deps.lines,
    cursor: deps.cursor,
    save: deps.save,
    quit: deps.quit,
    insert: deps.insert,
    move: deps.move,
    shell: deps.shell,
    buffers: deps.buffers,
    openFile: deps.openFile,
    commands: deps.commands,
    ui,
    git: deps.git,
    lsp: deps.lsp,
    diagnostics: deps.diagnostics,
    lastShellRun: deps.lastShellRun ?? null,
  }
}

export function hookUiStubs(notify: EditorContextUi['notify']): EditorContextUi {
  return { ...HOOK_UI, notify }
}
