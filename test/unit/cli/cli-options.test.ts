import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, sandboxIsOff, toScanOptions } from '../../../src/cli.ts';

describe('CLI option precedence used by the CI action', () => {
  it('the last repeated option wins over values in extra arguments', async () => {
    const program = buildProgram().action(() => undefined);
    await program.parseAsync(
      [
        'https://example.test/',
        '--out',
        '/extra-output',
        '--format',
        'pdf',
        '--fail-on',
        'none',
        '--out',
        '/action-output',
        '--format',
        'console,json,html',
        '--fail-on',
        'warning',
      ],
      { from: 'user' },
    );
    expect(program.opts()).toMatchObject({
      out: '/action-output',
      format: 'console,json,html',
      failOn: 'warning',
    });
  });
});

it('parses report options on the subcommand', async () => {
  const program = buildProgram();
  const report = program.commands.find((command) => command.name() === 'report');
  expect(report).toBeDefined();
  report?.action(() => undefined);
  await program.parseAsync(['report', 'input.json', '--format', 'html,pdf', '--out', 'd', '--lang', 'en'], {
    from: 'user',
  });
  expect(report?.opts()).toMatchObject({ format: 'html,pdf', out: 'd', lang: 'en' });
});

describe('--sandbox container', () => {
  afterEach(() => vi.unstubAllEnvs());

  const optionsOf = () => {
    const program = buildProgram().action(() => undefined);
    program.parse(['https://example.test', '--sandbox', 'container'], { from: 'user' });
    return toScanOptions('https://example.test', program.opts());
  };

  it('is marked as inside the image only by DSGVO_CHECK_CONTAINER=1', () => {
    vi.stubEnv('DSGVO_CHECK_CONTAINER', '1');
    expect(optionsOf()).toMatchObject({ sandbox: 'container', insideContainer: true });
    vi.stubEnv('DSGVO_CHECK_CONTAINER', '');
    expect(optionsOf()).toMatchObject({ sandbox: 'container', insideContainer: false });
  });

  it('only an explicit off counts as a weakened sandbox', () => {
    expect([sandboxIsOff('off'), sandboxIsOff('require'), sandboxIsOff('container')]).toEqual([
      true,
      false,
      false,
    ]);
  });
});

it('collapses repeated report formats from Action inputs', () => {
  const program = buildProgram().action(() => undefined);
  program.parse(['https://example.test', '--format', 'console,summary,summary'], { from: 'user' });
  expect(toScanOptions('https://example.test', program.opts()).formats).toEqual(['console', 'summary']);
});

describe('a value outside its allowed set is passed on as `invalid`', () => {
  const invalidOf = (...args: string[]) => {
    const program = buildProgram().action(() => undefined);
    program.parse(['https://example.test', ...args], { from: 'user' });
    return toScanOptions('https://example.test', program.opts()).invalid;
  };

  it.each([
    [[], undefined],
    [['--lang', 'en', '--sandbox', 'off', '--assume-region', 'eea'], undefined],
    [['--sandbox', 'container'], undefined],
    [['--assume-region', 'de'], undefined],
    [['--format', 'xml'], { option: '--format', value: 'xml' }],
    [['--lang', 'fr'], { option: '--lang', value: 'fr' }],
    [['--sandbox', 'maybe'], { option: '--sandbox', value: 'maybe' }],
    [['--assume-region', 'us'], { option: '--assume-region', value: 'us' }],
    [['--assume-region', ''], undefined],
    // only the first one is reported: format, lang, sandbox, assume-region
    [
      ['--assume-region', 'us', '--sandbox', 'maybe', '--lang', 'fr', '--format', 'xml'],
      { option: '--format', value: 'xml' },
    ],
    [['--assume-region', 'us', '--sandbox', 'maybe', '--lang', 'fr'], { option: '--lang', value: 'fr' }],
    [['--assume-region', 'us', '--sandbox', 'maybe'], { option: '--sandbox', value: 'maybe' }],
  ])('%j → %j', (args, invalid) => {
    expect(invalidOf(...args)).toEqual(invalid);
  });
});

describe('--profile and --lang lists', () => {
  const rawOf = (...args: string[]) => {
    const program = buildProgram().action(() => undefined);
    program.parse(['https://example.test', ...args], { from: 'user' });
    return program.opts() as Parameters<typeof toScanOptions>[1];
  };

  it('--profile defaults to developer', () => {
    expect(rawOf()).toMatchObject({ profile: 'developer' });
    expect(rawOf('--profile', 'owner,developer')).toMatchObject({ profile: 'owner,developer' });
  });

  it.each([
    [['--profile', 'developer,owner'], undefined],
    [['--profile', 'verbose'], { option: '--profile', value: 'verbose' }],
    [['--profile', 'owner,full'], { option: '--profile', value: 'full' }],
    [['--profile', ','], { option: '--profile', value: ',' }],
    [['--lang', 'de,en'], undefined],
    [['--lang', 'de,fr'], { option: '--lang', value: 'fr' }],
    [['--lang', ''], { option: '--lang', value: '' }],
    [['--profile', 'x', '--lang', 'fr'], { option: '--lang', value: 'fr' }],
    [['--profile', 'x', '--sandbox', 'maybe'], { option: '--profile', value: 'x' }],
  ])('%j → %j', (args, invalid) => {
    expect(toScanOptions('https://example.test', rawOf(...args)).invalid).toEqual(invalid);
  });

  it('the first language of --lang is the language of the scan', () => {
    expect(toScanOptions('https://example.test', rawOf('--lang', 'en,de')).lang).toBe('en');
    expect(toScanOptions('https://example.test', rawOf('--lang', 'de,en')).lang).toBe('de');
  });
});

describe('targets', () => {
  const parsed = (...args: string[]) => {
    const program = buildProgram();
    let urls: string[] = [];
    program.action((u: string[]) => {
      urls = u;
    });
    program.parse(args, { from: 'user' });
    return { urls, opts: program.opts() };
  };

  it('takes several URLs and a targets file', () => {
    expect(parsed('https://a.test/', 'https://b.test/', '--format', 'json').urls).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    const withFile = parsed('--targets', 'sites.txt');
    expect(withFile.urls).toEqual([]);
    expect(withFile.opts).toMatchObject({ targets: 'sites.txt' });
  });
});
