import type { ProductVersion } from '../snapshot/common.ts';

/**
 * Headers that name the server software. Their value stays `[redacted]` like any free text (it can carry hostnames,
 * addresses or contact data); only the product tokens read from it are stored. A header mapped to a product names it
 * by its own name and sends the version alone (`X-AspNet-Version: 4.0.30319`).
 */
export const PRODUCT_HEADERS: ReadonlyMap<string, string | null> = new Map([
  ['server', null],
  ['x-powered-by', null],
  ['x-generator', null],
  ['x-redirect-by', null],
  ['x-aspnet-version', 'ASP.NET'],
  ['x-aspnetmvc-version', 'ASP.NET MVC'],
]);

const MAX_PRODUCT_VERSIONS = 4;
const MAX_PRODUCT_LENGTH = 40;
const MAX_VERSION_LENGTH = 30;
/** Longer tokens cannot hold a valid pair and are not even sliced out of the value. */
const MAX_TOKEN_LENGTH = MAX_PRODUCT_LENGTH + 1 + MAX_VERSION_LENGTH;

/** A letter, then letters, digits, `_`, `+`, `-`. No dot: a dotted name cannot be told apart from a hostname. */
const PRODUCT_RE = /^[A-Za-z][A-Za-z0-9_+-]*$/;
/** Product names are words (`Oracle-Application-Server-10g`); more digits or a longer word is an identifier or a hash. */
const MAX_PRODUCT_DIGITS = 4;
const MAX_PRODUCT_WORD = 20;
/**
 * Numbers of at most eight digits joined by dots, an optional letter, then suffixes of at most ten characters
 * (`1.1.1f`, `8.1.2-1ubuntu2.14`, `9.4.43.v20210629`). Longer numbers or suffixes are identifiers rather than versions;
 * `@`, `:`, `/`, `?`, `;` and `%` never match. Only tested on at most `MAX_VERSION_LENGTH` characters.
 */
const VERSION_RE = /^\d{1,8}(?:\.\d{1,8})*[A-Za-z]?(?:[-+_.~][0-9A-Za-z]{1,10})*$/;
/** Four dotted numbers at the start read as an IPv4 address, also in octal or padded form (`10.0.0.1`, `0177.0.0.1`). */
const IPV4_START_RE = /^\d+(?:\.\d+){3}(?!\d)/;
/** The one dotted label shape that starts with a letter in a version: a letter and a build number (`v20210629`). */
const LETTER_LABEL_RE = /^[A-Za-z]\d+$/;
/** Eight or more hex digits with a letter among them: a hash, a UUID part or a token, not a word or a date. */
const HEX_ID_RE = /^(?=[0-9a-f]*[a-f])[0-9a-f]{8,}$/i;

/** A version of domain shape: a label that starts with a letter (`2.4.web01`, `1.w3b01`), or two labels with letters. */
function hostLikeVersion(version: string): boolean {
  const labels = version.split('.');
  if (labels.slice(1).some((label) => /^[A-Za-z]/.test(label) && !LETTER_LABEL_RE.test(label))) return true;
  return labels.filter((label) => /[A-Za-z]/.test(label)).length >= 2;
}

function validVersion(version: string): boolean {
  return (
    version.length <= MAX_VERSION_LENGTH &&
    VERSION_RE.test(version) &&
    !IPV4_START_RE.test(version) &&
    !hostLikeVersion(version) &&
    !version.split(/[-+_.~]/).some((part) => HEX_ID_RE.test(part))
  );
}

function validProduct(product: string): boolean {
  if (!PRODUCT_RE.test(product)) return false;
  if ((product.match(/\d/g)?.length ?? 0) > MAX_PRODUCT_DIGITS) return false;
  return product.split(/[-_+]/).every((word) => word.length <= MAX_PRODUCT_WORD && !HEX_ID_RE.test(word));
}

/** `name/version` of one token; `null` when either part is not of the strict shape. */
function productPair(token: string): ProductVersion | null {
  const slash = token.indexOf('/');
  if (slash < 1 || slash > MAX_PRODUCT_LENGTH) return null;
  const product = token.slice(0, slash);
  const version = token.slice(slash + 1);
  return validProduct(product) && validVersion(version) ? { product, version } : null;
}

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Blanks separate tokens; a comma only before a blank or at the end, as between joined fields (a URL path has commas). */
const isSeparator = (value: string, i: number): boolean =>
  isBlank(value[i]) || (value[i] === ',' && (i + 1 === value.length || isBlank(value[i + 1])));

/**
 * Product tokens of a value, passed to `take` until it returns false. Comments and quoted strings are skipped (RFC 9110
 * §5.6.4 and §5.6.5: comments nested, both with `\` escapes; an unclosed one hides the rest of the value). The grammar
 * puts a blank between a product and a comment, so a run of text glued to a comment or a quoted string (`a/(b)c/1`
 * inside a URL, the quoted local part of an e-mail address) yields no token at all. One linear pass, no expression over
 * the value.
 */
function forEachProductToken(value: string, take: (token: string) => boolean): void {
  let depth = 0;
  let quoted = false;
  /** Start of the current run of non-blank text, -1 between runs. */
  let start = -1;
  let enclosed = false;
  const end = (at: number): boolean => {
    const ok = start < 0 || enclosed || at - start > MAX_TOKEN_LENGTH || take(value.slice(start, at));
    start = -1;
    enclosed = false;
    return ok;
  };

  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    if (isSeparator(value, i)) {
      if (!end(i)) return;
      continue;
    }
    if (start < 0) start = i;
    if (c === '(' || c === '"') {
      enclosed = true;
      if (c === '(') depth = 1;
      else quoted = true;
    }
  }
  end(value.length);
}

/**
 * The product/version pairs of a product header, at most four and each once. Hosts, addresses, e-mail addresses, URLs
 * and comments are never kept: only tokens of the strict shape above pass.
 */
export function productVersionsOf(name: string, value: string): ProductVersion[] {
  const implied = PRODUCT_HEADERS.get(name.toLowerCase()) ?? null;
  const out: ProductVersion[] = [];

  forEachProductToken(value, (token) => {
    if (implied !== null) {
      // the version header sends one version: only its first token counts
      if (validVersion(token)) out.push({ product: implied, version: token });
      return false;
    }
    const pair = productPair(token);
    if (pair && !out.some((p) => p.product === pair.product && p.version === pair.version)) out.push(pair);
    return out.length < MAX_PRODUCT_VERSIONS;
  });
  return out;
}
