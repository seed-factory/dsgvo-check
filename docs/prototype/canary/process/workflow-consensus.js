export const meta = {
  name: 'canary2-consensus',
  description: 'Opus moderates Fable+Codex canary triage into consensus groups with fix zones; Fable critic checks it; moderator amends',
  phases: [
    { title: 'Moderate', detail: 'Opus moderator groups duplicates, decides, assigns zones' },
    { title: 'Critic', detail: 'Fable checks coverage, decisions vs spec, site-name leaks', model: 'fable' },
    { title: 'Amend', detail: 'moderator applies accepted corrections' },
  ],
}

const RUN = '20261030-canary2'
const T = `canary/results/${RUN}/triage`
const GROUP = {
  type: 'object', additionalProperties: false,
  required: ['gid', 'title', 'members', 'decision', 'zone', 'severity', 'kind', 'checkIds', 'siteCount', 'rationale', 'fix', 'testPlan', 'specRef', 'crossZone', 'question', 'evidence'],
  properties: {
    gid: { type: 'string' }, title: { type: 'string' },
    members: { type: 'array', items: { type: 'string' } },
    decision: { type: 'string', enum: ['fix', 'verify-then-fix', 'spec-question', 'rejected', 'by-design'] },
    zone: { type: 'string', enum: ['privacy', 'cmp', 'legal', 'requests', 'net', 'robustness', 'none'] },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    kind: { type: 'string' },
    checkIds: { type: 'array', items: { type: 'string' } },
    siteCount: { type: 'integer' },
    rationale: { type: 'string' }, fix: { type: 'string' }, testPlan: { type: 'string' }, specRef: { type: 'string' },
    crossZone: { type: 'string' }, question: { type: 'string' }, evidence: { type: 'string' },
  },
}
const CONSENSUS = {
  type: 'object', additionalProperties: false, required: ['groups', 'notes'],
  properties: { groups: { type: 'array', items: GROUP }, notes: { type: 'string' } },
}
const CRITIC = {
  type: 'object', additionalProperties: false, required: ['coverage', 'corrections'],
  properties: {
    coverage: { type: 'string' },
    corrections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['gid', 'problem', 'correction', 'severity'],
        properties: { gid: { type: 'string' }, problem: { type: 'string' }, correction: { type: 'string' }, severity: { type: 'string', enum: ['must', 'should'] } },
      },
    },
  },
}

phase('Moderate')
const draft = await agent(
  `Repository: /Users/user/Documents/germany/coding-memes. Read docs/prototype/canary/PROMPT-moderate.md and follow it exactly with {{RUN}} = ${RUN}. Every finding id from all ten ${T}/{fable,sol}-<ZONE>.json files must appear in exactly one group's members (94 ids in total; verify the count). The only file you may write is ${T}/consensus.json. Return the consensus object per the schema.`,
  { label: 'moderator', phase: 'Moderate', schema: CONSENSUS },
)
if (!draft) return { error: 'moderator failed' }
log(`draft: ${draft.groups.length} groups`)

phase('Critic')
const critic = await agent(
  `Repository: /Users/user/Documents/germany/coding-memes. READ-ONLY (do not modify any file). You are an adversarial reviewer of a consensus produced by a moderator over a canary-run triage of the dsgvo-check scanner prototype. Context and rules: docs/prototype/canary/PROMPT-moderate.md (what the moderator had to do), the inputs in ${T}/ (findings fable-*/sol-*, votes *-votes-on-*, merged.json), source of truth AGENTS.md, docs/03-checks.md, docs/consensus/README.md, docs/prototype/BRIEF.md, docs/prototype/STATUS.md.
The moderator's consensus (also written to ${T}/consensus.json):
${JSON.stringify(draft)}

Check and report corrections:
1. Coverage: every one of the 94 finding ids appears in exactly one group (list missing/duplicated ids).
2. Wrong merges (different root causes in one group) or missed merges (same root cause split).
3. Decisions that contradict the source of truth or the votes' verified evidence: a 'fix' that would make the code deviate from the spec (must be spec-question), a 'rejected' whose rejection reason you can refute from the run data/code, a 'spec-question' that is actually a plain code bug.
4. Zone assignment that cannot work given the file ownership in PROMPT-moderate.md (fix needs files of another zone and crossZone does not say so).
5. Any siteId, domain or site name inside title/rationale/fix/testPlan/question/crossZone (these go to git; only 'evidence' may hold siteIds).
6. Fix descriptions too vague for an implementer, or missing voter corrections ("Поправка").
Verify claims in the data/code yourself where it matters. Return coverage summary and corrections (severity must = needs change, should = improvement).`,
  { label: 'fable-critic', phase: 'Critic', model: 'fable', schema: CRITIC },
)
log(`critic: ${critic ? critic.corrections.length : 'failed'} corrections`)

phase('Amend')
const final = critic && critic.corrections.length
  ? await agent(
      `Repository: /Users/user/Documents/germany/coding-memes. You are the moderator again. Your draft consensus is in ${T}/consensus.json (rules: docs/prototype/canary/PROMPT-moderate.md, {{RUN}} = ${RUN}). An independent Fable critic returned these corrections:
${JSON.stringify(critic)}

For each correction: verify it against the data/code/spec; apply every 'must' that holds and every 'should' you agree with; ignore those you can refute (say why in notes). Keep every finding id in exactly one group. Overwrite ${T}/consensus.json with the amended consensus (only that file may be written) and return the amended object per the schema. In notes, list which corrections you applied and which you refused, with one-line reasons.`,
      { label: 'moderator-amend', phase: 'Amend', schema: CONSENSUS },
    )
  : draft
return { consensus: final || draft, critic }
