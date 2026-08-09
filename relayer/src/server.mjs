// Thin composition layer: wires the relayer's existing watcher/orchestrator/farm-flow modules
// into the pure httpRouter and exposes a node:http listener. Holds no request-handling logic of
// its own — see httpRouter.mjs for that. NOT mounted as Vite middleware: the in-memory
// jobs/mandates Maps need one long-lived process (CF Pages isolates don't share memory across
// requests), and running standalone keeps relayer secrets out of the Vite dev process.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { getAddress, http } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { createWatcher } from './cctp/watcher.mjs';
import { BASE_SEPOLIA, CCTP_DOMAIN, STELLAR_TESTNET } from './cctp/constants.mjs';
import { createOrchestrator } from './base/orchestrator.mjs';
import { createFarmFlow } from './flows/farm.mjs';
import { createRelayerRouter } from './httpRouter.mjs';
import { readUnwindEvidence } from './unwindEvidence.mjs';
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

export async function verifyRelayerReadiness({
  sqlite,
  reporter,
  baseCrossChainAvailable = true,
}) {
  if (!sqlite?.probe || !reporter?.probe) throw new Error('relayer durable readiness is not configured');
  const requireBaseReadiness = baseCrossChainAvailable === true;
  const local = await sqlite.probe();
  if (local?.writable !== true) throw new Error('relayer SQLite store is not writable');
  if (requireBaseReadiness && local?.baseEvidenceDurable !== true) {
    throw new Error('relayer SQLite Base evidence store is not durable');
  }
  if (requireBaseReadiness && local?.farmIntentDurable !== true) {
    throw new Error('relayer SQLite forward-farm intent store is not durable');
  }
  if (requireBaseReadiness && local?.unwindDurable !== true) {
    throw new Error('relayer SQLite unwind authority store is not durable');
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
  const remote = await reporter.probe({
    baseCrossChainAvailable: requireBaseReadiness,
  });
  if (
    remote?.ready !== true
    || remote?.schemaVersion !== 1
    || remote?.stores?.executionReceipts !== true
    || (requireBaseReadiness && (
      remote?.stores?.baseChildIntents !== true
      || remote?.stores?.baseRecoveryEvidence !== true
    ))
  ) {
    throw new Error('agent index reporter schema/store is not ready');
  }
  return { writable: true, reporterSchema: remote.schemaVersion };
}

export function startUnwindRecoveryWorker({
  reconcileCctpRelays,
  resumeUnwindJobs,
  recoveryLimit = 100,
  intervalMs = 5_000,
  schedule = setInterval,
  cancel = clearInterval,
  onError = () => {},
}) {
  if (typeof reconcileCctpRelays !== 'function' || typeof resumeUnwindJobs !== 'function'
      || typeof schedule !== 'function' || typeof cancel !== 'function'
      || typeof onError !== 'function') {
    throw new Error('unwind recovery worker dependencies are invalid');
  }
  if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit < 1 || recoveryLimit > 1_000
      || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
    throw new Error('unwind recovery worker bounds are invalid');
  }
  let running = false;
  let stopped = false;
  async function tick() {
    if (stopped || running) return false;
    running = true;
    try {
      await reconcileCctpRelays({ limit: recoveryLimit });
      await resumeUnwindJobs({ limit: recoveryLimit });
      return true;
    } catch (error) {
      try { onError(error); } catch {}
      return false;
    } finally {
      running = false;
    }
  }
  const timer = schedule(() => tick(), intervalMs);
  timer?.unref?.();
  return Object.freeze({
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    },
  });
}

export async function startVerifiedRelayer({
  verifyReadiness,
  resumeMandateActivations,
  reconcileCctpRelays = async () => {},
  resumeUnwindJobs = async () => {},
  resumeFarmJobs,
  startUnwindRecoveryWorker: startUnwindWorker = null,
  startBaseEvidenceWorker = null,
  startAssociationWorker = null,
  startWorker = null,
  openListener,
}) {
  await verifyReadiness();
  await resumeMandateActivations();
  await reconcileCctpRelays();
  await resumeUnwindJobs();
  await resumeFarmJobs();
  const workers = [];
  const stopWorkers = () => {
    for (const worker of [...workers].reverse()) worker?.stop?.();
  };
  try {
    if (startUnwindWorker) workers.push(startUnwindWorker());
    if (startBaseEvidenceWorker) workers.push(startBaseEvidenceWorker());
    if (startAssociationWorker) workers.push(startAssociationWorker());
    else if (startWorker) workers.push(startWorker());
    const server = await openListener();
    return { worker: workers[workers.length - 1] ?? null, workers, stopWorkers, server };
  } catch (error) {
    stopWorkers();
    throw error;
  }
}

const ENTRY_POINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const BYTES32_RE = /^0x[0-9a-f]{64}$/;

function lowerAddress(value, label) {
  try {
    const address = getAddress(value);
    if (/^0x0{40}$/i.test(address)) throw new Error('zero address');
    return address.toLowerCase();
  } catch {
    throw new Error(`active unwind ${label} is invalid`);
  }
}

function contractBytes32(value, label) {
  try {
    return `0x${Buffer.from(StrKey.decodeContract(value)).toString('hex')}`;
  } catch {
    throw new Error(`active unwind ${label} is invalid`);
  }
}

function buildUnwindEvidenceFacts(config) {
  const deployment = config?.base?.hardenedDeployment;
  const route = deployment?.route;
  const entryPointAddress = lowerAddress(
    config?.base?.mandatePolicy?.entryPointAddress,
    'EntryPoint',
  );
  const baseExitSweeperAddress = lowerAddress(
    deployment?.baseExitSweeper?.address,
    'BaseExitSweeper',
  );
  const usdcAddress = lowerAddress(route?.usdcAddress, 'USDC');
  const tokenMessengerV2Address = lowerAddress(
    route?.tokenMessengerAddress,
    'TokenMessengerV2',
  );
  const messageTransmitterV2Address = lowerAddress(
    config?.base?.messageTransmitterAddress,
    'MessageTransmitterV2',
  );
  const stellarTokenMessenger = contractBytes32(
    config?.stellar?.tokenMessengerMinter,
    'Stellar TokenMessenger',
  );
  const cctpForwarder = contractBytes32(
    config?.stellar?.forwarderAddress,
    'Stellar forwarder',
  );
  if (deployment?.generation !== 'hardened-v2'
      || deployment?.chainId !== 84532
      || config?.base?.chain?.id !== 84532
      || config?.base?.mandatePolicy?.entryPointVersion !== '0.7'
      || entryPointAddress !== ENTRY_POINT_V07
      || lowerAddress(config.base.baseExitSweeperAddress, 'configured BaseExitSweeper')
        !== baseExitSweeperAddress
      || lowerAddress(config.base.usdcAddress, 'configured USDC') !== usdcAddress
      || lowerAddress(config.base.tokenMessengerV2Address, 'configured TokenMessengerV2')
        !== tokenMessengerV2Address
      || messageTransmitterV2Address !== BASE_SEPOLIA.messageTransmitterV2.toLowerCase()
      || usdcAddress !== BASE_SEPOLIA.usdc.toLowerCase()
      || tokenMessengerV2Address !== BASE_SEPOLIA.tokenMessengerV2.toLowerCase()
      || config?.domains?.base !== CCTP_DOMAIN.BASE
      || config?.domains?.stellar !== CCTP_DOMAIN.STELLAR
      || config?.stellar?.tokenMessengerMinter !== STELLAR_TESTNET.tokenMessengerMinter
      || config?.stellar?.forwarderAddress !== STELLAR_TESTNET.cctpForwarder
      || route?.stellarDomain !== CCTP_DOMAIN.STELLAR
      || route?.finalityThreshold !== 1000
      || !BYTES32_RE.test(route?.mintRecipient)
      || !BYTES32_RE.test(route?.destinationCaller)
      || route.mintRecipient !== cctpForwarder
      || route.destinationCaller !== cctpForwarder) {
    throw new Error('active unwind deployment facts are invalid');
  }
  return Object.freeze({
    generation: 'hardened-v2',
    chainId: 84532,
    entryPointAddress,
    baseExitSweeperAddress,
    usdcAddress,
    tokenMessengerV2Address,
    messageTransmitterV2Address,
    stellarDomain: CCTP_DOMAIN.STELLAR,
    stellarTokenMessenger,
    cctpForwarder,
    finalityThreshold: 1000,
  });
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
        const pathname = new URL(req.url, 'http://local').pathname;
        if (['/unwind', '/unwind/attach', '/status'].some(
          (path) => pathname === path || pathname.endsWith(`/api/vf-cross${path}`),
        )) {
          res.setHeader('Cache-Control', 'no-store');
        }
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    }
    return handler(req, res);
  };
}

function deriveActivePoolTargets(
  baseCrossChainAvailable,
  allowedPools,
  hardenedDeployment,
  catalog,
) {
  if (!baseCrossChainAvailable) return new Map();
  const recordedPools = hardenedDeployment?.pools?.enabled;
  if (!Array.isArray(recordedPools)
      || !Array.isArray(allowedPools)
      || recordedPools.length !== allowedPools.length
      || recordedPools.some((pool, index) => pool !== allowedPools[index])) {
    throw new Error('active approved pool set disagrees with hardened deployment record');
  }
  if (!Array.isArray(allowedPools) || !(catalog instanceof Map) || catalog.size === 0) {
    throw new Error('active approved pool catalog is not configured');
  }
  const normalizedPools = [];
  for (const pool of allowedPools) {
    let checksum;
    try {
      checksum = typeof pool === 'string' ? getAddress(pool) : null;
    } catch {
      checksum = null;
    }
    if (!checksum || checksum !== pool
        || pool === '0x0000000000000000000000000000000000000000') {
      throw new Error('active approved pool address is not canonical');
    }
    normalizedPools.push(pool.toLowerCase());
  }
  const approvedSet = new Set(normalizedPools);
  if (approvedSet.size !== normalizedPools.length || approvedSet.size !== catalog.size) {
    throw new Error('active approved pool set disagrees with protocol catalog');
  }
  const poolTargets = new Map();
  for (const [pool, protocol] of catalog) {
    if (typeof pool !== 'string' || pool !== pool.toLowerCase()
        || typeof protocol !== 'string' || !protocol || !approvedSet.has(pool)) {
      throw new Error('active approved pool mapping disagrees with protocol catalog');
    }
    poolTargets.set(pool, protocol);
  }
  if (poolTargets.size !== approvedSet.size) {
    throw new Error('active approved pool mapping is incomplete');
  }
  return poolTargets;
}

/**
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 * @returns {{ handler: Function, listen: (port: number) => Promise<import('node:http').Server> }}
 */
export function createRelayerServer(config, {
  openSqlite = createSqliteStores,
  createWatcherFn = createWatcher,
  createRouter = createRelayerRouter,
  createReporter = createAgentIndexReporter,
  createHttpServer = createServer,
  createUnwindBundlerClient = ({ chain, rpcUrl }) => createBundlerClient({
    chain,
    transport: http(rpcUrl),
  }),
  readUnwindEvidenceFn = readUnwindEvidence,
  startUnwindRecoveryWorkerFn = startUnwindRecoveryWorker,
  poolTargetCatalog = BASE_SEPOLIA_POOL_TARGETS,
  recoveryLimit = 100,
  recoveryConcurrency = 4,
  unwindRecoveryIntervalMs = 5_000,
} = {}) {
  if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit < 1 || recoveryLimit > 1_000) {
    throw new Error('recoveryLimit must be between 1 and 1000');
  }
  if (!Number.isSafeInteger(recoveryConcurrency) || recoveryConcurrency < 1 || recoveryConcurrency > 32) {
    throw new Error('recoveryConcurrency must be between 1 and 32');
  }
  const privateBaseAvailability = config?.base?.baseCrossChainAvailable;
  const publicBaseAvailability = config?.publicRuntime?.baseCrossChainAvailable;
  if (typeof privateBaseAvailability !== 'boolean'
      || typeof publicBaseAvailability !== 'boolean') {
    throw new Error('Base execution availability must be boolean');
  }
  if (privateBaseAvailability !== publicBaseAvailability) {
    throw new Error('private/public Base execution availability disagree');
  }
  const baseCrossChainAvailable = privateBaseAvailability === true;
  const production = config.mode === 'production' || config.mode === 'staging';
  const poolTargets = deriveActivePoolTargets(
    baseCrossChainAvailable,
    config.base.allowedPools,
    config.base.hardenedDeployment,
    poolTargetCatalog,
  );
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
  let unwindPublicClient = null;
  let unwindBundlerClient = null;
  let unwindEvidenceFacts = null;
  if (baseCrossChainAvailable) {
    const durableAuthorityAvailable = Boolean(sqlite?.unwindJobs && sqlite?.cctpRelays);
    const receiptReadersAvailable = typeof config.base?.publicClient?.getChainId === 'function'
      && typeof config.base?.publicClient?.getTransactionReceipt === 'function'
      && typeof config.base?.bundlerRpcUrl === 'string'
      && Boolean(config.base.bundlerRpcUrl);
    if (production && !durableAuthorityAvailable) {
      throw new Error('active production unwind requires dedicated durable SQLite authority');
    }
    if (production && !receiptReadersAvailable) {
      throw new Error('active production unwind receipt readers are unavailable');
    }
    if (durableAuthorityAvailable && receiptReadersAvailable) {
      unwindEvidenceFacts = buildUnwindEvidenceFacts(config);
      unwindPublicClient = config.base.publicClient;
      unwindBundlerClient = createUnwindBundlerClient({
        chain: config.base.chain,
        rpcUrl: config.base.bundlerRpcUrl,
      });
      if (typeof unwindBundlerClient?.getUserOperation !== 'function'
          || typeof unwindBundlerClient?.getUserOperationReceipt !== 'function') {
        throw new Error('active production unwind bundler reader is unavailable');
      }
    }
  }
  const watcher = createWatcherFn(config);
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
  const agentIndexReporter = createReporter({
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
      baseCrossChainAvailable,
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
      baseCrossChainAvailable,
    });
  }

  // Sanitize client-facing error messages unless explicitly debugging (RELAYER_DEBUG_ERRORS=1),
  // so a public deploy never leaks internal error strings via protected POST /status. The smoke harness runs
  // localhost and sets the flag to keep full detail.
  // The Cloudflare Pages proxy (functions/api/vf-cross) sends x-vf-relayer-key on every request;
  // the VM is otherwise tunnel-only, so this shared secret is what makes the tunnel non-open.
  // Empty key = local dev (no gate).
  const router = createRouter({
      buildFarm,
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
      poolTargets,
      agentIndexReporter,
      associationOutbox,
      baseEvidenceOutbox: sqlite?.baseEvidenceOutbox ?? null,
      farmIntents: sqlite?.farmIntents ?? null,
      cctpRelays: sqlite?.cctpRelays ?? null,
      relayForwardMint: (relayIntent) => watcher.relayMint(relayIntent),
      unwindJobs: (!baseCrossChainAvailable || unwindEvidenceFacts)
        ? sqlite?.unwindJobs ?? null
        : null,
      readUnwindEvidence: readUnwindEvidenceFn,
      relayReverseMint: (relayIntent) => watcher.relayMint(relayIntent),
      resumeExistingReverse: (execId) => watcher.resumeExisting(execId),
      unwindPublicClient,
      unwindBundlerClient,
      unwindEvidenceFacts,
      recoveryLimit,
      recoveryConcurrency,
      forwardFarmDeployment: baseCrossChainAvailable
        && config.stellar?.tokenMessengerMinter && config.stellar?.usdcSac
        && config.base?.tokenMessengerV2Address && config.domains?.stellar ? {
        networkId: 'stellar-testnet',
        sourceDomain: config.domains.stellar,
        destinationDomain: config.domains.base,
        tokenMessengerMinter: config.stellar.tokenMessengerMinter,
        baseTokenMessenger: config.base.tokenMessengerV2Address,
        stellarUsdcSac: config.stellar.usdcSac,
        poolTargets,
      } : null,
      publicRuntime: runtimeConfig.publicRuntime,
    });
  const handler = withProxyKeyAuth(
    router,
    runtimeConfig.proxyKey,
  );

  async function listen(port) {
    const reconcileCctpRelays = ({ limit = recoveryLimit } = {}) => (
      sqlite && baseCrossChainAvailable
        ? watcher.sweepStuck({ limit })
        : Promise.resolve({ redriven: [], held: [], blocked: [], uncertain: [] })
    );
    const resumeUnwindJobs = ({ limit = recoveryLimit } = {}) => (
      router.resumeUnwindJobs({ limit })
    );
    const started = await startVerifiedRelayer({
      verifyReadiness: production
        ? () => verifyRelayerReadiness({
          sqlite,
          reporter: agentIndexReporter,
          baseCrossChainAvailable,
        })
        : async () => ({ writable: Boolean(sqlite), reporterSchema: runtimeConfig.reporterSchema }),
      resumeMandateActivations: () => router.resumeMandateActivations(),
      reconcileCctpRelays,
      resumeUnwindJobs,
      resumeFarmJobs: () => router.resumeFarmJobs(),
      startUnwindRecoveryWorker: sqlite
        ? () => startUnwindRecoveryWorkerFn({
          reconcileCctpRelays,
          resumeUnwindJobs,
          recoveryLimit,
          intervalMs: unwindRecoveryIntervalMs,
        })
        : null,
      startBaseEvidenceWorker: () => (baseCrossChainAvailable && sqlite?.baseEvidenceOutbox
        ? startBaseEvidenceOutboxWorker({
          outbox: sqlite.baseEvidenceOutbox,
          reporter: agentIndexReporter,
          onConflict: (leased) => {
            const authority = sqlite.farmIntents.evidenceConflictAuthority({
              identity: leased.identity,
            });
            if (authority === 'v2') {
              return sqlite.farmIntents.blockEvidenceConflict(
                { identity: leased.identity }, { transaction: false },
              );
            }
            if (authority === 'legacy') {
              return sqlite.farmExecutions.blockEvidenceConflict(
                { identity: leased.identity }, { transaction: false },
              );
            }
            throw new Error('Base evidence conflict has no owning authority');
          },
        })
        : null),
      startAssociationWorker: () => (associationOutbox
        ? startAssociationOutboxWorker({ outbox: associationOutbox, reporter: agentIndexReporter })
        : null),
      openListener: () => {
        const server = createHttpServer(handler);
        if (typeof server.once !== 'function') {
          server.listen(port);
          return server;
        }
        return new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off?.('listening', onListening);
            try { server.close(); } catch {}
            reject(error);
          };
          const onListening = () => {
            server.off?.('error', onError);
            resolve(server);
          };
          server.once('error', onError);
          server.once('listening', onListening);
          try {
            server.listen(port);
          } catch (error) {
            onError(error);
          }
        });
      },
    });
    started.server.on('close', () => started.stopWorkers());
    return started.server;
  }

  return { handler, listen };
}
