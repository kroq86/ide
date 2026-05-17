# qe Installability Contract

This contract defines the first installable milestone for `qe`. It is intentionally smaller than npm publishing or prebuilt release artifacts: a user can clone the repo, build locally, link the CLI, and run the editor without any sibling checkout or AI service.

## Supported Platforms

- macOS and Linux are supported for this milestone.
- Windows is WSL-first for now. Native Windows packaging is deferred.

## Required Tools

- Node.js 22 or newer
- npm
- Rust/Cargo
- Git

If any required tool is missing, the failed command should make the missing dependency clear. The CLI itself checks Node version, built app output, and the native sidecar.

## Install Path

From a fresh clone:

```sh
npm install
npm run build
npm link
qe README.md
```

This must work without `/Users/...` paths, without a sibling `terminal-react-core` checkout, and without developer-only scripts.

## Workspace Dependency Contract

- `terminal-react-core` lives inside this repo at `packages/terminal-react-core`.
- The root package uses npm workspaces for `app` and `packages/terminal-react-core`.
- `app/package.json` depends on `terminal-react-core` via `file:../packages/terminal-react-core`.
- The root package still declares npm workspaces so workspace scripts can target both packages. The dependency uses `file:` because npm 11 rejects `workspace:*` in this repo shape during the fresh-clone install contract.
- A fresh `npm install` at the repo root must wire the app dependency.

## CLI Contract

Public command:

```sh
qe [file]
```

The CLI lives at `bin/qe.mjs` and is exposed through root `package.json`:

```json
{ "bin": { "qe": "./bin/qe.mjs" } }
```

The CLI resolves the package root from its own location, then launches `app/dist/main.js` with all user arguments forwarded.

Failure diagnostics:

- If `app/dist/main.js` is missing, exit non-zero and print `Run npm run build first`.
- If the Rust sidecar binary is missing, exit non-zero and print `Run npm run build:native first`.
- If Node is older than 22, exit non-zero and print `qe requires Node.js 22+`.

## Native Sidecar Contract

The local build creates:

```text
native/editor-core/target/release/editor-core
```

The app resolves the sidecar package-relative from the built app, preferring the newest existing release/debug `editor-core` binary. The sidecar process runs with the user's current working directory so relative file paths and project operations behave like a normal CLI editor.

Prebuilt native binaries are out of scope for this milestone.

## No-AI Contract

AI is optional. Core editor, Git, shell, config, leader keys, and file editing must work without Ollama, OpenAI, or any network AI provider.

Users can explicitly disable AI:

```sh
AI_PROVIDER=none qe README.md
```

In no-AI mode:

- startup must not call Ollama/OpenAI;
- AI panels/commands show `AI disabled` instead of trying network calls;
- non-AI editor flows keep working.

## Verification

Required scripts:

```sh
npm run install:check
npm run test:install
```

`install:check` verifies built app output, sidecar binary, workspace dependency wiring, and CLI readiness.

`test:install` verifies the clone/build/link contract in an isolated temp copy and checks failure diagnostics for missing app/native output.
