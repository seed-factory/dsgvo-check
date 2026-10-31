#!/bin/bash
# Usage: codex-triage.sh <mode triage|vote> <RUN> ; runs one codex gpt-6.1-sol session per area, in parallel.
set -u
MODE=$1; RUN=$2
REPO=/Users/user/Documents/germany/coding-memes
OUT=$REPO/canary/results/$RUN/triage
mkdir -p "$OUT"
cd "$REPO"
run_area() {
  local key=$1 area=$2 scope=$3
  local prompt schema outfile log
  if [ "$MODE" = triage ]; then
    prompt=$(python3 - "$RUN" "$area" "$scope" "S-$key" <<'PY'
import sys
t=open('docs/prototype/canary/PROMPT-triage.md').read()
run,area,scope,prefix=sys.argv[1:5]
print(t.replace('{{RUN}}',run).replace('{{AREA}}',area).replace('{{SCOPE}}',scope).replace('{{PREFIX}}',prefix))
PY
)
    schema=docs/prototype/canary/triage.schema.json; outfile=$OUT/sol-$key.json
  else
    prompt=$(python3 - "$RUN" "$area" "$OUT/fable-$key.json" <<'PY'
import sys
t=open('docs/prototype/canary/PROMPT-vote.md').read()
run,area,f=sys.argv[1:4]
print(t.replace('{{RUN}}',run).replace('{{AREA}}',area).replace('{{OTHER}}','Claude Fable 5.1').replace('{{FINDINGS_FILE}}',f))
PY
)
    schema=docs/prototype/canary/votes.schema.json; outfile=$OUT/sol-votes-on-fable-$key.json
  fi
  log=$OUT/sol-$MODE-$key.log
  for attempt in 1 2 3; do
    codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only --ephemeral -C "$REPO" \
      --output-schema "$schema" -o "$outfile.tmp" "$prompt" > "$log" 2>&1 < /dev/null
    if python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$outfile.tmp" 2>/dev/null; then
      mv "$outfile.tmp" "$outfile"; echo "$key ok (attempt $attempt)"; return 0
    fi
    echo "$key attempt $attempt failed"; sleep 30
  done
  echo "$key FAILED"; return 1
}
export -f run_area; export MODE RUN REPO OUT
while IFS= read -r key && IFS= read -r area && IFS= read -r scope; do
  run_area "$key" "$area" "$scope" &
done < <(python3 -c "
import json
for a in json.load(open('docs/prototype/canary/areas.json')):
    print(a['key']); print(a['area']); print(a['scope'])
")
wait
echo "all done"
