#!/bin/bash
# Usage: codex-review.sh <RUN> ; one codex gpt-6.1-sol review session per fix zone, in parallel.
# Expects canary/results/<RUN>/review/zone-<zone>.diff (diff of the fix rounds per zone). Review findings of later
# rounds (canary/results/_handoff-*/review-round.json, field merged.findings) are added to the zone's group list.
# REPO defaults to the checkout this script lives in.
set -u
RUN=$1
REPO=${REPO:-$(cd "$(dirname "$0")/../../../.." && pwd)}
OUT=$REPO/canary/results/$RUN/review
cd "$REPO"
review_zone() {
  local zone=$1 prompt outfile log
  prompt=$(python3 - "$RUN" "$zone" <<'PY'
import glob,json,sys
run,zone=sys.argv[1:3]
groups=json.load(open(f'canary/results/{run}/triage/consensus.json'))['groups']
ids=[g['gid'] for g in groups if g['zone']==zone and g['decision'] in ('fix','verify-then-fix')]
for f in sorted(glob.glob('canary/results/_handoff-*/review-round.json')):
    ids+=[x['mid'] for x in json.load(open(f))['merged']['findings'] if x['zone']==zone]
t=open('docs/prototype/canary/PROMPT-review.md').read()
print(t.replace('{{ZONE}}',zone).replace('{{GIDS}}',', '.join(ids))
       .replace('{{DIFF}}',f'canary/results/{run}/review/zone-{zone}.diff').replace('{{PREFIX}}',f'S-{zone}'))
PY
)
  outfile=$OUT/sol-review-$zone.json; log=$OUT/sol-review-$zone.log
  for attempt in 1 2 3; do
    codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only --ephemeral -C "$REPO" \
      --output-schema docs/prototype/canary/review.schema.json -o "$outfile.tmp" "$prompt" > "$log" 2>&1 < /dev/null
    if python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$outfile.tmp" 2>/dev/null; then
      mv "$outfile.tmp" "$outfile"; echo "$zone ok (attempt $attempt)"; return 0
    fi
    if grep -q "usage limit" "$log"; then echo "$zone usage limit, stop"; return 1; fi
    echo "$zone attempt $attempt failed"; sleep 30
  done
  echo "$zone FAILED"; return 1
}
export -f review_zone; export RUN REPO OUT
for zone in privacy cmp legal requests net robustness; do
  review_zone "$zone" &
done
wait
echo "all done"
