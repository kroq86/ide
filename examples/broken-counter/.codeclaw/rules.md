# Example-local rules (CodeClaw Review)

These apply when you run review (`SPC a r`) on a buffer whose path lives under `examples/broken-counter/`. They are **prepended** to the repo root `.codeclaw/rules.md`.

- **No dynamic execution:** do not use `eval()`, `new Function(...)`, or the `Function` constructor in source files under this example.
