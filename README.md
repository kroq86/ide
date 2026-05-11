# qe-react-editor

Terminal-first **IDE**: React UI + Rust editor core, git and shell in one surface. **CodeClaw** is the built-in AI workflow—fix and review loops driven by **Ollama** (or compatible local HTTP), with **traces** so a run is inspectable, not a black box.

**In one line:** the model sees your *session* (editor, failed commands, diff, rules), proposes bounded steps, and leaves receipts.

---

## Try the demo

Fixture: [`examples/broken-counter/`](examples/broken-counter/).

```sh
npm --prefix app install
npm run build:native
bash scripts/dev.sh examples/broken-counter/src/counter.ts
```

In the app: `SPC t t` → run `npm --prefix examples/broken-counter test` (fails) → `Esc` then `SPC a f` → review patch → `a` to apply → verify reruns → `SPC a t` for the latest trace.

**Proof assets:** [`docs/codeclaw-proof-loop.cast`](docs/codeclaw-proof-loop.cast) · [`docs/codeclaw-proof-loop.gif`](docs/codeclaw-proof-loop.gif) · [`docs/codeclaw-proof-loop.mp4`](docs/codeclaw-proof-loop.mp4)

---

## What you get

| Area | Notes |
|------|--------|
| **Editor** | Modal buffers, Rust JSONL core (`native/editor-core/`), LSP-oriented protocol |
| **Shell** | PTY pane, tracked runs, exit codes, parsed error locations |
| **Git** | Status, diff, stage, commit, pull, push, log |
| **AI** | Chat, inline completion, CodeClaw **fix** / **review** with optional raw trace bundle (`CODECLAW_TRACE_RAW`) |
| **Project** | Rules, tasks, memory, and traces under `.codeclaw/` (paths follow **process cwd**—often `app/` when you launch from there) |

---

## Requirements

- **Node.js** 22+
- **npm**
- **Rust / Cargo** for `native/editor-core`
- Sibling **`terminal-react-core`** next to this repo (see layout below)
- **Ollama** (optional) for AI — e.g. `OLLAMA_URL`, `OLLAMA_MODEL`

```text
~/Documents/
  terminal-react-core/
  qe-react-editor/
```

---

## Run locally

```sh
npm --prefix app install
npm run build:native
npm run dev -- README.md
```

Ollama (defaults are loopback; set model to whatever you pull):

```sh
export OLLAMA_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.2:latest
```

---

## Keys (high level)

Press **`SPC`** in normal mode for the which-key menu.

| Keys | Action |
|------|--------|
| `SPC a f` | CodeClaw fix from last failed shell run |
| `SPC a r` | CodeClaw review (diff + rules) |
| `SPC a t` | Latest CodeClaw trace |
| `SPC a p` | AI chat |
| `SPC a c` | Inline completion |
| `SPC a e` | Explain last shell error |
| `SPC t t` / `SPC t a` | Shell / AI pane |
| `SPC g g` | Git panel |
| `SPC f f` | Open file |
| `SPC b b` | Switch buffer |
| `Ctrl-Q` | Quit |

---

## Verify / develop

```sh
npm run typecheck          # TypeScript
npm run test               # App tests + protocol smoke
npm run test:codeclaw      # CodeClaw unit tests only
npm run test:protocol      # Native build + protocol smoke
npm run build              # Native release + app bundle
cargo test --manifest-path native/editor-core/Cargo.toml
```

Fixture should fail **before** a manual fix (used by the demo narrative):

```sh
npm --prefix examples/broken-counter test
```

---

## Architecture (where to read code)

| Path | Role |
|------|------|
| [`app/src/main.tsx`](app/src/main.tsx) | Terminal UI, modes, panels, bindings |
| [`app/src/codeclaw.ts`](app/src/codeclaw.ts) | Fix/review context, proposals, git diff shaping, traces |
| [`app/src/shell.ts`](app/src/shell.ts) | Shell sidecar, `ShellRun` records |
| [`app/src/git.ts`](app/src/git.ts) | Git helpers |
| [`app/src/ai.ts`](app/src/ai.ts) | Ollama chat / completion / streaming |
| [`native/editor-core/`](native/editor-core/) | Rope buffer, undo, syntax, LSP-shaped protocol |
| [`native/qe-core/`](native/qe-core/) | Legacy QEmacs-derived scaffolding |

The editor sidecar prefers `native/editor-core/target/release/editor-core` and can fall back to the legacy C sidecar if that binary is missing.

---

## License

Files under [`native/qe-core/`](native/qe-core/) retain their original **LGPL** terms. Prototype TypeScript in `app/` is project-local unless otherwise marked.
