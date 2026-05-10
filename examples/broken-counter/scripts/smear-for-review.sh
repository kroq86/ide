#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/src/rule_breaker.ts"
if grep -q 'CODECLAW_REVIEW_DEMO' "$FILE" 2>/dev/null; then
  echo "Already smeared — remove the CODECLAW_REVIEW_DEMO block from $FILE first." >&2
  exit 1
fi
cat >>"$FILE" <<'EOF'

// CODECLAW_REVIEW_DEMO — delete this block after trying CodeClaw Review (SPC a r)
export const unsafeDemo = (): unknown => eval('1+1')
EOF
echo "Appended demo violation to $FILE (git diff should be non-empty)."
