# qe-react-editor

Terminal-first **IDE**: React UI on the vendored **terminal-react-core** workspace, editor backed by a **Rust** JSONL sidecar, **git** and **shell** in the same UI. **CodeClaw** is the optional built-in AI workflow: fix loop from a failed tracked shell run, review loop over git diff + rules, optional **raw trace** capture via `CODECLAW_TRACE_RAW`, summarized traces as JSON under `.codeclaw/traces/`.

---

## Try the demo

Fixture: [`examples/broken-counter/`](examples/broken-counter/).

```sh
npm install
npm run build
npm run dev -- examples/broken-counter/src/counter.ts
```

For CLI install testing, use `npm link` after `npm run build`, then run `qe examples/broken-counter/src/counter.ts`.

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
| **AI** | Chat, inline completion — [`app/src/ai.ts`](app/src/ai.ts). CodeClaw fix/review — [`app/src/codeclaw.ts`](app/src/codeclaw.ts). Multi-provider registry (Ollama + any OpenAI-compatible API) — [`app/src/ai-registry.ts`](app/src/ai-registry.ts). Optional append-only raw bundle: `CODECLAW_TRACE_RAW=1` (see [`app/src/codeclaw-trace-recorder.ts`](app/src/codeclaw-trace-recorder.ts)). |
| **Config** | TypeScript/ESM programmable config with command IDs, directives, hooks, and interactive UI helpers — [`app/src/config.ts`](app/src/config.ts), [`app/src/config-runtime.ts`](app/src/config-runtime.ts). |
| **Project** | `.codeclaw/` for rules, tasks, memory, traces — paths are relative to **process cwd** (often the `app/` directory if you start the binary from there). |

---

## Requirements

- **Node.js** 22+ (the app bundle targets `node22`; see [`app/package.json`](app/package.json) `build` script).
- **npm**
- **Rust / Cargo** for [`native/editor-core/`](native/editor-core/)
- **Git**
- **Ollama/OpenAI-compatible endpoint** (optional) for AI — core editor, Git, shell, and config work without AI

---

## Install Locally

First milestone install path from a fresh clone:

From repo root:

```sh
npm install
npm run build
npm link
qe README.md
```

The installability contract is documented in [`docs/install-spec.md`](docs/install-spec.md). This repo vendors `terminal-react-core` as `packages/terminal-react-core`, so no sibling checkout is required.

Useful checks:

```sh
npm run install:check
npm run test:install
```

For development without linking:

```sh
npm run dev -- README.md
```

---

## Programmable config

`qe` has a trusted local config layer, closer to Emacs/Vim config than static settings. Config files are searched in this order:

1. `~/.config/qe/config.ts`
2. `~/.config/qe/config.mts`
3. `~/.config/qe/config.js`
4. `~/.config/qe/config.mjs`
5. `~/.qe/config.js`

Press **`SPC p e`** to open or create a starter config. For a new TypeScript config, `qe` also creates `~/.config/qe/config-api.ts` beside it, so the generated config is portable across machines and does not depend on this repo living at a hardcoded path.

The behavioral contract for loading, actions, hooks, command overrides, generated typing helpers, and prompt cancellation lives in [`docs/config-spec.md`](docs/config-spec.md).

Example:

```ts
import { defineConfig } from './config-api.ts'

export default defineConfig({
  preset: 'web',
  extras: ['typescript', 'git', 'ai', 'formatting'],

  commands: {
    'tasks.pickAndRun': async (ctx) => {
      const task = await ctx.ui.pick('Run task', [
        'npm run typecheck',
        'npm --prefix app run test',
        'cargo test --manifest-path native/editor-core/Cargo.toml',
      ])
      if (task) return [
        { type: 'shell.run', command: task },
        { type: 'panel.open', panel: 'shell' },
      ]
    },
  },

  leader: {
    p: { t: 'tasks.pickAndRun' },
    x: {
      t: [
        { type: 'shell.run', command: 'npm test' },
        { type: 'panel.open', panel: 'shell' },
      ],
    },
    z: { r: (ctx) => ctx.shell.run('cargo test') },
  },

  hooks: {
    onSave: async (ctx) => {
      if (ctx.filename?.endsWith('.ts')) await ctx.commands.run('code.format')
    },
    // onChange fires only after content revision changes and is debounced by 250ms.
  },

  tasks: [
    { name: 'typecheck', command: 'npm run typecheck', tab: 'process', autoJumpToError: true },
    { name: 'app tests', command: 'npm --prefix app run test', tab: 'process' },
  ],

  workspace: {
    roots: ['.'],
    ignore: ['coverage/**'],
    allow: [],
  },
})
```

### Config action forms

Leader leaves, hooks, and user commands can be written as:

| Form | Example |
|------|---------|
| Command ID | `'file.find'` |
| Command object | `{ command: 'shell.run', args: { command: 'npm test' } }` |
| Directive | `{ type: 'ui.notify', message: 'saved' }` |
| Directive array | `[{ type: 'shell.run', command: 'npm test' }, { type: 'panel.open', panel: 'shell' }]` |
| Function | `(ctx) => ctx.shell.run('cargo test')` |

Built-in command IDs include:

```txt
file.find          file.save          buffer.switch
buffer.keep        cursor.back        cursor.forward
shell.run          panel.open         ai.chat
code.hover         code.definition    code.format
git.status         git.hunk.stage     git.hunk.preview
diagnostics.list   diagnostics.next   diagnostics.line
workspace.code     workspace.process  workspace.ai
workspace.rescan
tasks.pickAndRun   tasks.run
```

Supported directives:

```txt
shell.run      panel.open     openFile
editor.insert  editor.move    command.run
ui.notify
```

`EditorContext` exposes `ctx.commands.run`, `ctx.ui.pick/input/confirm/notify/panel`, `ctx.git`, `ctx.lsp`, `ctx.diagnostics`, `ctx.shell`, `ctx.buffers`, and basic editor operations. Interactive UI prompts are intended for leader commands; hooks run from sidecar events and should stay quick.

---

## AI providers

The editor supports **Ollama** (default) and any **OpenAI-compatible API** (OpenAI, Groq, LM Studio, OpenRouter, …). Switch providers via env or at runtime with **`SPC a m`** (model picker).

### Env vars

Env is loaded from a `.env` file at the repo root at startup (no shell flag needed — handled by [`app/src/env-loader.ts`](app/src/env-loader.ts)).

#### Provider selection

| Variable | Default | Effect |
|----------|---------|--------|
| `AI_PROVIDER` | `ollama` | Set to `openai` / `openai-compat` for an OpenAI-compatible endpoint, or `none` to disable AI |

### Use without AI

`qe` does not require Ollama, OpenAI, or any AI network service. To force no-AI mode:

```sh
AI_PROVIDER=none qe README.md
```

In this mode the editor starts normally and AI commands/panels report `AI disabled`. File editing, Git, shell, leader keys, diagnostics, and programmable config remain available.

#### Ollama

| Variable | Default |
|----------|---------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | `qwen2.5-coder:1.5b` |

FIM (fill-in-middle) is used automatically for supported model families (qwen-coder ≥7B, deepseek-coder, starcoder, codellama). Smaller qwen-coder models fall back to chat + `[CURSOR]`.

#### OpenAI-compatible

| Variable | Default | Notes |
|----------|---------|-------|
| `AI_BASE_URL` | `https://api.openai.com` | Override for Groq (`https://api.groq.com/openai`), LM Studio (`http://localhost:1234`), etc. |
| `AI_API_KEY` | — | Falls back to `OPENAI_API_KEY` |
| `AI_MODEL` | `gpt-4o-mini` | Falls back to `OAPENAI_MODEL` |

Example `.env` for GPT-4o:

```
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
AI_MODEL=gpt-4o
```

Example `.env` for Groq:

```
AI_PROVIDER=openai
AI_BASE_URL=https://api.groq.com/openai
AI_API_KEY=gsk_...
AI_MODEL=llama-3.3-70b-versatile
```

### Runtime model switching (`SPC a m`)

Press **`SPC a m`** in normal mode to open the model picker. It fetches models from both Ollama and your OpenAI-compatible endpoint in parallel (Ollama first), displays them as `ollama/<name>` / `openai/<name>`, and switches the active provider immediately on selection. The current model is shown in the editor header.

---

## Keys (from `COMMAND_LABELS`)

Press **`SPC`** in normal mode for which-key. Bindings are defined in [`app/src/leader.ts`](app/src/leader.ts) (excerpt):

| Keys | Label |
|------|--------|
| `SPC a f` | ai: fix failure (CodeClaw) |
| `SPC a r` | ai: review git diff (CodeClaw) |
| `SPC a t` | ai: show trace |
| `SPC a p` | ai: open AI tab |
| `SPC a m` | ai: select model (model picker, switches provider) |
| `SPC a c` | ai: trigger completion |
| `SPC a e` | ai: explain last error |
| `SPC a l` | ai: rerun last shell command |
| `SPC a k` | ai: clear chat |
| `SPC t t` | terminal: toggle shell **panel** (strip under editor) |
| `SPC t a` | workspace: AI tab |
| `SPC t p` | workspace: **process** tab (full-screen shell) |
| `SPC t c` | workspace: code tab |

Shell **panel** vs **process** tab: same sidecar, different layout — see [`docs/workspace-ui.md`](docs/workspace-ui.md).
| `SPC m t` | tasks: pick and run |
| `SPC m r` | workspace: rescan file index |
| `SPC b K` | buffer: keep temporary editor |
| `SPC b [` / `SPC b ]` | cursor: back / forward |
| `Option-1..9` | switch to numbered tab shown as `⌥N` |
| `Option-[` / `Option-]` | previous / next workflow tab (buffers, then process, then AI); macOS may send `«` / `»` |
| `Ctrl+PageUp` / `Ctrl+PageDown` | same, when Option+[ does not register as Meta |
| `SPC g g` | git: status — ll commit log (Magit) |
| `SPC g s` | git: stage current |
| `SPC g h n/p` | git: next / previous hunk |
| `SPC g h s/u/v` | git: stage / unstage / preview hunk |
| `SPC g b` | git: blame line |
| `SPC g l` | git: log |
| `SPC c d` / `gd` | code: go to definition |
| `SPC c h` / `K` | code: hover |
| `SPC c f` | code: format |
| `SPC x x` | diagnostics: list |
| `SPC x n/p` | diagnostics: next / previous |
| `SPC p e` | config: edit config file |
| `SPC p r` | config: reload config |
| `SPC :` | command palette |
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
npm run test:e2e           # build native/app + terminal E2E contract
npm run install:check      # verify built CLI install readiness
npm run test:install       # isolated clone/build/link installability contract
npm run test:codeclaw      # CodeClaw tests only (tsx)
npm run test:protocol      # build native + protocol smoke
npm run build              # native release + minified app bundle (~600kb; see docs/build.md)
cargo test --manifest-path native/editor-core/Cargo.toml
```

Bundle size and `dist/main.js … ⚠️` meaning: [`docs/build.md`](docs/build.md).

Terminal E2E expectations are specified in [`docs/e2e-spec.md`](docs/e2e-spec.md).

Fixture failure (for the demo narrative):

```sh
npm --prefix examples/broken-counter test
```

---

## Editor sidecar binary

[`resolveEditorCoreBinary`](app/src/protocol.ts) picks the **newer** of `native/editor-core/target/release/editor-core` and `native/editor-core/target/debug/editor-core` if they exist. The sidecar runs in the user’s current working directory so `qe file.ts` resolves files relative to where the command was launched.

---

## Architecture (entry points)

| Path | Role |
|------|------|
| [`app/src/main.tsx`](app/src/main.tsx) | UI, modes, panels, fix/review flows, quit |
| [`app/src/config.ts`](app/src/config.ts) | Public config types, config search/loading, `defineConfig`, leader merge |
| [`app/src/config-runtime.ts`](app/src/config-runtime.ts) | Command registry, config action normalization, directive execution |
| [`app/src/leader.ts`](app/src/leader.ts) | Leader groups, labels, which-key flattening |
| [`app/src/protocol.ts`](app/src/protocol.ts) | Sidecar binary resolution, snapshot / LSP message types |
| [`app/src/codeclaw.ts`](app/src/codeclaw.ts) | CodeClaw fix/review, traces, git diff for review |
| [`app/src/shell.ts`](app/src/shell.ts) | Shell sidecar, `ShellRun` |
| [`app/src/git.ts`](app/src/git.ts) | Git operations |
| [`app/src/ai.ts`](app/src/ai.ts) | Chat / completion wrappers, prompt building, inline completion sanitizer |
| [`app/src/ai-provider.ts`](app/src/ai-provider.ts) | `AiProvider` interface |
| [`app/src/ai-registry.ts`](app/src/ai-registry.ts) | Active provider singleton, model picker helpers |
| [`app/src/ollama-provider.ts`](app/src/ollama-provider.ts) | Ollama HTTP provider (FIM + chat) |
| [`app/src/openai-compat-provider.ts`](app/src/openai-compat-provider.ts) | OpenAI-compatible SSE provider |
| [`native/editor-core/`](native/editor-core/) | Rust editor core |
| [`native/qe-core/`](native/qe-core/) | Legacy C protocol binary / QEmacs-derived sources |

---

## Cursor MCP config

The optional Cursor MCP config in [`.cursor/mcp.json`](.cursor/mcp.json) is intentionally portable. It uses:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DOCS_ROOT` | `$PWD` | Docs root for the MCP server |
| `DOCS_MEMORY_PYTHON` | `python3` | Python executable used to run `docs_memory_mcp` |

Set `DOCS_MEMORY_PYTHON` to a venv interpreter if needed; do not hardcode machine-local paths in the repo.

---

## License

Source files under [`native/qe-core/`](native/qe-core/) include **GNU LGPL** headers (QEmacs-derived). Other layout (e.g. `app/`) is project-local unless individual files state otherwise.
