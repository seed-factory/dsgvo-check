/**
 * Steps of release.yml.
 * - `node release.ts`: checks that the release may start and sets the step output `version`.
 * - `node release.ts summary`: writes image, Action tag and GitLab integrity hash into the job summary.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { loadRuleset, loadTexts } from '../../src/core/data/load.ts';
import { githubFile, packageVersion, setOutput } from './common.ts';

const GITLAB_TEMPLATE = new URL('../../templates/gitlab/dsgvo-check.gitlab-ci.yml', import.meta.url);

/** The version typed into the workflow form; it must equal package.json, which the image and the tags follow. */
function releaseVersion(): string {
  const version = process.env.VERSION;
  const expected = packageVersion();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || version !== expected) {
    throw new Error(`Release version must equal package.json version ${expected}.`);
  }
  return version;
}

/** The ruleset and the German texts ship only after customer sign-off (`draft: false`). */
function assertNoDrafts(): void {
  const texts = loadTexts('de');
  const drafts = [texts.messages, texts.legalNotes, texts.ui]
    .flatMap((entries) => Object.entries(entries))
    .filter(([, entry]) => entry.draft)
    .map(([key]) => `texts/de ${key}`);
  if (loadRuleset().profile.draft) drafts.unshift('ruleset de-2026');

  if (drafts.length > 0) throw new Error(`Release blocked by drafts: ${drafts.slice(0, 5).join(', ')} …`);
}

/** A release never moves an existing tag: the API must answer 404 for `v<version>`. */
function assertTagIsNew(version: string): void {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid release repository.');

  const tag = spawnSync('gh', ['api', `repos/${repository}/git/ref/tags/v${version}`], { encoding: 'utf8' });
  if (tag.status === 0) throw new Error(`Release tag v${version} already exists.`);
  if (tag.error || !tag.stderr?.includes('HTTP 404')) {
    throw new Error('Could not confirm that the release tag is new.');
  }
}

function writeSummary(version: string): void {
  const integrity = createHash('sha256').update(readFileSync(GITLAB_TEMPLATE)).digest('base64');
  const lines = [
    `### dsgvo-check v${version}`,
    '',
    `- Image: \`ghcr.io/seed-factory/dsgvo-check:${version}\``,
    `- GitHub Action: \`uses: seed-factory/dsgvo-check@v${version}\``,
    `- GitLab template at \`v${version}\`: \`integrity: sha256-${integrity}\``,
  ];
  appendFileSync(githubFile('GITHUB_STEP_SUMMARY'), `${lines.join('\n')}\n`);
}

const version = releaseVersion();

if (process.argv[2] === 'summary') {
  writeSummary(version);
} else {
  assertNoDrafts();
  assertTagIsNew(version);
  setOutput('version', version);
}
