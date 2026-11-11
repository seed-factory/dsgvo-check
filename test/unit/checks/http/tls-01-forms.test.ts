import { describe, expect, it } from 'vitest';
import { tls01 } from '../../../../src/checks/http/tls-01.ts';
import { loadRuleset, loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage } from '../../../../src/core/data/messages.ts';
import type {
  DocumentResponse,
  FormTwinStage,
  HttpHop,
  HttpSection,
  HttpTwin,
} from '../../../../src/core/snapshot/http.ts';
import {
  makeBrowser,
  makeDocumentResponse,
  makeDom,
  makeHop,
  makeHttp,
  makePage,
  makePhase,
  makeSnapshot,
  makeTarget,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';
import { BIG, chain, httpsOk, redirect301, snap } from './tls-01-fixtures.ts';

describe('TLS-01 forms on pages served over http beyond the root', () => {
  const ROOT = 'http://www.example.test/';
  const POST = 'http://www.example.test/post-1/';
  const ACTION = 'http://www.example.test/wp-comments-post.php';
  const COMMENT_FORM = { action: ACTION, actionScheme: 'http' as const, method: 'post' as const };

  const htmlResponse = (hop: Partial<HttpHop>) =>
    ({
      status: 200,
      bodyBytes: BIG,
      bodyKind: 'html',
      hasForm: false,
      forms: [],
      formInspection: 'complete',
      ...hop,
    }) satisfies Partial<HttpHop>;

  const root = (hop: Partial<HttpHop> = {}) => chain(ROOT, [htmlResponse(hop)], { hostVariant: 'target' });
  const https = () => httpsOk('www.example.test');

  function twin(hop: Partial<HttpHop> | null, p: Partial<HttpTwin> = {}): HttpTwin {
    return {
      page: 'https://www.example.test/post-1/',
      url: POST,
      hop: hop === null ? null : makeHop({ url: POST, ...htmlResponse(hop) }),
      outcome: 'ok',
      ...p,
    };
  }
  const STAGE: FormTwinStage = { budget: 3, candidates: 1, durationMs: 600 };

  const scanWithTwins = (twins: HttpTwin[], http: Partial<HttpSection> = {}, chains = [root(), https()]) =>
    runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget('https://www.example.test/'),
        http: makeHttp({ chains, twins, formTwinStage: STAGE, ...http }),
      }),
    );
  const formOf = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r).find((o) => o.variant === 'form-on-http-page');

  /**
   * The answers that decide the http:// address of a page alike, however the page was found: `build` makes its
   * twin, and `page` is the https page that a limitation names.
   */
  function answersDecideAlike(build: typeof twin, page: string) {
    it.each<[string, Partial<HttpHop>]>([
      [
        'the address redirects to https',
        { status: 301, location: 'https://www.example.test/post-1/', bodyBytes: 0, bodyKind: 'empty' },
      ],
      ['the address answers 404', { status: 404 }],
      ['the http page has no data form', { hasForm: false, forms: [], formInspection: 'complete' }],
    ])('clean: %s', (_name, hop) => {
      const answer = build({ hasForm: undefined, forms: undefined, formInspection: undefined, ...hop });
      const r = scanWithTwins([answer]);
      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });

    it('no clean claim when the request timed out: limitation naming the page, no form finding', () => {
      const timedOut = build(null, { outcome: 'timeout', error: { code: 'timeout', message: 'x' } });
      const r = scanWithTwins([timedOut]);
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual([`http-form-twin-undecided:${page}`]);
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });
  }

  it('a comment form on the http:// address of an article → form-on-http-page naming where the form sends', () => {
    const r = scanWithTwins([twin({ hasForm: true, forms: [COMMENT_FORM] })]);
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
    expect(formOf(r)).toMatchObject({
      subject: 'http-entry:final',
      phases: ['http'],
      pages: [POST],
      params: {
        host: 'www.example.test',
        url: POST,
        action: ACTION,
        hasAction: 'yes',
        count: 1,
        downgrade: 'no',
        permalinks: 0,
      },
    });
    expect(formOf(r)?.evidence).toContainEqual({
      type: 'page',
      phase: 'http',
      url: POST,
      status: 200,
      role: 'http-form',
      formAction: ACTION,
    });
  });

  it('forms on the root and on an article of one host are one finding over both pages, the root first', () => {
    const r = scanWithTwins([twin({ hasForm: true, forms: [COMMENT_FORM] })], {}, [
      root({
        hasForm: true,
        forms: [{ action: 'http://www.example.test/kontakt', actionScheme: 'http', method: 'post' }],
      }),
      https(),
    ]);
    const forms = observationsOf(r).filter((o) => o.variant === 'form-on-http-page');
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({
      pages: [ROOT, POST],
      params: { url: ROOT, action: 'http://www.example.test/kontakt', count: 2 },
    });
  });

  answersDecideAlike(twin, 'https://www.example.test/post-1/');

  it.each<[string, HttpTwin]>([
    [
      'the host throttled the scan',
      twin(null, { outcome: 'throttled', error: { code: 'throttled', message: 'x' } }),
    ],
    [
      'a bot challenge answered',
      twin({ status: 403, hasForm: true, forms: [COMMENT_FORM] }, { challenge: 'cloudflare' }),
    ],
    ['a redirect to another http address', twin({ status: 301, location: 'http://www.example.test/post-1' })],
    ['a server error', twin({ status: 503 })],
  ])('no clean claim when %s: limitation, no form finding', (_name, t) => {
    const r = scanWithTwins([t]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toContain('http-form-twin-undecided:https://www.example.test/post-1/');
    expect(variantsOf(r)).toEqual(['no-redirect']);
  });

  it.each(['truncated', 'unavailable'] as const)(
    'an article read %s without a form seen: limitation http-form-not-inspected, no clean claim',
    (formInspection) => {
      const r = scanWithTwins([twin({ formInspection })]);
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual([`http-form-not-inspected:${POST}`]);
      expect(variantsOf(r)).toEqual(['no-redirect']);
    },
  );

  it('a form in the part of a cut body that was read is a finding without a limitation', () => {
    const r = scanWithTwins([twin({ hasForm: true, forms: [COMMENT_FORM], formInspection: 'truncated' })]);
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
  });

  it('the http:// root read only in part without a form seen: limitation http-form-not-inspected', () => {
    const r = scanWithTwins([], {}, [root({ formInspection: 'truncated', bodyTruncated: true }), https()]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual([`http-form-not-inspected:${ROOT}`]);
  });

  describe('linked legal documents that ended on plain http', () => {
    const legal = (p: Partial<DocumentResponse> = {}) =>
      makeDocumentResponse({
        role: 'impressum',
        url: 'http://www.example.test/impressum',
        foundVia: 'link',
        hasForm: true,
        forms: [{ action: 'http://www.example.test/impressum', actionScheme: 'http', method: 'post' }],
        formInspection: 'complete',
        ...p,
      });

    it('a contact form on the Impressum served over http → form-on-http-page on that page', () => {
      const r = scanWithTwins([], { documents: [legal()] });
      expect(formOf(r)).toMatchObject({
        pages: ['http://www.example.test/impressum'],
        params: { url: 'http://www.example.test/impressum', action: 'http://www.example.test/impressum' },
      });
    });

    it.each<[string, Partial<DocumentResponse>]>([
      ['it ended on https', { finalUrl: 'https://www.example.test/impressum', formInspection: undefined }],
      ['it answered 404', { status: 404 }],
      [
        'a bot challenge answered on https',
        {
          finalUrl: 'https://www.example.test/impressum',
          formInspection: undefined,
          error: { code: 'blocked', message: 'cloudflare: cf-mitigated' },
        },
      ],
    ])('no finding and no limitation when %s', (_name, p) => {
      const r = scanWithTwins([], { documents: [legal(p)] });
      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });

    it('a bot challenge answered on http instead of the document: limitation, no clean claim', () => {
      const blocked = legal({
        status: 403,
        hasForm: undefined,
        forms: undefined,
        formInspection: undefined,
        error: { code: 'blocked', message: 'cloudflare: cf-mitigated' },
      });
      const r = scanWithTwins([], { documents: [blocked] });
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['http-form-not-inspected:http://www.example.test/impressum']);
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });

    it('read only in part without a form: limitation http-form-not-inspected', () => {
      const r = scanWithTwins([], {
        documents: [legal({ hasForm: false, forms: [], formInspection: 'truncated' })],
      });
      expect(r.outcome?.limitations).toEqual(['http-form-not-inspected:http://www.example.test/impressum']);
    });
  });

  describe('the http:// address of a post that the visited pages link as its permalink', () => {
    const LINKED = 'https://www.example.test/post-1/';
    const permalinkTwin = (hop: Partial<HttpHop> | null, p: Partial<HttpTwin> = {}) =>
      twin(hop, { page: LINKED, source: 'permalink', linkedFrom: 'https://www.example.test/', ...p });
    const render = (lang: 'de' | 'en', params: Record<string, string | number>) =>
      formatMessage(loadTexts(lang).messages['TLS-01.form-on-http-page']!.body, params, lang);

    it('a comment form there counts like the other pages: one critical finding naming the action and the page', () => {
      const r = scanWithTwins([permalinkTwin({ hasForm: true, forms: [COMMENT_FORM] })]);
      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
      expect(formOf(r)).toMatchObject({
        subject: 'http-entry:final',
        pages: [POST],
        params: { url: POST, action: ACTION, hasAction: 'yes', count: 1, permalinks: 1 },
      });
      expect(formOf(r)?.evidence).toContainEqual({
        type: 'page',
        phase: 'http',
        url: POST,
        status: 200,
        role: 'http-form-permalink',
        formAction: ACTION,
      });
    });

    it('the text says the page was requested as the http address of a post the visited pages link', () => {
      const r = scanWithTwins([permalinkTwin({ hasForm: true, forms: [COMMENT_FORM] })]);
      const params = formOf(r)?.params as Record<string, string | number>;
      expect(render('de', params)).toContain(
        'Die Seite wurde als http-Adresse eines Beitrags oder Artikels abgefragt, den die besuchten Seiten als Permalink (rel="bookmark") verlinken; der Browser hat sie nicht besucht.',
      );
      expect(render('en', params)).toContain(
        'The page was requested as the http address of a post or article that the visited pages link as its permalink (rel="bookmark"); the browser did not visit it.',
      );
      for (const lang of ['de', 'en'] as const) {
        expect(render(lang, { ...params, permalinks: 0 })).not.toContain('rel="bookmark"');
        expect(render(lang, { ...params, permalinks: undefined as unknown as number })).not.toMatch(
          /\{|rel=/,
        );
      }
    });

    it('forms on the root, a visited page and a post are one finding; the post is counted and named as such', () => {
      const r = scanWithTwins(
        [
          twin(
            { hasForm: true, forms: [COMMENT_FORM], url: 'http://www.example.test/kontakt/' },
            {
              page: 'https://www.example.test/kontakt/',
              url: 'http://www.example.test/kontakt/',
              source: 'input-form',
            },
          ),
          permalinkTwin({ hasForm: true, forms: [COMMENT_FORM] }),
        ],
        {},
        [root({ hasForm: true, forms: [COMMENT_FORM] }), https()],
      );
      const forms = observationsOf(r).filter((o) => o.variant === 'form-on-http-page');
      expect(forms).toHaveLength(1);
      expect(forms[0]).toMatchObject({
        pages: [ROOT, 'http://www.example.test/kontakt/', POST],
        params: { url: ROOT, count: 3, permalinks: 1 },
      });
      expect(forms[0]?.evidence.filter((e) => e.type === 'page').map((e) => [e.url, e.role])).toEqual([
        [ROOT, 'http-form'],
        ['http://www.example.test/kontakt/', 'http-form'],
        [POST, 'http-form-permalink'],
      ]);
      expect(render('de', forms[0]?.params as Record<string, string | number>)).toContain(
        'Eine dieser Seiten wurde als http-Adresse eines Beitrags oder Artikels abgefragt',
      );
    });

    answersDecideAlike(permalinkTwin, LINKED);

    it('more permalinks than the budget leave the result complete: they are not known to carry a form', () => {
      const r = scanWithTwins([permalinkTwin({})], {
        formTwinStage: { budget: 1, candidates: 0, permalinkCandidates: 7, durationMs: 1 },
      });
      expect(r.status).toBe('completed');
      expect(r.outcome?.limitations ?? []).toEqual([]);
    });

    it('an older twin without a source counts as a page with a form', () => {
      const r = scanWithTwins([twin({ hasForm: true, forms: [COMMENT_FORM] })]);
      expect(formOf(r)?.params).toMatchObject({ permalinks: 0 });
      expect(formOf(r)?.evidence.find((e) => e.type === 'page')).toMatchObject({ role: 'http-form' });
    });
  });

  it('the step failed: partial with http-form-twins-not-collected', () => {
    const r = scanWithTwins([], {
      formTwinStage: {
        budget: 3,
        candidates: null,
        durationMs: 1,
        error: { code: 'collector-exception', message: 'x' },
      },
    });
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['http-form-twins-not-collected']);
  });

  it('more pages with a form than the budget: partial with http-form-twins-capped', () => {
    const r = scanWithTwins([twin({})], { formTwinStage: { budget: 1, candidates: 4, durationMs: 1 } });
    expect(r.outcome?.limitations).toEqual(['http-form-twins-capped']);
  });

  it('the step switched off (budget 0) or with nothing to request: no limitation', () => {
    for (const formTwinStage of [
      { budget: 0, candidates: 2, durationMs: 0 },
      { budget: 3, candidates: 0, durationMs: 0 },
    ]) {
      expect(scanWithTwins([], { formTwinStage }).status).toBe('completed');
    }
  });

  it('an older snapshot (hasForm without form facts) still gives the finding, without an action', () => {
    const old = chain(ROOT, [{ status: 200, bodyBytes: BIG, bodyKind: 'html', hasForm: true }]);
    const r = runCheck(tls01, snap(old, https()));
    expect(formOf(r)?.params).toMatchObject({ url: ROOT, action: '', hasAction: 'no', count: 1 });
  });

  it('counterexample: an https page whose form sends to http is no TLS-01 finding', () => {
    const form = {
      action: 'http://www.example.test/senden',
      actionScheme: 'http' as const,
      method: 'post',
      visible: true,
      fieldCount: 3,
      hasPasswordField: false,
      hasEmailField: true,
    };
    const snapshot = makeSnapshot({
      target: makeTarget('https://www.example.test/'),
      http: makeHttp({
        chains: [redirect301('www.example.test'), https()],
        twins: [],
        formTwinStage: { budget: 3, candidates: 0, durationMs: 0 },
      }),
      browser: makeBrowser({
        phases: [
          makePhase('A', {
            pages: [
              makePage({
                url: 'https://www.example.test/kontakt/',
                role: 'contact',
                dom: makeDom({ forms: [form] }),
              }),
            ],
          }),
        ],
      }),
    });
    const r = runCheck(tls01, snapshot);
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('level: a form on a page served over http is critical (T1_UNENCRYPTED)', () => {
    expect(loadRuleset().checks['TLS-01']?.variants['form-on-http-page']).toEqual({
      severity: 'critical',
      crm: 'T1_UNENCRYPTED',
    });
  });
});
