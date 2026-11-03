import { describe, expect, it } from 'vitest';
import { buildProgram, toScanOptions } from '../../../src/cli.ts';

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
