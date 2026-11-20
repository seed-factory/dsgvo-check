import { expect, it } from 'vitest';
import { requestsOf } from './derive-phase.ts';

it('classifies loaded resources and tracking events in the derived snapshot', () => {
  const hosts = {
    ads: 'securepubads.g.doubleclick.net',
    analytics: 'www.google-analytics.com',
    cdn: 'cdn.jsdelivr.net',
    chat: 'tawk.to',
    fonts: 'use.typekit.net',
    maps: 'www.openstreetmap.org',
    'session-recording': 'hotjar.com',
    social: 'facebook.net',
    video: 'www.youtube-nocookie.com',
  };
  const cases = [
    ['script', 'analytics', 'library', 'loaded'],
    ['stylesheet', 'fonts', 'stylesheet', 'loaded'],
    ['font', 'fonts', 'font', 'loaded'],
    ['document', 'maps', 'embed', 'loaded', 'iframe'],
    ['script', 'maps', 'library', 'loaded', 'js-api'],
    ['image', 'analytics', 'hit', 'event-sent'],
    ['image', 'maps', 'tile', 'loaded', 'tiles'],
    ['image', 'cdn', 'image', 'loaded'],
    ['xhr', 'ads', 'hit', 'event-sent'],
    ['beacon', 'session-recording', 'hit', 'event-sent'],
    ['websocket', 'analytics', 'hit', 'event-sent'],
    ['fetch', 'cdn', 'resource', 'loaded'],
    ['ping', 'social', 'resource', 'loaded'],
    ['eventsource', 'chat', 'resource', 'loaded'],
    ['other', 'ads', 'resource', 'loaded'],
    ['media', 'video', 'resource', 'loaded', 'other'],
    ['document', 'video', 'embed', 'loaded', 'iframe'],
    ['script', 'video', 'library', 'loaded', 'js-api'],
    ['image', 'video', 'image', 'loaded', 'other'],
    ['document', 'analytics', 'embed', 'loaded'],
    ['', 'analytics', 'resource', 'loaded'],
    ['toString', 'analytics', 'resource', 'loaded'],
  ] as const;

  const requests = requestsOf(
    ...cases.map(([resourceType, category]): [string, { resourceType: string }] => [
      `https://${hosts[category]}/unlisted-asset`,
      { resourceType },
    ]),
  );

  expect(requests).toHaveLength(cases.length);
  for (const [index, [resourceType, category, kind, stage, integration]] of cases.entries()) {
    const request = requests[index]!;
    expect(
      [request.category, request.kind, request.stage, request.integration],
      `${category}: ${resourceType}`,
    ).toEqual([category, kind, stage, integration]);
  }
});
