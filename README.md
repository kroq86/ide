# qe-react-editor

Terminal-first **IDE**: React UI on **terminal-react-core**, editor backed by a **Rust** JSONL sidecar, **git** and **shell** in the same UI. **CodeClaw** is the built-in AI workflow (Ollama HTTP): fix loop from a failed tracked shell run, review loop over git diff + rules, optional **raw trace** capture via `CODECLAW_TRACE_RAW`, summarized traces as JSON under `.codeclaw/traces/`.

**In one line:** bounded proposals (patch / review findings), verify hooks, and written traces—not silent repo rewrites.

---

## Try the demo

Fixture: [`examples/broken-counter/`](examples/broken-counter/).

```sh
npm --prefix app install
npm run build:native
bash scripts/dev.sh examples/broken-counter/src/counter.ts
```

`scripts/dev.sh` runs `npm --prefix app run build` then `node app/dist/main.js` with the file argument (see [`scripts/dev.sh`](scripts/dev.sh)).

In the app (normal mode, `SPC` leader):

1. `SPC t t` — open shell pane.
2. Run: `npm --prefix examples/broken-counter test` (fixture is meant to fail).
3. `Esc`, then `SPC a f` — CodeClaw fix from last failed run; follow on-screen prompts (`a` to apply when offered).
4. After a cycle completes, `SPC a t` — see **Trace viewer** (details below).

---

## What you get

| Area | Notes |
|------|--------|
| **Editor** | Modal buffers; Rust sidecar [`native/editor-core/`](native/editor-core/) speaks JSONL with snapshots, edits, and **LSP-shaped** requests/responses (hover, definition, completion, format) — see [`app/src/protocol.ts`](app/src/protocol.ts). |
| **Shell** | PTY pane; tracked runs with exit code, output tail, parsed locations — [`app/src/shell.ts`](app/src/shell.ts). |
| **Git** | Status / diff / stage / commit / pull / push / log UI — [`app/src/git.ts`](app/src/git.ts). |
| **AI** | Chat, inline completion — [`app/src/ai.ts`](app/src/ai.ts). CodeClaw fix/review — [`app/src/codeclaw.ts`](app/src/codeclaw.ts). Optional append-only raw bundle: `CODECLAW_TRACE_RAW=1` (see [`app/src/codeclaw-trace-recorder.ts`](app/src/codeclaw-trace-recorder.ts)). |
| **Project** | `.codeclaw/` for rules, tasks, memory, traces — paths are relative to **process cwd** (often the `app/` directory if you start the binary from there). |

---

## Requirements

- **Node.js** 22+ (the app bundle targets `node22`; see [`app/package.json`](app/package.json) `build` script).
- **npm**
- **Rust / Cargo** for [`native/editor-core/`](native/editor-core/)
- **`terminal-react-core`** as a **sibling directory** of this repo so [`app/package.json`](app/package.json) can resolve `file:../../terminal-react-core`
- **Ollama** (optional) on the host for AI — env vars below

---

## Run locally

From repo root:

```sh
npm --prefix app install
npm run build:native
npm run dev -- README.md
```

Root [`package.json`](package.json): `dev` = `build:native` + `npm --prefix app run dev --` (forwards args to `node dist/main.js`).

---

## Ollama environment

Defaults are set **in code** (you may override with env):

| Variable | Default (both call sites) | Where read |
|----------|---------------------------|------------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | [`app/src/ai.ts`](app/src/ai.ts), [`app/src/codeclaw.ts`](app/src/codeclaw.ts) |
| `OLLAMA_MODEL` | **`qwen2.5-coder:1.5b`** (chat / completion / FIM) | [`app/src/ai.ts`](app/src/ai.ts) |
| `OLLAMA_MODEL` | **`llama3.2:latest`** (CodeClaw fix + review) | [`app/src/codeclaw.ts`](app/src/codeclaw.ts) |

If **`OLLAMA_MODEL` is set** in the environment, **both** `ai.ts` and `codeclaw.ts` use that same tag. Install models with `ollama pull …` to match whatever you set.

---

## Keys (from `COMMAND_LABELS`)

Press **`SPC`** in normal mode for which-key. Bindings are defined in [`app/src/leader.ts`](app/src/leader.ts) (excerpt):

| Keys | Label |
|------|--------|
| `SPC a f` | ai: fix failure (CodeClaw) |
| `SPC a r` | ai: review git diff (CodeClaw) |
| `SPC a t` | ai: show trace |
| `SPC a p` | ai: open chat |
| `SPC a c` | ai: trigger completion |
| `SPC a e` | ai: explain last error |
| `SPC a l` | ai: rerun last shell command |
| `SPC a k` | ai: clear chat |
| `SPC t t` | terminal: toggle shell |
| `SPC t a` | terminal: toggle AI panel |
| `SPC g g` | git: status — ll commit log (Magit) |
| `SPC g s` | git: stage current |
| `SPC f f` | file: open |
| `SPC b b` | buffer: switch |
| `Ctrl-Q` | quit (handled in [`app/src/main.tsx`](app/src/main.tsx)) |

---

## Trace viewer (`SPC a t`)

[`readLatestTrace`](app/src/codeclaw.ts) loads the **newest `*.json` by mtime** in `.codeclaw/traces/` **only** (not subdirectories). Fix summaries live there; **review** traces are written under `.codeclaw/traces/review/` ([`writeReviewTrace`](app/src/codeclaw.ts)) and **are not** selected by `SPC a t` today.

---

## Verify / develop

Scripts from root [`package.json`](package.json):

```sh
npm run typecheck          # tsc in app/
npm run test               # app/unit tests + app/test/protocol-smoke.mjs
npm run test:codeclaw      # CodeClaw tests only (tsx)
npm run test:protocol      # build native + protocol smoke
npm run build              # native release + app esbuild bundle
cargo test --manifest-path native/editor-core/Cargo.toml
```

Fixture failure (for the demo narrative):

```sh
npm --prefix examples/broken-counter test
```

---

## Editor sidecar binary

[`resolveEditorCoreBinary`](app/src/protocol.ts) picks the **newer** of `native/editor-core/target/release/editor-core` and `native/editor-core/target/debug/editor-core` if they exist; otherwise it falls back to **`native/qe-core/qe-protocol`**.

---

## Architecture (entry points)

| Path | Role |
|------|------|
| [`app/src/main.tsx`](app/src/main.tsx) | UI, modes, panels, fix/review flows, quit |
| [`app/src/protocol.ts`](app/src/protocol.ts) | Sidecar binary resolution, snapshot / LSP message types |
| [`app/src/codeclaw.ts`](app/src/codeclaw.ts) | CodeClaw fix/review, traces, git diff for review |
| [`app/src/shell.ts`](app/src/shell.ts) | Shell sidecar, `ShellRun` |
| [`app/src/git.ts`](app/src/git.ts) | Git operations |
| [`app/src/ai.ts`](app/src/ai.ts) | Ollama chat / completion |
| [`native/editor-core/`](native/editor-core/) | Rust editor core |
| [`native/qe-core/`](native/qe-core/) | Legacy C protocol binary / QEmacs-derived sources |

More design notes: [`docs/design.md`](docs/design.md), [`docs/plan.md`](docs/plan.md), AI/trace details: [`docs/ai_settings.md`](docs/ai_settings.md).

---

## License

Source files under [`native/qe-core/`](native/qe-core/) include **GNU LGPL** headers (QEmacs-derived). Other layout (e.g. `app/`) is project-local unless individual files state otherwise.
