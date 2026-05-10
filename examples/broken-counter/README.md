# Broken Counter Demo

This tiny fixture is intentionally broken for the CodeClaw demo.

```sh
npm --prefix examples/broken-counter test
```

Expected demo flow:

```text
1. Open examples/broken-counter/src/counter.ts.
2. Press `SPC t t` and run `npm --prefix examples/broken-counter test` in the shell pane.
3. Press SPC a f.
4. Review the patch.
5. Press a to apply.
6. Watch the test rerun and pass.
7. Press SPC a t to view the trace.
```

## Review demo (rule violation + trace)

From the **repository root** (so `.codeclaw/rules.md` resolves):

```sh
./examples/broken-counter/scripts/smear-for-review.sh
```

Open `examples/broken-counter/src/rule_breaker.ts`, ensure your cwd for the editor session is the repo root, then press **SPC a r**. The model should flag the staged/unstaged diff against the rules (including **no `eval()`**). Each review run writes **`.codeclaw/traces/review/<id>-codeclaw-review.json`** (fix traces stay in `.codeclaw/traces/*.json`).

Revert the smear:

```sh
git checkout -- examples/broken-counter/src/rule_breaker.ts
```
