/**
 * Beyond the stop words, finding texts of the browser module only describe what was observed: no claims about
 * consent, "tracker" labels, necessity verdicts, evaluative terms, "missing imprint" or obligations. Legal notes are
 * exempt.
 */
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage, renderMessage, templateParams } from '../../../../src/core/data/messages.ts';

/** Phrase patterns per language, each with a label for the failure message. */
const RULES: Record<'de' | 'en', Array<[string, RegExp]>> = {
  de: [
    [
      'consent claim',
      /ohne\s+(eine\s+|die\s+)?\p{L}*(einwilligung|zustimmung)|ohne\s+rechtsgrundlage|einwilligung\s+liegt|einwilligungslos/iu,
    ],
    ['consent claim', /vor\s+(einer\s+|der\s+)?(einwilligung|zustimmung)\b/iu],
    ['tracker label', /\btracker|tracking-cookie|spionage|überwachung|schnüffel/iu],
    ['tracker label', /tracking-(?!signatur)\p{L}+/iu],
    [
      'necessity verdict',
      /unbedingt\s+erforderlich|nicht\s+erforderlich|technisch\s+notwendig|\bnotwendig(e[nmrs]?)?\b|essen[sz]i?ell/iu,
    ],
    ['evaluative term', /manipulativ|dark\s+pattern|täuschend|irreführend|nudging|versteckt/iu],
    [
      'missing imprint',
      /fehlende[ns]?\s+impressum|impressum\s+fehlt|kein\s+impressum|datenschutzerklärung\s+fehlt|keine\s+datenschutzerklärung|impressumspflicht/iu,
    ],
    ['obligation', /sie\s+müssen|sie\s+sind\s+verpflichtet|\bpflicht\b|\bmuss\b/iu],
    [
      'consent state',
      /einwilligung\s+erteilt|erteilte[nmrs]?\s+einwilligung|zugestimmt|zustimmung\s+erfolgt/iu,
    ],
  ],
  en: [
    [
      'consent claim',
      /without\s+(a\s+|any\s+)?(\w+\s+)?(consent|legal\s+basis)|no\s+consent\s+(was\s+)?given/i,
    ],
    ['consent claim', /before\s+(any\s+)?consent\b/i],
    [
      'tracker label',
      /\btrackers?\b|tracking\s+(cookie|identifier|storage|endpoint)s?|spyware|surveillance/i,
    ],
    ['necessity verdict', /strictly\s+necessary|\bnecessary\b|\bessential\b/i],
    ['evaluative term', /manipulative|dark\s+pattern|deceptive|misleading|nudging|\bhidden\b/i],
    ['missing imprint', /missing\s+(imprint|legal\s+notice|privacy\s+policy)|no\s+privacy\s+policy/i],
    ['obligation', /you\s+must|you\s+are\s+required|is\s+mandatory/i],
    ['consent state', /consent\s+(was\s+)?given|user\s+agreed|granted\s+consent/i],
  ],
};

/** Quoted button labels („Nur notwendige“, “…”) may contain otherwise restricted words. */
const unquote = (s: string) => s.replace(/„[^“]*“|“[^”]*”|"[^"]*"/g, '""');

describe('browser finding texts only describe observations', () => {
  for (const lang of ['de', 'en'] as const) {
    const texts = loadTexts(lang);
    const keys = browserChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));
    it.each(keys)(`${lang}: %s`, (key) => {
      const m = texts.messages[key];
      expect(m, `${key} has no ${lang} text`).toBeDefined();
      const text = unquote(`${m?.title ?? ''}\n${m?.body ?? ''}`);
      const hits = RULES[lang].filter(([, re]) => re.test(text)).map(([label, re]) => `${label}: ${re}`);
      expect(hits).toEqual([]);
    });
  }
});

describe('browser legal notes per check or per variant', () => {
  const allowed = new Set(
    browserChecks.flatMap((c) => [
      c.id,
      ...c.variants.flatMap((v) => [`${c.id}.${v.variant}`, `${c.id}.${v.variantGroup ?? v.variant}`]),
    ]),
  );
  const browserKeys = (lang: 'de' | 'en') =>
    Object.keys(loadTexts(lang).legalNotes)
      .filter((k) => browserChecks.some((c) => k === c.id || k.startsWith(`${c.id}.`)))
      .sort();

  it('every key names a browser check, or one of its variants or variant groups, in both languages', () => {
    expect(browserKeys('de').filter((k) => !allowed.has(k))).toEqual([]);
    expect(browserKeys('de')).toEqual(browserKeys('en'));
  });

  it('a stored or read identifier is not filed under the contested status of requests without one', () => {
    const de = loadTexts('de').legalNotes;
    expect(de['CONSENT-01']?.status).toBe('contested');
    expect(de['CONSENT-01.tracking-completed']?.status).not.toBe('contested');
  });
});

describe('browser actions also serve several findings at once', () => {
  const variants = browserChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));

  for (const lang of ['de', 'en'] as const) {
    const texts = loadTexts(lang);
    it.each(variants)(`${lang}: %s uses only parameters of its finding and points to no title`, (key) => {
      const action = texts.actions[key] ?? '';
      const m = texts.messages[key];
      const own = new Set([...templateParams(m?.title ?? ''), ...templateParams(m?.body ?? '')]);
      expect(templateParams(action).filter((p) => !own.has(p))).toEqual([]);
      expect(action).not.toMatch(
        /\btitel|\btitle\b|dieser dienst|dieses dienstes|diesen dienst|this service/iu,
      );
    });
  }

  it('LEGAL-01: each document kind names its document, a mixed group names both', () => {
    const de = loadTexts('de');
    const action = (documentKind: string) =>
      formatMessage(de.actions['LEGAL-01.document-not-found']!, { documentKind }, 'de');
    expect(action('impressum')).toBe('Verlinken Sie das Impressum gut sichtbar im Seitenfuß jeder Seite.');
    expect(action('privacy')).toBe(
      'Verlinken Sie die Datenschutzerklärung gut sichtbar im Seitenfuß jeder Seite.',
    );
    expect(action('impressum, privacy')).toBe(
      'Verlinken Sie Impressum und Datenschutzerklärung gut sichtbar im Seitenfuß jeder Seite.',
    );
    expect(
      renderMessage(de, 'LEGAL-01.document-not-found', { documentKind: 'impressum, privacy' }).title,
    ).toBe('Impressum und Datenschutzerklärung nicht gefunden');
  });

  it('CONSENT-05: requests and stored entries in one group get a title for both', () => {
    const params = {
      kind: 'request, storage',
      service: 'Google Ads, Google Marketing Platform (DoubleClick)',
    };
    expect(renderMessage(loadTexts('de'), 'CONSENT-05.tracking-after-reject', params).title).toBe(
      'Kennungen nach bestätigter Ablehnung gesendet oder gespeichert: Google Ads, Google Marketing Platform (DoubleClick)',
    );
    expect(
      renderMessage(loadTexts('de'), 'CONSENT-05.tracking-after-reject', { kind: 'storage', service: 'X' })
        .title,
    ).toBe('Analyse- oder Marketing-Kennung nach bestätigter Ablehnung gespeichert: X');
  });

  it('CONSENT-05: a reject saved in the settings layer is named in every title, after the moment of the reject', () => {
    const titles = (lang: 'de' | 'en') =>
      ['request', 'storage', 'both', 'request, storage'].map(
        (kind) =>
          renderMessage(loadTexts(lang), 'CONSENT-05.tracking-after-reject', {
            kind,
            service: 'X',
            rejectPath: 'settings',
          }).title,
      );
    expect(titles('de')).toEqual([
      'Anfragen mit dauerhafter Kennung nach bestätigter Ablehnung über die Einstellungen: X',
      'Analyse- oder Marketing-Kennung nach bestätigter Ablehnung über die Einstellungen gespeichert: X',
      'Kennungen nach bestätigter Ablehnung über die Einstellungen gesendet und gespeichert: X',
      'Kennungen nach bestätigter Ablehnung über die Einstellungen gesendet oder gespeichert: X',
    ]);
    expect(titles('en')).toEqual([
      'Requests with a persistent identifier after a confirmed rejection via the settings: X',
      'Analytics or marketing identifier stored after a confirmed rejection via the settings: X',
      'Identifiers sent and stored after a confirmed rejection via the settings: X',
      'Identifiers sent or stored after a confirmed rejection via the settings: X',
    ]);
    expect(
      renderMessage(loadTexts('de'), 'CONSENT-05.cookieless-ping-after-reject', {
        service: 'X',
        rejectPath: 'settings',
      }).title,
    ).toBe('Anfragen ohne dauerhafte Kennung nach Ablehnung über die Einstellungen: X');
  });

  it('titles put the service last, so a list of services reads as one', () => {
    const de = loadTexts('de');
    const params = { service: 'Google Ads, Google Analytics', requestCount: 12 };
    expect(renderMessage(de, 'CONSENT-01.tracking-completed', params).title).toBe(
      'Anfragen mit dauerhafter Kennung vor einer Interaktion: Google Ads, Google Analytics',
    );
    expect(renderMessage(de, 'PRIV-01.not-named', { service: 'A, B, C' }).title).toBe(
      'Nicht gefunden in der Datenschutzerklärung: A, B, C',
    );
  });
});

describe('EMBED titles name the moment of the loads', () => {
  /** Each message with the params that name its services, and the end of its title after the colon. */
  const NAMES = {
    'EMBED-01.fonts-loaded': [{ service: 'Google Fonts' }, 'Google Fonts'],
    'EMBED-01.fonts-in-embed-frame': [
      { service: 'Google Fonts', embedService: 'Google Maps' },
      'Google Fonts in Google Maps',
    ],
    'EMBED-02.maps-loaded': [{ service: 'Google Maps' }, 'Google Maps'],
    'EMBED-03.video-loaded': [{ service: 'YouTube' }, 'YouTube'],
  } as const;
  const KEYS = Object.keys(NAMES) as Array<keyof typeof NAMES>;
  type Titles = [string, string, string, string];
  /**
   * Moment params, then the de and en titles of the site's fonts, an embed's fonts, maps and videos with the services
   * left out.
   */
  const CASES: Array<[string, Record<string, string | boolean | null>, Record<'de' | 'en', Titles>]> = [
    [
      'before the interaction',
      { moment: 'before-interaction', rejectConfirmed: null },
      {
        de: [
          'Externe Schriftarten geladen',
          'Externe Schriftarten von einer Einbettung geladen',
          'Externer Kartendienst geladen',
          'Externer Videodienst geladen',
        ],
        en: [
          'External fonts loaded',
          'External fonts loaded by an embed',
          'External map service loaded',
          'External video service loaded',
        ],
      },
    ],
    [
      'before the interaction and after the confirmed reject',
      { moment: 'before-and-after-reject', rejectConfirmed: true },
      {
        de: [
          'Externe Schriftarten geladen, auch nach bestätigter Ablehnung',
          'Externe Schriftarten von einer Einbettung geladen, auch nach bestätigter Ablehnung',
          'Externer Kartendienst geladen, auch nach bestätigter Ablehnung',
          'Externer Videodienst geladen, auch nach bestätigter Ablehnung',
        ],
        en: [
          'External fonts loaded, also after confirmed rejection',
          'External fonts loaded by an embed, also after confirmed rejection',
          'External map service loaded, also after confirmed rejection',
          'External video service loaded, also after confirmed rejection',
        ],
      },
    ],
    [
      'before the interaction and after a reject the CMP state did not confirm',
      { moment: 'before-and-after-reject', rejectConfirmed: false },
      {
        de: [
          'Externe Schriftarten geladen, auch nach Ablehnung',
          'Externe Schriftarten von einer Einbettung geladen, auch nach Ablehnung',
          'Externer Kartendienst geladen, auch nach Ablehnung',
          'Externer Videodienst geladen, auch nach Ablehnung',
        ],
        en: [
          'External fonts loaded, also after rejection',
          'External fonts loaded by an embed, also after rejection',
          'External map service loaded, also after rejection',
          'External video service loaded, also after rejection',
        ],
      },
    ],
    [
      'only after the confirmed reject',
      { moment: 'after-reject', rejectConfirmed: true },
      {
        de: [
          'Externe Schriftarten nach bestätigter Ablehnung geladen',
          'Externe Schriftarten von einer Einbettung nach bestätigter Ablehnung geladen',
          'Externer Kartendienst nach bestätigter Ablehnung geladen',
          'Externer Videodienst nach bestätigter Ablehnung geladen',
        ],
        en: [
          'External fonts loaded after confirmed rejection',
          'External fonts loaded by an embed after confirmed rejection',
          'External map service loaded after confirmed rejection',
          'External video service loaded after confirmed rejection',
        ],
      },
    ],
    [
      'before the interaction and after the confirmed reject saved in the settings layer',
      { moment: 'before-and-after-reject', rejectConfirmed: true, rejectPath: 'settings' },
      {
        de: [
          'Externe Schriftarten geladen, auch nach bestätigter Ablehnung über die Einstellungen',
          'Externe Schriftarten von einer Einbettung geladen, auch nach bestätigter Ablehnung über die Einstellungen',
          'Externer Kartendienst geladen, auch nach bestätigter Ablehnung über die Einstellungen',
          'Externer Videodienst geladen, auch nach bestätigter Ablehnung über die Einstellungen',
        ],
        en: [
          'External fonts loaded, also after confirmed rejection via the settings',
          'External fonts loaded by an embed, also after confirmed rejection via the settings',
          'External map service loaded, also after confirmed rejection via the settings',
          'External video service loaded, also after confirmed rejection via the settings',
        ],
      },
    ],
    [
      'only after a save in the settings layer the CMP state did not confirm',
      { moment: 'after-reject', rejectConfirmed: false, rejectPath: 'settings' },
      {
        de: [
          'Externe Schriftarten nach Ablehnung über die Einstellungen geladen',
          'Externe Schriftarten von einer Einbettung nach Ablehnung über die Einstellungen geladen',
          'Externer Kartendienst nach Ablehnung über die Einstellungen geladen',
          'Externer Videodienst nach Ablehnung über die Einstellungen geladen',
        ],
        en: [
          'External fonts loaded after rejection via the settings',
          'External fonts loaded by an embed after rejection via the settings',
          'External map service loaded after rejection via the settings',
          'External video service loaded after rejection via the settings',
        ],
      },
    ],
    [
      'a first-layer reject keeps the wording without a path',
      { moment: 'after-reject', rejectConfirmed: true, rejectPath: 'first-layer' },
      {
        de: [
          'Externe Schriftarten nach bestätigter Ablehnung geladen',
          'Externe Schriftarten von einer Einbettung nach bestätigter Ablehnung geladen',
          'Externer Kartendienst nach bestätigter Ablehnung geladen',
          'Externer Videodienst nach bestätigter Ablehnung geladen',
        ],
        en: [
          'External fonts loaded after confirmed rejection',
          'External fonts loaded by an embed after confirmed rejection',
          'External map service loaded after confirmed rejection',
          'External video service loaded after confirmed rejection',
        ],
      },
    ],
    [
      'a summary of findings with different moments',
      { moment: 'after-reject, before-and-after-reject', rejectConfirmed: true },
      {
        de: [
          'Externe Schriftarten geladen',
          'Externe Schriftarten von einer Einbettung geladen',
          'Externer Kartendienst geladen',
          'Externer Videodienst geladen',
        ],
        en: [
          'External fonts loaded',
          'External fonts loaded by an embed',
          'External map service loaded',
          'External video service loaded',
        ],
      },
    ],
  ];

  for (const lang of ['de', 'en'] as const) {
    const texts = loadTexts(lang);
    it.each(CASES)(`${lang}: %s`, (_name, moment, titles) => {
      KEYS.forEach((key, i) => {
        const [names, tail] = NAMES[key];
        const params = {
          ...moment,
          ...names,
          fontService: true,
          integrationType: 'iframe',
          bannerFound: true,
          afterReject: moment.moment !== 'before-interaction',
          pageCount: 1,
          requestCount: 1,
          afterRejectPageCount: moment.moment === 'before-interaction' ? 0 : 1,
          frameFontRequestCount: 0,
          frameHelperCount: 0,
        };
        const m = renderMessage(texts, key, params);
        expect(m.title).toBe(`${titles[lang][i]}: ${tail}`);
        const text = unquote(`${m.title}\n${m.body}`);
        expect(RULES[lang].filter(([, re]) => re.test(text)).map(([label]) => label)).toEqual([]);
      });
    });
  }
});
