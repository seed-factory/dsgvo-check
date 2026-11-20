import { afterAll, beforeAll } from 'vitest';
import { type FixtureServer, type FixtureServerOptions, startFixtureServer } from './server.ts';

export function useFixtureServer(
  options: () => FixtureServerOptions,
  prepare?: (server: FixtureServer) => Promise<void>,
): () => FixtureServer {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer(options());
    await prepare?.(server);
  });
  afterAll(async () => server?.close());
  return () => server;
}
