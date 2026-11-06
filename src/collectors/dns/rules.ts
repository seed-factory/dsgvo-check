/** Schema and loader of test/data/dns/*.yaml: the mail domains the DNS stage after the browser leaves out. */
import { z } from 'zod';
import { loadSection } from '../../core/data/load.ts';
import { dataSection, LowerName } from '../../core/data/parse.ts';

/** A domain name as the masked address keeps it: lower case, labels separated by dots, no trailing dot. */
const DomainName = LowerName.refine(
  (s) => /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{2,63}$/u.test(s),
  'must be a domain name such as example.de',
);

export const mailDomainsSection = dataSection(
  'dns',
  'mailDomains',
  z
    .strictObject({ freeMail: z.array(DomainName).min(1) })
    .transform((v) => ({ freeMail: new Set(v.freeMail) as ReadonlySet<string> })),
);

export const loadMailDomainRules = (dataDir?: string) => loadSection(mailDomainsSection, dataDir);
export type MailDomainRules = ReturnType<typeof loadMailDomainRules>;

/** The sections, for the completeness test. */
export const dnsSections = [mailDomainsSection] as const;
