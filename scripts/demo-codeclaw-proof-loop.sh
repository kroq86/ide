#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COUNTER="$ROOT_DIR/examples/broken-counter/src/counter.ts"
TRACE_DIR="$ROOT_DIR/.codeclaw/traces"
TRACE_FILE="$TRACE_DIR/demo-codeclaw-fix.json"

mkdir -p "$TRACE_DIR"

cat > "$COUNTER" <<'TS'
export function add(a: number, b: number): number {
  return a - b
}
TS

cleanup() {
  cat > "$COUNTER" <<'TS'
export function add(a: number, b: number): number {
  return a - b
}
TS
}
trap cleanup EXIT

pause() {
  sleep "${1:-0.7}"
}

say() {
  printf "\n\033[1;36m%s\033[0m\n" "$1"
  pause 0.45
}

cmd() {
  printf "\n\033[1;90m$ %s\033[0m\n" "$*"
  pause 0.35
  "$@"
}

printf "\033[2J\033[H"
printf "\033[1;37mCodeClaw v0.2 Proof Loop\033[0m\n"
printf "AI-native terminal workspace where the model sees the whole debugging session.\n"
printf "\n\033[1;33mLoop:\033[0m test fails -> SPC a f -> patch proposed -> accept -> test reruns -> trace saved\n"
pause 1

say "1. Open the intentionally broken demo file"
cmd sed -n '1,8p' examples/broken-counter/src/counter.ts

say "2. Run the test in the shell pane (SPC t t, then Enter)"
set +e
printf "\n\033[1;90m$ npm --prefix examples/broken-counter test\033[0m\n"
npm --prefix examples/broken-counter test
TEST_STATUS=$?
set -e
printf "\n\033[31mTracked ShellRun exitCode=%s\033[0m\n" "$TEST_STATUS"
pause 1

say "3. Press SPC a f"
printf "CodeClaw reads:\n"
printf "  - failing command and exit code\n"
printf "  - stderr/stdout tail\n"
printf "  - active file\n"
printf "  - git diff/status\n"
printf "  - .codeclaw/rules.md\n"
pause 1

say "4. Structured patch proposal"
cat <<'PATCH'
Root cause:
  add() subtracts b from a, so add(2, 3) returns -1 instead of 5.

Risk:
  low - small single-file patch with verification command

Patch:
  examples/broken-counter/src/counter.ts
    - return a - b
    + return a + b

Verify:
  npm --prefix examples/broken-counter test

Accept? [a] apply  [r] reject  [e] edit prompt
PATCH
pause 1.3

say "5. Press a to apply"
perl -0pi -e 's/return a - b/return a + b/' "$COUNTER"
cmd sed -n '1,8p' examples/broken-counter/src/counter.ts

say "6. CodeClaw reruns the verify command"
cmd npm --prefix examples/broken-counter test

say "7. Trace saved"
cat > "$TRACE_FILE" <<JSON
{
  "id": "demo-codeclaw-fix",
  "workflow": "fix",
  "startedAt": "2026-05-10T18:42:11Z",
  "input": {
    "command": "npm --prefix examples/broken-counter test",
    "activeFile": "examples/broken-counter/src/counter.ts",
    "gitBranch": "main"
  },
  "failure": {
    "exitCode": $TEST_STATUS,
    "locations": []
  },
  "proposal": {
    "summary": "Fix add() to add instead of subtract.",
    "rootCause": "add() subtracts b from a.",
    "filesChanged": ["examples/broken-counter/src/counter.ts"],
    "risk": "low",
    "assessedRisk": {
      "level": "low",
      "reasons": ["small single-file patch with verification command"],
      "canAutoApply": true,
      "requiresConfirm": false
    }
  },
  "accepted": true,
  "verify": {
    "command": "npm --prefix examples/broken-counter test",
    "exitCode": 0,
    "passed": true
  }
}
JSON

printf "\n\033[1;90m$ SPC a t\033[0m\n"
cat <<TRACE

Workflow: fix
Failure command: npm --prefix examples/broken-counter test
Root cause: add() subtracts b from a.
Files changed: examples/broken-counter/src/counter.ts
Accepted: yes
Verify command: npm --prefix examples/broken-counter test
Verify result: passed
Trace file: .codeclaw/traces/demo-codeclaw-fix.json
TRACE

pause 1.5
printf "\n\033[1;32mCodeClaw does not just suggest a fix. It proves what happened.\033[0m\n"
