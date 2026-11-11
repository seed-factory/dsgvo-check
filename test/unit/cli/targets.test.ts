import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../../src/core/runtime/errors.ts';
import {
  parseList,
  parseTargetList,
  planTargets,
  reportVariants,
  siteDirName,
} from '../../../src/targets.ts';

describe('parseTargetList', () => {
  it.each([
    ['one URL per line', 'https://a.test/\nhttps://b.test/\n', ['https://a.test/', 'https://b.test/']],
    ['blank lines and surrounding spaces', '\n  https://a.test/  \n\n\t\n', ['https://a.test/']],
    ['full-line comments', '# sites\nhttps://a.test/\n  # off\n', ['https://a.test/']],
    ['a comment after whitespace', 'https://a.test/ # main shop\n', ['https://a.test/']],
    ['a # without preceding whitespace is part of the URL', 'https://a.test/#top\n', ['https://a.test/#top']],
    ['CRLF line ends', 'https://a.test/\r\nhttps://b.test/\r\n', ['https://a.test/', 'https://b.test/']],
    ['a byte order mark', '\uFEFFhttps://a.test/\n', ['https://a.test/']],
    ['only comments', '# nothing\n\n', []],
  ])('%s', (_name, text, urls) => {
    expect(parseTargetList(text)).toEqual(urls);
  });
});

describe('parseList', () => {
  it('trims, drops empty entries and duplicates, keeps the order', () => {
    expect(parseList(' de, en ,,de,')).toEqual(['de', 'en']);
  });
});

describe('siteDirName', () => {
  it.each([
    ['https://www.Example.de/a', 'www.example.de'],
    ['http://localhost:8080/', 'localhost_8080'],
    ['https://example.de:443/', 'example.de'],
    ['http://example.de:443/', 'example.de_443'],
    ['http://example.de:80/', 'example.de'],
    ['https://bücher.de/', 'xn--bcher-kva.de'],
    ['https://example.de./', 'example.de'],
    ['example.de', 'example.de'],
    ['http://[::1]:3000/', '__1_3000'],
    ['https://[2001:db8::1]/', '2001_db8__1'],
  ])('%s → %s', (url, dir) => {
    expect(siteDirName(url)).toBe(dir);
  });
});

describe('reportVariants', () => {
  const dir = path.join('out', 'site');

  it('one language and one profile write into the directory itself', () => {
    expect(reportVariants(dir, ['en'], ['owner'])).toEqual([{ lang: 'en', detail: 'brief', dir }]);
  });

  it.each([
    [
      'two languages',
      ['de', 'en'] as const,
      ['developer'] as const,
      [
        ['de', 'full', 'de/developer'],
        ['en', 'full', 'en/developer'],
      ],
    ],
    [
      'two profiles',
      ['de'] as const,
      ['owner', 'developer'] as const,
      [
        ['de', 'brief', 'de/owner'],
        ['de', 'full', 'de/developer'],
      ],
    ],
    [
      'both, languages outside and profiles inside in the given order',
      ['en', 'de'] as const,
      ['developer', 'owner'] as const,
      [
        ['en', 'full', 'en/developer'],
        ['en', 'brief', 'en/owner'],
        ['de', 'full', 'de/developer'],
        ['de', 'brief', 'de/owner'],
      ],
    ],
  ])('%s', (_name, langs, profiles, expected) => {
    expect(reportVariants(dir, langs, profiles)).toEqual(
      expected.map(([lang, detail, sub]) => ({ lang, detail, dir: path.join(dir, sub as string) })),
    );
  });
});

describe('planTargets', () => {
  const base = { urls: [] as string[], fileUrls: null, outDir: 'out', maxTargets: 20, snapshot: false };
  const failure = (input: Parameters<typeof planTargets>[0]) => {
    try {
      planTargets(input);
    } catch (err) {
      return err instanceof InvalidInputError ? { code: err.code, params: err.params } : err;
    }
    return null;
  };

  it('keeps a single URL without a targets file as it is, even when it is not a URL', () => {
    expect(planTargets({ ...base, urls: ['not a url'] })).toEqual([{ url: 'not a url', outDir: 'out' }]);
  });

  it('keeps a snapshot run without a URL in the output directory', () => {
    expect(planTargets({ ...base, snapshot: true })).toEqual([{ url: '', outDir: 'out' }]);
  });

  it('puts every site into the directory of its host, positional URLs first', () => {
    expect(
      planTargets({
        ...base,
        urls: ['https://b.test/'],
        fileUrls: ['https://a.test:8443/', 'c.test'],
      }),
    ).toEqual([
      { url: 'https://b.test/', outDir: path.join('out', 'b.test') },
      { url: 'https://a.test:8443/', outDir: path.join('out', 'a.test_8443') },
      { url: 'c.test', outDir: path.join('out', 'c.test') },
    ]);
  });

  it('a targets file with one URL still uses the host directory', () => {
    expect(planTargets({ ...base, fileUrls: ['https://a.test/'] })).toEqual([
      { url: 'https://a.test/', outDir: path.join('out', 'a.test') },
    ]);
  });

  it.each([
    ['an empty targets file', { fileUrls: [] }, { code: 'target-missing', params: {} }],
    [
      'more targets than the limit',
      { urls: ['https://a.test/', 'https://b.test/'], maxTargets: 1 },
      { code: 'targets-too-many', params: { count: 2, max: 1 } },
    ],
    [
      'two targets of one directory',
      { urls: ['https://a.test/', 'https://A.test/other'] },
      { code: 'targets-duplicate', params: { dir: 'a.test' } },
    ],
    [
      'snapshot flags with a targets file',
      { fileUrls: ['https://a.test/'], snapshot: true },
      { code: 'targets-snapshot', params: {} },
    ],
    [
      'snapshot flags with several URLs, before the limit',
      { urls: ['https://a.test/', 'https://b.test/'], snapshot: true, maxTargets: 1 },
      { code: 'targets-snapshot', params: {} },
    ],
    [
      'an invalid URL among several',
      { urls: ['https://a.test/', 'http://'] },
      { code: 'target-invalid-url', params: { url: 'http://' } },
    ],
    [
      'an unsupported scheme',
      { urls: ['https://a.test/', 'ftp://b.test/'] },
      { code: 'target-unsupported-scheme', params: { scheme: 'ftp:' } },
    ],
  ])('%s is refused before anything is scanned', (_name, input, expected) => {
    expect(failure({ ...base, ...input })).toEqual(expected);
  });
});
