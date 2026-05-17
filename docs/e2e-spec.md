# qe Terminal E2E Contract

This document is the behavioral contract for terminal end-to-end tests. The E2E suite proves that the built editor works through the same terminal surface a user sees.

## Runner Contract

- E2E tests run separately from normal unit/protocol tests via `npm run test:e2e`.
- Root `test:e2e` must build native `editor-core` and the app bundle before running tests.
- App `test:e2e` runs against the existing production bundle at `app/dist/main.js`.
- Tests must launch `qe` in a real PTY-like terminal, not call React components or sidecar APIs directly.
- Tests must isolate `HOME`, `cwd`, config files, repo fixtures, and edited files in temporary directories.
- Tests must never read or write the real user config under `~/.config/qe`.

## Assertion Contract

- Tests interact only through terminal key sequences.
- Tests assert user-visible terminal text or durable side effects on disk.
- Tests should avoid depending on transient status messages when a durable file/UI outcome exists.
- Terminal text may be compacted by ANSI cursor movement and layout, so assertions may use compact strings such as `exportconstvalue`.
- LSP E2E proves key routing and graceful UI behavior only; it does not require a language server to return semantic results.
- On failure, the harness must print key history, a stripped screen tail, and a raw ANSI tail.

## Required Scenarios

- Boot a file, render visible content, and quit through leader keys.
- Yank a visual line, paste it, save it, and verify the file on disk.
- Show leader hints and open/filter the command palette.
- Create starter config files with `SPC p e` in an isolated `HOME`.
- Run programmable config leader directives from a temp config.
- Cancel a config prompt and prove later config actions still run.
- Open the Git panel in a modified temp repo.
- Route `K` hover and `gd` definition keys without hanging.

## Harness Contract

- `spawnQe(args, options)` must accept isolated `cwd`, `home`, terminal `cols`, and `rows`.
- `sendKeys(sequence)` must send keys slowly enough for React/terminal state transitions.
- `waitForText()` and `waitForFile()` must timeout with diagnostics.
- `quitQe()` should prefer user-visible quit keys and may fall back to `Ctrl-Q` for cleanup.
- `node-pty` is the preferred PTY implementation. If it cannot spawn on the host, the Python PTY bridge may be used as a compatibility fallback.
