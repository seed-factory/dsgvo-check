import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeDocumentResponse, makeHttp, makeSnapshot, makeTarget } from '../../utils/snapshot-builder.ts';

const TARGET = 'https://www.example.test/';

/**
 * Writes a saved snapshot whose start document is fine except for one HDR-01 warning (Referrer-Policy `unsafe-url`),
 * so a scan from it exits 1 with `--fail-on warning` and 0 with `--fail-on critical`. Returns the file.
 */
export function writeWarningSnapshot(): string {
  const snapshot = makeSnapshot({
    target: makeTarget(TARGET),
    http: makeHttp({
      documents: [
        makeDocumentResponse({
          url: TARGET,
          headers: [
            { name: 'strict-transport-security', value: 'max-age=31536000' },
            { name: 'content-security-policy', value: "default-src 'self'; frame-ancestors 'none'" },
            { name: 'x-content-type-options', value: 'nosniff' },
            { name: 'referrer-policy', value: 'unsafe-url' },
            { name: 'permissions-policy', value: 'camera=()' },
          ],
        }),
      ],
    }),
  });

  const file = path.join(mkdtempSync(path.join(tmpdir(), 'dsgvo-warning-')), 'input.json');
  writeFileSync(file, JSON.stringify(snapshot));
  return file;
}
