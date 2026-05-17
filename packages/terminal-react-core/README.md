# terminal-react-core

`terminal-react-core` is a React-based rendering core for building rich terminal applications.

It is useful when plain CLI output is no longer enough and you need a real terminal UI with layout, input handling, styled text, fullscreen mode, and reusable React components.

## Why a real user would need it

Top practical use cases:

1. AI coding assistant in the terminal
2. Interactive git or code review TUI
3. Deployment and DevOps dashboard
4. Database or admin console
5. CI/CD monitor with live updates
6. Internal developer dashboard
7. Interactive setup or configuration wizard
8. Agent or worker monitoring console
9. Support or operations tool for server environments
10. Power-user terminal productivity app

## What it gives you

- React-driven terminal rendering
- flexbox-style layout via the local Yoga TypeScript port
- styled text and ANSI-aware rendering
- keyboard, mouse, focus, and selection support
- fullscreen terminal app support
- standalone build output in `dist/`
- minimal `demo/` app included in this repo

## Quick start

```bash
npm install
npm run build
npm run demo
```

## Demo

The repo includes a real local `vmbench` toolbox TUI in [demo/index.tsx](/Users/ll/Documents/terminal-react-core/demo/index.tsx).

`npm run demo` launches a small operator-style terminal UI that:

- shows a selectable list of `vmbench` actions
- runs the local `vmbench` CLI with fixed presets
- renders structured JSON results inside the terminal UI
- shows inline failures for missing files or command errors

This is not direct MCP access from the demo runtime.
It is a local `vmbench` integration that demonstrates the kind of MCP-style operator workflow this renderer is meant to support.

Local dependency:

- required path: `/Users/ll/honeybadger`
- required CLI: `/Users/ll/honeybadger/vmbench_cli.py`

Some demo actions depend on files already existing inside the local `vmbench` repo, so `gate` and `compare` may intentionally render useful inline errors if those preset files are absent.

## Current status

This package now:

- typechecks successfully
- builds successfully into `dist/`
- runs a real CLI-backed toolbox demo locally

## Who this is for

This repo is most useful for:

- developers building complex CLI or TUI tools
- teams building terminal-first internal tools
- products that want a custom terminal renderer without app-specific wrapper code

It is less useful for:

- tiny one-shot CLIs with simple text output
- apps that do not need interactivity or layout
