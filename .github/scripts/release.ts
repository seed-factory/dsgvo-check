import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { loadRuleset, loadTexts } from '../../src/core/data/load.ts';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const version = process.env.VERSION;
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || version !== pkg.version) {
  throw new Error(`Release version must equal package.json version ${pkg.version}.`);
}

if (process.argv[2] === 'summary') {
  const template = readFileSync(new URL('../../templates/gitlab/dsgvo-check.gitlab-ci.yml', import.meta.url));
  const integrity = createHash('sha256').update(template).digest('base64');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY as string,
    `### dsgvo-check v${version}\n\n` +
      `- Image: \`ghcr.io/seed-factory/dsgvo-check:${version}\`\n` +
      `- GitHub Action: \`uses: seed-factory/dsgvo-check@v${version}\`\n` +
      `- GitLab template at \`v${version}\`: \`integrity: sha256-${integrity}\`\n`,
  );
} else {
  // The ruleset and the German texts ship only after customer sign-off (draft: false).
  const texts = loadTexts('de');
  const drafts = [texts.messages, texts.legalNotes, texts.ui]
    .flatMap((entries) => Object.entries(entries))
    .filter(([, entry]) => entry.draft)
    .map(([key]) => `texts/de ${key}`);
  if (loadRuleset().profile.draft) drafts.unshift('ruleset de-2026');
  if (drafts.length > 0) throw new Error(`Release blocked by drafts: ${drafts.slice(0, 5).join(', ')} …`);

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid release repository.');
  const tag = spawnSync('gh', ['api', `repos/${repository}/git/ref/tags/v${version}`], {
    encoding: 'utf8',
  });
  if (tag.status === 0) throw new Error(`Release tag v${version} already exists.`);
  if (tag.error || !tag.stderr?.includes('HTTP 404')) {
    throw new Error('Could not confirm that the release tag is new.');
  }
  appendFileSync(process.env.GITHUB_OUTPUT as string, `version=${version}\n`);
}
