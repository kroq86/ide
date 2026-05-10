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
  q: 'quit',    b: 'buffer',  f: 'file/fix', t: 'toggle',
  s: 'save',    k: 'kill',    n: 'next',     p: 'prev',
  N: 'new',     l: 'list',    w: 'save+quit',
  a: 'ai',      c: 'code',   e: 'explain-err',
  g: 'git',     d: 'definition', r: 'refresh',
  h: 'hover',   m: 'mode',
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
  'f s': 'file: save',
  't t': 'terminal: toggle shell',
  't a': 'terminal: toggle AI panel',
  'a p': 'ai: open chat',
  'a c': 'ai: trigger completion',
  'a e': 'ai: explain last error',
  'a f': 'ai: fix failure (CodeClaw)',
  'a t': 'ai: show trace',
  'a l': 'ai: rerun last shell command',
  'a r': 'ai: review git diff (CodeClaw)',
  'g g': 'git: open panel',
  'g s': 'git: stage current',
  'c h': 'code: hover (LSP)',
  'c d': 'code: go to definition',
  'c e': 'config: edit config file',
  'c r': 'config: reload config',
  'm t f': 'mode: test current file',
  'm t a': 'mode: test all',
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
  sidecar: { save(): void },
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
  },
  git: {
    open: () => void
    stage: () => void
  },
  lsp: {
    hover: () => void
    definition: () => void
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
      w: () => { sidecar.save(); buffers.quitAll() },
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
    f: { f: buffers.openFilePrompt, s: () => sidecar.save() },
    t: {
      t: () => setPanel((prev: unknown) => {
        const p = prev as { type?: string } | null
        return p?.type === 'shell' ? null : { type: 'shell' }
      }),
      a: () => setPanel((prev: unknown) => {
        const p = prev as { type?: string } | null
        return p?.type === 'ai' ? null : { type: 'ai', focused: true }
      }),
    },
    a: {
      p: ai.openChat,
      c: ai.triggerCompletion,
      e: ai.explainError,
      f: ai.fixFailure,
      t: ai.showTrace,
      l: ai.rerunLast,
      r: ai.review,
    },
    g: {
      g: git.open,
      s: git.stage,
    },
    c: {
      h: lsp.hover,
      d: lsp.definition,
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
