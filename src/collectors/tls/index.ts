/**
 * TLS collector. One handshake per host variant (target, www, apex) with node:tls (see `probe.ts`):
 * port 443, or the explicit port of an https target URL for the target itself.
 */
import type { TlsCollector } from '../../core/collector.ts';
import { errorMessage } from '../../core/errors.ts';
import { hostVariants } from '../http/hosts.ts';
import type { ProbeRecord } from '../http/types.ts';
import { DEFAULT_TLS_TIMEOUT_MS, probeTlsEndpoint } from './probe.ts';
import type { TlsSection } from './types.ts';

export { certificateInfo, chainOf, probeTlsEndpoint } from './probe.ts';

export interface TlsCollectorOptions {
  /** Connect + handshake budget per endpoint. */
  timeoutMs?: number;
  /** Port for the host variants (default 443). An explicit port of an https target URL wins for the target. */
  port?: number;
}

/** Explicit non-default port of an https target URL, else null. */
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
