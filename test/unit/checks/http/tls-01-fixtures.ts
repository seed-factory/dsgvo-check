import type { HostVariant, HttpHop, RedirectChain } from '../../../../src/core/snapshot/http.ts';
import { makeChain, makeHop, makeHttp, makeSnapshot } from '../../../utils/snapshot-builder.ts';

export const BIG = 20_000;

export function chain(
  startUrl: string,
  hops: Partial<HttpHop>[],
  p: Partial<RedirectChain> = {},
): RedirectChain {
  const built = hops.map((hop) => makeHop({ url: startUrl, ...hop }));
  return makeChain({
    startUrl,
    hops: built,
    final: p.outcome && p.outcome !== 'ok' ? null : (built.at(-1) ?? null),
    ...p,
  });
}

export const httpsOk = (host = 'www.example.de', hv: HostVariant = 'target') =>
  chain(`https://${host}/`, [{ status: 200, bodyBytes: BIG, tlsAuthorized: true }], { hostVariant: hv });

export const redirect301 = (host = 'www.example.de', to = `https://${host}/`, hv: HostVariant = 'target') =>
  chain(
    `http://${host}/`,
    [
      { status: 301, location: to },
      { url: to, status: 200, bodyBytes: BIG },
    ],
    { hostVariant: hv },
  );

export const snap = (...chains: RedirectChain[]) => makeSnapshot({ http: makeHttp({ chains }) });
