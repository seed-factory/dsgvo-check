/** Honest User-Agent token with a link to the repository, as required by the specification. */
import { TOOL_NAME, TOOL_VERSION } from './version.ts';

export const REPO_URL = 'https://github.com/seed-factory/dsgvo-check';

export function uaToken(version: string = TOOL_VERSION): string {
  return `${TOOL_NAME}/${version} (+${REPO_URL}; passive DSGVO/security check)`;
}

/** Browser: the real Chrome UA from `browser.version()` (HeadlessChrome → Chrome) plus the token. */
export function browserUserAgent(chromeUserAgent: string, version: string = TOOL_VERSION): string {
  return `${chromeUserAgent.replace(/HeadlessChrome\//g, 'Chrome/')} ${uaToken(version)}`;
}

export const ACCEPT_LANGUAGE = 'de-DE,de;q=0.9,en;q=0.5';
