/**
 * Which mail domains the DNS stage after the browser checks besides the scanned domain. Pure: it reads the snapshot.
 *
 * - `final`: the registrable domain of the start page's final host, when a redirect leads to another domain. Only the
 *   start page counts, so a link to a third party never makes its DNS a target.
 * - `contact`: the exact domain of addresses the Impressum shows, in its text or as a mailto link on an Impressum page.
 *   The privacy policy, DMARC report addresses and other pages are left out: they name processors, data protection
 *   officers and report receivers, whose mail settings are not the site's.
 */
import type { DocumentsSection, PageVisit } from '../../core/snapshot/browser.ts';
import type { MailDomainSource, MailDomainStage, MailDomainTarget } from '../../core/snapshot/dns.ts';
import type { Snapshot } from '../../core/snapshot/index.ts';
import { registrableDomain } from '../../core/url/url.ts';

/** Skipped contact domains kept in the snapshot; an Impressum with a long address list stays bounded. */
const MAX_RECORDED_SKIPPED = 10;
/** Pages named per domain as where the address was seen. */
const MAX_SOURCES = 3;
/** Link regions that belong to the page frame, not to the Impressum text: an agency credit sits in the footer. */
const FRAME_REGIONS: ReadonlySet<string> = new Set(['header', 'nav', 'footer', 'banner']);

const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?`;
/** The domain the redaction keeps of an address (`[redacted]@example.de`); a full stop after it ends the sentence. */
const MASKED_ADDRESS = new RegExp(String.raw`\[redacted\]@(${LABEL}(?:\.${LABEL})+)`, 'gu');

export type PlannedMailDomain = Omit<MailDomainTarget, 'status' | 'reason' | 'budget'> & {
  /** Not queried: a free-mail provider, or over `dns.maxMailDomains`. */
  skip?: 'free-mail' | 'limit';
};

export interface MailTargetPlan {
  targets: PlannedMailDomain[];
  contacts: MailDomainStage['contacts'];
}

export interface MailTargetOptions {
  maxMailDomains: number;
  freeMail: ReadonlySet<string>;
}

/** A DNS name in ASCII (IDN as punycode), or null when it is no domain with a registrable part. */
function asciiDomain(domain: string): string | null {
  let host: string;
  try {
    host = new URL(`http://${domain}/`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  return registrableDomain(host) ? host : null;
}

function addressDomains(text: string): string[] {
  return [...text.matchAll(MASKED_ADDRESS)].flatMap((m) => {
    const d = asciiDomain(m[1] as string);
    return d ? [d] : [];
  });
}

interface Sighting {
  domain: string;
  source: MailDomainSource;
}

/** Addresses in the Impressum text, in document order; parts the reader marked as hidden and unrelated do not count. */
function textSightings(documents: DocumentsSection | undefined): Sighting[] {
  return (documents?.documents ?? [])
    .filter((d) => d.kind === 'impressum')
    .flatMap((d) =>
      d.parts
        .filter((p) => p.origin !== 'hidden-irrelevant')
        .flatMap((p) =>
          addressDomains(p.text).map((domain) => ({
            domain,
            source: { kind: 'impressum-text' as const, url: p.sourceUrl || d.finalUrl },
          })),
        ),
    );
}

/** Impressum pages the browser could read; a blocked or failed visit shows no addresses. */
function impressumPages(snapshot: Readonly<Snapshot>): PageVisit[] {
  return (snapshot.browser?.phases ?? []).flatMap((ph) =>
    ph.pages.filter((p) => p.role === 'impressum' && p.evaluable),
  );
}

/** Recipients of mailto links in the content of Impressum pages ("E-Mail schreiben" links carry no address text). */
function mailtoSightings(pages: readonly PageVisit[]): Sighting[] {
  return pages.flatMap((page) =>
    (page.dom?.links ?? [])
      .filter((l) => l.hrefKind === 'mailto' && l.mailto && !FRAME_REGIONS.has(l.region))
      .flatMap((l) =>
        addressDomains(l.mailto as string).map((domain) => ({
          domain,
          source: { kind: 'impressum-mailto' as const, url: page.finalUrl },
        })),
      ),
  );
}

function addSource(target: { sources: MailDomainSource[] }, source: MailDomainSource): void {
  const known = target.sources.some((s) => s.kind === source.kind && s.url === source.url);
  if (!known && target.sources.length < MAX_SOURCES) target.sources.push(source);
}

/**
 * Contact domains in order of first sighting, each with the pages that showed it: the addresses written in the
 * Impressum text in document order first, then mailto recipients the text does not show. A link's place within the
 * text is not recorded, so the written addresses, which the reader sees, decide the cap.
 */
function contactDomains(
  snapshot: Readonly<Snapshot>,
): Array<{ domain: string; sources: MailDomainSource[] }> {
  const byDomain = new Map<string, { domain: string; sources: MailDomainSource[] }>();
  const sightings = [...textSightings(snapshot.documents), ...mailtoSightings(impressumPages(snapshot))];
  for (const { domain, source } of sightings) {
    const entry = byDomain.get(domain) ?? { domain, sources: [] };
    addSource(entry, source);
    byDomain.set(domain, entry);
  }
  return [...byDomain.values()];
}

/**
 * Whether the Impressum was read: a document with text (a PDF or an empty page shows no addresses) or an Impressum
 * page with its links.
 */
function contactsState(snapshot: Readonly<Snapshot>, o: MailTargetOptions): MailTargetPlan['contacts'] {
  if (o.maxMailDomains === 0) return 'off';
  const readDocument = (snapshot.documents?.documents ?? []).some(
    (d) => d.kind === 'impressum' && d.parts.some((p) => p.origin !== 'hidden-irrelevant'),
  );
  const readPage = impressumPages(snapshot).some((p) => p.dom !== null);
  return readDocument || readPage ? 'impressum' : 'not-collected';
}

function finalTarget(snapshot: Readonly<Snapshot>, entryDomain: string): PlannedMailDomain | null {
  const finalHost = snapshot.target.finalHost?.toLowerCase().replace(/\.$/, '');
  const domain = finalHost ? registrableDomain(finalHost) : null;
  if (!finalHost || !domain || domain === entryDomain) return null;
  return { domain, host: finalHost, orgDomain: domain, roles: ['final'], sources: [] };
}

export function selectMailTargets(snapshot: Readonly<Snapshot>, o: MailTargetOptions): MailTargetPlan {
  const dns = snapshot.dns;
  const contacts = contactsState(snapshot, o);
  if (!dns || dns.notApplicable) return { targets: [], contacts };

  const entryDomain = dns.domain.toLowerCase();
  const final = finalTarget(snapshot, entryDomain);
  const targets: PlannedMailDomain[] = final ? [final] : [];
  if (contacts === 'off') return { targets, contacts };

  // Only skipped domains are capped in the record: a long list of free-mail addresses must not hide a planned domain.
  let planned = 0;
  let skipped = 0;
  for (const { domain, sources } of contactDomains(snapshot)) {
    // The scanned domain is checked already; the final domain gains the contact role and its sources.
    if (domain === entryDomain) continue;
    if (final && domain === final.domain) {
      final.roles.push('contact');
      for (const s of sources) addSource(final, s);
      continue;
    }

    const orgDomain = registrableDomain(domain) ?? domain;
    const target: PlannedMailDomain = { domain, host: domain, orgDomain, roles: ['contact'], sources };
    if (o.freeMail.has(domain)) target.skip = 'free-mail';
    else if (planned >= o.maxMailDomains) target.skip = 'limit';
    else planned++;

    if (target.skip && skipped++ >= MAX_RECORDED_SKIPPED) {
      // The limitation must survive the cap: one skipped-for-limit entry is always kept.
      if (target.skip !== 'limit' || targets.some((t) => t.skip === 'limit')) continue;
    }
    targets.push(target);
  }
  return { targets, contacts };
}
