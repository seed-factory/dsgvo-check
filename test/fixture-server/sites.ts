/**
 * Fixture sites keyed by their directory under test/fixture-server/sites/. `hosts` maps a hostname to its docroot, `tls`
 * the certificate kind per host (default valid), `routes` are fixed responses, `fileHeaders` per-file response headers.
 */
import type { CertKind } from '../utils/certs.ts';
import type { RouteSpec } from './server.ts';

export interface SiteConfig {
  hosts: Record<string, string>;
  tls?: Record<string, CertKind>;
  routes?: RouteSpec[];
  fileHeaders?: Record<string, Record<string, string | string[]>>;
}

const html = { 'content-type': 'text/html; charset=utf-8' };
const gaCollect: RouteSpec = { host: 'www.google-analytics.com', path: '/g/collect', status: 204 };
/** Google Fonts stylesheet and font file under the docroots `fonts` and `gstatic`, readable cross-origin. */
const fontFiles: Record<string, Record<string, string>> = {
  'fonts/css2': { 'content-type': 'text/css; charset=utf-8', 'access-control-allow-origin': '*' },
  'gstatic/s/roboto/v30/fixture-roboto.woff2': {
    'content-type': 'font/woff2',
    'access-control-allow-origin': '*',
  },
};

export const SITES: Record<string, SiteConfig> = {
  'browser/clean': { hosts: { 'www.example.test': 'www' } },
  'browser/cmp-stub': {
    hosts: {
      'www.example.test': 'www',
      'www.googletagmanager.com': 'gtm',
      'www.google.com': 'google',
      'fonts.googleapis.com': 'fonts',
      'fonts.gstatic.com': 'gstatic',
    },
    routes: [gaCollect],
    fileHeaders: {
      'gtm/gtag/js': { 'content-type': 'application/javascript; charset=utf-8' },
      'google/maps/embed': html,
      ...fontFiles,
    },
  },
  'browser/cookies': {
    hosts: { 'www.example.test': 'www' },
    routes: [
      {
        host: 'tracker.example.net',
        path: '/pixel.gif',
        status: 200,
        headers: {
          'content-type': 'image/gif',
          'set-cookie': ['uid=SECRET_3P_VALUE_7; Path=/; SameSite=None; Secure; Max-Age=86400'],
        },
        body: '',
      },
    ],
    fileHeaders: {
      'www/index.html': {
        'set-cookie': [
          'sid=SECRET_HTTP_VALUE_1; Path=/; HttpOnly; Secure; SameSite=Lax',
          'pref=SECRET_HTTP_VALUE_2; Path=/; Max-Age=86400',
        ],
      },
    },
  },
  'browser/dse': { hosts: { 'www.example.test': 'www' } },
  'browser/fatal': {
    hosts: {},
    tls: { 'expired.example.test': 'expired' },
    routes: [
      {
        host: 'blocked.example.test',
        path: '/',
        status: 403,
        headers: { ...html, 'cf-mitigated': 'challenge', server: 'cloudflare' },
        body: '<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser</p></body></html>',
      },
      {
        host: 'down.example.test',
        path: '/',
        status: 503,
        headers: html,
        body: '<!doctype html><title>503</title><p>Wartung</p>',
      },
      {
        host: 'expired.example.test',
        path: '/',
        status: 200,
        headers: html,
        body: '<!doctype html><title>ok</title>',
      },
      {
        host: 'throttled.example.test',
        path: '/',
        status: 429,
        headers: { 'retry-after': '0', ...html },
        body: '<!doctype html><title>429</title><p>Zu viele Anfragen</p>',
      },
      {
        host: 'slow.example.test',
        path: '/',
        status: 200,
        delayMs: 60000,
        headers: html,
        body: '<!doctype html><title>slow</title>',
      },
    ],
  },
  'browser/fonts': {
    hosts: { 'www.example.test': 'www', 'fonts.googleapis.com': 'fonts', 'fonts.gstatic.com': 'gstatic' },
    fileHeaders: fontFiles,
  },
  'browser/ga4': {
    hosts: { 'www.example.test': 'www', 'www.googletagmanager.com': 'gtm' },
    routes: [gaCollect],
    fileHeaders: { 'gtm/gtag/js': { 'content-type': 'application/javascript; charset=utf-8' } },
  },
  'browser/maps': {
    hosts: { 'www.example.test': 'www', 'www.google.com': 'google' },
    fileHeaders: { 'google/maps/embed': html },
  },
  'browser/no-legal': { hosts: { 'www.example.test': 'www' } },
  'browser/selection': { hosts: { 'www.example.test': 'www' } },
  'browser/ssrf': {
    hosts: {
      'www.example.test': 'www',
      'intranet.example.test': 'intranet',
      'popup.example.test': 'popup',
      'popup-click.example.test': 'popup-click',
      'frames.other.test': 'nested',
    },
    routes: [
      {
        host: 'redir.example.test',
        path: '/',
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      },
    ],
  },
  'browser/throttle': {
    hosts: { 'www.example.test': 'www', 'busy.example.test': 'busy' },
    routes: [
      {
        host: 'www.example.test',
        path: '/impressum/',
        status: 429,
        headers: { 'retry-after': '1', ...html },
        body: '<!doctype html><html lang="de"><title>429</title><p>Zu viele Anfragen</p></html>',
      },
      {
        host: 'busy.example.test',
        path: '^/img-\\d\\.png$',
        pathRegex: true,
        status: 503,
        headers: { 'retry-after': '0', 'content-type': 'text/plain' },
        body: 'busy',
      },
    ],
  },
  'browser/video': {
    hosts: {
      'www.example.test': 'www',
      'www.youtube-nocookie.com': 'nocookie',
      'i.ytimg.com': 'ytimg',
    },
    routes: [{ host: 'www.youtube-nocookie.com', path: '/youtubei/v1/log_event', status: 204 }],
    fileHeaders: { 'nocookie/embed/fixture-a': html, 'nocookie/embed/fixture-b': html },
  },
  'cmp/borlabs': { hosts: { 'www.borlabs.test': 'www' } },
  'cmp/ccm19': { hosts: { 'www.ccm19.test': 'www', 'cloud.ccm19.de': 'ccm' } },
  'cmp/complianz': { hosts: { 'www.complianz.test': 'www' } },
  'cmp/cookiebot': { hosts: { 'www.cookiebot.test': 'www', 'consent.cookiebot.com': 'cb' } },
  'cmp/cookiehub': { hosts: { 'www.cookiehub.test': 'www', 'cdn.cookiehub.eu': 'ch' } },
  'cmp/cookieman': { hosts: { 'www.cookieman.test': 'www', 'stats.cookieman.test': 'stats' } },
  'cmp/generic': { hosts: { 'www.generic.test': 'www', 'consent.unknown-cmp.test': 'frame' } },
  'cmp/real-cookie-banner': { hosts: { 'www.rcb.test': 'www' } },
  'cmp/shops': { hosts: { 'www.animated-shop.test': 'animated', 'www.vendors-shop.test': 'vendors' } },
  'cmp/shopware': { hosts: { 'www.shopware.test': 'www', 'stats.shopware.test': 'stats' } },
  'cmp/usercentrics': {
    hosts: { 'www.usercentrics.test': 'www', 'web.cmp.usercentrics.eu': 'uc3', 'app.usercentrics.eu': 'uc2' },
  },
  'cmp/wix': {
    hosts: { 'www.wix.test': 'www', 'static.parastorage.com': 'parastorage', 'stats.wix.test': 'stats' },
  },
  'core/smoke': {
    hosts: { 'www.example.test': 'www', 'www.google-analytics.com': 'ga', 'fonts.googleapis.com': 'fonts' },
    tls: {
      'expired.example.test': 'expired',
      'selfsigned.example.test': 'self-signed',
      'wrongname.example.test': 'wrong-name',
    },
    routes: [
      {
        host: 'example.test',
        scheme: 'http',
        path: '/',
        status: 301,
        headers: { location: 'https://www.example.test/' },
      },
      {
        host: 'www.example.test',
        path: '/set-cookie',
        status: 200,
        headers: {
          'set-cookie': ['fixture_session=abc; Path=/; HttpOnly', 'fixture_pref=1; Path=/; Max-Age=3600'],
          'content-type': 'text/plain',
        },
        body: 'ok',
      },
      gaCollect,
    ],
    fileHeaders: {
      'fonts/css2': { 'content-type': 'text/css; charset=utf-8' },
      'www/index.html': {
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff',
      },
    },
  },
  'pipeline/consent-shop': {
    hosts: {
      'www.consent-shop.test': 'ok',
      'www.leaky-shop.test': 'leaky',
      'www.blocking-shop.test': 'blocking',
      'www.late-shop.test': 'late',
      'www.notice-shop.test': 'notice',
    },
  },
  'pipeline/passive': {
    hosts: { 'www.example.test': 'www', 'example.test': 'www' },
    routes: [
      {
        host: 'www.example.test',
        scheme: 'http',
        path: '.*',
        pathRegex: true,
        status: 301,
        headers: { location: 'https://www.example.test/' },
      },
      {
        host: 'example.test',
        scheme: 'http',
        path: '.*',
        pathRegex: true,
        status: 301,
        headers: { location: 'https://example.test/' },
      },
      {
        host: 'example.test',
        scheme: 'https',
        path: '.*',
        pathRegex: true,
        status: 301,
        headers: { location: 'https://www.example.test/' },
      },
    ],
  },
};
