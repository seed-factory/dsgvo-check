#!/bin/bash
# Usage: codex-critique.sh <RUN> ; one codex gpt-6.1-sol session writes an architecture/test-quality critique (Markdown).
# Output: canary/results/<RUN>/review/sol-critique.md. REPO defaults to the checkout this script lives in.
set -u
RUN=$1
REPO=${REPO:-$(cd "$(dirname "$0")/../../../.." && pwd)}
OUT=$REPO/canary/results/$RUN/review
mkdir -p "$OUT"
cd "$REPO"
prompt=$(cat docs/prototype/canary/PROMPT-critique.md)
for attempt in 1 2 3; do
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only --ephemeral -C "$REPO" \
    -o "$OUT/sol-critique.md.tmp" "$prompt" > "$OUT/sol-critique.log" 2>&1 < /dev/null
  if [ -s "$OUT/sol-critique.md.tmp" ]; then mv "$OUT/sol-critique.md.tmp" "$OUT/sol-critique.md"; echo "critique ok"; exit 0; fi
  if grep -q "usage limit" "$OUT/sol-critique.log"; then echo "usage limit, stop"; exit 1; fi
  echo "attempt $attempt failed"; sleep 30
done
echo "critique FAILED"; exit 1
