import { describe, it, expect } from 'vitest';
import * as serverModule from '../src/server.mjs';

const { runtimeServerConfig } = serverModule;

describe('runtimeServerConfig', () => {
  it('uses the validated config object and never ambient process.env values', () => {
    const config = {
      publicOrigin: 'https://canonical-relay.example',
      reporter: {
        url: 'https://canonical-app.example/api/agent-index',
        schema: 1,
        hasSecret: true,
      },
      secrets: { proxyAuth: true },
      runtime: {
        proxyKey: 'canonical-proxy-secret',
        reporterSecret: 'canonical-reporter-secret',
        debugErrors: false,
      },
      publicRuntime: { readiness: { ready: true }, digests: { deployments: 'a'.repeat(64) } },
    };
    const got = runtimeServerConfig(config);
    expect(got).toEqual({
      relayerOrigin: 'https://canonical-relay.example',
      reporterEndpoint: 'https://canonical-app.example/api/agent-index',
      reporterSchema: 1,
      reporterSecret: 'canonical-reporter-secret',
      proxyKey: 'canonical-proxy-secret',
      sanitizeErrors: true,
      publicRuntime: config.publicRuntime,
    });
  });

  // Defect caught: the outbox worker and socket started before either local SQLite writability or
  // authenticated remote schema/store readiness had been proven.
  it('gates startup on local writable-store and authenticated reporter probes', async () => {
    const localProbe = { probe: async () => ({ writable: true }) };
    const reporter = { probe: async () => ({ ready: true, schemaVersion: 1 }) };
    expect(typeof serverModule.verifyRelayerReadiness).toBe('function');
    await expect(serverModule.verifyRelayerReadiness({ sqlite: localProbe, reporter }))
      .resolves.toEqual({ writable: true, reporterSchema: 1 });
    await expect(serverModule.verifyRelayerReadiness({
      sqlite: { probe: async () => { throw new Error('read only'); } },
      reporter,
    })).rejects.toThrow(/read only/);
  });

  // Defect caught: merely exporting readiness checks did not stop eager construction from starting
  // the outbox/execution workers and socket before those checks had succeeded.
  it('starts reconciliation, delivery, and the listener only after readiness succeeds', async () => {
    const order = [];
    const dependencies = {
      verifyReadiness: async () => { order.push('ready'); },
      resumeFarmJobs: async () => { order.push('reconcile'); },
      startWorker: () => { order.push('worker'); return { stop() {} }; },
      openListener: () => { order.push('listen'); return { close() {} }; },
    };
    expect(typeof serverModule.startVerifiedRelayer).toBe('function');
    await expect(serverModule.startVerifiedRelayer(dependencies)).resolves.toMatchObject({
      worker: expect.any(Object),
      server: expect.any(Object),
    });
    expect(order).toEqual(['ready', 'reconcile', 'worker', 'listen']);

    order.length = 0;
    await expect(serverModule.startVerifiedRelayer({
      ...dependencies,
      verifyReadiness: async () => { order.push('rejected'); throw new Error('remote unavailable'); },
    })).rejects.toThrow(/remote unavailable/);
    expect(order).toEqual(['rejected']);
  });
});
