// TLS collector: one handshake per host variant (target, www, apex), port 443 or the explicit port of an https target
// URL for the target itself (see `probe.ts`).

import { errorMessage } from '../../core/runtime/errors.ts';
import type { TlsCollector } from '../../core/snapshot/collector.ts';
import type { ProbeRecord } from '../../core/snapshot/http.ts';
import type { TlsSection } from '../../core/snapshot/tls.ts';
import { hostVariants } from '../http/hosts.ts';
import { DEFAULT_TLS_TIMEOUT_MS, probeTlsEndpoint } from './probe.ts';

export { certificateInfo, chainOf, probeTlsEndpoint } from './probe.ts';

export interface TlsCollectorOptions {
  timeoutMs?: number;
  port?: number;
}

export function targetTlsPort(url: string): number | null {
  const u = new URL(url);
  return u.protocol === 'https:' && u.port ? Number(u.port) : null;
}

export function createTlsCollector(opts: TlsCollectorOptions = {}): TlsCollector {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TLS_TIMEOUT_MS;
  const defaultPort = opts.port ?? 443;
  return async (ctx) => {
    try {
      const targetPort = targetTlsPort(ctx.target.url);
      const targets = hostVariants(ctx.target.host, ctx.target.etld1).map((t) => ({
        ...t,
        port: t.hostVariant === 'target' && targetPort !== null ? targetPort : defaultPort,
      }));
      const probes: ProbeRecord[] = targets.map((t) => ({
        kind: 'tls',
        class: 'T',
        target: `${t.host}:${t.port}`,
        purpose: 'certificate',
      }));
      const endpoints = await Promise.all(targets.map((t) => probeTlsEndpoint(ctx, t, t.port, timeoutMs)));
      const section: TlsSection = {
        endpoints,
        errors: endpoints.flatMap((e) => (e.error ? [e.error] : [])),
      };
      return { status: ctx.signal.aborted ? 'partial' : 'ok', sections: { tls: section }, probes };
    } catch (err) {
      ctx.log.error(`tls collector: ${errorMessage(err)}`);
      return {
        status: 'error',
        reason: 'exception',
        sections: {},
        error: { code: 'tls-collector-exception', message: errorMessage(err), phase: 'tls' },
      };
    }
  };
}

export const collectTls: TlsCollector = createTlsCollector();
