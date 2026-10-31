#!/bin/bash
# Usage: codex-verify.sh <RUN> <MID> ; codex gpt-6.1-sol verifies one merged review finding (read-only, no repro test).
# Expects canary/results/<RUN>/review/findings/<MID>.json; writes sol-verdict-<MID>.json next to it.
# REPO defaults to the checkout this script lives in.
set -u
RUN=$1; MID=$2
REPO=${REPO:-$(cd "$(dirname "$0")/../../../.." && pwd)}
DIR=$REPO/canary/results/$RUN/review/findings
cd "$REPO"
prompt=$(python3 - "$DIR/$MID.json" <<'PY'
import sys
t=open('docs/prototype/canary/PROMPT-verify.md').read()
f=open(sys.argv[1]).read()
t=t.replace('{{FINDING}}',f).replace('{{TMPTEST}}','(песочница только на чтение: временный тест не создавай, воспроизводи через node -e или разбором кода)')
print(t)
PY
)
out=$DIR/sol-verdict-$MID.json; log=$DIR/sol-verdict-$MID.log
for attempt in 1 2 3; do
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only --ephemeral -C "$REPO" \
    --output-schema docs/prototype/canary/verdict.schema.json -o "$out.tmp" "$prompt" > "$log" 2>&1 < /dev/null
  if python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$out.tmp" 2>/dev/null; then
    mv "$out.tmp" "$out"; echo "$MID ok (attempt $attempt)"; exit 0
  fi
  echo "$MID attempt $attempt failed"; sleep 30
done
echo "$MID FAILED"; exit 1
