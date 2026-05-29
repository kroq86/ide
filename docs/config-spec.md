# qe Programmable Config Contract

This document is the behavioral contract for local `qe` config. Config is trusted local code, like Emacs/Vim config, but the editor still keeps command/directive behavior predictable.

Product direction and phased work live in [roadmap.md](roadmap.md). TypeScript is the extension language; Rust `editor-core` is the text/LSP core.

## Config Loading

- `qe` searches in this priority order:
  1. `~/.config/qe/config.ts`
  2. `~/.config/qe/config.mts`
  3. `~/.config/qe/config.js`
  4. `~/.config/qe/config.mjs`
  5. `~/.qe/config.js`
- `.ts` and `.mts` configs load through `tsx/esm/api`.
- `.js` and `.mjs` configs load through native dynamic import.
- Broken configs are reported to stderr and skipped; the loader continues to the next candidate.
- Reload appends a timestamp query to the selected config path so Node's ESM cache is bypassed.

## Actions

Config actions may be:

- a command ID: `'git.status'`
- a command object: `{ command: 'shell.run', args: { command: 'npm test' } }`
- a directive: `{ type: 'panel.open', panel: 'shell' }`
- a directive array, executed in order
- a function receiving `EditorContext`

Unknown command IDs call `ctx.ui.notify("unknown command: <id>", "error")` and do not throw.

Unknown directive types call `ctx.ui.notify("unknown directive: <type>", "error")` and execution continues with later directives in the same array.

## Command Registry

- Built-in commands and user commands share one registry.
- User commands may override built-in command IDs.
- Last registration wins.
- This is intentional because config is trusted local code and overrides are a core customization mechanism.

## EditorContext modes

Config code receives `EditorContext` from leader keys, commands, and hooks. The same factory builds both modes:

| Capability | Interactive (leader, palette) | Hook (`onOpen`, `onSave`, …) |
|------------|------------------------------|------------------------------|
| `shell.run`, `openFile`, `save`, `insert`, `move`, LSP | Yes | Yes |
| `commands.run`, `ui.notify` | Yes | Yes |
| `git.*`, `diagnostics.*` | Yes | Yes (same implementations when wired) |
| `ui.pick`, `ui.input`, `ui.confirm`, `ui.panel` | Yes | No — `pick`/`input` → `null`, `confirm` → `false`, `panel` no-op |

Hooks must stay fast; do not rely on modal prompts inside hooks.

## Hooks

- `onOpen` runs after a buffer receives its initial snapshot.
- `onSave` runs after the sidecar reports a saved buffer.
- `onChange` means content changed, not “any snapshot arrived.”
- `onChange` fires only when a buffer snapshot has a new numeric `revision` after the first snapshot for that buffer.
- Cursor moves, resize, viewport updates, save-only snapshots, diagnostics-only snapshots, and the initial snapshot must not fire `onChange`.
- `onChange` is debounced by 250ms per buffer; rapid revision changes coalesce into one hook call.
- `onBufEnter` runs when the active buffer changes (including the first activation after startup).
- `onShellDone` runs after a **tracked** shell command finishes (`ctx.shell.run` / `{ type: 'shell.run' }`). `ctx.lastShellRun` is set for that hook invocation (command, `exitCode`, `stdout`/`stderr` tails, parsed `locations`).
- Hook contexts can run commands/directives, but interactive UI prompts are unavailable there: `pick()` and `input()` resolve to `null`, `confirm()` resolves to `false`, and `panel()` is a no-op.

### What does not fire hooks

| Event | `onChange` | `onBufEnter` | `onShellDone` |
|-------|------------|--------------|---------------|
| Cursor-only snapshot | No | No | No |
| Resize / viewport-only snapshot | No | No | No |
| Diagnostics-only snapshot (same `revision`) | No | No | No |
| Initial snapshot (first for buffer) | No | No | No |
| PTY typing in shell pane (non-tracked) | No | No | No |
| Tracked shell exit | No | No | Yes |
| Switch active buffer | No | Yes | No |

## UI Prompts

Config-driven prompts are `ctx.ui.pick()`, `ctx.ui.input()`, and `ctx.ui.confirm()`.

- `pick()` resolves to the selected item value or `null`.
- `input()` resolves to the entered string or `null`.
- `confirm()` resolves to `true` or `false`.
- Escape cancels the active prompt.
- Starting a new config prompt cancels the previous config prompt.
- Replacing a config prompt with any non-config prompt cancels the previous config prompt.
- Cancellation values are `null` for `pick` and `input`, and `false` for `confirm`.

## Plugins

After `config.ts` loads, `qe` imports optional modules from `~/.config/qe/plugins/`:

- Files: `*.ts`, `*.mts`, `*.js`, `*.mjs` (non-recursive; one level).
- Export `setup(registry)` or `commands` (record merged into config commands).
- Export `onStartup` for a one-shot action when the app opens (interactive context; supports `ui.splash`).
- Trusted local code — same trust model as `config.ts`.
- Reload config re-imports plugins with a cache-busting query (same as config reload).

## Eval (Emacs-style)

Trusted local code — same model as config/plugins. Implementation: [`app/src/config-eval.ts`](../app/src/config-eval.ts).

| Mode | Leader (normal mode) | Behavior |
|------|----------------------|----------|
| **eval-file** | `Space` → `p` → `f` | Re-import **current buffer** path |
| **eval-expression** | `Space` → `p` → `;` | Prompt; body runs as `async (ctx) => { … }` |
| **eval-selection** | `Space` → `p` → `s` | Evaluates the last visual selection (select with `v`, then `SPC p s`) |

### eval-file by path type

- **Config file** (`~/.config/qe/config.ts`, …) — reload config + leader/commands/hooks without restart.
- **Plugin file** (`~/.config/qe/plugins/*.ts`) — register `commands` + run `setup(registry)` immediately.
- **Other `.ts/.js`** — run `export default (ctx) => …`, or register `commands`, or call `setup(registry)`.

Scratch buffers and non-script paths → error notify.

### Expression / selection body

- **Expressions** (`SPC p ;`) and non-module **selections** run as `async (ctx) => { … }`.
- Pasted **selections** or **expressions** with top-level **`import` / `export`** are imported as a small module (same as eval-file for plugins).
- No `eval()` / `new Function` — code is imported via `tsx` like config files.

## Generated Typing Helper

`SPC p e` creates `~/.config/qe/config.ts` and, if missing, `~/.config/qe/config-api.ts`.

- `config-api.ts` is generated beside the user config so it is portable across machines.
- It must not contain absolute local paths.
- It must export `defineConfig()`.
- It must include the public unions for directive types, panel names, extras, and hooks.
- It is a local helper until `qe/config` becomes a real package entry.
