/**
 * Why a setting is refused, without any wording: an id plus parameters. The text of `config.problem.<id>` lives in
 * test/data/texts/{de,en} and is rendered where the language is known (CLI, `scan()`).
 */
import type { z } from 'zod';
import type { MessageParams } from '../report/schema.ts';

export interface ProblemReason {
  id: string;
  params: MessageParams;
}

/** Ids that the schema puts into the `message` of its own checks; any other message of an issue is not an id. */
export const REASON = {
  /** A pause or gap that may only be made stricter than the built-in value. */
  floor: 'floor',
  proxyScheme: 'proxy-scheme',
  dnsServer: 'dns-server',
  dwellOrder: 'dwell-order',
  tlsDaysOrder: 'tls-days-order',
  tlsShareOrder: 'tls-share-order',
  reportReserve: 'report-reserve',
  integer: 'integer',
  number: 'number',
  unreadable: 'unreadable',
} as const;

const OWN_IDS: ReadonlySet<string> = new Set(Object.values(REASON));

/** Ids that `reasonOf` derives from the zod issue itself. */
const DERIVED_IDS = [
  'min',
  'above',
  'max',
  'items-min',
  'length-min',
  'option',
  'type',
  'unknown-keys',
  'invalid',
] as const;

/** Every id a problem can carry; each one has a text `config.problem.<id>` in every language (checked by a test). */
export const REASON_IDS: readonly string[] = [...Object.values(REASON), ...DERIVED_IDS];

/** Parameters of an own reason: the ones a custom check attached, or the bound of a too-small value. */
function ownReasonParams(issue: z.core.$ZodIssue): MessageParams | undefined {
  if (issue.code === 'custom') return issue.params as MessageParams | undefined;
  if (issue.code === 'too_small') return { min: Number(issue.minimum) };
  return undefined;
}

/** The reason of one zod issue: our own id when the check carries one, otherwise derived from the issue itself. */
export function reasonOf(issue: z.core.$ZodIssue): ProblemReason {
  if (OWN_IDS.has(issue.message)) return { id: issue.message, params: { ...ownReasonParams(issue) } };

  switch (issue.code) {
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'array') return { id: 'items-min', params: { min } };
      if (issue.origin === 'string') return { id: 'length-min', params: { min } };
      return { id: issue.inclusive ? 'min' : 'above', params: { min } };
    }

    case 'too_big':
      return { id: 'max', params: { max: Number(issue.maximum) } };

    case 'invalid_value':
      return { id: 'option', params: { options: issue.values.join(', ') } };

    case 'invalid_type':
      return { id: 'type', params: { expected: issue.expected } };

    case 'unrecognized_keys':
      return { id: 'unknown-keys', params: { keys: issue.keys.join(', ') } };

    default:
      return { id: 'invalid', params: {} };
  }
}
