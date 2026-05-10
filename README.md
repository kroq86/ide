# CodeClaw

An AI-native terminal workspace where the model sees your whole debugging session.

Most AI coding tools see files. CodeClaw sees the session: editor state, shell failures, git diff, project rules, verification results, and a trace of what happened.

```text
test fails -> press SPC a f -> patch proposed -> accept -> test reruns -> trace saved
```

Demo assets:

- Asciinema recording: `docs/codeclaw-proof-loop.cast`
- GIF preview: `docs/codeclaw-proof-loop.gif`
- YouTube upload file: `docs/codeclaw-proof-loop.mp4`

## Demo

The clean public demo lives in `examples/broken-counter/`.

```sh
npm --prefix app install
npm run build:native
bash scripts/dev.sh examples/broken-counter/src/counter.ts
```

Inside CodeClaw:

```text
1. Press Ctrl-T to focus the shell pane.
2. Run: npm --prefix examples/broken-counter test
3. The test fails.
4. Press Esc, then SPC a f.
5. Review the proposed patch.
6. Press a to apply.
7. CodeClaw reruns the verify command.
8. Press SPC a t to view the trace.
```

The demo exists to prove one sentence:

```text
CodeClaw does not just suggest a fix. It proves what happened.
```

## What It Does

- Terminal-native React workspace built on `terminal-react-core`
- Modal editor pane backed by a Rust JSONL editor core
- Shell pane with tracked command runs, exit codes, output tails, and parsed locations
- Git panel with status, hunks, stage/unstage, commits, pull, push, and log
- AI pane using Ollama for chat, completion, and structured CodeClaw fixes
- Project rules and memory in `.codeclaw/`
- Trace files in `.codeclaw/traces/`

## CodeClaw Keys

Press `SPC` in normal mode to open the which-key menu.

- `SPC a f`: fix the last failed tracked shell run
- `SPC a t`: show the latest CodeClaw trace
- `SPC a p`: open AI chat
- `SPC a c`: trigger inline completion
- `SPC a e`: explain the last shell error

Useful supporting keys:

- `SPC t t`: toggle shell panel
- `SPC t a`: toggle AI panel
- `SPC g g`: open git panel
- `SPC f f`: open file
- `SPC b b`: switch buffer
- `Ctrl-Q`: quit

## Requirements

- Node.js 22+
- npm
- Rust/Cargo for `native/editor-core`
- A sibling checkout/build of `terminal-react-core`
- Optional: Ollama for AI features

Expected local layout:

```text
~/Documents/
  terminal-react-core/
  qe-react-editor/
```

The app dependency uses `file:../../terminal-react-core` from `app/`.

## Install And Run

```sh
npm --prefix app install
npm run build:native
npm run dev -- README.md
```

AI calls use Ollama by default:

```sh
export OLLAMA_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.2:latest
```

## Verification

```sh
npm run typecheck
npm run test:codeclaw
npm run test:protocol
cargo test --manifest-path native/editor-core/Cargo.toml
npm run build
```

The broken-counter fixture should fail before CodeClaw fixes it:

```sh
npm --prefix examples/broken-counter test
```

## Architecture

```text
app/src/main.tsx        React terminal UI, modes, panels, key handling
app/src/codeclaw.ts     Fix context, patch proposals, risk gates, traces
app/src/shell.ts        PTY shell sidecar and normalized ShellRun records
app/src/git.ts          Git status/diff/log/stage helpers
app/src/ai.ts           Ollama streaming chat/completion
native/editor-core/     Rust editor core: rope buffer, undo, syntax, LSP surface
native/qe-core/         Legacy QEmacs-derived prototype scaffolding
```

The editor sidecar prefers `native/editor-core/target/release/editor-core` and falls back to the legacy C sidecar if the Rust binary is missing.

## License Notes

QEmacs-derived files under `native/qe-core/` retain their original LGPL terms. The TypeScript prototype code in `app/` is local project code.
