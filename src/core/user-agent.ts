/** User-Agent per D10: literal TZ requirement — an honest token with a link to the repository. */
import { TOOL_NAME, TOOL_VERSION } from './version.ts';

export const REPO_URL = 'https://github.com/seed-factory/dsgvo-check';

export function uaToken(version: string = TOOL_VERSION): string {
  return `${TOOL_NAME}/${version} (+${REPO_URL}; passive DSGVO/security check)`;
}

/** HTTP/TLS probes: the token alone. */
export function httpUserAgent(version: string = TOOL_VERSION): string {
  return uaToken(version);
}

/** Browser: the real Chrome UA from `browser.version()` (HeadlessChrome → Chrome) plus the token. */
export function browserUserAgent(chromeUserAgent: string, version: string = TOOL_VERSION): string {
  return `${chromeUserAgent.replace(/HeadlessChrome\//g, 'Chrome/')} ${uaToken(version)}`;
}

export const ACCEPT_LANGUAGE = 'de-DE,de;q=0.9,en;q=0.5';
