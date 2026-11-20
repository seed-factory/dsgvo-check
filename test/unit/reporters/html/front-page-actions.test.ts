import { describe, expect, it } from 'vitest';
import type { Finding, FullReport } from '../../../../src/core/report/schema.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { buildReportView } from '../../../../src/reporters/report-view.ts';
import { ctx, entry, finding, findingOf, inventory, reportWith } from './front-page-fixtures.ts';

describe('the action list', () => {
  const view = (findings: Finding[]) => buildReportView(reportWith(findings), ctx());

  it('has one entry per message, counting the findings and pages it covers', () => {
    const { actions } = view([
      entry(1, 'a', 'https://www.example.de/'),
      entry(2, 'b', 'https://www.example.de/'),
      entry(3, 'c', 'https://www.example.de/kontakt'),
    ]);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      severity: 'info',
      action: 'Prüfen Sie den Eintrag.',
      covers: '3 Befunde, 2 Seiten',
    });
  });

  it('names the differing entries of findings that share a message in the title', () => {
    const [shared] = view([entry(1, 'beta'), entry(2, 'alpha'), entry(3, 'alpha')]).actions;
    expect(shared!.title).toBe('Eintrag alpha, beta gefunden');

    const [single] = view([entry(1, 'alpha')]).actions;
    expect(single!.title).toBe('Eintrag alpha gefunden');
  });

  it('names five entries and counts the rest', () => {
    const [de] = view(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, n) => entry(n, name))).actions;
    const [en] = buildReportView(
      reportWith(['a', 'b', 'c', 'd', 'e', 'f'].map((name, n) => entry(n, name))),
      ctx('full', 'en'),
    ).actions;

    expect(de!.title).toBe('Eintrag a, b, c, d, e und 2 weitere gefunden');
    expect(en!.title).toBe('Eintrag a, b, c, d, e and 1 more gefunden');
  });

  it('lists critical before warning before info, and the most severe finding sets the level of an entry', () => {
    const { actions } = view([
      entry(1, 'a'),
      finding(2, { severity: 'warning', messageId: 'HDR-01.header-missing' }),
      finding(3, { severity: 'critical', messageId: 'CONSENT-01.tracking-completed' }),
      { ...entry(4, 'b'), severity: 'warning' },
    ]);

    expect(actions.map((a) => a.severity)).toEqual(['critical', 'warning', 'warning']);
    expect(actions.at(0)!.severityLabel).toBe('Kritisch');
  });

  it('shows the action texts of the data files and leaves the line out when a message has none', () => {
    const { actions } = view([
      finding(1, { severity: 'critical', messageId: 'CONSENT-01.tracking-completed' }),
      finding(2, {
        severity: 'info',
        messageId: 'UNKNOWN-01.nothing',
        text: { lang: 'de', title: 'T', body: 'B', draft: true },
      }),
    ]);

    expect(actions[0]!.action).toMatch(/Einwilligung/);
    expect(actions[1]).toMatchObject({ title: 'T', action: '' });
  });

  it('renders badge, title, action and coverage in the HTML', () => {
    const html = renderHtml(reportWith([entry(1, 'a'), entry(2, 'b')]), ctx('brief'));
    expect(html).toMatch(
      /<li class="action sev-info">\s*<p class="action-title"><span class="badge sev-info">Hinweis<\/span> <strong>Eintrag a, b gefunden<\/strong>/,
    );
    expect(html).toContain('Prüfen Sie den Eintrag.');
    expect(html).toContain('2 Befunde, 1 Seite');
  });
});

describe('the action list: params of grouped findings', () => {
  const counted = (n: number, params: Finding['params'], pages: string[]) =>
    findingOf(300 + n, 'TEST-02.counted', 'info', { params, pages });
  const PAGE = (p: string) => `https://www.example.de/${p}`;

  it('keeps shared values, adds up differing numbers, lists other values and counts distinct pages', () => {
    const r = reportWith([
      counted(1, { name: 'b', count: 2, host: 'h.example', kind: 'cookie', pageCount: 2, mode: true }, [
        PAGE('a'),
        PAGE('b'),
      ]),
      counted(2, { name: 'a', count: 3, host: 'h.example', kind: 'request', pageCount: 2, mode: true }, [
        PAGE('b'),
        PAGE('c'),
      ]),
    ]);
    const [item] = buildReportView(r, ctx()).actions;

    // `kind` differs: the select falls back to its neutral branch
    expect(item!.title).toBe('Eintrag a, b auf 3 Seiten');
    expect(item!.action).toBe('Prüfen Sie a, b (5 Stück, h.example) sofort.');
    expect(item!.covers).toBe('2 Befunde, 3 Seiten');
  });

  it('formats the action of a single finding with its own params', () => {
    const r = reportWith([
      counted(1, { name: 'x', count: 1, host: 'h.example', kind: 'cookie', mode: false }, []),
    ]);
    expect(buildReportView(r, ctx()).actions[0]!.action).toBe('Prüfen Sie x (1 Stück, h.example).');
  });

  it('orders by severity, then data protection before transport security and mail, then by the pages covered', () => {
    const r = reportWith([
      findingOf(1, 'MAIL-01.policy-none', 'warning', { pages: [] }),
      findingOf(2, 'HDR-01.hsts-missing', 'warning', { pages: [PAGE('a')] }),
      findingOf(3, 'PRIV-01.not-named', 'warning', { pages: [PAGE('a')] }),
      findingOf(4, 'EMBED-01.fonts-loaded', 'warning', { pages: [PAGE('a'), PAGE('b')] }),
      findingOf(5, 'TLS-02.certificate-invalid', 'critical', { pages: [] }),
    ]);
    r.checks = [
      ['MAIL-01', 'dns'],
      ['HDR-01', 'http'],
      ['TLS-02', 'http'],
      ['PRIV-01', 'browser'],
      ['EMBED-01', 'browser'],
    ].map(([id, module]) => ({ ...r.checks[0]!, id: id!, module: module! }));

    const order = buildReportView(r, ctx()).actions.map((a) => a.title);
    const ids = ['TLS-02', 'EMBED-01', 'PRIV-01', 'HDR-01', 'MAIL-01'].map(
      (id) =>
        buildReportView(reportWith(r.findings.filter((f) => f.checkId === id)), ctx()).actions[0]!.title,
    );
    expect(order).toEqual(ids);
  });
});

describe('the action list: mail findings of several domains', () => {
  const mail = (n: number, domain: string, scope: string, variant = 'record-not-found') =>
    findingOf(300 + n, `MAIL-01.${variant}`, 'warning', {
      subject: scope === 'site' ? 'dmarc' : `dmarc@contact:${domain}`,
      pages: [],
      params: { domain, mailDomain: domain, scope, inherited: 'none' },
    });
  const withDnsChecks = (r: FullReport) => {
    r.checks = [{ ...r.checks[0]!, id: 'MAIL-01', module: 'dns' }];
    return r;
  };

  it('a missing DMARC record on the scanned domain and on an Impressum domain → two items, each naming its domain', () => {
    const r = withDnsChecks(
      reportWith([mail(1, 'example.de', 'site'), mail(2, 'example-mail.de', 'contact')]),
    );
    const actions = buildReportView(r, ctx()).actions;

    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.covers)).toEqual(['1 Befund', '1 Befund']);
    expect(actions[0]!.action).toContain('für example.de');
    expect(actions[0]!.action).not.toContain('example-mail.de');
    expect(actions[1]!.title).toContain('example-mail.de');
    expect(actions[1]!.action).toContain('für example-mail.de');
  });

  it('the same record found again under another scope stays one item', () => {
    const r = withDnsChecks(
      reportWith([
        mail(1, 'example.de', 'site', 'policy-none'),
        mail(2, 'example.de', 'contact', 'policy-none'),
      ]),
    );
    expect(buildReportView(r, ctx()).actions).toHaveLength(1);
  });
});

describe('the action list without an item', () => {
  const actionSection = (out: string) => {
    const start = out.indexOf('>Was zu tun ist</h2>');
    return out.slice(start, out.indexOf('</section>', start));
  };

  it('points to the services table when every finding is an inventory row', () => {
    const r = reportWith([
      inventory(1, 'Matomo', ['tracking', 'not-observed', 'not-observed']),
      inventory(2, 'Vimeo', ['loaded', 'not-observed', 'not-observed']),
    ]);
    for (const detail of ['full', 'brief'] as const) {
      const section = actionSection(renderHtml(r, ctx(detail)));
      expect(section).toContain('Kein Befund, aus dem sich ein Schritt ergibt.');
      expect(section).toContain('Die 2 beobachteten Dienste stehen in der Tabelle „Beobachtete Dienste“.');
      expect(section).not.toContain('Keine Befunde beobachtet');
    }
  });

  it('leaves a suppressed finding out of the list and says that it is suppressed', () => {
    const suppressed = {
      ...entry(1, 'a'),
      suppression: { reason: 'geprüft', expires: '2099-01-01', expired: false },
    };
    const r = reportWith([suppressed]);
    r.summary.counts = { ...r.summary.counts!, info: 0, suppressed: 1 };
    const section = actionSection(renderHtml(r, ctx('brief')));

    expect(section).not.toContain('Eintrag a gefunden');
    expect(section).toContain('Ein Befund ist unterdrückt.');
  });

  it('keeps a finding whose suppression has expired in the list', () => {
    const expired = {
      ...entry(1, 'a'),
      suppression: { reason: 'geprüft', expires: '2020-01-01', expired: true },
    };

    expect(actionSection(renderHtml(reportWith([expired]), ctx('brief')))).toContain('Eintrag a gefunden');
  });

  it('says no findings were observed when the report has none', () => {
    const section = actionSection(renderHtml(reportWith([]), ctx('brief')));

    expect(section).toContain('Keine Befunde beobachtet.');
  });
});
