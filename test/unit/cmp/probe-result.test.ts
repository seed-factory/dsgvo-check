/**
 * The probe runs in the page's own world, where the page can replace built-ins and so return anything. The Node side
 * keeps each field only in the probe's shape and vocabulary: a forged role, tag, selector, vendor role, blocking method,
 * heuristic signal or candidate reason never reaches the facts, a result of a normal page passes unchanged.
 */
import { describe, expect, it } from 'vitest';
import { loadProbeData } from '../../../src/cmp/adapters-file.ts';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import { PROBE_NAME_RULES, toMeasured } from '../../../src/cmp/page/measure.ts';
import { parseProbeResult } from '../../../src/cmp/page/probe-result.ts';
import type { ProbeArgs, ProbeResult, RawButton } from '../../../src/cmp/page/probe-types.ts';
import { ARIA_ROLES, NAME_RULES } from '../../../src/core/redaction/page-names.ts';

const BOX = { x: 10, y: 700, width: 120, height: 20 };

const ARGS: ProbeArgs = {
  mode: 'banner',
  containers: ['#CybotCookiebotDialog'],
  overlays: [],
  vendorRoles: [
    { selector: '#CybotCookiebotDialogBodyButtonDecline', role: 'reject' },
    { selector: '#CybotCookiebotDialogBodyButtonAccept', role: 'accept' },
  ],
  purAbo: [],
  keywords: ['cookie', 'datenschutz'],
  frameMode: false,
  maxButtons: 40,
  selectorAttributes: loadProbeData().selectorAttributes,
  names: PROBE_NAME_RULES,
};

const button = (p: Partial<RawButton> = {}): RawButton => ({
  role: 'button',
  name: 'Ablehnen',
  tag: 'button',
  vendorRole: 'reject',
  box: BOX,
  rendered: true,
  visibleInViewport: true,
  inViewport: true,
  enabled: true,
  hitTestOk: true,
  actionable: true,
  contrast: 7.5,
  fontSizePx: 14,
  selector: '#CybotCookiebotDialogBodyButtonDecline',
  inShadowDom: false,
  href: null,
  ...p,
});

function result(p: Partial<ProbeResult> = {}): ProbeResult {
  return {
    found: true,
    containerCount: 1,
    visible: true,
    containerBox: { x: 0, y: 600, width: 1366, height: 168 },
    containerFixed: true,
    containerSelector: '#CybotCookiebotDialog',
    textLength: 80,
    purAbo: false,
    keywordHits: ['cookie'],
    buttons: [button()],
    buttonsTruncated: false,
    animating: false,
    blocking: {
      overlay: true,
      scrollLock: true,
      inert: false,
      coveredRatio: 0.4,
      method: ['overlay-selector', 'grid-hit-test', 'overflow-hidden'],
      ariaModal: true,
    },
    viewport: { width: 1366, height: 768 },
    coveredLinks: [{ label: 'Impressum', box: BOX, coveredBy: 'banner' }],
    heuristic: null,
    rejectedCandidate: null,
    ...p,
  };
}

const parse = (raw: unknown, args: ProbeArgs = ARGS) => parseProbeResult(raw, args);
const firstButton = (b: Record<string, unknown>) =>
  parse(result({ buttons: [{ ...button(), ...b } as RawButton] })).buttons[0];

describe('parseProbeResult', () => {
  it('counterexample: the result of a normal page passes unchanged', () => {
    const normal = result({
      buttons: [
        button(),
        button({
          name: 'Alle zulassen',
          vendorRole: 'accept',
          selector: 'button[data-testid="uc-accept-all-button"]',
        }),
        button({
          role: 'link',
          tag: 'a',
          vendorRole: null,
          selector: 'a[data-cookie-refuse=""]',
          href: '/datenschutz',
        }),
        button({ tag: 'uc-button', vendorRole: null, selector: '#banner > uc-button:nth-child(2)' }),
      ],
    });
    expect(parse(structuredClone(normal))).toEqual(normal);
  });

  it.each([
    [
      'a role that is no role becomes the implicit role of the tag',
      { role: '?cid=zq7role' },
      { role: 'button' },
    ],
    ['a role of a link tag', { role: 'zq7=alice@example.test', tag: 'a' }, { role: 'link', tag: 'a' }],
    [
      'a tag that is no tag name',
      { tag: 'x-a?token=zq7tok', role: 'zq7' },
      { tag: 'unknown', role: 'generic' },
    ],
    [
      'a vendor role the arguments do not name',
      { vendorRole: 'zq7role=alice@example.test' },
      { vendorRole: null },
    ],
    ['a vendor role of another vendor', { vendorRole: 'settings' }, { vendorRole: null }],
    ['a forged selector', { selector: '#zq7alice\\@example\\.test' }, { selector: null }],
    [
      'a selector with a query value',
      { selector: 'button[aria-label="Akzeptieren ?sid=zq7abc"]' },
      { selector: null },
    ],
    ['a contrast out of range', { contrast: 99 }, { contrast: null }],
    ['a font size that is no number', { fontSizePx: 'zq7' }, { fontSizePx: null }],
    ['a flag that is no boolean', { actionable: 'zq7' }, { actionable: false }],
    ['a name that is no string', { name: { zq7: 1 } }, { name: '' }],
  ])('%s', (_case, forged, expected) => {
    expect(firstButton(forged)).toMatchObject(expected);
  });

  it('drops fields the probe does not return, and buttons that are no objects', () => {
    const raw = { ...result(), zq7: 'alice@example.test', buttons: [{ ...button(), zq7: 'x' }, 'zq7', null] };
    const parsed = parse(raw);
    expect(parsed.buttons).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain('zq7');
  });

  it('keeps only the fixed vocabulary of blocking methods, heuristic signals and candidate facts', () => {
    const parsed = parse({
      ...result(),
      blocking: { ...result().blocking, method: ['overlay-grid', 'zq7=alice@example.test', 7] },
      heuristic: { score: 5, signals: ['heuristic:dialog', 'heuristic:keywords:3', 'heuristic:zq7', 'zq7'] },
      rejectedCandidate: {
        fact: {
          reason: 'keywords',
          keywordHits: 1,
          controls: ['accept', 'zq7', 'accept'],
          cookieWording: true,
          fixed: true,
          dialog: false,
          named: false,
          zq7: 'alice@example.test',
        },
        rank: 3,
        box: BOX,
      },
      coveredLinks: [
        { label: 'Datenschutz', box: BOX, coveredBy: 'overlay' },
        { label: 'Impressum', box: BOX, coveredBy: 'zq7' },
      ],
      keywordHits: ['cookie', 'zq7'],
      containerSelector: '#zq7',
    });
    expect(parsed.blocking.method).toEqual(['overlay-grid']);
    expect(parsed.heuristic).toEqual({ score: 5, signals: ['heuristic:dialog', 'heuristic:keywords:3'] });
    expect(parsed.rejectedCandidate?.fact).toEqual({
      reason: 'keywords',
      keywordHits: 1,
      controls: ['accept'],
      cookieWording: true,
      fixed: true,
      dialog: false,
      named: false,
    });
    expect(parsed.coveredLinks.map((l) => l.coveredBy)).toEqual(['overlay']);
    expect(parsed.keywordHits).toEqual(['cookie']);
    expect(parsed.containerSelector).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('zq7');
  });

  it.each([
    ['a candidate with a reason the probe does not give', { reason: 'zq7' }],
    ['a candidate with a count that is no number', { keywordHits: 'zq7' }],
  ])('drops %s', (_case, fact) => {
    const base = {
      reason: 'keywords',
      keywordHits: 1,
      controls: [],
      cookieWording: false,
      fixed: false,
      dialog: true,
      named: false,
    };
    expect(
      parse({ ...result(), rejectedCandidate: { fact: { ...base, ...fact }, rank: 1, box: BOX } })
        .rejectedCandidate,
    ).toBeNull();
  });

  it('numbers that are not finite do not pass', () => {
    const parsed = parse({
      ...result(),
      containerBox: { x: Number.NaN, y: 0, width: 1, height: 1 },
      textLength: Number.POSITIVE_INFINITY,
      blocking: { ...result().blocking, coveredRatio: 7 },
    });
    expect(parsed).toMatchObject({ containerBox: null, textLength: 0, blocking: { coveredRatio: null } });
  });

  it('switches and the container text are kept only when the arguments asked for them', () => {
    const raw = {
      ...result(),
      switches: [{ checked: true, disabled: true }],
      fullText: { text: 'Cookies zq7', truncated: false },
    };
    expect(parse(raw)).not.toHaveProperty('switches');
    expect(parse(raw)).not.toHaveProperty('fullText');
    expect(parse(raw, { ...ARGS, switches: 'input', fullTextMaxChars: 7 })).toMatchObject({
      switches: [{ checked: true, disabled: true }],
      fullText: { text: 'Cookies', truncated: false },
    });
  });

  it('a result that is no object at all is an error without page data', () => {
    expect(() => parse('zq7alice@example.test')).toThrow(/^cmp probe returned no result$/);
  });

  it('a forged vendor role does not become the kind of the control', () => {
    const forged = parse(result({ buttons: [button({ name: 'Weiter', vendorRole: 'zq7' })] }));
    const layer = toMeasured(forged, loadLexicon(), 'https://www.example.test/').firstLayer;
    expect(layer.buttons[0]).toMatchObject({ vendorRole: null });
    expect(JSON.stringify(layer)).not.toContain('zq7');
  });
});

describe('the probe gets the rules of the Node side', () => {
  it('name and tag patterns and the role list are those of src/core/redaction/page-names.ts', () => {
    expect(PROBE_NAME_RULES).toEqual({ ...NAME_RULES, roles: ARIA_ROLES });
    const { idLike } = PROBE_NAME_RULES;
    for (const p of [
      PROBE_NAME_RULES.chars,
      ...PROBE_NAME_RULES.notName,
      ...idLike.compact,
      ...idLike.plain,
      idLike.otherDigit,
      idLike.separator,
      idLike.token,
      idLike.tokenSplit,
      idLike.word,
      idLike.wordsWithGroup,
      PROBE_NAME_RULES.tag,
    ])
      expect(() => new RegExp(p.source, p.flags)).not.toThrow();
  });
});
