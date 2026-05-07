# qe-react-editor

A terminal-native React editor prototype: modal text editing in the main pane, plus shell, git, and AI panels sharing one session context.

The project is intentionally split into a React terminal UI and small sidecars. The current editor sidecar is a prototype JSONL line-buffer, not the full QEmacs editor core.

## Current State

- React terminal UI built with `terminal-react-core`
- Alternate-screen full-terminal rendering
- Normal, insert, visual, command, and search modes
- Vim-like basics: `hjkl`, `w/b`, `gg/G`, `dd`, `yy`, `p/P`, visual select/delete/yank
- Undo/redo: `u` and `Ctrl-R`
- Lightweight buffer records with one active editor sidecar
- Buffer commands under `SPC b`
- File prompt under `SPC f f`
- Shell panel with semantic error/location capture
- Git panel with status, hunk expansion, stage/unstage, commit, pull, push, log
- AI chat/completion hooks using Ollama streaming
- Session context for AI: active file, open buffers, shell sessions, git summary

## Requirements

- Node.js 22+
- npm
- `make` and a C compiler for `native/qe-core/qe-protocol`
- A sibling checkout/build of `terminal-react-core`
- Optional: Ollama for AI features

Expected local layout for the current prototype:

```text
~/Documents/
  terminal-react-core/
  qe-react-editor/
```

The app dependency uses `file:../../terminal-react-core` from `app/`.

## Install

```sh
npm --prefix app install
npm run build:native
```

## Run

```sh
bash scripts/dev.sh README.md
```

or:

```sh
npm run dev -- README.md
```

Quit with `Ctrl-Q`.

## Useful Commands

```sh
npm run build
npm run typecheck
npm run test:protocol
```

## Editor Keys

- `i`, `a`, `I`, `A`, `o`, `O`: enter insert mode
- `Esc`: normal mode
- `h/j/k/l`, arrows: move
- `w`, `b`: word movement
- `gg`, `G`: file start/end
- `/`: search, then `n` / `N`
- `v`, `V`: visual mode
- `dd`, `yy`, `p`, `P`: delete/yank/paste
- `u`: undo
- `Ctrl-R`: redo
- `Ctrl-S`: save
- `Ctrl-Q`: quit

## Leader Keys

Press `SPC` in normal mode to open the which-key menu.

- `SPC b b`: switch buffer
- `SPC b l`: list/switch buffers
- `SPC b n`: next buffer
- `SPC b p`: previous buffer
- `SPC b N`: new scratch buffer
- `SPC b k`: kill buffer
- `SPC f f`: open file
- `SPC t t`: toggle shell panel
- `SPC t a`: toggle AI panel
- `SPC a p`: open AI chat
- `SPC a c`: trigger completion
- `SPC a e`: explain last shell error
- `SPC g g`: open git panel
- `SPC g s`: stage current file

## Git Panel

Open with `SPC g g`.

- `j/k`: move
- `Tab`: expand/collapse file hunks
- `s`: stage selected file/hunk
- `u`: unstage selected file/hunk
- `cc`: commit prompt
- `ll`: show recent log
- `F`: pull
- `P`: push
- `g` or `r`: refresh
- `q` or `Esc`: close

## AI

AI calls use Ollama by default:

```sh
export OLLAMA_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.2:latest
```

The AI context currently includes the active buffer, open buffer names, recent shell sessions, and git status/diff summary.

## Architecture

```text
app/src/main.tsx        React terminal UI, modes, panels, key handling
app/src/protocol.ts    JSONL wrapper for the editor sidecar
app/src/shell.ts       PTY shell sidecar and semantic shell capture
app/src/git.ts         Git status/diff/log/stage helpers
app/src/ai.ts          Ollama streaming chat/completion
native/qe-core/
  qe-protocol.c        Prototype line-buffer sidecar
```

The long-term core is undecided. The current C sidecar is useful scaffolding; a future owned core would likely move toward a real rope buffer, structured undo, syntax, and LSP.

## License Notes

QEmacs-derived files under `native/qe-core/` retain their original LGPL terms. The TypeScript prototype code in `app/` is local project code.
