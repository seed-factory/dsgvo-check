export const meta = {
  name: 'canary2-fable-triage',
  description: 'Claude Fable 5.1 triages canary run 20261030-canary2 in 5 independent areas (read-only), returns structured findings',
  phases: [{ title: 'Triage', detail: 'one Fable agent per area: CMP, REQ, LEG, NET, ROB', model: 'fable' }],
}

const RUN = '20261030-canary2'
const AREAS = ['CMP', 'REQ', 'LEG', 'NET', 'ROB']

const FINDING = {
  type: 'object', additionalProperties: false,
  required: ['id','kind','fixClass','severity','checkId','variant','summary','sites','siteCount','evidence','rootCause','files','specRef','fix','testPlan','confidence'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['false-positive','false-negative','inconclusive-excess','crash-error','privacy-leak','report-quality','perf','spec-gap'] },
    fixClass: { type: 'string', enum: ['code-bug','data-catalog','spec-question','by-design'] },
    severity: { type: 'string', enum: ['blocker','major','minor'] },
    checkId: { type: 'string' }, variant: { type: 'string' }, summary: { type: 'string' },
    sites: { type: 'array', items: { type: 'string' } }, siteCount: { type: 'integer' },
    evidence: { type: 'string' }, rootCause: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    specRef: { type: 'string' }, fix: { type: 'string' }, testPlan: { type: 'string' },
    confidence: { type: 'string', enum: ['high','medium','low'] },
  },
}
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['area','verdict','findings'],
  properties: { area: { type: 'string' }, verdict: { type: 'string' }, findings: { type: 'array', items: FINDING } },
}

phase('Triage')
const results = await parallel(AREAS.map((key) => () => agent(
  `Repository: /Users/user/Documents/germany/coding-memes. Your full task instructions are in the file docs/prototype/canary/PROMPT-triage.md — read it first and follow it exactly, with these substitutions:
- {{RUN}} = ${RUN}
- {{AREA}} = the "area" field of the entry with key "${key}" in docs/prototype/canary/areas.json
- {{SCOPE}} = the "scope" field of that same entry
- {{PREFIX}} = F-${key}

Hard constraints: READ-ONLY. Do not edit, create or delete any file in the repository (not src/, data/, test/, docs/, canary/). Do not run scans, builds, tests or anything that touches the network. Allowed: reading files, grep/jq/node -e over local JSON, and \`node scripts/canary-summary.ts ${RUN} --with-sites --stdout\`.
Another model analyses the same area independently; be precise and evidence-driven, every claim backed by a siteId + JSON path or code file:line you actually opened. Return the JSON object per the schema (area = "${key}").`,
  { label: `fable-triage:${key}`, phase: 'Triage', model: 'fable', schema: SCHEMA },
).then((r) => ({ key, ...r }))))

const ok = results.filter(Boolean)
log(`areas returned: ${ok.map((r) => `${r.key}=${r.findings.length}`).join(', ')}; missing: ${AREAS.filter((k) => !ok.some((r) => r.key === k)).join(',') || 'none'}`)
return { run: RUN, areas: ok }
