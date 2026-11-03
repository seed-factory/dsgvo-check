import { describe, expect, it } from 'vitest';
import { defineCheck } from '../../../src/core/check.ts';
import { CheckRegistry } from '../../../src/core/registry.ts';
import { scan } from '../../../src/scan.ts';
import { makeTls, makeTlsEndpoint } from '../../utils/snapshot-builder.ts';
import { browserCheck, opts, tlsCheck, withBrowser } from './scan-fixtures.ts';

describe('scan — invalid certificate on the target', () => {
  it('invalid certificate on the target → browser not started, browser checks skipped (tls-blocked)', async () => {
    let browserCalled = false;
    const result = await scan(
      opts({
        collectors: {
          ...withBrowser,
          browser: async () => {
            browserCalled = true;
            return { status: 'ok', sections: {} };
          },
          tls: async () => ({
            status: 'ok',
            sections: {
              tls: makeTls({
                endpoints: [makeTlsEndpoint({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' })],
              }),
            },
          }),
        },
        registry: new CheckRegistry([
          browserCheck,
          defineCheck({
            id: 'TEST-02',
            module: 'http',
            requires: ['tls'],
            variants: [{ variant: 'header' }],
            run: () => [],
          }),
        ]),
      }),
    );
    expect(browserCalled).toBe(false);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'tls-blocked',
    });
  });

  it('invalid certificate on an explicit target port → tls-blocked as well', async () => {
    let browserCalled = false;
    const result = await scan(
      opts({
        url: 'https://www.example.de:8443/',
        collectors: {
          ...withBrowser,
          browser: async () => {
            browserCalled = true;
            return { status: 'ok', sections: {} };
          },
          tls: async () => ({
            status: 'ok',
            sections: {
              tls: makeTls({
                endpoints: [
                  makeTlsEndpoint({ port: 8443, authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }),
                ],
              }),
            },
          }),
        },
        registry: new CheckRegistry([browserCheck, tlsCheck]),
      }),
    );
    expect(browserCalled).toBe(false);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({ reason: 'tls-blocked' });
  });

  it.each(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])(
    'incomplete chain (%s) does not block the browser: Chrome completes chains via AIA',
    async (code) => {
      let browserCalled = false;
      await scan(
        opts({
          collectors: {
            ...withBrowser,
            browser: async (ctx) => {
              browserCalled = true;
              return withBrowser.browser(ctx);
            },
            tls: async () => ({
              status: 'ok',
              sections: {
                tls: makeTls({
                  endpoints: [
                    makeTlsEndpoint({
                      authorized: false,
                      authorizationError: code,
                      chainComplete: false,
                      hostnameMatches: true,
                    }),
                  ],
                }),
              },
            }),
          },
          registry: new CheckRegistry([browserCheck, tlsCheck]),
        }),
      );
      expect(browserCalled).toBe(true);
    },
  );

  it('wrong host name with an incomplete chain still blocks the browser', async () => {
    let browserCalled = false;
    await scan(
      opts({
        collectors: {
          ...withBrowser,
          browser: async (ctx) => {
            browserCalled = true;
            return withBrowser.browser(ctx);
          },
          tls: async () => ({
            status: 'ok',
            sections: {
              tls: makeTls({
                endpoints: [
                  makeTlsEndpoint({
                    authorized: false,
                    authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
                    chainComplete: false,
                    hostnameMatches: false,
                  }),
                ],
              }),
            },
          }),
        },
        registry: new CheckRegistry([browserCheck, tlsCheck]),
      }),
    );
    expect(browserCalled).toBe(false);
  });
});
