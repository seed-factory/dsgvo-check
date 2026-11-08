/** Runs only the Vitest files that a change can affect; see the "Entwicklung" section of README.md. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { changedFiles, chooseSource, git, hasRef, headIsMerge } from './changes.ts';
import { scanDataConsumers } from './data-consumers.ts';
import { type Plan, planRun } from './plan.ts';

const DEFAULT_PROJECTS = ['unit', 'integration', 'e2e'];

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const ownArgs = split === -1 ? argv : argv.slice(0, split);
const passthrough = split === -1 ? [] : argv.slice(split + 1);

const { values } = parseArgs({
  args: ownArgs,
  options: {
    project: { type: 'string', multiple: true },
    base: { type: 'string' },
    files: { type: 'string', multiple: true },
    all: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
  strict: true,
});

const projects = values.project?.length ? values.project : DEFAULT_PROJECTS;
const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
const lines = (text: string) => text.split('\0').filter(Boolean);

const source = chooseSource({
  all: values.all,
  files: (values.files ?? []).map((file) =>
    path.relative(root, path.resolve(file)).split(path.sep).join('/'),
  ),
  base: values.base,
  env: process.env,
  headIsMerge: headIsMerge(root),
  hasRef: (ref) => hasRef(root, ref),
});

const repoFiles = lines(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
const sourceTexts = repoFiles
  .filter((file) => /^(src|test)\/.*\.ts$/.test(file))
  .flatMap((file) => {
    try {
      return [{ path: file, text: readFileSync(path.join(root, file), 'utf8') }];
    } catch {
      return [];
    }
  });

let plan: Plan;
let inputs: string[] = [];
if (source.kind === 'full') {
  plan = { mode: 'full', reasons: [source.reason] };
} else {
  inputs = source.kind === 'files' ? source.files : changedFiles(root, source);
  plan = planRun(inputs, { files: repoFiles, consumers: scanDataConsumers(sourceTexts) });
}

const label = projects.join(', ');
console.log(`Test selection for ${label}: ${plan.mode}`);
for (const reason of plan.reasons) console.log(`  ${reason}`);
if (plan.mode === 'selective') {
  console.log(`  ${plan.related.length} file(s) passed to vitest related`);
  for (const file of plan.related) console.log(`    ${file}`);
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const summary = [
    `### Test selection: ${label}`,
    '',
    plan.mode === 'full' ? 'Mode: full run' : `Mode: selective, ${plan.related.length} related file(s)`,
    '',
    ...plan.reasons.map((reason) => `- ${reason}`),
    '',
    '<details><summary>Inputs</summary>',
    '',
    ...(inputs.length > 0 ? inputs.map((file) => `- \`${file}\``) : ['- none']),
    '',
    '</details>',
    '',
  ];
  appendFileSync(summaryPath, `${summary.join('\n')}\n`);
}

const vitestBin = path.join(root, 'node_modules/vitest/vitest.mjs');
const projectArgs = projects.flatMap((name) => ['--project', name]);

async function listSelected(): Promise<void> {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    root,
    project: projects,
    watch: false,
    run: true,
    ...(plan.mode === 'selective' ? { related: plan.related } : {}),
  });
  try {
    const specs =
      plan.mode === 'selective' && plan.related.length === 0
        ? []
        : await vitest.getRelevantTestSpecifications();
    const byProject = new Map<string, string[]>(projects.map((name) => [name, []]));
    for (const spec of specs) byProject.get(spec.project.name)?.push(path.relative(root, spec.moduleId));
    for (const [name, files] of byProject) {
      console.log(`${name}: ${files.length}`);
      for (const file of files.sort()) console.log(`  ${file}`);
    }
  } finally {
    await vitest.close();
  }
}

if (values.list) {
  await listSelected();
  process.exit(0);
}

if (plan.mode === 'selective' && plan.related.length === 0) {
  console.log(`No affected tests for ${label}.`);
  process.exit(0);
}

const vitestArgs =
  plan.mode === 'full'
    ? ['run', ...projectArgs, ...passthrough]
    : ['related', '--run', '--passWithNoTests', ...projectArgs, ...passthrough, ...plan.related];
const child = spawnSync(process.execPath, [vitestBin, ...vitestArgs], { cwd: root, stdio: 'inherit' });
process.exit(child.status ?? 1);
