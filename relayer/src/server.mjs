// Thin composition layer: wires the relayer's existing watcher/orchestrator/farm-flow modules
// into the pure httpRouter and exposes a node:http listener. Holds no request-handling logic of
// its own — see httpRouter.mjs for that. NOT mounted as Vite middleware: the in-memory
// jobs/mandates Maps need one long-lived process (CF Pages isolates don't share memory across
// requests), and running standalone keeps relayer secrets out of the Vite dev process.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createWatcher } from './cctp/watcher.mjs';
import { createOrchestrator } from './base/orchestrator.mjs';
import { createFarmFlow } from './flows/farm.mjs';
import { createRelayerRouter } from './httpRouter.mjs';
import { createMandateStoresV3 } from './mandateStore.mjs';
import { createSqliteStores } from './sqliteStores.mjs';
import { startAssociationOutboxWorker } from './associationOutbox.mjs';
import { startBaseEvidenceOutboxWorker } from './baseEvidenceOutbox.mjs';
import {
  BASE_SEPOLIA_POOL_TARGETS,
  createAgentIndexReporter,
} from './agentIndexReporter.mjs';

export function runtimeServerConfig(config) {
  return {
    relayerOrigin: config.publicOrigin,
    reporterEndpoint: config.reporter.url,
    reporterSchema: config.reporter.schema,
    reporterSecret: config.runtime.reporterSecret,
    proxyKey: config.runtime.proxyKey,
    sanitizeErrors: !config.runtime.debugErrors,
    publicRuntime: config.publicRuntime,
  };
}

export async function verifyRelayerReadiness({ sqlite, reporter }) {
  if (!sqlite?.probe || !reporter?.probe) throw new Error('relayer durable readiness is not configured');
  const local = await sqlite.probe();
  if (local?.writable !== true) throw new Error('relayer SQLite store is not writable');
  if (local?.baseEvidenceDurable !== true) {
    throw new Error('relayer SQLite Base evidence store is not durable');
  }
  if (local?.farmIntentDurable !== true) {
    throw new Error('relayer SQLite forward-farm intent store is not durable');
  }
  if (!Array.isArray(local.legacyMandateTables)) {
    throw new Error('relayer SQLite legacy mandate metadata is invalid');
  }
  if (local.legacyMandateTables.length > 0) {
    throw new Error('plaintext legacy mandate tables require offline migration');
  }
  if (local.mandateMigrationCleanupPending !== false) {
    throw new Error('offline mandate migration cleanup is pending');
  }
  const remote = await reporter.probe();
  if (
    remote?.ready !== true
    || remote?.schemaVersion !== 1
    || remote?.stores?.executionReceipts !== true
    || remote?.stores?.baseChildIntents !== true
    || remote?.stores?.baseRecoveryEvidence !== true
  ) {
    throw new Error('agent index reporter schema/store is not ready');
  }
  return { writable: true, reporterSchema: remote.schemaVersion };
}

export async function startVerifiedRelayer({
  verifyReadiness,
  resumeMandateActivations,
  reconcileCctpRelays = async () => {},
  resumeFarmJobs,
  startBaseEvidenceWorker = null,
  startAssociationWorker = null,
  startWorker = null,
  openListener,
}) {
  await verifyReadiness();
  await resumeMandateActivations();
  await reconcileCctpRelays();
  await resumeFarmJobs();
  const workers = [];
  const stopWorkers = () => {
    for (const worker of [...workers].reverse()) worker?.stop?.();
  };
  try {
    if (startBaseEvidenceWorker) workers.push(startBaseEvidenceWorker());
    if (startAssociationWorker) workers.push(startAssociationWorker());
    else if (startWorker) workers.push(startWorker());
    const server = openListener();
    return { worker: workers[workers.length - 1] ?? null, workers, stopWorkers, server };
  } catch (error) {
    stopWorkers();
    throw error;
  }
}

/** Shared-secret gate between the Cloudflare proxy and this relayer. Empty key = open (local dev). */
export function withProxyKeyAuth(handler, key) {
  return async function authed(req, res) {
    if (key) {
      const got = String(req.headers['x-vf-relayer-key'] || '');
      const a = Buffer.from(got);
      const b = Buffer.from(key);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    }
    return handler(req, res);
  };
}

/**
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 * @returns {{ handler: Function, listen: (port: number) => Promise<import('node:http').Server> }}
 */
export function createRelayerServer(config, {
  openSqlite = createSqliteStores,
  createRouter = createRelayerRouter,
  createHttpServer = createServer,
  recoveryLimit = 100,
  recoveryConcurrency = 4,
} = {}) {
  if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit < 1 || recoveryLimit > 1_000) {
    throw new Error('recoveryLimit must be between 1 and 1000');
  }
  if (!Number.isSafeInteger(recoveryConcurrency) || recoveryConcurrency < 1 || recoveryConcurrency > 32) {
    throw new Error('recoveryConcurrency must be between 1 and 32');
  }
  if (process.env.RELAYER_OFFLINE_KEY_MIGRATION === '1') {
    throw new Error('RELAYER_OFFLINE_KEY_MIGRATION cannot run in the HTTP relayer process');
  }
  const sessionKeyCipher = config?.sessionKeyCipher;
  if (config.dbPath
    && (typeof sessionKeyCipher?.seal !== 'function' || typeof sessionKeyCipher?.open !== 'function')) {
    throw new Error('session-key encryption cipher is required before relayer startup');
  }
  const runtimeConfig = runtimeServerConfig(config);
  // When RELAYER_DB_PATH is set, sqlite backs the idempotency store + jobs + mandates so a restart
  // loses nothing (session keys still die at their 1h TTL either way). Build BEFORE createWatcher so
  // the watcher gets the sqlite-backed relay-work store rather than the file store.
  // Task 8: the watcher's store is the checkpointed relay-work authority (cctp_relay_work via
  // `cctpRelays`), never the generic relay_records KV.
  const sqlite = config.dbPath ? openSqlite(config.dbPath, { sessionKeyCipher }) : null;
  if (sqlite) config = { ...config, store: sqlite.cctpRelays };
  const watcher = createWatcher(config);
  const jobs = sqlite ? sqlite.jobs : new Map();
  // Capability-bound encrypted mandate authority is the sole live registration/farm path.
  // Legacy approval-bearing stores remain migration artifacts and are never wired into HTTP.
  const mandateStoresV3 = sqlite ?? createMandateStoresV3();
  const mandatesV3 = mandateStoresV3.mandatesV3;
  const mandateActivations = mandateStoresV3.mandateActivations;
  // This server's own public origin, compared against every stored mandate's relayerOrigin on
  // every operation (httpRouter.mjs's Step 2 "compare relayer origin to server configuration").
  // Unset = local dev, no compare performed — same "empty = open" posture as RELAYER_PROXY_KEY
  // below. Also what every /mandate response reports as `relayerOrigin`, so the
  // client (frontend/src/wallet/baseBinding.js) can start enforcing it.
  const relayerOrigin = runtimeConfig.relayerOrigin;
  const agentIndexReporter = createAgentIndexReporter({
    endpoint: runtimeConfig.reporterEndpoint,
    secret: runtimeConfig.reporterSecret,
    schemaVersion: runtimeConfig.reporterSchema,
  });
  const associationOutbox = sqlite?.associationOutbox ?? null;

  // Per-request: each /farm call brings its own ephemeral session key, so the orchestrator (and
  // the kernel client it reconstructs) is built fresh per key rather than shared/cached.
  function buildFarm(sessionPrivateKey) {
    const orchestrator = createOrchestrator({
      chain: config.base.chain,
      rpcUrl: config.base.rpcUrl,
      bundlerRpcUrl: config.base.bundlerRpcUrl,
      yieldRouterAddress: config.base.yieldRouterAddress,
      usdcAddress: config.base.usdcAddress,
      sessionPrivateKey,
    });
    return createFarmFlow({ watcher, orchestrator, domains: config.domains });
  }

  function buildMandateActivator(sessionPrivateKey) {
    return createOrchestrator({
      chain: config.base.chain,
      rpcUrl: config.base.rpcUrl,
      bundlerRpcUrl: config.base.bundlerRpcUrl,
      yieldRouterAddress: config.base.yieldRouterAddress,
      usdcAddress: config.base.usdcAddress,
      sessionPrivateKey,
    });
  }

  // Reverse leg: relay ONLY the mint. `stellarRecipient` is already encoded in the burn's
  // hookData (see cctp/reverse.mjs) — accepted here for logging/idempotency, not for routing.
  // The withdraw+burn happens client-side via BaseExitSweeper.exitAllAndBurn; the relayer never
  // constructs or dispatches a burn.
  //
  // Task 8 fail-closed note: relayMint now REQUIRES the immutable canonical expectation and the
  // HTTP layer does not yet construct one from the request intent (Task 11 owns that wiring).
  // Until then this call — like the /farm flow — rejects with RELAY_VALIDATION before any row,
  // poll, or destination send. There is deliberately no bypass.
  function relayUnwindMint({ unwindTxHash }) {
    return watcher.relayMint({ sourceDomain: config.domains.base, burnTxHash: unwindTxHash, execId: unwindTxHash });
  }

  // Sanitize client-facing error messages unless explicitly debugging (RELAYER_DEBUG_ERRORS=1),
  // so a public deploy never leaks internal error strings via protected POST /status. The smoke harness runs
  // localhost and sets the flag to keep full detail.
  // The Cloudflare Pages proxy (functions/api/vf-cross) sends x-vf-relayer-key on every request;
  // the VM is otherwise tunnel-only, so this shared secret is what makes the tunnel non-open.
  // Empty key = local dev (no gate).
  const router = createRouter({
      buildFarm,
      relayUnwindMint,
      jobs,
      mandatesV3,
      mandateActivations,
      buildMandateActivator,
      genId: () => randomBytes(16).toString('hex'),
      usdcAddress: config.base.usdcAddress,
      yieldRouterAddress: config.base.yieldRouterAddress,
      relayerOrigin,
      sanitizeErrors: runtimeConfig.sanitizeErrors,
      networkId: 'stellar-testnet',
      poolTargets: BASE_SEPOLIA_POOL_TARGETS,
      agentIndexReporter,
      associationOutbox,
      baseEvidenceOutbox: sqlite?.baseEvidenceOutbox ?? null,
      farmExecutions: sqlite?.farmExecutions ?? null,
      farmIntents: sqlite?.farmIntents ?? null,
      cctpRelays: sqlite?.cctpRelays ?? null,
      relayForwardMint: (relayIntent) => watcher.relayMint(relayIntent),
      recoveryLimit,
      recoveryConcurrency,
      forwardFarmDeployment: config.stellar?.tokenMessengerMinter && config.stellar?.usdcSac
        && config.base?.tokenMessengerV2Address && config.domains?.stellar ? {
        networkId: 'stellar-testnet',
        sourceDomain: config.domains.stellar,
        destinationDomain: config.domains.base,
        tokenMessengerMinter: config.stellar.tokenMessengerMinter,
        baseTokenMessenger: config.base.tokenMessengerV2Address,
        stellarUsdcSac: config.stellar.usdcSac,
        poolTargets: BASE_SEPOLIA_POOL_TARGETS,
      } : null,
      publicRuntime: runtimeConfig.publicRuntime,
    });
  const handler = withProxyKeyAuth(
    router,
    runtimeConfig.proxyKey,
  );

  async function listen(port) {
    const production = config.mode === 'production' || config.mode === 'staging';
    const started = await startVerifiedRelayer({
      verifyReadiness: production
        ? () => verifyRelayerReadiness({ sqlite, reporter: agentIndexReporter })
        : async () => ({ writable: Boolean(sqlite), reporterSchema: runtimeConfig.reporterSchema }),
      resumeMandateActivations: () => router.resumeMandateActivations(),
      reconcileCctpRelays: () => (sqlite
        ? watcher.sweepStuck({ limit: recoveryLimit })
        : Promise.resolve({ redriven: [], held: [], blocked: [], uncertain: [] })),
      resumeFarmJobs: () => router.resumeFarmJobs(),
      startBaseEvidenceWorker: () => (sqlite?.baseEvidenceOutbox
        ? startBaseEvidenceOutboxWorker({
          outbox: sqlite.baseEvidenceOutbox,
          reporter: agentIndexReporter,
          onConflict: (leased) => {
            try {
              return sqlite.farmIntents.blockEvidenceConflict(
                { identity: leased.identity }, { transaction: false },
              );
            } catch {
              return sqlite.farmExecutions.blockEvidenceConflict(
                { identity: leased.identity }, { transaction: false },
              );
            }
          },
        })
        : null),
      startAssociationWorker: () => (associationOutbox
        ? startAssociationOutboxWorker({ outbox: associationOutbox, reporter: agentIndexReporter })
        : null),
      openListener: () => {
        const server = createHttpServer(handler);
        server.listen(port);
        return server;
      },
    });
    started.server.on('close', () => started.stopWorkers());
    return started.server;
  }

  return { handler, listen };
}
