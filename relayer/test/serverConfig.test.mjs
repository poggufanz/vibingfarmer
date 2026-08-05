import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as serverModule from '../src/server.mjs';
import { createSqliteStores } from '../src/sqliteStores.mjs';

const { runtimeServerConfig } = serverModule;

function serverConfig(overrides = {}) {
  return {
    dbPath: join(mkdtempSync(join(tmpdir(), 'vf-server-config-')), 'relayer.db'),
    mode: 'test',
    publicOrigin: 'https://canonical-relay.example',
    reporter: { url: null, schema: 1, hasSecret: false },
    runtime: { proxyKey: '', reporterSecret: '', debugErrors: false },
    publicRuntime: { readiness: { ready: true }, digests: {} },
    cctp: {},
    base: {
      chain: {}, rpcUrl: 'http://127.0.0.1:8545', bundlerRpcUrl: 'http://127.0.0.1:4337',
      yieldRouterAddress: `0x${'11'.repeat(20)}`, usdcAddress: `0x${'22'.repeat(20)}`,
    },
    domains: { base: 6 },
    ...overrides,
  };
}

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
    const reporter = { probe: async () => ({
      ready: true,
      schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true },
    }) };
    expect(typeof serverModule.verifyRelayerReadiness).toBe('function');
    await expect(serverModule.verifyRelayerReadiness({ sqlite: localProbe, reporter }))
      .resolves.toEqual({ writable: true, reporterSchema: 1 });
    await expect(serverModule.verifyRelayerReadiness({
      sqlite: { probe: async () => { throw new Error('read only'); } },
      reporter,
    })).rejects.toThrow(/read only/);
  });

  it.each([
    ['wrong schema acknowledgement', { ready: true, schemaVersion: 2, stores: { executionReceipts: true, baseChildIntents: true } }],
    ['missing receipt store', { ready: true, schemaVersion: 1, stores: { baseChildIntents: true } }],
    ['missing Base-child store', { ready: true, schemaVersion: 1, stores: { executionReceipts: true } }],
  ])('keeps startup closed for %s', async (_label, remote) => {
    await expect(serverModule.verifyRelayerReadiness({
      sqlite: { probe: async () => ({ writable: true }) },
      reporter: { probe: async () => remote },
    })).rejects.toThrow(/schema\/store is not ready/);
  });

  it('keeps readiness closed while either plaintext legacy mandate table exists', async () => {
    for (const legacyMandateTables of [['mandates'], ['mandates_v2'], ['mandates', 'mandates_v2']]) {
      await expect(serverModule.verifyRelayerReadiness({
        sqlite: { probe: async () => ({ writable: true, legacyMandateTables }) },
        reporter: { probe: async () => ({
          ready: true,
          schemaVersion: 1,
          stores: { executionReceipts: true, baseChildIntents: true },
        }) },
      })).rejects.toThrow(/legacy|plaintext|mandate/i);
    }
  });

  it('passes the exact non-enumerable session-key cipher explicitly into SQLite construction', () => {
    const config = serverConfig();
    const sessionKeyCipher = Object.freeze({ seal() {}, open() {} });
    Object.defineProperty(config, 'sessionKeyCipher', {
      value: sessionKeyCipher, enumerable: false, configurable: false,
    });
    let captured;
    try {
      serverModule.createRelayerServer(config, {
        openSqlite(path, options) {
          captured = { path, options };
          throw new Error('sqlite options captured');
        },
      });
    } catch {
      // The injected constructor deliberately stops composition after observing its arguments.
    }

    expect(captured).toEqual({
      path: config.dbPath,
      options: expect.objectContaining({ sessionKeyCipher }),
    });
    expect(captured.options.sessionKeyCipher).toBe(sessionKeyCipher);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty object', {}],
    ['seal-only object', { seal() {} }],
    ['open-only object', { open() {} }],
  ])('rejects an %s session-key cipher before opening SQLite or a listener', (_label, malformedCipher) => {
    const config = serverConfig();
    if (_label !== 'absent') {
      Object.defineProperty(config, 'sessionKeyCipher', {
        value: malformedCipher, enumerable: false,
      });
    }
    let opened = false;
    expect(() => serverModule.createRelayerServer(config, {
      openSqlite() {
        opened = true;
        throw new Error('SQLite must not open');
      },
    })).toThrow(/session.*cipher|encryption/i);
    expect(opened).toBe(false);
  });

  it.each(['mandates', 'mandates_v2'])('rejects readiness for a real SQLite database containing legacy %s before any listener serves', async (legacyTable) => {
    const config = serverConfig();
    const db = new DatabaseSync(config.dbPath);
    if (legacyTable === 'mandates') {
      db.exec('CREATE TABLE mandates (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    } else {
      db.exec(`
        CREATE TABLE mandates_v2 (
          serialized_approval TEXT NOT NULL,
          stellar_owner TEXT NOT NULL,
          kernel_address TEXT NOT NULL,
          session_private_key TEXT NOT NULL,
          session_key_address TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (serialized_approval, stellar_owner, kernel_address)
        )
      `);
    }
    db.close();
    const sessionKeyCipher = Object.freeze({
      seal() { return 'unused-test-envelope'; },
      open() { return { plaintext: 'unused-test-key', needsRotation: false }; },
    });
    const openSqlite = (path, options) => createSqliteStores(path, options);
    const sqlite = openSqlite(config.dbPath, { sessionKeyCipher });
    const reporter = { probe: async () => ({
      ready: true,
      schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true },
    }) };
    let listenerOpened = false;
    try {
      await expect(serverModule.startVerifiedRelayer({
        verifyReadiness: () => serverModule.verifyRelayerReadiness({ sqlite, reporter }),
        resumeFarmJobs: async () => {},
        startWorker: () => ({ stop() {} }),
        openListener: () => { listenerOpened = true; return { close() {} }; },
      })).rejects.toThrow(/legacy|plaintext|mandate/i);
      expect(listenerOpened).toBe(false);
    } finally {
      sqlite.db.close();
    }
  });

  it('rejects the offline plaintext-key migration flag before constructing an HTTP server', () => {
    const previous = process.env.RELAYER_OFFLINE_KEY_MIGRATION;
    process.env.RELAYER_OFFLINE_KEY_MIGRATION = '1';
    try {
      expect(() => serverModule.createRelayerServer(serverConfig({ dbPath: null })))
        .toThrow(/offline|migration|RELAYER_OFFLINE_KEY_MIGRATION/i);
    } finally {
      if (previous === undefined) delete process.env.RELAYER_OFFLINE_KEY_MIGRATION;
      else process.env.RELAYER_OFFLINE_KEY_MIGRATION = previous;
    }
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
