/**
 * Table rows paired with their `name` for `it.each(named(rows))('%s', (_name, row) => …)`: Vitest cuts a `$name`
 * title after 40 characters, a `%s` title keeps the whole name.
 */
export const named = <T extends { name: string }>(rows: readonly T[]): Array<[string, T]> =>
  rows.map((row) => [row.name, row]);
