/**
 * Word search for names in page text. The browser collector (the consent dialog) and the checks (the privacy policy)
 * both search with it, so that a service counts as named in one text exactly when it would in the other: text and
 * term are folded into the same search form, and a term counts only as whole words. Pure.
 */

/** NFKC, case, ä/ae, ß/ss, soft hyphen, diacritics; punctuation and hyphens → spaces; one space on either side. */
export function normalizeText(s: string): string {
  return ` ${s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u00AD/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Whether `text`, in the form `normalizeText` gives, holds `term` as whole words: both carry a space on either side,
 * so `Google Ads` is not found at the start of `Google AdSense`.
 */
export function containsTerm(text: string, term: string): boolean {
  const t = normalizeText(term);
  return t.trim().length > 0 && text.includes(t);
}

/** The first of `terms` that `text` (in the form `normalizeText` gives) holds as whole words; null when none. */
export function firstTermIn(text: string, terms: readonly string[]): string | null {
  return terms.find((t) => containsTerm(text, t)) ?? null;
}

/** What a service of the catalog is named by: its name, then its German and English aliases, in this order. */
export interface ServiceNames {
  name: string;
  aliasesDe?: readonly string[];
  aliasesEn?: readonly string[];
}

/** The terms that name a service (the `named` level of PRIV-01), in the order a search tries them. */
export function serviceNameTerms(s: ServiceNames): string[] {
  return [s.name, ...(s.aliasesDe ?? []), ...(s.aliasesEn ?? [])];
}
