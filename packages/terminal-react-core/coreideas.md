## Product Definition

Build a standalone TypeScript package called `terminal-react-core`.

It is a React-based terminal rendering core for building TUI applications.
It is not a complete end-user product.
It is infrastructure for building terminal apps that need:

- React component composition
- state-driven rendering
- flexbox-style layout
- keyboard input
- mouse and focus events
- fullscreen / alternate-screen behavior
- styled terminal output
- reusable terminal-native UI primitives

The package should:

- expose a clean top-level API from `src/index.ts`
- build to `dist/` as ESM with declarations
- include a small but useful `demo/` app
- be usable under normal Node/npm workflows
- not depend on a larger proprietary app shell

---

## Non-Goals

Do not build:

- a browser app
- a web UI abstraction
- a one-shot CLI helper library
- a batteries-included product with auth, network sync, analytics, or backend APIs
- a thin ANSI string utility only

This repo is specifically for terminal UI runtime and component infrastructure.

---

## Core Architecture

At a high level, the system should look like this:

1. User writes React components like `Box`, `Text`, `Button`.
2. React reconciler builds a custom terminal DOM tree.
3. Layout is computed using a Yoga-based layout engine.
4. Render tree is converted into terminal screen output.
5. Input from stdin is parsed into semantic events.
6. Events update state and trigger re-render.

---

## Cross-Layer Mapping (Use Everywhere)

Use this explanation format for every technical topic in this prep:

1. Idea level - what problem it solves.
2. Language/API level - what engineers write/use.
3. Planner/runtime level - how system decides and executes.
4. Storage/data-structure level - how data is represented.
5. OS/hardware level - what CPU, memory, I/O do.
6. Complexity/perf level - big-O and real bottlenecks.
7. One-liner - 1 sentence final summary.

---

## Topic 1: Public Package Shape

### 1. Idea level

The package must feel like a standalone terminal UI core, not an extracted internal folder dump.
Users need a clear import surface and a normal build artifact.

### 2. Language/API level

Expose from `src/index.ts`:

- root functions like `render`, `renderSync`, `createRoot`
- main primitives like `Box`, `Text`, `Button`, `Link`
- useful hooks like `useInput`, `useStdin`, `useTerminalFocus`, `useInterval`
- supporting types

`package.json` should point `main`, `module`, `types`, and `exports` to `dist/`.

### 3. Planner/runtime level

The package build step should compile source to distributable output.
Consumers should import from the package root, not deep internal paths.

### 4. Storage/data-structure level

Representation is file- and module-based:

- `src/index.ts` as canonical export surface
- `dist/index.js`
- `dist/index.d.ts`

### 5. OS/hardware level

The OS reads compiled JS files from disk.
Node resolves the package entry and loads modules into process memory.

### 6. Complexity/perf level

Module resolution cost is basically startup overhead.
Biggest risk is not asymptotic cost but broken packaging, unstable exports, or accidental deep-import dependence.

### 7. One-liner

The public package shape turns a renderer codebase into a usable library.

---

## Topic 2: Custom React Terminal Renderer

### 1. Idea level

The central problem is: terminal apps need declarative UI composition, but React does not target terminals out of the box.
A custom renderer solves that.

### 2. Language/API level

Engineers write normal React trees:

```tsx
<Box flexDirection="column">
  <Text>Hello</Text>
</Box>
```

They call `render(<App />)`.

### 3. Planner/runtime level

React reconciliation turns component output into host instances.
The renderer must:

- create host nodes
- diff props
- append/remove children
- update text
- trigger layout recalculation
- commit to terminal output

### 4. Storage/data-structure level

Need a custom internal DOM-like tree:

- root node
- element nodes like `ink-box`, `ink-text`, `ink-link`
- text nodes
- style fields
- event handler references
- optional Yoga node references

### 5. OS/hardware level

CPU executes reconciliation and diff logic.
Memory stores the host tree and layout graph.
Terminal output eventually becomes writes to stdout.

### 6. Complexity/perf level

Typical React reconciliation is roughly proportional to changed subtree size.
Real bottlenecks are:

- large tree updates
- layout recalculation
- text measurement
- terminal repaint cost

### 7. One-liner

A custom React renderer lets terminal UIs be built as real component trees instead of manual string output.

---

## Topic 3: Terminal DOM / Host Node Model

### 1. Idea level

React needs a host representation that is meaningful for terminal layout and rendering.

### 2. Language/API level

Engineers do not manipulate host nodes directly.
They indirectly create nodes via components like:

- `Box` -> `ink-box`
- `Text` -> `ink-text`
- `Link` -> `ink-link`
- raw ANSI leaf -> `ink-raw-ansi`

### 3. Planner/runtime level

The reconciler should interpret React host elements as terminal-specific nodes and attach:

- attributes
- style
- text styles
- event handlers
- layout references

### 4. Storage/data-structure level

Each node should minimally store:

- type/name
- children
- parent
- text value if leaf
- style props
- text-style props
- event handlers
- Yoga node pointer/reference

### 5. OS/hardware level

This is in-memory object graph work.
CPU traverses it repeatedly for reconciliation, layout, and paint.

### 6. Complexity/perf level

Traversal cost is O(n) over relevant subtree or render tree.
Main bottleneck is repeated full-tree walking if incremental work is poor.

### 7. One-liner

The terminal DOM is the in-memory bridge between React trees and terminal output.

---

## Topic 4: Layout Engine

### 1. Idea level

Terminal UIs need spatial structure, not just lines of text.
A layout engine solves positioning, sizing, wrapping, and flex behavior.

### 2. Language/API level

Engineers use props like:

- `flexDirection`
- `flexGrow`
- `flexShrink`
- `width`
- `height`
- `padding`
- `margin`
- `borderStyle`
- `justifyContent`
- `alignItems`

### 3. Planner/runtime level

The runtime should convert style props into Yoga layout instructions, compute layout from root width, and store computed positions and sizes on nodes.

### 4. Storage/data-structure level

Need:

- Yoga node per layout-capable host node
- style-to-layout mapping
- computed layout fields such as x/y/width/height

### 5. OS/hardware level

CPU performs layout math.
Memory stores the Yoga graph and layout results.
No external I/O here unless logs/debug traces are written.

### 6. Complexity/perf level

Layout is typically O(n) in number of layout nodes per pass.
Real bottlenecks:

- repeated full layout recalculation
- text measure callbacks
- expensive reflows triggered by frequent updates

### 7. One-liner

The layout engine makes terminal UI spatially structured instead of line-by-line manual formatting.

---

## Topic 5: Text Rendering and ANSI Awareness

### 1. Idea level

Terminal text is not simple ASCII.
It includes color, style, ANSI codes, wide characters, combining marks, bidi cases, wrapping, truncation, and hyperlink sequences.

### 2. Language/API level

Engineers write:

- `<Text color="ansi:green">`
- `<Ansi>{rawAnsiString}</Ansi>`
- text wrapping and truncation props

### 3. Planner/runtime level

The runtime should:

- measure string width in terminal cells
- parse ANSI where needed
- preserve style segments
- wrap or truncate by cell width
- emit terminal-ready output without corrupting escape sequences

### 4. Storage/data-structure level

Need representations for:

- style spans
- grapheme-aware strings
- parsed ANSI tokens
- screen cells or equivalent render buffer entries

### 5. OS/hardware level

CPU does tokenization, width calculation, and buffer generation.
Memory stores spans and screen buffers.
stdout writes emit final bytes.

### 6. Complexity/perf level

Usually O(n) in characters/tokens.
Real bottlenecks:

- repeated width calculation
- ANSI parse churn
- re-serializing large styled logs
- wide-char and grapheme handling

### 7. One-liner

ANSI-aware text rendering turns terminal text into a correct, structured rendering problem rather than naive string concatenation.

---

## Topic 6: Screen Buffer and Paint Pipeline

### 1. Idea level

A terminal UI should render predictably and avoid flicker.
A screen buffer makes painting deliberate instead of ad hoc.

### 2. Language/API level

Users do not directly manage the buffer.
They see stable UI updates from regular React renders.

### 3. Planner/runtime level

Pipeline should be:

1. reconcile tree
2. compute layout
3. traverse render tree
4. write into screen/output buffer
5. flush buffer diff to terminal

### 4. Storage/data-structure level

Need:

- screen cell grid or line-oriented output buffer
- style pools / char pools if interning is used
- previous frame data for diffing

### 5. OS/hardware level

CPU builds the frame.
Memory holds current and previous frame state.
I/O writes final diff or output to stdout.

### 6. Complexity/perf level

Full repaint is roughly O(screen area + rendered content).
Diff-based flushes reduce I/O, but bottlenecks remain:

- large frame generation
- full-screen repaints
- terminal write throughput

### 7. One-liner

A screen buffer makes terminal painting stable, controllable, and optimizable.

---

## Topic 7: Input System

### 1. Idea level

A useful TUI must react to keyboard input and sometimes mouse input, not just print output.

### 2. Language/API level

Engineers use hooks like:

```tsx
useInput((input, key) => {
  if (key.upArrow) { ... }
  if (input === 'q') { ... }
})
```

### 3. Planner/runtime level

Runtime should:

- read stdin
- switch to raw mode when needed
- parse incoming bytes into semantic key/input events
- emit those events through an internal event system
- let components subscribe through hooks

### 4. Storage/data-structure level

Need:

- parsed key event objects
- event emitter/listener registry
- stdin/raw-mode state

### 5. OS/hardware level

OS supplies stdin bytes from terminal device.
Node reads the stream.
CPU parses byte sequences into higher-level input events.

### 6. Complexity/perf level

Per-event handling is usually O(number of listeners).
Bottlenecks are not algorithmic so much as:

- incorrect raw mode transitions
- listener ordering bugs
- event parsing edge cases

### 7. One-liner

The input system turns raw terminal bytes into usable application events.

---

## Topic 8: Focus, Selection, and Interaction

### 1. Idea level

Complex TUIs need more than keypresses.
They need focus order, click targets, hover, selection, and alternate-screen interactions.

### 2. Language/API level

Engineers should be able to write:

- `tabIndex`
- `autoFocus`
- `onClick`
- `onFocus`
- `onBlur`
- selection-aware wrappers like `NoSelect`
- fullscreen wrappers like `AlternateScreen`

### 3. Planner/runtime level

Runtime should:

- maintain focusable nodes
- dispatch click/focus/keyboard events to correct targets
- support selection state where applicable
- manage alternate-screen enable/disable sequences safely

### 4. Storage/data-structure level

Need:

- focus manager
- hit testing over layout boxes
- event handler references on nodes
- selection state
- alt-screen active flags

### 5. OS/hardware level

Mouse and focus signals arrive as terminal escape/input sequences.
CPU parses them and dispatches events.
stdout emits control sequences for alt-screen and mouse modes.

### 6. Complexity/perf level

Hit testing is often O(n) without spatial indexing.
Real bottlenecks:

- too many interactive nodes
- event dispatch traversal
- bad cleanup causing terminal mode leakage

### 7. One-liner

Focus and interaction support make the terminal UI behave like an application instead of static text.

---

## Topic 9: Root Lifecycle

### 1. Idea level

Apps need a clean mount/unmount lifecycle and sometimes reusable roots.

### 2. Language/API level

Provide:

- `render(node, options?)`
- `renderSync(node, options?)`
- `createRoot(options?)`

Return objects should support:

- rerender
- unmount
- waitUntilExit

### 3. Planner/runtime level

The runtime should:

- initialize streams and terminal state
- mount root tree
- patch console if configured
- clean up on unmount
- restore terminal modes on exit/suspend/resume paths

### 4. Storage/data-structure level

Need:

- root instance map keyed by stdout or equivalent
- current tree reference
- lifecycle flags like paused/unmounted

### 5. OS/hardware level

This interacts heavily with process streams and terminal device state.
Cleanup correctness matters because raw mode and escape modes affect the shell after process exit.

### 6. Complexity/perf level

Lifecycle work is mostly constant or proportional to cleanup tasks.
Real risk is not big-O but correctness: leaked raw mode, hidden cursor, stale alt-screen, broken shell state.

### 7. One-liner

The root lifecycle makes terminal app startup and shutdown safe and predictable.

---

## Topic 10: Utility Layer

### 1. Idea level

Terminal rendering needs support code for width, semver shims, environment checks, wrapping, logging, and process helpers.

### 2. Language/API level

These are mostly internal helpers, not marquee user-facing API.

Examples:

- string width
- wrap ANSI
- slice ANSI
- semver comparison
- env utilities

### 3. Planner/runtime level

Utilities should isolate platform-specific and low-level behavior so the renderer code stays focused on rendering logic.

### 4. Storage/data-structure level

Mostly module-level helpers and small pure functions.

### 5. OS/hardware level

Some helpers touch process env, streams, or child-process behavior; most are CPU-only string/data work.

### 6. Complexity/perf level

Usually linear in input size.
The important part is correctness on terminal edge cases.

### 7. One-liner

The utility layer keeps the terminal core reliable by isolating low-level edge-case logic.

---

## Topic 11: Demo App

### 1. Idea level

The repo needs a demo that proves user value, not just that artifacts build.

### 2. Language/API level

The demo should be small and understandable.
Current best shape: `todo-tui`.

Features:

- list tasks
- move selection with arrows
- add task
- toggle completion
- delete task
- quit

### 3. Planner/runtime level

The demo should exercise:

- rendering
- state updates
- keyboard input
- list redraw
- conditional UI

### 4. Storage/data-structure level

Simple in-memory task array is enough:

- `id`
- `text`
- `done`

Optional local persistence can come later.

### 5. OS/hardware level

stdin handles key input, stdout renders UI, CPU updates state and redraws.

### 6. Complexity/perf level

Operations are O(n) over task count, which is fine for demo scale.
The value is feature clarity, not scale benchmarking.

### 7. One-liner

The demo must show a believable small TUI, not a fake artifact test.

---

## Topic 12: Build System

### 1. Idea level

A package like this must actually build in a normal environment or it is not reusable.

### 2. Language/API level

Use:

- TypeScript
- `tsup` for bundling
- `tsx` for running demo

Scripts:

- `npm run typecheck`
- `npm run build`
- `npm run demo`

### 3. Planner/runtime level

Build system should:

- compile ESM output
- generate `.d.ts`
- keep package metadata aligned with `dist/`

### 4. Storage/data-structure level

Need:

- `package.json`
- `tsconfig.json`
- `dist/` output
- lockfile

### 5. OS/hardware level

Node and build tools read source files, transform them, and write generated output to disk.

### 6. Complexity/perf level

Build time is proportional to codebase size.
Main pain is toolchain mismatch, not asymptotic complexity.

### 7. One-liner

The build system turns a source tree into a real distributable package.

---

## Implementation Checklist

To recreate the repo from scratch, build these parts in order:

1. Package metadata and build config.
2. Public export surface.
3. Terminal DOM model.
4. React reconciler integration.
5. Layout engine integration.
6. Text rendering and ANSI-aware utilities.
7. Screen buffer and output pipeline.
8. Input parsing and hook system.
9. Focus / selection / alt-screen interaction support.
10. Root lifecycle and cleanup behavior.
11. Minimal useful demo.
12. README and package polish.

---

## Success Criteria

A correct rebuild should satisfy all of these:

- package installs and builds with normal npm workflow
- `render`, `renderSync`, `createRoot` work
- `Box`, `Text`, `Button`, and hooks are usable
- layout works via Yoga-backed sizing and positioning
- input works through stdin raw-mode handling
- output is ANSI-aware and width-correct
- cleanup restores terminal state correctly
- demo behaves like a small real TUI

---

## Final One-Liner

Recreate `terminal-react-core` as a standalone React-powered terminal UI runtime that turns component trees, layout, and input events into real interactive TUI applications under normal Node tooling.
