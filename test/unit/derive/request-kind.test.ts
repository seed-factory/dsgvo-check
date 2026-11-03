/** Request kind, tracking stage and integration are looked up from small tables; unlisted values take the default. */
import { describe, expect, it } from 'vitest';
import { integrationFromKind, kindFromResourceType, stageFromKind } from '../../../src/derive/index.ts';
import type { RequestKind, ServiceCategory } from '../../../src/derive/types.ts';

describe('kindFromResourceType', () => {
  it.each<[string, ServiceCategory, RequestKind]>([
    ['script', 'analytics', 'library'],
    ['stylesheet', 'fonts', 'stylesheet'],
    ['font', 'fonts', 'font'],
    ['document', 'maps', 'embed'],
    ['image', 'analytics', 'hit'],
    ['image', 'maps', 'tile'],
    ['image', 'cdn', 'image'],
    ['xhr', 'ads', 'hit'],
    ['beacon', 'session-recording', 'hit'],
    ['websocket', 'analytics', 'hit'],
    ['fetch', 'cdn', 'resource'],
    ['ping', 'social', 'resource'],
    ['eventsource', 'chat', 'resource'],
    ['other', 'ads', 'resource'],
    ['media', 'video', 'resource'],
    ['', 'analytics', 'resource'],
    ['toString', 'analytics', 'resource'],
  ])('%s of %s → %s', (resourceType, category, kind) => {
    expect(kindFromResourceType(resourceType, category)).toBe(kind);
  });
});

describe('stageFromKind', () => {
  it.each<[RequestKind, string]>([
    ['hit', 'event-sent'],
    ['config', 'initialised'],
    ['library', 'loaded'],
    ['embed', 'loaded'],
    ['stylesheet', 'loaded'],
    ['font', 'loaded'],
    ['tile', 'loaded'],
    ['image', 'loaded'],
    ['resource', 'loaded'],
  ])('%s → %s', (kind, stage) => {
    expect(stageFromKind(kind)).toBe(stage);
  });
});

describe('integrationFromKind', () => {
  it.each<[ServiceCategory, RequestKind, string | undefined]>([
    ['maps', 'embed', 'iframe'],
    ['video', 'embed', 'iframe'],
    ['maps', 'library', 'js-api'],
    ['video', 'library', 'js-api'],
    ['maps', 'tile', 'tiles'],
    ['maps', 'image', 'static'],
    ['video', 'image', 'thumbnail'],
    ['maps', 'hit', 'other'],
    ['video', 'resource', 'other'],
    ['analytics', 'embed', undefined],
    ['cdn', 'image', undefined],
  ])('%s %s → %s', (category, kind, integration) => {
    expect(integrationFromKind(category, kind)).toBe(integration);
  });
});
