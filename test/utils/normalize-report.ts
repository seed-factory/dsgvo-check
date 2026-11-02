/** Keep the report's shape and business values stable while removing machine, release and timing variation. */
export function normalizeReport(value: unknown, key = '', parent = ''): unknown {
  if (value === null) return value;
  if (typeof value === 'number' && /^(durationMs|tMs|tStartMs|tEndMs|atMs)$/.test(key)) return 0;
  if (typeof value === 'string') {
    if (/^(schemaVersion|version|datasetVersion|catalogVersion|node)$/.test(key)) return '<version>';
    if (/^(startedAt|createdAt|checkedAt|date|rechtsstand|reviewedAt|reviewBy|notBefore|notAfter)$/.test(key))
      return '<time>';
    if (parent === 'userAgent' || key === '$schema') return value.replace(/\d+(?:\.\d+)+/g, '<version>');
    return value.replaceAll('example.de', 'example.test');
  }
  if (Array.isArray(value)) return value.map((item) => normalizeReport(item, '', key));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, normalizeReport(item, name, key)]),
    );
  }
  return value;
}
