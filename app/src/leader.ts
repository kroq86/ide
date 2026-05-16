import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { mergeLeaderTree, type LeaderTree, type EditorContext } from './config.js'

// Internal leader node: leaves are plain () => void (no EditorContext arg).
// The config-level LeaderTree (with ctx arg) is merged in via mergeLeaderTree.
export interface LeaderNode {
  [key: string]: (() => void) | LeaderNode
}

export type CmdItem = { label: string; keys: string; action: () => void }

// Repo root resolved at module load — same calculation as protocol.ts so that
// relative snapshot filenames (which are relative to the repo root) resolve correctly.
export const REPO_ROOT: string = (() => {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '../..')
  } catch {
    return process.cwd()
  }
})()

export function isLeafAction(v: (() => void) | LeaderNode): v is () => void {
  return typeof v === 'function'
}

export const NODE_LABELS: Record<string, string> = {
  q: 'quit/session', b: 'buffer',  f: 'file/find', t: 'terminal',
  s: 'save',    k: 'kill',    n: 'next',     p: 'parameters',
  N: 'new',     l: 'list',    w: 'save+quit',
  a: 'ai',      c: 'code',   e: 'explain-err',
  g: 'git',     d: 'definition', r: 'refresh',
  h: 'hover',   m: 'mode',    x: 'diagnostics/quickfix',
  u: 'ui/toggle',
  o: 'open',
}

export const COMMAND_LABELS: Record<string, string> = {
  'q q': 'quit',
  'q w': 'save and quit',
  'b b': 'buffer: switch',
  'b l': 'buffer: list',
  'b k': 'buffer: kill',
  'b n': 'buffer: next',
  'b p': 'buffer: previous',
  'b s': 'buffer: save',
  'b N': 'buffer: new scratch',
  'f f': 'file: open',
  'f n': 'file: new scratch',
  'f s': 'file: save',
  't t': 'terminal: toggle shell',
  't a': 'terminal: toggle AI panel',
  't r': 'terminal: rerun last command',
  'a p': 'ai: open chat',
  'a c': 'ai: trigger completion',
  'a e': 'ai: explain last error',
  'a f': 'ai: fix failure (CodeClaw)',
  'a t': 'ai: show trace',
  'a l': 'ai: rerun last shell command',
  'a r': 'ai: review git diff (CodeClaw)',
  'a k': 'ai: clear chat',
  'a m': 'ai: select model',
  'g g': 'git: status — ll commit log (Magit)',
  'g s': 'git: stage current',
  'g h n': 'git: next hunk',
  'g h p': 'git: previous hunk',
  'g h s': 'git: stage hunk',
  'g h u': 'git: unstage hunk',
  'g h v': 'git: preview hunk',
  'g b': 'git: blame line',
  'g l': 'git: log',
  'g f': 'git: current file history',
  'c h': 'code: hover (LSP)',
  'c d': 'code: go to definition',
  'c r': 'code: references',
  'c R': 'code: rename',
  'c a': 'code: action',
  'c f': 'code: format',
  'c i': 'code: toggle inlay hints',
  's s': 'search: buffer',
  's r': 'search: replace',
  'x x': 'diagnostics: list',
  'x b': 'diagnostics: buffer',
  'x d': 'diagnostics: line',
  'x n': 'diagnostics: next',
  'x p': 'diagnostics: previous',
  'x e': 'diagnostics: next error',
  'x w': 'diagnostics: next warning',
  'u h': 'ui: toggle inlay hints',
  'u w': 'ui: toggle wrap',
  'u d': 'ui: toggle diagnostics',
  'p e': 'config: edit config file',
  'p r': 'config: reload config',
  'm t f': 'mode: test current file',
  'm t a': 'mode: test all',
  ':': 'command palette',
}

/**
 * Label shown in the which-key panel for one key. Uses COMMAND_LABELS with the full
 * sequence (e.g. `a f`) so leaves match reality; NODE_LABELS alone is wrong under nested menus.
 */
export function whichKeyDesc(parentPath: string, key: string, val: (() => void) | LeaderNode): string {
  const parent = parentPath.trimEnd().trim()
  const cmdPath = parent ? `${parent} ${key}` : key
  if (isLeafAction(val)) {
    return COMMAND_LABELS[cmdPath] ?? NODE_LABELS[key] ?? key
  }
  return `+${NODE_LABELS[key] ?? key}`
}

export function flattenLeader(node: LeaderNode, prefix = ''): CmdItem[] {
  const items: CmdItem[] = []
  for (const [key, val] of Object.entries(node)) {
    const path = prefix ? `${prefix} ${key}` : key
    if (isLeafAction(val)) {
      const label = COMMAND_LABELS[path] ?? `SPC ${path}`
      items.push({ label, keys: `SPC ${path}`, action: val })
    } else {
      items.push(...flattenLeader(val as LeaderNode, path))
    }
  }
  return items
}

// setPanel is typed as (v: unknown) => void so that leader.ts has no dependency
// on the Panel union type (which references git types in main.tsx).
export function buildLeaderMap(
  sidecar: { save(): void; saveAndQuit(): void },
  setPanel: (v: unknown) => void,
  buffers: {
    openSwitcher: () => void
    openFilePrompt: () => void
    next: () => void
    previous: () => void
    kill: () => void
    newScratch: () => void
    quitAll: () => void
  },
  ai: {
    openChat: () => void
    triggerCompletion: () => void
    explainError: () => void
    fixFailure: () => void
    showTrace: () => void
    rerunLast: () => void
    review: () => void
    clearChat: () => void
    selectModel: () => void
  },
  git: {
    open: () => void
    stage: () => void
    log: () => void
    nextHunk: () => void
    previousHunk: () => void
    stageHunk: () => void
    unstageHunk: () => void
    previewHunk: () => void
    blameLine: () => void
    fileHistory: () => void
  },
  lsp: {
    hover: () => void
    definition: () => void
    references: () => void
    rename: () => void
    codeAction: () => void
    format: () => void
    toggleInlayHints: () => void
  },
  diagnostics: {
    list: () => void
    buffer: () => void
    line: () => void
    next: () => void
    previous: () => void
    nextError: () => void
    nextWarning: () => void
    toggle: () => void
  },
  search: {
    buffer: () => void
    replace: () => void
  },
  ui: {
    toggleWrap: () => void
  },
  config: {
    open: () => void
    reload: () => void
  },
  mode: {
    testFile: () => void
    testAll: () => void
  },
  userLeader: LeaderTree,
  makeCtx: () => EditorContext,
): LeaderNode {
  const builtin: LeaderNode = {
    q: {
      q: buffers.quitAll,
      w: () => { sidecar.saveAndQuit() },
    },
    b: {
      b: buffers.openSwitcher,
      l: buffers.openSwitcher,
      k: buffers.kill,
      n: buffers.next,
      p: buffers.previous,
      s: () => sidecar.save(),
      N: buffers.newScratch,
    },
    f: { f: buffers.openFilePrompt, n: buffers.newScratch, s: () => sidecar.save() },
    t: {
      t: () => setPanel((prev: unknown) => {
        const p = prev as { type?: string } | null
        return p?.type === 'shell' ? null : { type: 'shell' }
      }),
      a: () => setPanel((prev: unknown) => {
        const p = prev as { type?: string } | null
        return p?.type === 'ai' ? null : { type: 'ai', focused: true }
      }),
      r: ai.rerunLast,
    },
    a: {
      p: ai.openChat,
      c: ai.triggerCompletion,
      e: ai.explainError,
      f: ai.fixFailure,
      t: ai.showTrace,
      l: ai.rerunLast,
      r: ai.review,
      k: ai.clearChat,
      m: ai.selectModel,
    },
    g: {
      g: git.open,
      s: git.stage,
      h: {
        n: git.nextHunk,
        p: git.previousHunk,
        s: git.stageHunk,
        u: git.unstageHunk,
        v: git.previewHunk,
      },
      b: git.blameLine,
      l: git.log,
      f: git.fileHistory,
    },
    c: {
      h: lsp.hover,
      d: lsp.definition,
      r: lsp.references,
      R: lsp.rename,
      a: lsp.codeAction,
      f: lsp.format,
      i: lsp.toggleInlayHints,
    },
    s: {
      s: search.buffer,
      r: search.replace,
    },
    x: {
      x: diagnostics.list,
      b: diagnostics.buffer,
      d: diagnostics.line,
      n: diagnostics.next,
      p: diagnostics.previous,
      e: diagnostics.nextError,
      w: diagnostics.nextWarning,
    },
    u: {
      h: lsp.toggleInlayHints,
      w: ui.toggleWrap,
      d: diagnostics.toggle,
    },
    p: {
      e: config.open,
      r: config.reload,
    },
    m: {
      t: {
        f: mode.testFile,
        a: mode.testAll,
      },
    },
  }
  const tree = mergeLeaderTree(builtin, userLeader, makeCtx) as LeaderNode
  ;(tree as LeaderNode)[':'] = () => {
    setPanel({ type: 'cmdpalette', query: '', cursor: 0, items: flattenLeader(tree) })
  }
  return tree
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Walk up from filePath (or root) looking for a package.json with a test script.
// root defaults to REPO_ROOT but can be overridden for testing.
export function findNearestTestScript(filePath: string | null, root = REPO_ROOT): string | null {
  let dir = filePath
    ? dirname(isAbsolute(filePath) ? filePath : join(root, filePath))
    : root
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
        if (scripts['test']) return 'npm test'
        const key = Object.keys(scripts).find(k => k.startsWith('test'))
        if (key) return `npm run ${key}`
      } catch { /* skip malformed */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function extractFirstCodeBlock(text: string): string | null {
  const m = text.match(/```(?:\w+\n|\n)?([\s\S]*?)```/)
  const cmd = m?.[1]?.trim()
  return cmd && cmd.length > 0 ? cmd : null
}

export type ParsedLocationLike = { file: string; row: number; col: number; message: string }

export function extractFirstLocation(text: string): ParsedLocationLike | null {
  const bt = text.match(/`([^`\s]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|c|cpp|h|rb|java)):(\d+)(?::(\d+))?`/)
  if (bt) return { file: bt[1]!, row: +bt[2]! - 1, col: bt[3] ? +bt[3] - 1 : 0, message: '' }
  const bare = text.match(/\b([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|c|cpp|h|rb|java)):(\d+)(?::(\d+))?/)
  if (bare) return { file: bare[1]!, row: +bare[2]! - 1, col: bare[3] ? +bare[3] - 1 : 0, message: '' }
  return null
}

export function printable(input: string): boolean {
  return input.length === 1 && input >= ' ' && input <= '~'
}

export function printableText(input: string): boolean {
  return input.length > 0 && /^[\x20-\x7e]+$/.test(input)
}

export function bufferName(filename: string | null): string {
  return filename ? basename(filename) : '*scratch*'
}
