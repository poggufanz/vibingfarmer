import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as serverModule from '../src/server.mjs';
import { createSqliteStores } from '../src/sqliteStores.mjs';

const { runtimeServerConfig } = serverModule;

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

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
    const localProbe = { probe: async () => ({
      writable: true,
      baseEvidenceDurable: true,
      farmIntentDurable: true,
      legacyMandateTables: [],
      mandateMigrationCleanupPending: false,
    }) };
    const reporter = { probe: async () => ({
      ready: true,
      schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
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
    ['wrong schema acknowledgement', { ready: true, schemaVersion: 2, stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true } }],
    ['missing receipt store', { ready: true, schemaVersion: 1, stores: { baseChildIntents: true, baseRecoveryEvidence: true } }],
    ['missing Base-child store', { ready: true, schemaVersion: 1, stores: { executionReceipts: true, baseRecoveryEvidence: true } }],
    ['missing Base-recovery store', {
      ready: true, schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true },
    }],
  ])('keeps startup closed for %s', async (_label, remote) => {
    await expect(serverModule.verifyRelayerReadiness({
      sqlite: { probe: async () => ({
        writable: true,
        baseEvidenceDurable: true,
        farmIntentDurable: true,
        legacyMandateTables: [],
        mandateMigrationCleanupPending: false,
      }) },
      reporter: { probe: async () => remote },
    })).rejects.toThrow(/schema\/store is not ready/);
  });

  it.each([
    ['missing Base evidence durability flag', {
      writable: true, farmIntentDurable: true, legacyMandateTables: [], mandateMigrationCleanupPending: false,
    }],
    ['missing farm intent durability flag', {
      writable: true, baseEvidenceDurable: true, legacyMandateTables: [], mandateMigrationCleanupPending: false,
    }],
    ['missing writable flag', { legacyMandateTables: [], mandateMigrationCleanupPending: false }],
    ['false writable flag', {
      writable: false, legacyMandateTables: [], mandateMigrationCleanupPending: false,
    }],
    ['non-boolean writable flag', {
      writable: 1, legacyMandateTables: [], mandateMigrationCleanupPending: false,
    }],
    ['missing legacy-table list', { writable: true, baseEvidenceDurable: true, mandateMigrationCleanupPending: false }],
    ['null legacy-table list', {
      writable: true, baseEvidenceDurable: true, legacyMandateTables: null, mandateMigrationCleanupPending: false,
    }],
    ['non-array legacy-table list', {
      writable: true, baseEvidenceDurable: true, legacyMandateTables: 'none', mandateMigrationCleanupPending: false,
    }],
    ['missing cleanup flag', { writable: true, baseEvidenceDurable: true, legacyMandateTables: [] }],
    ['null cleanup flag', {
      writable: true, baseEvidenceDurable: true, legacyMandateTables: [], mandateMigrationCleanupPending: null,
    }],
    ['non-boolean cleanup flag', {
      writable: true, baseEvidenceDurable: true, legacyMandateTables: [], mandateMigrationCleanupPending: 'false',
    }],
  ])('rejects malformed local readiness: %s before probing the reporter', async (_label, local) => {
    let reporterCalls = 0;
    let rejection;
    try {
      await serverModule.verifyRelayerReadiness({
        sqlite: { probe: async () => local },
        reporter: { probe: async () => {
          reporterCalls += 1;
          return {
            ready: true,
            schemaVersion: 1,
            stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
          };
        } },
      });
    } catch (error) {
      rejection = error;
    }

    expect(reporterCalls).toBe(0);
    expect(rejection?.message).toMatch(/writable|durable|evidence|legacy|migration|cleanup|readiness|probe/i);
  });

  it('keeps readiness closed while either plaintext legacy mandate table exists', async () => {
    for (const legacyMandateTables of [['mandates'], ['mandates_v2'], ['mandates', 'mandates_v2']]) {
      await expect(serverModule.verifyRelayerReadiness({
        sqlite: { probe: async () => ({
          writable: true,
          baseEvidenceDurable: true,
          farmIntentDurable: true,
          legacyMandateTables,
          mandateMigrationCleanupPending: false,
        }) },
        reporter: { probe: async () => ({
          ready: true,
          schemaVersion: 1,
          stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
        }) },
      })).rejects.toThrow(/legacy|plaintext|mandate/i);
    }
  });

  it('keeps readiness closed while offline migration cleanup is durably pending', async () => {
    const config = serverConfig();
    const sessionKeyCipher = Object.freeze({
      seal() { return 'unused-test-envelope'; },
      open() { return { plaintext: 'unused-test-key', needsRotation: false }; },
    });
    const seeded = createSqliteStores(config.dbPath, { sessionKeyCipher });
    const migrationState = {
      phase: 'cleanup_pending',
      manifestVersion: 1,
      sourceDigest: sha256Json(['vf-server-config-test-source-v1']),
      targetDigest: sha256Json(['vf-mandate-migration-target-v1', []]),
      migratedCount: 0,
      quarantinedCount: 0,
      updatedAt: 2_000_000_000,
    };
    seeded.db.prepare(`
      UPDATE mandate_migration_state
      SET phase = ?, manifest_version = ?, source_digest = ?, target_digest = ?,
          migrated_count = ?, quarantined_count = ?, updated_at = ?
      WHERE id = 1
    `).run(
      migrationState.phase,
      migrationState.manifestVersion,
      migrationState.sourceDigest,
      migrationState.targetDigest,
      migrationState.migratedCount,
      migrationState.quarantinedCount,
      migrationState.updatedAt,
    );
    expect(seeded.db.prepare(`
      SELECT phase, manifest_version, source_digest, target_digest,
             migrated_count, quarantined_count, updated_at
      FROM mandate_migration_state WHERE id = 1
    `).get()).toEqual({
      phase: migrationState.phase,
      manifest_version: migrationState.manifestVersion,
      source_digest: migrationState.sourceDigest,
      target_digest: migrationState.targetDigest,
      migrated_count: migrationState.migratedCount,
      quarantined_count: migrationState.quarantinedCount,
      updated_at: migrationState.updatedAt,
    });
    seeded.db.close();
    const sqlite = createSqliteStores(config.dbPath, { sessionKeyCipher });
    const calls = { reporter: 0, resume: 0, worker: 0, listener: 0 };
    const reporter = { probe: async () => {
      calls.reporter += 1;
      return {
        ready: true,
        schemaVersion: 1,
        stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
      };
    } };
    try {
      expect(sqlite.probe()).toMatchObject({ mandateMigrationCleanupPending: true });
      await expect(serverModule.startVerifiedRelayer({
        verifyReadiness: () => serverModule.verifyRelayerReadiness({ sqlite, reporter }),
        resumeMandateActivations: async () => {},
        resumeFarmJobs: async () => { calls.resume += 1; },
        startWorker: () => { calls.worker += 1; return { stop() {} }; },
        openListener: () => { calls.listener += 1; return { close() {} }; },
      })).rejects.toThrow(/migration|cleanup|pending|plaintext/i);
      expect(calls).toEqual({ reporter: 0, resume: 0, worker: 0, listener: 0 });
    } finally {
      sqlite.db.close();
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

  it.each([
    ['mandates', 'v1'],
    ['mandates_v2', 'v2'],
    ['Mandates', 'v1'],
    ['Mandates_V2', 'v2'],
  ])('rejects readiness for a real SQLite database containing legacy %s before any listener serves', async (legacyTable, kind) => {
    const config = serverConfig();
    const db = new DatabaseSync(config.dbPath);
    if (kind === 'v1') {
      db.exec(`CREATE TABLE ${legacyTable} (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    } else {
      db.exec(`
        CREATE TABLE ${legacyTable} (
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
    expect(sqlite.probe().legacyMandateTables.map((name) => name.toLowerCase()))
      .toContain(legacyTable.toLowerCase());
    const reporter = { probe: async () => ({
      ready: true,
      schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
    }) };
    let listenerOpened = false;
    try {
      await expect(serverModule.startVerifiedRelayer({
        verifyReadiness: () => serverModule.verifyRelayerReadiness({ sqlite, reporter }),
        resumeMandateActivations: async () => {},
        resumeFarmJobs: async () => {},
        startWorker: () => ({ stop() {} }),
        openListener: () => { listenerOpened = true; return { close() {} }; },
      })).rejects.toThrow(/legacy|plaintext|mandate/i);
      expect(listenerOpened).toBe(false);
    } finally {
      sqlite.db.close();
    }
  });

  it('allows the explicit in-memory development server without a persistence cipher', () => {
    expect(() => serverModule.createRelayerServer(serverConfig({ dbPath: null }))).not.toThrow();
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

  describe('activation recovery startup', () => {
    // Defect caught: farm recovery, the outbox worker, or the listener can begin before pending
    // mandate activation recovery has completed after a relayer restart.
    it('recovers activations before farm work, worker delivery, and listening', async () => {
      const order = [];

      await expect(serverModule.startVerifiedRelayer({
        verifyReadiness: async () => { order.push('ready'); },
        resumeMandateActivations: async () => {
          order.push('activation-start');
          await Promise.resolve();
          order.push('activation-done');
        },
        resumeFarmJobs: async () => {
          order.push('farm-start');
          await Promise.resolve();
          order.push('farm-done');
        },
        startWorker: () => { order.push('worker'); return { stop() {} }; },
        openListener: () => { order.push('listen'); return { close() {} }; },
      })).resolves.toMatchObject({
        worker: expect.any(Object),
        server: expect.any(Object),
      });

      expect(order).toEqual([
        'ready',
        'activation-start',
        'activation-done',
        'farm-start',
        'farm-done',
        'worker',
        'listen',
      ]);
    });

    // Defect caught: startup continues to farm recovery or accepts traffic after activation
    // recovery fails, leaving pending mandate activation state unexamined.
    it('does not recover farm work, start delivery, or listen when activation recovery rejects', async () => {
      const order = [];

      await expect(serverModule.startVerifiedRelayer({
        verifyReadiness: async () => { order.push('ready'); },
        resumeMandateActivations: async () => {
          order.push('activation');
          throw new Error('activation recovery unavailable');
        },
        resumeFarmJobs: async () => { order.push('farm'); },
        startWorker: () => { order.push('worker'); return { stop() {} }; },
        openListener: () => { order.push('listen'); return { close() {} }; },
      })).rejects.toThrow(/activation recovery unavailable/);

      expect(order).toEqual(['ready', 'activation']);
    });

    // Defect caught: the process accepts traffic or starts asynchronous delivery despite farm
    // recovery having failed after activation recovery completed.
    it('does not start delivery or listen when farm recovery rejects', async () => {
      const order = [];

      await expect(serverModule.startVerifiedRelayer({
        verifyReadiness: async () => { order.push('ready'); },
        resumeMandateActivations: async () => { order.push('activation'); },
        resumeFarmJobs: async () => {
          order.push('farm');
          throw new Error('farm recovery unavailable');
        },
        startWorker: () => { order.push('worker'); return { stop() {} }; },
        openListener: () => { order.push('listen'); return { close() {} }; },
      })).rejects.toThrow(/farm recovery unavailable/);

      expect(order).toEqual(['ready', 'activation', 'farm']);
    });

    // Defect caught: createRelayerServer.listen can forget to forward the router's real v3
    // recovery method even while the lower-level startVerifiedRelayer ordering tests stay green.
    it('wires and awaits the actual router activation recovery before farm recovery and socket creation', async () => {
      const order = [];
      let routerDeps;
      const closeCallbacks = [];
      const router = async () => {};
      router.resumeMandateActivations = async () => {
        order.push('activation-start');
        await Promise.resolve();
        order.push('activation-done');
      };
      router.resumeFarmJobs = async () => {
        order.push('farm-start');
        await Promise.resolve();
        order.push('farm-done');
      };
      const fakeServer = {
        listen(port) {
          expect(port).toBe(0);
          order.push('listen');
        },
        on(event, callback) {
          if (event === 'close') closeCallbacks.push(callback);
          return this;
        },
        close() {
          for (const callback of closeCallbacks) callback();
        },
      };

      const relayer = serverModule.createRelayerServer(serverConfig({ dbPath: null }), {
        createRouter(deps) {
          routerDeps = deps;
          return router;
        },
        createHttpServer(handler) {
          expect(typeof handler).toBe('function');
          order.push('socket-create');
          return fakeServer;
        },
      });
      let started;
      try {
        started = await relayer.listen(0);
        expect(started).toBe(fakeServer);
        expect(order).toEqual([
          'activation-start',
          'activation-done',
          'farm-start',
          'farm-done',
          'socket-create',
          'listen',
        ]);
        expect(routerDeps).toMatchObject({
          mandatesV3: expect.objectContaining({ get: expect.any(Function) }),
          mandateActivations: expect.objectContaining({
            reconcileExpired: expect.any(Function),
            listRecoverable: expect.any(Function),
          }),
          buildMandateActivator: expect.any(Function),
        });
      } finally {
        started?.close();
      }
    });
  });
});

describe('Task 11 production startup ordering', () => {
  // Defect caught: the listener and association delivery could start before durable CCTP truth
  // was reconciled or before the separate Base-evidence outbox worker existed.
  it('awaits readiness, mandate, CCTP, and farm recovery before both workers and listening', async () => {
    const order = [];
    const started = await serverModule.startVerifiedRelayer({
      verifyReadiness: async () => { order.push('readiness'); },
      resumeMandateActivations: async () => { order.push('mandate'); },
      reconcileCctpRelays: async () => { order.push('cctp'); },
      resumeFarmJobs: async () => { order.push('farm'); },
      startBaseEvidenceWorker: () => {
        order.push('base-evidence');
        return { stop: () => order.push('base-evidence-stop') };
      },
      startAssociationWorker: () => {
        order.push('association');
        return { stop: () => order.push('association-stop') };
      },
      openListener: () => { order.push('listen'); return { close() {} }; },
    });
    expect(order).toEqual([
      'readiness', 'mandate', 'cctp', 'farm', 'base-evidence', 'association', 'listen',
    ]);
    expect(started.workers).toHaveLength(2);
    started.stopWorkers();
    expect(order.slice(-2)).toEqual(['association-stop', 'base-evidence-stop']);
  });
});
