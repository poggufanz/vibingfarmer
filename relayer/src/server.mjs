// Thin composition layer: wires the relayer's existing watcher/orchestrator/farm-flow modules
// into the pure httpRouter and exposes a node:http listener. Holds no request-handling logic of
// its own — see httpRouter.mjs for that. NOT mounted as Vite middleware: the in-memory
// jobs/mandates Maps need one long-lived process (CF Pages isolates don't share memory across
// requests), and running standalone keeps relayer secrets out of the Vite dev process.

import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWatcher } from './cctp/watcher.mjs';
import { createOrchestrator } from './base/orchestrator.mjs';
import { createFarmFlow } from './flows/farm.mjs';
import { createRelayerRouter } from './httpRouter.mjs';
import { createMandateStoreV2 } from './mandateStore.mjs';
import { createSqliteStores } from './sqliteStores.mjs';
import { startAssociationOutboxWorker } from './associationOutbox.mjs';
import {
  BASE_SEPOLIA_POOL_TARGETS,
  createAgentIndexReporter,
} from './agentIndexReporter.mjs';

const MANDATE_SWEEP_MS = 10 * 60 * 1000; // evict expired session keys every 10 min

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
  ) {
    throw new Error('agent index reporter schema/store is not ready');
  }
  return { writable: true, reporterSchema: remote.schemaVersion };
}

export async function startVerifiedRelayer({
  verifyReadiness,
  resumeFarmJobs,
  startWorker,
  openListener,
}) {
  await verifyReadiness();
  await resumeFarmJobs();
  const worker = startWorker();
  const server = openListener();
  return { worker, server };
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
export function createRelayerServer(config, { openSqlite = createSqliteStores } = {}) {
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
  // the watcher gets the sqlite-backed idempotency store rather than the file store.
  const sqlite = config.dbPath ? openSqlite(config.dbPath, { sessionKeyCipher }) : null;
  if (sqlite) config = { ...config, store: sqlite.store };
  const watcher = createWatcher(config);
  const jobs = sqlite ? sqlite.jobs : new Map();
  // VF Wallet Task 7: owner/kernel-bound mandate store, keyed on (approval, stellarOwner,
  // kernelAddress) together — never logged, never returned to a caller. Memory (or sqlite when
  // RELAYER_DB_PATH is set) — TTL so session keys don't linger past the mandate's lifetime. The
  // legacy approval-only store (mandateStore.mjs's createMandateStore / sqliteStores.mjs's
  // `mandates` table) is deliberately no longer wired in here at all: any row still sitting there
  // stays untouched for rollback, but this server never reads or writes it again.
  const mandatesV2 = sqlite ? sqlite.mandatesV2 : createMandateStoreV2();
  // This server's own public origin, compared against every stored mandate's relayerOrigin on
  // every operation (httpRouter.mjs's Step 2 "compare relayer origin to server configuration").
  // Unset = local dev, no compare performed — same "empty = open" posture as RELAYER_PROXY_KEY
  // below. Also what every /mandate + /mandate/valid response reports as `relayerOrigin`, so the
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

  // Reverse leg: relay ONLY the mint. `stellarRecipient` is already encoded in the burn's
  // hookData (see cctp/reverse.mjs) — accepted here for logging/idempotency, not for routing.
  // The withdraw+burn happens client-side via BaseExitSweeper.exitAllAndBurn; the relayer never
  // constructs or dispatches a burn.
  function relayUnwindMint({ unwindTxHash }) {
    return watcher.relayMint({ sourceDomain: config.domains.base, burnTxHash: unwindTxHash, execId: unwindTxHash });
  }

  // Sanitize client-facing error messages unless explicitly debugging (RELAYER_DEBUG_ERRORS=1),
  // so a public deploy never leaks internal error strings via GET /status. The smoke harness runs
  // localhost and sets the flag to keep full detail.
  // The Cloudflare Pages proxy (functions/api/vf-cross) sends x-vf-relayer-key on every request;
  // the VM is otherwise tunnel-only, so this shared secret is what makes the tunnel non-open.
  // Empty key = local dev (no gate).
  const router = createRelayerRouter({
      buildFarm,
      relayUnwindMint,
      jobs,
      mandatesV2,
      genId: randomUUID,
      usdcAddress: config.base.usdcAddress,
      yieldRouterAddress: config.base.yieldRouterAddress,
      relayerOrigin,
      sanitizeErrors: runtimeConfig.sanitizeErrors,
      networkId: 'stellar-testnet',
      poolTargets: BASE_SEPOLIA_POOL_TARGETS,
      agentIndexReporter,
      associationOutbox,
      farmExecutions: sqlite?.farmExecutions ?? null,
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
      resumeFarmJobs: () => router.resumeFarmJobs(),
      startWorker: () => (associationOutbox
        ? startAssociationOutboxWorker({ outbox: associationOutbox, reporter: agentIndexReporter })
        : null),
      openListener: () => {
        const server = createServer(handler);
        server.listen(port);
        return server;
      },
    });
    // Periodically drop expired session keys so they don't wait for a matching /farm to be evicted.
    const sweep = setInterval(() => mandatesV2.sweep(), MANDATE_SWEEP_MS);
    sweep.unref?.(); // never keep the process alive just for the sweep
    started.server.on('close', () => clearInterval(sweep));
    started.server.on('close', () => started.worker?.stop());
    return started.server;
  }

  return { handler, listen };
}
