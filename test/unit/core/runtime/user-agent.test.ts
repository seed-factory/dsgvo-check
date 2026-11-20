/**
 * The honest User-Agent: the tool's name and version, what it does and the repository link. The link follows the
 * description without `+`, so the token does not take the ` (+http…` form crawler tests look for.
 */
import { describe, expect, it } from 'vitest';
import { browserUserAgent, REPO_URL, uaToken } from '../../../../src/core/runtime/user-agent.ts';
import { TOOL_VERSION } from '../../../../src/core/runtime/version.ts';

const HEADLESS =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';

describe('User-Agent token', () => {
  it('names the tool, its version, the passive check and the repository', () => {
    expect(uaToken('1.2.3')).toBe(
      'dsgvo-check/1.2.3 (passive DSGVO/security check; https://github.com/seed-factory/dsgvo-check)',
    );
    expect(uaToken()).toBe(uaToken(TOOL_VERSION));
    expect(uaToken()).toContain(REPO_URL);
  });

  it.each([
    ['the HTTP token', uaToken()],
    ['the browser User-Agent', browserUserAgent(HEADLESS)],
  ])('%s carries no link in the crawler form "(+http"', (_name, userAgent) => {
    expect(userAgent).not.toMatch(/\(\s*\+\s*http/i);
  });
});

describe('browser User-Agent', () => {
  it('is the Chrome User-Agent of the engine, headless named as Chrome, followed by the token', () => {
    expect(browserUserAgent(HEADLESS, '1.2.3')).toBe(
      `${HEADLESS.replace('HeadlessChrome/', 'Chrome/')} ${uaToken('1.2.3')}`,
    );
    expect(browserUserAgent(HEADLESS)).not.toContain('HeadlessChrome');
  });
});
