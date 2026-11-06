/**
 * Schemas and loaders of test/data/dns/*.yaml: the mail domains the DNS stage after the browser leaves out, and the
 * DKIM selectors probed per mail domain (MAIL-03).
 */
import { z } from 'zod';
import type { DkimRules } from '../../checks/dns/lib/dkim.ts';
import { loadSection } from '../../core/data/load.ts';
import { dataSection, LowerName } from '../../core/data/parse.ts';

/** A domain name as the masked address keeps it: lower case, labels separated by dots, no trailing dot. */
const DomainName = LowerName.refine(
  (s) => /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{2,63}$/u.test(s),
  'must be a domain name such as example.de',
);

/** A DNS name that may hold service labels such as `_spf` (SPF include targets). */
const DnsName = LowerName.refine(
  (s) => /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(s),
  'must be a DNS name such as _spf.example.com',
);

/** A DKIM selector: one or more labels, the part in front of `._domainkey.` (RFC 6376 §3.1), not the full name. */
const DKIM_SELECTOR = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/;
const Selector = LowerName.refine(
  (s) => DKIM_SELECTOR.test(s) && !/(?:^|\.)_domainkey(?:\.|$)/.test(s),
  'must be a DKIM selector such as selector1',
);

export const mailDomainsSection = dataSection(
  'dns',
  'mailDomains',
  z
    .strictObject({ freeMail: z.array(DomainName).min(1) })
    .transform((v) => ({ freeMail: new Set(v.freeMail) as ReadonlySet<string> })),
);

const Provider = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a kebab-case id'),
  mx: z.array(DnsName).min(1),
  spfIncludes: z.array(DnsName).min(1),
  selectors: z.array(Selector).min(1),
  fixed: z.boolean(),
});

export const dkimSection = dataSection(
  'dns',
  'dkim',
  z
    .strictObject({
      providers: z
        .array(Provider)
        .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, 'provider ids must be unique'),
      commonSelectors: z.array(Selector).min(1),
    })
    .transform((v): DkimRules => v),
);

export const loadMailDomainRules = (dataDir?: string) => loadSection(mailDomainsSection, dataDir);
export type MailDomainRules = ReturnType<typeof loadMailDomainRules>;
export const loadDkimRules = (dataDir?: string): DkimRules => loadSection(dkimSection, dataDir);

/** The sections, for the completeness test. */
export const dnsSections = [mailDomainsSection, dkimSection] as const;
