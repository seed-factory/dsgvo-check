import { appendFileSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
appendFileSync(process.env.GITHUB_OUTPUT as string, `version=${version}\n`);
