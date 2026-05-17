# qe Programmable Config Contract

This document is the behavioral contract for local `qe` config. Config is trusted local code, like Emacs/Vim config, but the editor still keeps command/directive behavior predictable.

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

## Hooks

- `onOpen` runs after a buffer receives its initial snapshot.
- `onSave` runs after the sidecar reports a saved buffer.
- `onChange` means content changed, not “any snapshot arrived.”
- `onChange` fires only when a buffer snapshot has a new numeric `revision` after the first snapshot for that buffer.
- Cursor moves, resize, viewport updates, save-only snapshots, diagnostics-only snapshots, and the initial snapshot must not fire `onChange`.
- `onChange` is debounced by 250ms per buffer; rapid revision changes coalesce into one hook call.
- Hook contexts can run commands/directives, but interactive UI prompts are unavailable there: `pick()` and `input()` resolve to `null`, `confirm()` resolves to `false`, and `panel()` is a no-op.

## UI Prompts

Config-driven prompts are `ctx.ui.pick()`, `ctx.ui.input()`, and `ctx.ui.confirm()`.

- `pick()` resolves to the selected item value or `null`.
- `input()` resolves to the entered string or `null`.
- `confirm()` resolves to `true` or `false`.
- Escape cancels the active prompt.
- Starting a new config prompt cancels the previous config prompt.
- Replacing a config prompt with any non-config prompt cancels the previous config prompt.
- Cancellation values are `null` for `pick` and `input`, and `false` for `confirm`.

## Generated Typing Helper

`SPC p e` creates `~/.config/qe/config.ts` and, if missing, `~/.config/qe/config-api.ts`.

- `config-api.ts` is generated beside the user config so it is portable across machines.
- It must not contain absolute local paths.
- It must export `defineConfig()`.
- It must include the public unions for directive types, panel names, extras, and hooks.
- It is a local helper until `qe/config` becomes a real package entry.
