import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as serverModule from '../src/server.mjs';
import { createSqliteStores } from '../src/sqliteStores.mjs';

const { runtimeServerConfig } = serverModule;
const APPROVED_POOLS = [
  '0x389250872044368759D3db5C09b2706A6628d4e0',
  '0x5E843A639F0555E2A6669601621befC887Bdb479',
  '0xadD3c1A75c7Cef2516b51750959BD829a4AD4761',
];
const APPROVED_POOL_TARGETS = new Map([
  ['0x389250872044368759d3db5c09b2706a6628d4e0', 'aave-v3'],
  ['0x5e843a639f0555e2a6669601621befc887bdb479', 'morpho-blue'],
  ['0xadd3c1a75c7cef2516b51750959bd829a4ad4761', 'moonwell'],
]);
const UNWIND_ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const UNWIND_SWEEPER = `0x${'44'.repeat(20)}`;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const BASE_MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';
const STELLAR_TOKEN_MESSENGER = 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP';
const STELLAR_TOKEN_MESSENGER_BYTES32 =
  '0xda6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8';
const STELLAR_FORWARDER = 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ';
const STELLAR_FORWARDER_BYTES32 =
  '0x3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e';

function activeHardenedDeployment() {
  return {
    generation: 'hardened-v2',
    chainId: 84532,
    baseExitSweeper: { address: UNWIND_SWEEPER },
    route: {
      usdcAddress: BASE_USDC,
      tokenMessengerAddress: BASE_TOKEN_MESSENGER,
      stellarDomain: 27,
      mintRecipient: STELLAR_FORWARDER_BYTES32,
      destinationCaller: STELLAR_FORWARDER_BYTES32,
      finalityThreshold: 1000,
    },
    pools: { enabled: [...APPROVED_POOLS] },
  };
}

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
    publicRuntime: {
      readiness: { ready: true },
      digests: {},
      baseCrossChainAvailable: false,
      unavailableReason: 'Hardened Base deployment is not active.',
    },
    cctp: {},
    base: {
      chain: {}, rpcUrl: 'http://127.0.0.1:8545', bundlerRpcUrl: 'http://127.0.0.1:4337',
      yieldRouterAddress: `0x${'11'.repeat(20)}`, usdcAddress: `0x${'22'.repeat(20)}`,
      allowedPools: [], baseCrossChainAvailable: false,
    },
    domains: { base: 6 },
    ...overrides,
  };
}

function productionListenHarness({ baseCrossChainAvailable, local, remote }) {
  const config = serverConfig({ mode: 'production', dbPath: '/var/lib/vf/relayer.db' });
  config.base.baseCrossChainAvailable = baseCrossChainAvailable;
  config.base.allowedPools = baseCrossChainAvailable ? [...APPROVED_POOLS] : [];
  config.base.hardenedDeployment = baseCrossChainAvailable
    ? activeHardenedDeployment()
    : null;
  if (baseCrossChainAvailable) {
    config.base.chain = { id: 84532 };
    config.base.usdcAddress = BASE_USDC;
    config.base.baseExitSweeperAddress = UNWIND_SWEEPER;
    config.base.tokenMessengerV2Address = BASE_TOKEN_MESSENGER;
    config.base.messageTransmitterAddress = BASE_MESSAGE_TRANSMITTER;
    config.base.mandatePolicy = {
      entryPointVersion: '0.7', entryPointAddress: UNWIND_ENTRY_POINT,
    };
    config.base.bundlerRpcUrl = 'https://bundler.invalid';
    Object.defineProperty(config.base, 'publicClient', {
      value: { getChainId() {}, getTransactionReceipt() {} },
    });
    config.stellar = {
      tokenMessengerMinter: STELLAR_TOKEN_MESSENGER,
      forwarderAddress: STELLAR_FORWARDER,
    };
    config.domains = { base: 6, stellar: 27 };
  }
  config.publicRuntime.baseCrossChainAvailable = baseCrossChainAvailable;
  config.publicRuntime.unavailableReason = baseCrossChainAvailable
    ? null : 'Hardened Base deployment is not active.';
  Object.defineProperty(config, 'sessionKeyCipher', {
    value: Object.freeze({ seal() {}, open() {} }),
    enumerable: false,
  });
  const state = {
    listenerCalls: 0, reporterOptions: null, workerOptions: null,
    workerStops: 0, sweepCalls: [], unwindResumeCalls: [], reverseResumeCalls: [],
    closeCallbacks: [], order: [], routerDeps: null,
  };
  const sqlite = {
    probe: async () => local,
    jobs: new Map(),
    mandatesV3: {},
    mandateActivations: {},
    cctpRelays: {},
    unwindJobs: {},
  };
  const router = async () => {};
  router.resumeMandateActivations = async () => ({ resumed: [], held: [] });
  router.resumeUnwindJobs = async (options) => {
    state.order.push('unwind');
    state.unwindResumeCalls.push(options);
    return { resumed: [], held: [], blocked: [], uncertain: [], expired: [] };
  };
  router.resumeFarmJobs = async () => ({ resumed: [], held: [], blocked: [], uncertain: [] });
  const httpServer = {
    listen() { state.listenerCalls += 1; state.order.push('listen'); },
    on(event, callback) {
      if (event === 'close') state.closeCallbacks.push(callback);
      return this;
    },
    close() { for (const callback of state.closeCallbacks) callback(); },
  };
  const relayer = serverModule.createRelayerServer(config, {
    openSqlite: () => sqlite,
    createReporter: () => ({
      probe: async (options) => {
        state.reporterOptions = options;
        return remote;
      },
    }),
    createUnwindBundlerClient: () => ({ getUserOperation() {}, getUserOperationReceipt() {} }),
    createWatcherFn: () => ({
      relayMint() {},
      async resumeExisting(execId) {
        state.reverseResumeCalls.push(execId);
        return { status: 'in-progress' };
      },
      async sweepStuck(options) {
        state.order.push('cctp');
        state.sweepCalls.push(options);
        return { redriven: [], held: [], blocked: [], uncertain: [] };
      },
    }),
    startUnwindRecoveryWorkerFn(options) {
      state.order.push('worker');
      state.workerOptions = options;
      return { stop() { state.workerStops += 1; } };
    },
    createRouter: (deps) => { state.routerDeps = deps; return router; },
    createHttpServer: () => httpServer,
  });
  return { relayer, state, httpServer };
}

describe('runtimeServerConfig', () => {
  it.each(['/unwind', '/unwind/attach', '/status'])(
    'marks protected tunnel-auth 401 no-store before routing %s',
    async (path) => {
      let routed = false;
      const headers = {};
      const response = {
        statusCode: 0,
        setHeader(name, value) { headers[name] = value; },
        end(body) { this.body = body; },
      };
      const handler = serverModule.withProxyKeyAuth(() => { routed = true; }, 'proxy-secret');
      await handler({
        method: 'POST', url: `/api/vf-cross${path}`, headers: { 'x-vf-relayer-key': 'wrong' },
      }, response);
      expect(response.statusCode).toBe(401);
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(routed).toBe(false);
    },
  );

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
      unwindDurable: true,
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

  it('requires only global local/remote readiness when Base execution is closed', async () => {
    let probeOptions;
    const sqlite = { probe: async () => ({
      writable: true,
      legacyMandateTables: [],
      mandateMigrationCleanupPending: false,
    }) };
    const reporter = { probe: async (options) => {
      probeOptions = options;
      return { ready: true, schemaVersion: 1, stores: { executionReceipts: true } };
    } };

    await expect(serverModule.verifyRelayerReadiness({
      sqlite,
      reporter,
      baseCrossChainAvailable: false,
    })).resolves.toEqual({ writable: true, reporterSchema: 1 });
    expect(probeOptions).toEqual({ baseCrossChainAvailable: false });
  });

  it('retains every Base durability/readiness requirement when Base execution is active', async () => {
    let reporterCalls = 0;
    await expect(serverModule.verifyRelayerReadiness({
      sqlite: { probe: async () => ({
        writable: true,
        legacyMandateTables: [],
        mandateMigrationCleanupPending: false,
      }) },
      reporter: { probe: async () => {
        reporterCalls += 1;
        return { ready: true, schemaVersion: 1, stores: { executionReceipts: true } };
      } },
      baseCrossChainAvailable: true,
    })).rejects.toThrow(/Base evidence|farm intent|durable/i);
    expect(reporterCalls).toBe(0);
  });

  it('requires the dedicated durable unwind authority before active-Base startup', async () => {
    let reporterCalls = 0;
    await expect(serverModule.verifyRelayerReadiness({
      sqlite: { probe: async () => ({
        writable: true,
        baseEvidenceDurable: true,
        farmIntentDurable: true,
        unwindDurable: false,
        legacyMandateTables: [],
        mandateMigrationCleanupPending: false,
      }) },
      reporter: { probe: async () => {
        reporterCalls += 1;
        return {
          ready: true, schemaVersion: 1,
          stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
        };
      } },
      baseCrossChainAvailable: true,
    })).rejects.toThrow(/unwind.*durable|durable.*unwind/i);
    expect(reporterCalls).toBe(0);
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
        unwindDurable: true,
        legacyMandateTables: [],
        mandateMigrationCleanupPending: false,
      }) },
      reporter: { probe: async () => remote },
    })).rejects.toThrow(/schema\/store is not ready/);
  });

  it.each([
    ['missing Base evidence durability flag', {
      writable: true, farmIntentDurable: true, unwindDurable: true,
      legacyMandateTables: [], mandateMigrationCleanupPending: false,
    }],
    ['missing farm intent durability flag', {
      writable: true, baseEvidenceDurable: true, unwindDurable: true,
      legacyMandateTables: [], mandateMigrationCleanupPending: false,
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
          unwindDurable: true,
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

  it('propagates closed Base availability to composed builders and omits forward deployment facts', async () => {
    let routerDeps;
    const base = {
      chain: { id: 84532 },
      rpcUrl: 'https://legacy-rpc.invalid',
      bundlerRpcUrl: 'https://legacy-bundler.invalid',
      yieldRouterAddress: `0x${'11'.repeat(20)}`,
      usdcAddress: `0x${'22'.repeat(20)}`,
      tokenMessengerV2Address: `0x${'33'.repeat(20)}`,
      baseCrossChainAvailable: false,
    };
    serverModule.createRelayerServer(serverConfig({
      dbPath: null,
      base,
      stellar: { tokenMessengerMinter: 'stellar-messenger', usdcSac: 'stellar-usdc' },
      domains: { base: 6, stellar: 27 },
    }), {
      createRouter(deps) {
        routerDeps = deps;
        return async () => {};
      },
    });

    expect(routerDeps.forwardFarmDeployment).toBeNull();
    await expect(routerDeps.buildMandateActivator('legacy-session-key').activateMandate('approval'))
      .rejects.toThrow('Base cross-chain execution is unavailable');
    await expect(routerDeps.buildFarm('legacy-session-key').recoverDeposits({
      approval: 'approval',
      children: [{ allocation: {}, recovery: { phase: 'cctp_mint', state: 'confirmed' } }],
      onCheckpoint() {},
    })).rejects.toThrow('Base cross-chain execution is unavailable');
  });

  it.each([
    ['string false', 'false'],
    ['numeric one', 1],
    ['object', {}],
  ])('rejects non-boolean Base availability before composing the server: %s', (_label, value) => {
    const config = serverConfig({ dbPath: null });
    config.base.baseCrossChainAvailable = value;
    config.publicRuntime.baseCrossChainAvailable = value;
    let routerComposed = false;

    expect(() => serverModule.createRelayerServer(config, {
      createRouter() { routerComposed = true; return async () => {}; },
    })).toThrow(/Base.*availability.*boolean/i);
    expect(routerComposed).toBe(false);
  });

  it('rejects inconsistent private/public Base availability before composing HTTP or builders', () => {
    const config = serverConfig({ dbPath: null });
    config.base.baseCrossChainAvailable = true;
    config.publicRuntime.baseCrossChainAvailable = false;
    let routerComposed = false;

    expect(() => serverModule.createRelayerServer(config, {
      createRouter() { routerComposed = true; return async () => {}; },
    })).toThrow(/Base.*availability.*disagree/i);
    expect(routerComposed).toBe(false);
  });

  it('wires only the exact active record-approved pool map into HTTP and forward deployment', () => {
    const config = serverConfig({ dbPath: null });
    config.base.baseCrossChainAvailable = true;
    config.publicRuntime.baseCrossChainAvailable = true;
    config.publicRuntime.unavailableReason = null;
    config.base.allowedPools = [...APPROVED_POOLS];
    config.base.hardenedDeployment = { pools: { enabled: [...APPROVED_POOLS] } };
    config.base.tokenMessengerV2Address = `0x${'33'.repeat(20)}`;
    config.stellar = { tokenMessengerMinter: 'stellar-messenger', usdcSac: 'stellar-usdc' };
    config.domains = { base: 6, stellar: 27 };
    let routerDeps;

    serverModule.createRelayerServer(config, {
      createRouter(deps) { routerDeps = deps; return async () => {}; },
    });

    expect(routerDeps.poolTargets).toEqual(APPROVED_POOL_TARGETS);
    expect(routerDeps.forwardFarmDeployment.poolTargets).toBe(routerDeps.poolTargets);
  });

  it('composes active production unwind with the dedicated SQLite authority and two read-only clients', () => {
    const config = serverConfig({ mode: 'production' });
    config.base.baseCrossChainAvailable = true;
    config.publicRuntime.baseCrossChainAvailable = true;
    config.publicRuntime.unavailableReason = null;
    config.base.allowedPools = [...APPROVED_POOLS];
    config.base.chain = { id: 84532 };
    config.base.hardenedDeployment = activeHardenedDeployment();
    config.base.usdcAddress = BASE_USDC;
    config.base.baseExitSweeperAddress = UNWIND_SWEEPER;
    config.base.tokenMessengerV2Address = BASE_TOKEN_MESSENGER;
    config.base.messageTransmitterAddress = BASE_MESSAGE_TRANSMITTER;
    config.base.mandatePolicy = {
      entryPointVersion: '0.7', entryPointAddress: UNWIND_ENTRY_POINT,
    };
    config.base.bundlerRpcUrl = 'https://bundler.invalid';
    const publicClient = Object.freeze({
      getChainId() {}, getTransactionReceipt() {},
    });
    Object.defineProperty(config.base, 'publicClient', { value: publicClient });
    config.stellar = {
      tokenMessengerMinter: STELLAR_TOKEN_MESSENGER,
      forwarderAddress: STELLAR_FORWARDER,
      usdcSac: 'stellar-usdc',
    };
    config.domains = { base: 6, stellar: 27 };
    Object.defineProperty(config, 'sessionKeyCipher', {
      value: Object.freeze({ seal() {}, open() {} }), enumerable: false,
    });
    const unwindJobs = Object.freeze({ reserve() {} });
    const sqlite = {
      jobs: new Map(), mandatesV3: {}, mandateActivations: {},
      cctpRelays: {}, unwindJobs,
    };
    const bundlerClient = Object.freeze({ getUserOperation() {}, getUserOperationReceipt() {} });
    let bundlerInput;
    let routerDeps;

    serverModule.createRelayerServer(config, {
      openSqlite: () => sqlite,
      createUnwindBundlerClient(input) {
        bundlerInput = input;
        return bundlerClient;
      },
      createRouter(deps) { routerDeps = deps; return async () => {}; },
    });

    expect(bundlerInput).toEqual({ chain: config.base.chain, rpcUrl: config.base.bundlerRpcUrl });
    expect(routerDeps).toMatchObject({
      unwindJobs,
      unwindPublicClient: publicClient,
      unwindBundlerClient: bundlerClient,
      readUnwindEvidence: expect.any(Function),
      relayReverseMint: expect.any(Function),
      unwindEvidenceFacts: {
        generation: 'hardened-v2',
        chainId: 84532,
        entryPointAddress: UNWIND_ENTRY_POINT.toLowerCase(),
        baseExitSweeperAddress: UNWIND_SWEEPER.toLowerCase(),
        usdcAddress: BASE_USDC.toLowerCase(),
        tokenMessengerV2Address: BASE_TOKEN_MESSENGER.toLowerCase(),
        messageTransmitterV2Address: BASE_MESSAGE_TRANSMITTER.toLowerCase(),
        stellarDomain: 27,
        stellarTokenMessenger: STELLAR_TOKEN_MESSENGER_BYTES32,
        cctpForwarder: STELLAR_FORWARDER_BYTES32,
        finalityThreshold: 1000,
      },
    });
    expect(routerDeps.unwindJobs).not.toBe(routerDeps.jobs);
  });

  it('composes the same complete unwind authority in active non-production mode', () => {
    const config = serverConfig({ mode: 'development' });
    config.base.baseCrossChainAvailable = true;
    config.publicRuntime.baseCrossChainAvailable = true;
    config.publicRuntime.unavailableReason = null;
    config.base.allowedPools = [...APPROVED_POOLS];
    config.base.chain = { id: 84532 };
    config.base.hardenedDeployment = activeHardenedDeployment();
    Object.assign(config.base, {
      usdcAddress: BASE_USDC,
      baseExitSweeperAddress: UNWIND_SWEEPER,
      tokenMessengerV2Address: BASE_TOKEN_MESSENGER,
      messageTransmitterAddress: BASE_MESSAGE_TRANSMITTER,
      mandatePolicy: { entryPointVersion: '0.7', entryPointAddress: UNWIND_ENTRY_POINT },
      bundlerRpcUrl: 'https://bundler.invalid',
    });
    const publicClient = { getChainId() {}, getTransactionReceipt() {} };
    Object.defineProperty(config.base, 'publicClient', { value: publicClient });
    config.stellar = {
      tokenMessengerMinter: STELLAR_TOKEN_MESSENGER,
      forwarderAddress: STELLAR_FORWARDER,
    };
    config.domains = { base: 6, stellar: 27 };
    Object.defineProperty(config, 'sessionKeyCipher', {
      value: Object.freeze({ seal() {}, open() {} }), enumerable: false,
    });
    const unwindJobs = {};
    const sqlite = {
      jobs: new Map(), mandatesV3: {}, mandateActivations: {}, cctpRelays: {}, unwindJobs,
    };
    const bundlerClient = { getUserOperation() {}, getUserOperationReceipt() {} };
    let routerDeps;

    serverModule.createRelayerServer(config, {
      openSqlite: () => sqlite,
      createUnwindBundlerClient: () => bundlerClient,
      createRouter(deps) { routerDeps = deps; return async () => {}; },
    });

    expect(routerDeps).toMatchObject({
      unwindJobs,
      unwindPublicClient: publicClient,
      unwindBundlerClient: bundlerClient,
      unwindEvidenceFacts: { generation: 'hardened-v2', chainId: 84532 },
    });
  });

  it.each([
    ['missing pool', APPROVED_POOLS.slice(0, 2)],
    ['unknown pool', [...APPROVED_POOLS.slice(0, 2), '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD']],
    ['extra pool', [...APPROVED_POOLS, '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD']],
    ['duplicate pool', [APPROVED_POOLS[0], APPROVED_POOLS[0], APPROVED_POOLS[2]]],
  ])('rejects active record/catalog pool mismatch before router composition: %s', (_label, allowedPools) => {
    const config = serverConfig({ dbPath: null });
    config.base.baseCrossChainAvailable = true;
    config.publicRuntime.baseCrossChainAvailable = true;
    config.publicRuntime.unavailableReason = null;
    config.base.allowedPools = allowedPools;
    config.base.hardenedDeployment = { pools: { enabled: [...allowedPools] } };
    let routerComposed = false;

    expect(() => serverModule.createRelayerServer(config, {
      createRouter() { routerComposed = true; return async () => {}; },
    })).toThrow(/approved.*pool|pool.*catalog|pool.*mapping/i);
    expect(routerComposed).toBe(false);
  });

  it('rejects an active approved set when the configured protocol catalog is missing a mapping', () => {
    const config = serverConfig({ dbPath: null });
    config.base.baseCrossChainAvailable = true;
    config.publicRuntime.baseCrossChainAvailable = true;
    config.publicRuntime.unavailableReason = null;
    config.base.allowedPools = [...APPROVED_POOLS];
    config.base.hardenedDeployment = { pools: { enabled: [...APPROVED_POOLS] } };

    expect(() => serverModule.createRelayerServer(config, {
      poolTargetCatalog: new Map([...APPROVED_POOL_TARGETS].slice(0, 2)),
    })).toThrow(/approved.*pool|pool.*catalog|pool.*mapping/i);
  });

  it.each([
    ['missing hardened record', null],
    ['record/config mismatch', { pools: { enabled: APPROVED_POOLS.slice(0, 2) } }],
  ])('rejects active pool authority not sourced from the exact hardened record: %s', (_label, hardenedDeployment) => {
    const config = serverConfig({ dbPath: null });
    config.base.baseCrossChainAvailable = true;
    config.publicRuntime.baseCrossChainAvailable = true;
    config.publicRuntime.unavailableReason = null;
    config.base.allowedPools = [...APPROVED_POOLS];
    config.base.hardenedDeployment = hardenedDeployment;

    expect(() => serverModule.createRelayerServer(config))
      .toThrow(/hardened.*pool|pool.*record|approved.*pool/i);
  });

  it('does not wire the static legacy pool catalog while Base execution is closed', () => {
    const config = serverConfig({ dbPath: null });
    config.base.allowedPools = [...APPROVED_POOLS];
    let routerDeps;

    serverModule.createRelayerServer(config, {
      createRouter(deps) { routerDeps = deps; return async () => {}; },
    });

    expect(routerDeps.poolTargets).toEqual(new Map());
    expect(routerDeps.forwardFarmDeployment).toBeNull();
  });

  it('lets the actual production listener start without Base-only readiness while Base is closed', async () => {
    const { relayer, state, httpServer } = productionListenHarness({
      baseCrossChainAvailable: false,
      local: {
        writable: true,
        legacyMandateTables: [],
        mandateMigrationCleanupPending: false,
      },
      remote: { ready: true, schemaVersion: 1, stores: { executionReceipts: true } },
    });

    await expect(relayer.listen(8788)).resolves.toBe(httpServer);
    expect(state.listenerCalls).toBe(1);
    expect(state.reporterOptions).toEqual({ baseCrossChainAvailable: false });
    expect(state.workerOptions).toMatchObject({ recoveryLimit: 100, intervalMs: 5_000 });
    expect(state.workerOptions.reconcileCctpRelays).toEqual(expect.any(Function));
    expect(state.workerOptions.resumeUnwindJobs).toEqual(expect.any(Function));
    expect(state.routerDeps.resumeExistingReverse).toEqual(expect.any(Function));
    await state.routerDeps.resumeExistingReverse('unwind:proof-backed');
    expect(state.reverseResumeCalls).toEqual(['unwind:proof-backed']);
    expect(state.sweepCalls).toEqual([]);
  });

  it('keeps the actual production listener closed when active Base durability is absent', async () => {
    const { relayer, state } = productionListenHarness({
      baseCrossChainAvailable: true,
      local: {
        writable: true,
        legacyMandateTables: [],
        mandateMigrationCleanupPending: false,
      },
      remote: { ready: true, schemaVersion: 1, stores: { executionReceipts: true } },
    });

    await expect(relayer.listen(8788)).rejects.toThrow(/Base evidence|farm intent|durable/i);
    expect(state.listenerCalls).toBe(0);
  });

  it('composes, bounds, and stops the recurring active unwind recovery worker around the listener', async () => {
    const { relayer, state, httpServer } = productionListenHarness({
      baseCrossChainAvailable: true,
      local: {
        writable: true,
        baseEvidenceDurable: true,
        farmIntentDurable: true,
        unwindDurable: true,
        legacyMandateTables: [],
        mandateMigrationCleanupPending: false,
      },
      remote: {
        ready: true,
        schemaVersion: 1,
        stores: {
          executionReceipts: true,
          baseChildIntents: true,
          baseRecoveryEvidence: true,
        },
      },
    });

    await expect(relayer.listen(8788)).resolves.toBe(httpServer);
    expect(state.order).toEqual(['cctp', 'unwind', 'worker', 'listen']);
    expect(state.workerOptions).toMatchObject({ recoveryLimit: 100, intervalMs: 5_000 });
    expect(state.workerOptions.reconcileCctpRelays).toEqual(expect.any(Function));
    expect(state.workerOptions.resumeUnwindJobs).toEqual(expect.any(Function));

    await state.workerOptions.reconcileCctpRelays({ limit: 7 });
    await state.workerOptions.resumeUnwindJobs({ limit: 7 });
    expect(state.sweepCalls.at(-1)).toEqual({ limit: 7 });
    expect(state.unwindResumeCalls.at(-1)).toEqual({ limit: 7 });
    httpServer.close();
    expect(state.workerStops).toBe(1);
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
      router.resumeUnwindJobs = async () => {
        order.push('unwind-start');
        await Promise.resolve();
        order.push('unwind-done');
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
          'unwind-start',
          'unwind-done',
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

describe('Task 12 recurring unwind recovery worker', () => {
  it('redrives Task8 before unwind projection on bounded non-overlapping ticks and stops cleanly', async () => {
    const calls = [];
    const errors = [];
    let scheduled;
    let cancelled = null;
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    let cctpTicks = 0;
    const worker = serverModule.startUnwindRecoveryWorker({
      recoveryLimit: 7,
      intervalMs: 1_000,
      reconcileCctpRelays: async ({ limit }) => {
        calls.push(`cctp:${limit}`);
        cctpTicks += 1;
        if (cctpTicks === 1) await first;
      },
      resumeUnwindJobs: async ({ limit }) => { calls.push(`unwind:${limit}`); },
      schedule(callback, intervalMs) {
        expect(intervalMs).toBe(1_000);
        scheduled = callback;
        return { unref() { calls.push('unref'); } };
      },
      cancel(timer) { cancelled = timer; },
      onError(error) { errors.push(error); },
    });

    const inFlight = worker.tick();
    expect(await worker.tick()).toBe(false);
    expect(calls).toEqual(['unref', 'cctp:7']);
    releaseFirst();
    expect(await inFlight).toBe(true);
    expect(calls).toEqual(['unref', 'cctp:7', 'unwind:7']);

    await scheduled();
    expect(calls.slice(-2)).toEqual(['cctp:7', 'unwind:7']);
    worker.stop();
    expect(cancelled).not.toBeNull();
    expect(await worker.tick()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('retries a transient Task8 hold on a later tick without restart or duplicate completion', async () => {
    let relayState = 'attestation_pending';
    let attempts = 0;
    let completions = 0;
    const projections = [];
    const worker = serverModule.startUnwindRecoveryWorker({
      recoveryLimit: 2,
      intervalMs: 1_000,
      schedule: () => ({ unref() {} }),
      cancel() {},
      onError() {},
      reconcileCctpRelays: async () => {
        if (relayState === 'minted') return;
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('iris transient'), {
          code: 'RELAY_RETRYABLE',
        });
        relayState = 'minted';
        completions += 1;
      },
      resumeUnwindJobs: async () => { projections.push(relayState); },
    });

    expect(await worker.tick()).toBe(false);
    expect(relayState).toBe('attestation_pending');
    expect(await worker.tick()).toBe(true);
    expect(await worker.tick()).toBe(true);
    expect({ attempts, completions, projections }).toEqual({
      attempts: 2, completions: 1, projections: ['minted', 'minted'],
    });
    worker.stop();
  });
});

describe('Task 11 production startup ordering', () => {
  // Defect caught: the listener and association delivery could start before durable CCTP truth
  // was reconciled or before the separate Base-evidence outbox worker existed.
  it('awaits readiness, mandate, CCTP, unwind, and farm recovery before both workers and listening', async () => {
    const order = [];
    const started = await serverModule.startVerifiedRelayer({
      verifyReadiness: async () => { order.push('readiness'); },
      resumeMandateActivations: async () => { order.push('mandate'); },
      reconcileCctpRelays: async () => { order.push('cctp'); },
      resumeUnwindJobs: async () => { order.push('unwind'); },
      resumeFarmJobs: async () => { order.push('farm'); },
      startUnwindRecoveryWorker: () => {
        order.push('unwind-worker');
        return { stop: () => order.push('unwind-worker-stop') };
      },
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
      'readiness', 'mandate', 'cctp', 'unwind', 'farm',
      'unwind-worker', 'base-evidence', 'association', 'listen',
    ]);
    expect(started.workers).toHaveLength(3);
    started.stopWorkers();
    expect(order.slice(-3)).toEqual([
      'association-stop', 'base-evidence-stop', 'unwind-worker-stop',
    ]);
  });

  it('does not recover farms, start workers, or listen when unwind recovery fails', async () => {
    const order = [];
    await expect(serverModule.startVerifiedRelayer({
      verifyReadiness: async () => { order.push('readiness'); },
      resumeMandateActivations: async () => { order.push('mandate'); },
      reconcileCctpRelays: async () => { order.push('cctp'); },
      resumeUnwindJobs: async () => {
        order.push('unwind');
        throw new Error('unwind recovery unavailable');
      },
      resumeFarmJobs: async () => { order.push('farm'); },
      startBaseEvidenceWorker: () => { order.push('worker'); return { stop() {} }; },
      openListener: () => { order.push('listen'); return { close() {} }; },
    })).rejects.toThrow(/unwind recovery unavailable/);
    expect(order).toEqual(['readiness', 'mandate', 'cctp', 'unwind']);
  });

  it('stops both workers when the listener rejects asynchronously', async () => {
    const order = [];
    await expect(serverModule.startVerifiedRelayer({
      verifyReadiness: async () => {},
      resumeMandateActivations: async () => {},
      reconcileCctpRelays: async () => {},
      resumeFarmJobs: async () => {},
      startBaseEvidenceWorker: () => ({ stop: () => order.push('base-stop') }),
      startAssociationWorker: () => ({ stop: () => order.push('association-stop') }),
      openListener: () => Promise.reject(Object.assign(new Error('address in use'), {
        code: 'EADDRINUSE',
      })),
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(order).toEqual(['association-stop', 'base-stop']);
  });
});
