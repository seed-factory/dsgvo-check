import { describe, expect, it } from 'vitest';
import { legal02 } from '../../../../../src/checks/browser/legal-02.ts';
import { splitSentences } from '../../../../../src/checks/browser/policy-claims.ts';
import type { Observation } from '../../../../../src/core/api.ts';
import { loadDataDir, loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import { EvidenceSchema } from '../../../../../src/core/report/schema.ts';
import type { DocumentPart, DocumentRecord } from '../../../../../src/core/snapshot/browser.ts';
import { observationsOf, runCheck } from '../../../../utils/snapshot-builder.ts';
import { scenariosOf } from '../scenarios/index.ts';
import {
  currentImpressum,
  currentPolicy,
  docPart,
  impressumDocument,
  LEGAL02_IMPRESSUM,
  LEGAL02_ORIGIN,
  LEGAL02_PRIVACY,
  legalSite,
  policyDocument,
} from '../scenarios/legal-02.ts';

const scenario = (file: string) =>
  scenariosOf('LEGAL-02')
    .find((s) => s.file === file)!
    .build();
const run = (documents: DocumentRecord[], attempts = []) => runCheck(legal02, legalSite(documents, attempts));
const referenceIds = (documents: DocumentRecord[]) =>
  observationsOf(run(documents))
    .map((o) => o.params.referenceId)
    .sort();
/** A policy with one part of `text` beside the current Impressum. */
const withPolicyText = (text: string, o: Parameters<typeof docPart>[2] = {}) => [
  currentImpressum(),
  policyDocument([docPart('p1', text, o)]),
];
/** An Impressum with one part of `text` beside the current policy. */
const withImpressumText = (text: string) => [
  impressumDocument([docPart('i1', text, { sourceUrl: LEGAL02_IMPRESSUM })]),
  currentPolicy(),
];
const quotes = (o: Observation) => o.evidence.flatMap((e) => (e.type === 'text-match' ? [e] : []));

describe('LEGAL-02 designations of a former legal situation', () => {
  it('violation: Privacy Shield in the policy → one info-level observation with the case, date and quote', () => {
    const r = runCheck(legal02, scenario('violation-privacy-shield-in-policy.json'));

    expect(r.status).toBe('completed');
    const [o, ...rest] = observationsOf(r);
    expect(rest).toEqual([]);
    expect(o).toMatchObject({
      variant: 'outdated-reference',
      confidence: 'medium',
      subject: 'privacy:privacy-shield',
      pages: [LEGAL02_PRIVACY],
      params: {
        documentKind: 'privacy',
        documentUrl: LEGAL02_PRIVACY,
        referenceId: 'privacy-shield',
        reference: 'EU-US Privacy Shield',
        reason: 'invalidated',
        replacedBy: 'EU-U.S. Data Privacy Framework',
        since: '2020-07-16',
        ruling: 'C-311/18 (Schrems II)',
        section: 'Datenschutzerklärung > 5. Plugins und Tools > Analytics',
        hasSection: true,
        mentionCount: 1,
      },
    });
    expect(o!.evidence[0]).toMatchObject({ type: 'document', kind: 'privacy', url: LEGAL02_PRIVACY });
    expect(quotes(o!)).toEqual([
      expect.objectContaining({
        documentId: 'doc-privacy',
        section: 'Datenschutzerklärung > 5. Plugins und Tools > Analytics',
        quote: 'Google ist unter dem EU-US Privacy Shield zertifiziert.',
        matchLevel: 'term',
      }),
    ]);
    for (const ev of o!.evidence) expect(EvidenceSchema.safeParse({ id: 'e1', ...ev }).success).toBe(true);
  });

  it('violation: TMG and RStV in the Impressum → one observation per designation', () => {
    const r = runCheck(legal02, scenario('violation-tmg-rstv-in-impressum.json'));

    const os = observationsOf(r);
    expect(os.map((o) => o.subject).sort()).toEqual(['impressum:rstv', 'impressum:tmg']);
    expect(os.find((o) => o.params.referenceId === 'tmg')?.params).toMatchObject({
      documentKind: 'impressum',
      reason: 'replaced',
      replacedBy: 'Digitale-Dienste-Gesetz (DDG)',
      since: '2024-05-14',
      ruling: null,
    });
    expect(quotes(os.find((o) => o.params.referenceId === 'rstv')!).map((q) => q.quote)).toEqual([
      'Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV: Erika Mustermann, Anschrift wie oben.',
    ]);
  });

  it('clean: current designations (DDG, MStV, TDDDG, DPF) → completed without observations', () => {
    const r = runCheck(legal02, scenario('clean-current-references.json'));
    expect(r.status).toBe('completed');
    expect(observationsOf(r)).toEqual([]);
  });

  it('inconclusive: only a PDF policy and an Impressum link that answered with an error', () => {
    const r = runCheck(legal02, scenario('inconclusive-no-documents.json'));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'no-documents' });
    expect(r.outcome?.limitations).toEqual(['impressum-not-found', 'privacy-pdf']);
  });

  it('counterexample scenario: historical and successor sentences only → nothing', () => {
    const r = runCheck(legal02, scenario('clean-historical-and-successor-mentions.json'));
    expect(r.status).toBe('completed');
    expect(observationsOf(r)).toEqual([]);
  });
});

type Case = [label: string, kind: 'impressum' | 'privacy', text: string];

/** Sentences that use a designation only as former or next to its successor. */
const MARKED: Case[] = [
  [
    'invalidity stated in the sentence',
    'privacy',
    'Das EU-US Privacy Shield wurde vom EuGH am 16.07.2020 für ungültig erklärt.',
  ],
  [
    'the end of the framework',
    'privacy',
    'Seit dem Wegfall des Privacy Shield nutzen wir Standardvertragsklauseln.',
  ],
  [
    'the former designation in brackets',
    'impressum',
    'Angaben gemäß § 5 DDG (vormals § 5 TMG): Beispiel GmbH.',
  ],
  [
    '"bzw." keeps old and new designation in one sentence',
    'impressum',
    'Angaben nach TMG bzw. DDG: Beispiel GmbH.',
  ],
  [
    'the successor framework named in the sentence',
    'privacy',
    'Google ist nach dem EU-US Data Privacy Framework zertifiziert (Nachfolger des Privacy Shield).',
  ],
  [
    'the full title of the DSGVO names the directive it repealed',
    'privacy',
    'Grundlage ist die Verordnung (EU) 2016/679 vom 27. April 2016 zur Aufhebung der Richtlinie 95/46/EG (Datenschutz-Grundverordnung).',
  ],
  [
    'English: the framework was struck down',
    'privacy',
    'The EU-U.S. Privacy Shield was invalidated by the CJEU in 2020.',
  ],
  ['the renamed law next to its new name', 'privacy', 'Rechtsgrundlage ist § 25 TDDDG (ehemals TTDSG).'],
  [
    '"bzw." before a paragraph sign keeps both designations in one sentence',
    'impressum',
    'Angaben gemäß § 5 TMG bzw. § 5 DDG: Beispiel GmbH.',
  ],
  [
    'the German name of the framework that followed',
    'privacy',
    'Wir übermitteln Daten nach Safe Harbor bzw. dem EU-US-Datenschutzrahmen.',
  ],
];

/** Sentences that hold no designation at all. */
const UNRELATED: Case[] = [
  ['plain BDSG is the current law', 'privacy', 'Rechtsgrundlage ist § 26 BDSG.'],
  ['TMG inside another word', 'impressum', 'Beispiel STMG GmbH, Musterstraße 1, 10115 Berlin.'],
];

const textDocuments = (kind: Case[1], text: string) =>
  kind === 'privacy' ? withPolicyText(text) : withImpressumText(text);

describe('LEGAL-02 counts only a mention its own sentence does not mark as former', () => {
  it.each([...MARKED, ...UNRELATED])('%s → no observation', (_label, kind, text) => {
    const r = run(textDocuments(kind, text));
    expect(r.status).toBe('completed');
    expect(observationsOf(r)).toEqual([]);
  });

  it.each(MARKED)(
    '%s: without the cues and successors of the dictionary it is reported',
    (_l, kind, text) => {
      const legal = structuredClone(loadDataDir('legal')) as {
        outdatedReferences: { historicalCues: object; references: Array<{ successors: string[] }> };
      };
      legal.outdatedReferences.historicalCues = { de: [], en: [] };
      for (const r of legal.outdatedReferences.references) r.successors = [];
      const r = runCheck(legal02, legalSite(textDocuments(kind, text)), { data: { legal } });
      expect(observationsOf(r)).not.toEqual([]);
    },
  );

  it('a mention only in a hidden template part of the page → no observation', () => {
    expect(
      referenceIds(
        withPolicyText('Google ist unter dem Privacy Shield zertifiziert.', { origin: 'hidden-irrelevant' }),
      ),
    ).toEqual([]);
  });

  it('a historical sentence does not hide a separate sentence that uses the designation', () => {
    const r = run(
      withPolicyText(
        'Das Privacy Shield wurde 2020 für ungültig erklärt. Unser Newsletter-Dienst ist unter dem Privacy Shield zertifiziert.',
      ),
    );
    const [o, ...rest] = observationsOf(r);
    expect(rest).toEqual([]);
    expect(o?.params.mentionCount).toBe(1);
    expect(quotes(o!).map((q) => q.quote)).toEqual([
      'Unser Newsletter-Dienst ist unter dem Privacy Shield zertifiziert.',
    ]);
  });

  it.each<Case>([
    [
      'a successor in another sentence',
      'privacy',
      'Wir prüfen das Data Privacy Framework. Google ist unter dem Privacy Shield zertifiziert.',
    ],
    [
      'a sentence that starts with a paragraph sign',
      'impressum',
      'Angaben nach § 5 DDG. § 7 TMG regelt die Haftung.',
    ],
    [
      'a sentence that starts with a number',
      'privacy',
      'Das Privacy Shield wurde aufgehoben. 2026 ist der Anbieter unter dem Privacy Shield zertifiziert.',
    ],
  ])('%s: the marked neighbour does not hide the mention', (_label, kind, text) => {
    expect(observationsOf(run(textDocuments(kind, text))).map((o) => o.params.mentionCount)).toEqual([1]);
  });

  it('only the legal splitting starts a sentence at "§" or a number; the policy statements keep theirs', () => {
    const abbreviations = new Set(['abs']);
    const text = 'Angaben nach § 5 Abs. 1 DDG. § 7 TMG regelt die Haftung. 2026 gilt das.';
    expect(splitSentences(text, abbreviations)).toEqual([text]);
    expect(splitSentences(text, abbreviations, { legalStarts: true })).toEqual([
      'Angaben nach § 5 Abs. 1 DDG.',
      '§ 7 TMG regelt die Haftung.',
      '2026 gilt das.',
    ]);
  });
});

describe('LEGAL-02 spellings and repeats', () => {
  it.each<[string, 'impressum' | 'privacy', string, string]>([
    [
      'the English framework name',
      'privacy',
      'Our provider is certified under the EU-U.S. Privacy Shield Framework.',
      'privacy-shield',
    ],
    [
      'a bare link to the former participant list',
      'privacy',
      'Weitere Informationen: https://www.privacyshield.gov/participant?id=[redacted]',
      'privacy-shield',
    ],
    [
      'the German name of the framework',
      'privacy',
      'Google hat sich dem EU-US-Datenschutzschild unterworfen.',
      'privacy-shield',
    ],
    [
      'an inflected law name',
      'impressum',
      'Diensteanbieter im Sinne des Telemediengesetzes ist die Beispiel GmbH.',
      'tmg',
    ],
    [
      'a paragraph with "Abs."',
      'impressum',
      'Als Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG für eigene Inhalte verantwortlich.',
      'tmg',
    ],
    ['the renamed law', 'privacy', 'Die Speicherung erfolgt nach § 25 Abs. 1 TTDSG.', 'ttdsg'],
    [
      'the earlier framework',
      'privacy',
      'Der Anbieter ist nach dem Safe-Harbor-Abkommen zertifiziert.',
      'safe-harbor',
    ],
    [
      'the repealed directive',
      'privacy',
      'Wir verarbeiten Daten im Sinne der Richtlinie 95/46/EG.',
      'directive-95-46',
    ],
    [
      'an explicit old version of the BDSG',
      'privacy',
      'Rechtsgrundlage ist § 28 Abs. 1 BDSG a. F. in Verbindung mit Ihrer Einwilligung.',
      'bdsg-old',
    ],
  ])('%s is reported', (_label, kind, text, id) => {
    const documents = kind === 'privacy' ? withPolicyText(text) : withImpressumText(text);
    expect(referenceIds(documents)).toEqual([id]);
  });

  it('repeats in a document give one observation that counts the sentences', () => {
    const [o, ...rest] = observationsOf(
      run(
        withImpressumText(
          'Angaben gemäß § 5 TMG: Beispiel GmbH. Als Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG verantwortlich. Nach §§ 8 bis 10 TMG sind wir nicht verpflichtet, fremde Informationen zu überwachen.',
        ),
      ),
    );
    expect(rest).toEqual([]);
    expect(o?.params.mentionCount).toBe(3);
  });

  it('at most three sentences are quoted; the count covers all of them', () => {
    const text = Array.from(
      { length: 5 },
      (_, i) => `Dienst ${i + 1} ist unter dem Privacy Shield zertifiziert.`,
    ).join(' ');
    const [o] = observationsOf(run(withPolicyText(text)));
    expect(o?.params.mentionCount).toBe(5);
    expect(quotes(o!)).toHaveLength(3);
  });

  it('a sentence longer than a quote is cut around the designation', () => {
    const filler =
      'Die Verarbeitung dient der Analyse der Nutzung unserer Website und der Verbesserung des Angebots';
    const text = `${filler}, ${filler}, und der Anbieter ist unter dem Privacy Shield zertifiziert, ${filler}, ${filler}.`;
    const [q] = quotes(observationsOf(run(withPolicyText(text)))[0]!);
    expect(q!.quote.length).toBeLessThanOrEqual(200);
    expect(q!.quote).toContain('Privacy Shield');
    expect(q!.quote.startsWith('…')).toBe(true);
    expect(q!.quote.endsWith('…')).toBe(true);
  });

  it('two documents whose URLs differ only in a redacted query are two pages', () => {
    const url = `${LEGAL02_ORIGIN}/index.php?page=[redacted]`;
    const os = observationsOf(
      run([
        impressumDocument([docPart('i1', 'Angaben gemäß § 5 DDG: Beispiel GmbH.', { sourceUrl: url })], {
          url,
          finalUrl: url,
        }),
        policyDocument(
          [docPart('p1', 'Google ist unter dem Privacy Shield zertifiziert.', { sourceUrl: url })],
          {
            url,
            finalUrl: url,
          },
        ),
        policyDocument(
          [docPart('s1', 'Der Kursanbieter ist unter dem Privacy Shield zertifiziert.', { sourceUrl: url })],
          {
            id: 'doc-privacy-2',
            url,
            finalUrl: url,
            role: 'supplement',
          },
        ),
      ]),
    );
    expect(os.map((o) => [o.subject, o.evidence.find((e) => e.type === 'text-match')?.documentId])).toEqual([
      ['privacy:privacy-shield', 'doc-privacy'],
      ['privacy:privacy-shield', 'doc-privacy-2'],
    ]);
  });

  it('Impressum and policy on the same page → one observation per designation', () => {
    const combined = `${LEGAL02_ORIGIN}/impressum-datenschutz`;
    const parts = [
      docPart('c1', 'Angaben gemäß § 5 TMG: Beispiel GmbH.', { section: 'Impressum', sourceUrl: combined }),
      docPart('c2', 'Google ist unter dem Privacy Shield zertifiziert.', {
        section: 'Datenschutz',
        sourceUrl: combined,
      }),
    ];
    const os = observationsOf(
      run([
        impressumDocument(parts, { url: combined, finalUrl: combined }),
        policyDocument(parts, { url: combined, finalUrl: combined }),
      ]),
    );
    expect(os.map((o) => [o.subject, o.params.documentKind, o.params.documentUrl]).sort()).toEqual([
      ['combined:privacy-shield', 'combined', combined],
      ['combined:tmg', 'combined', combined],
    ]);
  });

  it('a further privacy notice of the site is searched too', () => {
    const notice = `${LEGAL02_ORIGIN}/datenschutzhinweise-kurse`;
    const os = observationsOf(
      run([
        currentImpressum(),
        currentPolicy(),
        policyDocument(
          [
            docPart('s1', 'Unser Kursanbieter ist unter dem Privacy Shield zertifiziert.', {
              sourceUrl: notice,
            }),
          ],
          {
            id: 'doc-privacy-2',
            url: notice,
            finalUrl: notice,
            role: 'supplement',
          },
        ),
      ]),
    );
    expect(os.map((o) => [o.subject, o.params.documentUrl, o.params.hasSection, o.params.section])).toEqual([
      ['privacy:privacy-shield', notice, false, null],
    ]);
  });

  it('a designation whose change lies after the scan date is not looked for', () => {
    const r = runCheck(legal02, scenario('violation-tmg-rstv-in-impressum.json'), {
      now: new Date('2024-01-01T00:00:00Z'),
    });
    expect(observationsOf(r).map((o) => o.params.referenceId)).toEqual(['rstv']);
  });
});

describe('LEGAL-02 reports what it could not read', () => {
  it('a PDF policy: the Impressum is still searched, the result is partial', () => {
    const r = runCheck(legal02, scenario('violation-tmg-with-policy-pdf.json'));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['privacy-pdf']);
    expect(observationsOf(r).map((o) => o.subject)).toEqual(['impressum:tmg']);
  });

  it.each<[string, Partial<DocumentRecord>, string]>([
    ['cut off at the reading limit', { complete: false, errors: ['truncated'] }, 'privacy-incomplete'],
    [
      'with expandables that were not opened',
      { complete: false, errors: ['expand-failed'] },
      'privacy-incomplete',
    ],
  ])('a policy %s is searched and the result is partial', (_label, p, limitation) => {
    const policy = policyDocument([docPart('p1', 'Google ist unter dem Privacy Shield zertifiziert.')], p);
    const r = run([currentImpressum(), policy]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual([limitation]);
    expect(observationsOf(r).map((o) => o.subject)).toEqual(['privacy:privacy-shield']);
  });

  it.each<[string, Partial<DocumentRecord>, string]>([
    ['in another language', { lang: 'fr' }, 'privacy-language-unsupported'],
    ['judged an error page', { errors: ['soft-404'] }, 'privacy-not-found'],
    ['that answered 404', { status: 404 }, 'privacy-not-found'],
  ])('a policy %s is not searched', (_label, p, limitation) => {
    const policy = policyDocument([docPart('p1', 'Google ist unter dem Privacy Shield zertifiziert.')], p);
    const r = run([currentImpressum(), policy]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual([limitation]);
    expect(observationsOf(r)).toEqual([]);
  });

  it('no Impressum found: the policy is still searched', () => {
    const r = run([policyDocument([docPart('p1', 'Google ist unter dem Privacy Shield zertifiziert.')])]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['impressum-not-found']);
    expect(observationsOf(r).map((o) => o.subject)).toEqual(['privacy:privacy-shield']);
  });

  it('candidates read for Impressum details are no documents', () => {
    const snap = legalSite([currentPolicy()]);
    snap.documents!.candidates = [
      impressumDocument([docPart('k1', 'Angaben gemäß § 5 TMG: Beispiel GmbH.')], {
        url: `${LEGAL02_ORIGIN}/kontakt`,
        finalUrl: `${LEGAL02_ORIGIN}/kontakt`,
      }),
    ];
    const r = runCheck(legal02, snap);
    expect(r.outcome?.limitations).toEqual(['impressum-not-found']);
    expect(observationsOf(r)).toEqual([]);
  });

  const NOTICE = `${LEGAL02_ORIGIN}/datenschutzhinweise-kurse`;
  const notice = (p: Partial<DocumentRecord>) =>
    policyDocument([docPart('s1', 'Unser Kursanbieter ist unter dem Privacy Shield zertifiziert.')], {
      id: 'doc-privacy-2',
      url: NOTICE,
      finalUrl: NOTICE,
      role: 'supplement',
      ...p,
    });

  it.each<[string, Partial<DocumentRecord>, string[]]>([
    ['only a PDF', { format: 'pdf', parts: [] }, []],
    ['in another language', { lang: 'fr' }, []],
    ['cut off at the reading limit', { complete: false, errors: ['truncated'] }, ['privacy:privacy-shield']],
  ])('a further privacy notice %s is noted; the policy is still searched', (_label, p, subjects) => {
    const r = run([currentImpressum(), currentPolicy(), notice(p)]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['supplement-not-evaluated']);
    expect(observationsOf(r).map((o) => o.subject)).toEqual(subjects);
  });

  it.each<[string, 'error' | 'other-language' | 'not-found' | 'soft-404', string[]]>([
    ['whose fetch failed', 'error', ['supplement-not-evaluated']],
    ['only noted as another language version', 'other-language', ['supplement-not-evaluated']],
    ['behind a link that answered 404', 'not-found', []],
    ['behind a link to an error page', 'soft-404', []],
  ])('a further privacy notice %s', (_label, outcome, limitations) => {
    const r = runCheck(
      legal02,
      legalSite(
        [currentImpressum(), currentPolicy()],
        [
          {
            kind: 'privacy',
            via: 'link',
            url: NOTICE,
            status: outcome === 'not-found' ? 404 : null,
            outcome,
            supplement: true,
          },
        ],
      ),
    );
    expect(r.outcome?.limitations).toEqual(limitations);
    expect(r.status).toBe(limitations.length > 0 ? 'partial' : 'completed');
  });

  it('a further privacy notice alone is no policy: the policy is still reported as not found', () => {
    const r = run([currentImpressum(), notice({})]);
    expect(r.outcome?.limitations).toEqual(['privacy-not-found']);
    expect(observationsOf(r).map((o) => o.params.documentUrl)).toEqual([NOTICE]);
  });
});

describe('LEGAL-02 texts', () => {
  const de = loadTexts('de');
  const en = loadTexts('en');

  /** Every reason and limitation the check reports. */
  const LIMITATIONS = [
    ...['impressum', 'privacy'].flatMap((kind) =>
      ['not-found', 'pdf', 'unsupported-format', 'language-unsupported', 'incomplete'].map(
        (x) => `${kind}-${x}`,
      ),
    ),
    'supplement-not-evaluated',
  ];

  it.each(['de', 'en'] as const)('%s: the reason and every limitation have words', (lang) => {
    const ui = loadTexts(lang).ui;
    expect(formatMessage(ui['report.reason']!.text, { code: 'no-documents' }, lang)).not.toBe('');
    for (const code of LIMITATIONS) {
      expect(formatMessage(ui['report.checkLimitation']!.text, { code }, lang), code).not.toBe('');
    }
  });

  it('the body states the fact, the date and that the meaning was not assessed', () => {
    const [o] = observationsOf(runCheck(legal02, scenario('violation-privacy-shield-in-policy.json')));
    const m = renderMessage(de, 'LEGAL-02.outdated-reference', o!.params);
    expect(m.title).toBe(
      'Bezeichnung einer früheren Rechtslage beobachtet in der Datenschutzerklärung: EU-US Privacy Shield',
    );
    expect(m.body).toContain(
      'Der zugehörige Angemessenheitsbeschluss wurde am 2020-07-16 vom EuGH für ungültig erklärt (Rechtssache C-311/18 (Schrems II)).',
    );
    expect(m.body).toContain(
      `Unter ${LEGAL02_PRIVACY}, Abschnitt „Datenschutzerklärung > 5. Plugins und Tools > Analytics“,`,
    );
    expect(m.body.endsWith('Die rechtliche Bedeutung der Angabe wurde nicht bewertet.')).toBe(true);
    expect(renderMessage(en, 'LEGAL-02.outdated-reference', o!.params).body).toContain(
      'declared invalid by the CJEU on 2020-07-16 (case C-311/18 (Schrems II))',
    );
  });

  it.each<[string, string]>([
    ['replaced', 'Abgelöst am 2024-05-14 durch: Digitale-Dienste-Gesetz (DDG).'],
    ['renamed', 'Umbenannt am 2024-05-14 in: Digitale-Dienste-Gesetz (DDG).'],
    ['repealed', 'Aufgehoben mit Wirkung zum 2024-05-14, ersetzt durch: Digitale-Dienste-Gesetz (DDG).'],
  ])('reason %s', (reason, sentence) => {
    const params = {
      documentKind: 'impressum',
      documentUrl: LEGAL02_IMPRESSUM,
      reference: 'X',
      hasSection: false,
      section: null,
      mentionCount: 2,
      reason,
      since: '2024-05-14',
      replacedBy: 'Digitale-Dienste-Gesetz (DDG)',
      ruling: null,
    };
    const body = renderMessage(de, 'LEGAL-02.outdated-reference', params).body;
    expect(body).toContain(sentence);
    expect(body).toContain(`Unter ${LEGAL02_IMPRESSUM} wurde die Bezeichnung „X“ beobachtet (2 Sätze`);
  });

  it('a title for several findings names both documents and lists the designations last', () => {
    const params = {
      documentKind: 'impressum, privacy',
      reference: 'EU-US Privacy Shield, Telemediengesetz (TMG)',
    };
    expect(renderMessage(de, 'LEGAL-02.outdated-reference', params).title).toBe(
      'Bezeichnung einer früheren Rechtslage beobachtet in Impressum und Datenschutzerklärung: EU-US Privacy Shield, Telemediengesetz (TMG)',
    );
    expect(
      renderMessage(en, 'LEGAL-02.outdated-reference', { ...params, documentKind: 'combined' }).title,
    ).toBe(
      'Designation of a former legal situation observed in the legal notice and privacy policy: EU-US Privacy Shield, Telemediengesetz (TMG)',
    );
  });
});

/** Parts with a mention in each origin the collector records for visible text. */
const ORIGINS: DocumentPart['origin'][] = ['visible', 'expandable', 'frame'];

describe('LEGAL-02 reads every part the page shows', () => {
  it.each(ORIGINS)('a mention in a part of origin %s is reported', (origin) => {
    expect(
      referenceIds(withPolicyText('Google ist unter dem Privacy Shield zertifiziert.', { origin })),
    ).toEqual(['privacy-shield']);
  });
});
