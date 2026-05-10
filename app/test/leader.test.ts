import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLeaderMap, flattenLeader, isLeafAction,
  COMMAND_LABELS, NODE_LABELS,
  type LeaderNode, type CmdItem,
} from '../src/leader.ts'
import type { LeaderTree, EditorContext } from '../src/config.ts'

// ── Minimal mocks ─────────────────────────────────────────────────────────────

const noop = () => {}

const mockSidecar = { save: noop }
const mockSetPanel = (_v: unknown) => {}
const mockBufs = {
  openSwitcher: noop, openFilePrompt: noop,
  next: noop, previous: noop, kill: noop, newScratch: noop, quitAll: noop,
}
const mockAi = {
  openChat: noop, triggerCompletion: noop, explainError: noop,
  fixFailure: noop, showTrace: noop, rerunLast: noop, review: noop,
}
const mockGit   = { open: noop, stage: noop }
const mockLsp   = { hover: noop, definition: noop }
const mockCfg   = { open: noop, reload: noop }
const mockMode  = { testFile: noop, testAll: noop }
const emptyLeader: LeaderTree = {}
const makeCtx = (): EditorContext => ({
  filename: null, lines: [], cursor: { row: 0, col: 0 },
  save: noop, quit: noop, insert: noop, move: noop,
  shell: { run: noop, lines: () => [] },
  buffers: { list: () => [], current: () => null, switch: noop, kill: noop, next: noop, previous: noop },
  openFile: noop,
})

function makeMap(overrides: Partial<typeof mockAi & typeof mockBufs> = {}): LeaderNode {
  return buildLeaderMap(
    mockSidecar, mockSetPanel,
    { ...mockBufs, ...overrides },
    { ...mockAi,  ...overrides },
    mockGit, mockLsp, mockCfg, mockMode,
    emptyLeader, makeCtx,
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('isLeafAction', () => {
  it('returns true for functions', () => {
    assert.equal(isLeafAction(() => {}), true)
  })
  it('returns false for objects', () => {
    assert.equal(isLeafAction({ sub: () => {} } as unknown as () => void), false)
  })
})

describe('flattenLeader', () => {
  it('flattens nested nodes into CmdItems', () => {
    const node: LeaderNode = { a: { b: noop, c: noop }, d: noop }
    const items = flattenLeader(node)
    assert.equal(items.length, 3)
    const keys = items.map(i => i.keys)
    assert.ok(keys.includes('SPC a b'))
    assert.ok(keys.includes('SPC a c'))
    assert.ok(keys.includes('SPC d'))
  })

  it('every item action is a callable function', () => {
    const node: LeaderNode = { x: { y: noop }, z: noop }
    const items = flattenLeader(node)
    for (const item of items) {
      assert.equal(typeof item.action, 'function', `action for ${item.keys} is not a function`)
    }
  })

  it('every item keys starts with "SPC "', () => {
    const node: LeaderNode = { a: { b: noop } }
    const items = flattenLeader(node)
    for (const item of items) {
      assert.ok(item.keys.startsWith('SPC '), `${item.keys} does not start with "SPC "`)
    }
  })

  it('uses COMMAND_LABELS when available, falls back to SPC path', () => {
    const items = flattenLeader({ 'q': { 'q': noop } })
    const qq = items.find(i => i.keys === 'SPC q q')
    assert.ok(qq, 'SPC q q not found')
    assert.equal(qq!.label, 'quit')

    // Unknown key should fall back to 'SPC <path>'
    const items2 = flattenLeader({ z: { z: noop } })
    const zz = items2.find(i => i.keys === 'SPC z z')
    assert.ok(zz, 'SPC z z not found')
    assert.equal(zz!.label, 'SPC z z')
  })
})

describe('buildLeaderMap — structure', () => {
  it('produces a non-empty leader node', () => {
    const map = makeMap()
    assert.ok(typeof map === 'object' && map !== null)
    assert.ok(Object.keys(map).length > 0)
  })

  it('every leaf in the full flattened tree is a function', () => {
    const map = makeMap()
    const items = flattenLeader(map)
    assert.ok(items.length > 0, 'no items in flattened leader')
    for (const item of items) {
      assert.equal(
        typeof item.action, 'function',
        `action for "${item.keys}" is ${typeof item.action}, not a function`,
      )
    }
  })

  it('no item action is undefined or null', () => {
    const map = makeMap()
    const items = flattenLeader(map)
    for (const item of items) {
      assert.notEqual(item.action, undefined, `action for "${item.keys}" is undefined`)
      assert.notEqual(item.action, null,      `action for "${item.keys}" is null`)
    }
  })
})

describe('buildLeaderMap — specific key presence', () => {
  const map = makeMap()
  const items = flattenLeader(map)
  const keySet = new Set(items.map(i => i.keys))

  const required = [
    'SPC a p', 'SPC a c', 'SPC a e', 'SPC a f', 'SPC a t', 'SPC a l', 'SPC a r',
    'SPC m t f', 'SPC m t a',
    'SPC g g', 'SPC g s',
    'SPC b b', 'SPC b k', 'SPC b n', 'SPC b p', 'SPC b s', 'SPC b N',
    'SPC f f', 'SPC f s',
    'SPC t t', 'SPC t a',
    'SPC q q', 'SPC q w',
    'SPC c h', 'SPC c d', 'SPC c e', 'SPC c r',
  ]

  for (const key of required) {
    it(`includes ${key}`, () => {
      assert.ok(keySet.has(key), `missing keybinding: ${key}`)
    })
  }

  it('includes SPC : (command palette)', () => {
    assert.ok(':' in map, 'SPC : not in leader map')
    assert.equal(typeof map[':'], 'function')
  })
})

describe('COMMAND_LABELS coverage', () => {
  it('every COMMAND_LABELS entry is a plain string (not a fallback SPC path)', () => {
    for (const [key, label] of Object.entries(COMMAND_LABELS)) {
      assert.ok(
        typeof label === 'string' && label.length > 0,
        `COMMAND_LABELS["${key}"] is empty`,
      )
      // Labels should not be the raw "SPC <key>" fallback format
      assert.notEqual(label, `SPC ${key}`, `COMMAND_LABELS["${key}"] is just the fallback`)
    }
  })

  it('all COMMAND_LABELS keys appear in the flattened builtin leader', () => {
    const map = makeMap()
    const items = flattenLeader(map)
    const keySet = new Set(items.map(i => i.keys))
    for (const key of Object.keys(COMMAND_LABELS)) {
      assert.ok(keySet.has(`SPC ${key}`), `COMMAND_LABELS has "${key}" but no matching keybinding`)
    }
  })
})

describe('NODE_LABELS', () => {
  it('contains expected top-level group names', () => {
    assert.equal(NODE_LABELS['a'], 'ai')
    assert.equal(NODE_LABELS['b'], 'buffer')
    assert.equal(NODE_LABELS['g'], 'git')
    assert.equal(NODE_LABELS['m'], 'mode')
    assert.equal(NODE_LABELS['c'], 'code')
  })
})

describe('userLeader merge', () => {
  it('user leader actions appear in the flattened map', () => {
    let called = false
    const userLeader: LeaderTree = {
      u: { u: () => { called = true } } as LeaderNode,
    }
    const map = buildLeaderMap(
      mockSidecar, mockSetPanel,
      mockBufs, mockAi, mockGit, mockLsp, mockCfg, mockMode,
      userLeader, makeCtx,
    )
    const items = flattenLeader(map)
    const item = items.find(i => i.keys === 'SPC u u')
    assert.ok(item, 'user-defined SPC u u not found in flattened map')
    item!.action()
    assert.ok(called, 'user-defined action was not called')
  })
})
