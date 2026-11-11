/** List helper for observation fields and evidence; a fixed order keeps the report identical between runs. */
export function sortedUniq(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}
