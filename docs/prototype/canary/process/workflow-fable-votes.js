export const meta = {
  name: 'canary2-fable-votes',
  description: 'Claude Fable 5.1 votes (accept/reject/verify) on every Codex GPT-6.1-Sol canary triage finding, per area, verifying against run data and code (read-only)',
  phases: [{ title: 'Vote', detail: 'one Fable agent per area', model: 'fable' }],
}

const RUN = '20261030-canary2'
const AREAS = ['CMP', 'REQ', 'LEG', 'NET', 'ROB']
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['votes'],
  properties: {
    votes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'vote', 'fixClass', 'reason', 'duplicateOf'],
        properties: {
          id: { type: 'string' },
          vote: { type: 'string', enum: ['accept', 'reject', 'verify'] },
          fixClass: { type: 'string', enum: ['code-bug', 'data-catalog', 'spec-question', 'by-design'] },
          reason: { type: 'string' },
          duplicateOf: { type: 'string' },
        },
      },
    },
  },
}

phase('Vote')
const results = await parallel(AREAS.map((key) => () => agent(
  `Repository: /Users/user/Documents/germany/coding-memes. Your full task instructions are in docs/prototype/canary/PROMPT-vote.md — read it first and follow it exactly, with these substitutions:
- {{RUN}} = ${RUN}
- {{AREA}} = the "area" field of the entry with key "${key}" in docs/prototype/canary/areas.json
- {{OTHER}} = Codex GPT-6.1-Sol
- {{FINDINGS_FILE}} = canary/results/${RUN}/triage/sol-${key}.json

Hard constraints: READ-ONLY. Do not edit, create or delete any file in the repository. No scans, builds, tests or network. Allowed: reading files, grep/jq/node -e over local JSON, \`node scripts/canary-summary.ts ${RUN} --with-sites --stdout\`.
Vote on EVERY finding in that file (one vote per id). Verify each against the actual run data and code you open yourself; do not trust the finding text. Return the JSON object per the schema.`,
  { label: `fable-vote:${key}`, phase: 'Vote', model: 'fable', schema: SCHEMA },
).then((r) => ({ key, ...r }))))

const ok = results.filter(Boolean)
log(`areas voted: ${ok.map((r) => `${r.key}=${r.votes.length}`).join(', ')}; missing: ${AREAS.filter((k) => !ok.some((r) => r.key === k)).join(',') || 'none'}`)
return { run: RUN, areas: ok }
