/**
 * Honest User-Agent token with a link to the repository, as required by the specification. The link follows the
 * description and carries no `+`: search engine crawlers announce themselves as ` (+http…`, and a CMP that tests for
 * that form (CCM19's `isBotBrowser`) would keep its banner closed and the scanner would not see what a visitor sees.
 */
import { TOOL_NAME, TOOL_VERSION } from './version.ts';

export const REPO_URL = 'https://github.com/seed-factory/dsgvo-check';

export function uaToken(version: string = TOOL_VERSION): string {
  return `${TOOL_NAME}/${version} (passive DSGVO/security check; ${REPO_URL})`;
}

/** Browser: the real Chrome UA from `browser.version()` (HeadlessChrome → Chrome) plus the token. */
export function browserUserAgent(chromeUserAgent: string, version: string = TOOL_VERSION): string {
  return `${chromeUserAgent.replace(/HeadlessChrome\//g, 'Chrome/')} ${uaToken(version)}`;
}

export const ACCEPT_LANGUAGE = 'de-DE,de;q=0.9,en;q=0.5';
