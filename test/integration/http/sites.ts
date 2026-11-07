/** Inline fixture sites for the HTTP/TLS tests (each scenario has its own registrable domain). */
import type { RouteSpec } from '../../fixture-server/server.ts';

export const GOOD_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), geolocation=()',
};

const filler = '<p>Willkommen auf unserer Website. Hier steht ein Absatz mit etwas Inhalt.</p>'.repeat(40);

export const page = (title: string, extra = '') =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${filler}${extra}</body></html>`;

const html = (
  host: string,
  scheme: 'http' | 'https',
  path: string,
  body: string,
  headers = GOOD_HEADERS,
) => ({
  host,
  scheme,
  path,
  status: 200,
  headers,
  body,
});

const redirect = (host: string, scheme: 'http' | 'https', path: string, location: string, status = 301) => ({
  host,
  scheme,
  path,
  status,
  headers: { location },
  body: '',
});

const LEGAL_LINKS =
  '<footer><a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a></footer>';

/** redirect.test — the "good" site (http → 301 → https, full headers, Impressum without nosniff, apex → https://www as info). */
export const REDIRECT_SITE: RouteSpec[] = [
  redirect('www.redirect.test', 'http', '/', 'https://www.redirect.test/'),
  redirect('redirect.test', 'http', '/', 'https://www.redirect.test/'),
  redirect('redirect.test', 'https', '/', 'https://www.redirect.test/'),
  {
    ...html('www.redirect.test', 'https', '/', page('Start', LEGAL_LINKS)),
    headers: { ...GOOD_HEADERS, 'set-cookie': 'sid=fixture-secret; Path=/; HttpOnly' },
  },
  html(
    'www.redirect.test',
    'https',
    '/impressum',
    page('Impressum'),
    Object.fromEntries(Object.entries(GOOD_HEADERS).filter(([k]) => k !== 'x-content-type-options')),
  ),
  html('www.redirect.test', 'https', '/datenschutz', page('Datenschutz')),
];

/** plain.test — http serves the page (with a contact form) without redirect; https works too. */
export const PLAIN_SITE: RouteSpec[] = [
  html(
    'www.plain.test',
    'http',
    '/',
    page('Start', '<form method="post" action="/kontakt"><input type="email" name="email"></form>'),
  ),
  html('www.plain.test', 'https', '/', page('Start')),
];

/** httponly.test — http content, port 443 closed (routed in the test). */
export const HTTP_ONLY_SITE: RouteSpec[] = [html('www.httponly.test', 'http', '/', page('Start'))];

/** expired.test — http content, https with an expired certificate. */
export const EXPIRED_SITE: RouteSpec[] = [
  html('www.expired.test', 'http', '/', page('Start')),
  html('www.expired.test', 'https', '/', page('Start')),
];

/** meta.test — http answers with a small meta-refresh page; https works. */
export const META_SITE: RouteSpec[] = [
  html(
    'www.meta.test',
    'http',
    '/',
    '<!doctype html><meta http-equiv="refresh" content="0; url=https://www.meta.test/"><title>Weiter</title>',
  ),
  html('www.meta.test', 'https', '/', page('Start')),
];

/**
 * busy.test — www.busy.test answers normally and redirects to the target, so the target sees four different URLs and
 * www stays healthy (per-host state). The target's 429 answers come from the overload handler of the test.
 */
export const BUSY_SITE: RouteSpec[] = [
  redirect('www.busy.test', 'http', '/', 'http://busy.test/a'),
  redirect('www.busy.test', 'https', '/', 'https://busy.test/b'),
];

/** loop.test — endless redirect loop on http. */
export const LOOP_SITE: RouteSpec[] = [
  { host: 'www.loop.test', scheme: 'http', path: '/', status: 302, headers: { location: '/a' }, body: '' },
  { host: 'www.loop.test', scheme: 'http', path: '/a', status: 302, headers: { location: '/' }, body: '' },
  html('www.loop.test', 'https', '/', page('Start')),
];

/** port.test — the site only answers on https port 8443 (80/443 closed, routed in the test). */
export const PORT_SITE: RouteSpec[] = [html('www.port.test', 'https', '/', page('Start', LEGAL_LINKS))];

/** origin.test → moved.test — the start page redirects to another registrable domain with an expired certificate. */
export const MOVED_SITE: RouteSpec[] = [
  redirect('www.origin.test', 'http', '/', 'https://www.origin.test/'),
  redirect('www.origin.test', 'https', '/', 'https://www.moved.test/'),
  html('www.moved.test', 'https', '/', page('Start')),
];

/** sib.test — www redirects to a sibling subdomain whose certificate has expired. */
export const SIBLING_SITE: RouteSpec[] = [
  redirect('www.sib.test', 'http', '/', 'https://www.sib.test/'),
  redirect('www.sib.test', 'https', '/', 'https://shop.sib.test/'),
  html('shop.sib.test', 'https', '/', page('Shop')),
];

/** challenge.test — https answers the start page with a WAF challenge (429, x-vercel-mitigated) instead of the site. */
export const CHALLENGE_SITE: RouteSpec[] = [
  redirect('www.challenge.test', 'http', '/', 'https://www.challenge.test/'),
  {
    host: 'www.challenge.test',
    scheme: 'https',
    path: '/',
    status: 429,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-vercel-mitigated': 'challenge' },
    body: '<!doctype html><title>Security Checkpoint</title>',
  },
];

/**
 * builder.test — a site builder kept the slugs of copied pages: the Impressum is at /seite-3, the privacy
 * policy at /impressum-2.
 */
export const BUILDER_SITE: RouteSpec[] = [
  redirect('www.builder.test', 'http', '/', 'https://www.builder.test/'),
  html(
    'www.builder.test',
    'https',
    '/',
    page(
      'Start',
      '<nav><a href="/impressum-2">Datenschutz</a></nav>' +
        '<footer><a href="/seite-3">Impressum</a> · <a href="/impressum-2">Datenschutz</a></footer>',
    ),
  ),
  html('www.builder.test', 'https', '/seite-3', page('Impressum')),
  html('www.builder.test', 'https', '/impressum-2', page('Datenschutz')),
];

/** Headers of a server that names its software, with the operating system in a comment. */
export const VERSION_HEADERS: Record<string, string> = {
  ...GOOD_HEADERS,
  'x-powered-by': 'PHP/7.2.34',
  server: 'Apache/2.4.41 (Ubuntu)',
};

/** powered.test — start page and Impressum name PHP and Apache with versions; the Datenschutz page names none. */
export const POWERED_SITE: RouteSpec[] = [
  redirect('www.powered.test', 'http', '/', 'https://www.powered.test/'),
  redirect('powered.test', 'http', '/', 'https://www.powered.test/'),
  redirect('powered.test', 'https', '/', 'https://www.powered.test/'),
  html('www.powered.test', 'https', '/', page('Start', LEGAL_LINKS), VERSION_HEADERS),
  html('www.powered.test', 'https', '/impressum', page('Impressum'), VERSION_HEADERS),
  html('www.powered.test', 'https', '/datenschutz', page('Datenschutz'), {
    ...GOOD_HEADERS,
    server: 'nginx',
  }),
];

/** markup.test — the version is only in the page markup (meta generator, meta http-equiv), not in a response header. */
export const MARKUP_VERSION_SITE: RouteSpec[] = [
  html(
    'www.markup.test',
    'https',
    '/',
    '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="generator" content="WordPress 6.4.2">' +
      '<meta http-equiv="X-Powered-By" content="PHP/7.2.34"><title>Start</title></head><body><h1>Start</h1>' +
      `${filler}</body></html>`,
  ),
];

export const ALL_ROUTES: RouteSpec[] = [
  ...POWERED_SITE,
  ...MARKUP_VERSION_SITE,
  ...CHALLENGE_SITE,
  ...BUILDER_SITE,
  ...PORT_SITE,
  ...SIBLING_SITE,
  ...MOVED_SITE,
  ...REDIRECT_SITE,
  ...PLAIN_SITE,
  ...HTTP_ONLY_SITE,
  ...EXPIRED_SITE,
  ...META_SITE,
  ...BUSY_SITE,
  ...LOOP_SITE,
];
