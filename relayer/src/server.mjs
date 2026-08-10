// Thin composition layer: wires the relayer's existing watcher/orchestrator/farm-flow modules
// into the pure httpRouter and exposes a node:http listener. Holds no request-handling logic of
// its own — see httpRouter.mjs for that. NOT mounted as Vite middleware: the in-memory
// jobs/mandates Maps need one long-lived process (CF Pages isolates don't share memory across
// requests), and running standalone keeps relayer secrets out of the Vite dev process.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { getAddress, http } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { createWatcher } from './cctp/watcher.mjs';
import { BASE_SEPOLIA, CCTP_DOMAIN, STELLAR_TESTNET } from './cctp/constants.mjs';
import { createOrchestrator } from './base/orchestrator.mjs';
import { createFarmFlow } from './flows/farm.mjs';
import { createRelayerRouter, sameRecoveryFarmIntentFacts } from './httpRouter.mjs';
import { readUnwindEvidence } from './unwindEvidence.mjs';
import { createMandateStoresV3 } from './mandateStore.mjs';
import { createSqliteStores } from './sqliteStores.mjs';
import { startAssociationOutboxWorker } from './associationOutbox.mjs';
import { startBaseEvidenceOutboxWorker } from './baseEvidenceOutbox.mjs';
import { BASE_SEPOLIA_POOL_TARGETS, createAgentIndexReporter } from './agentIndexReporter.mjs';
import { createBaseRecoveryExecutor } from './baseRecovery.mjs';
import { pollAttestation } from './cctp/iris.mjs';
import { confirmMintBase, submitMintBase } from './cctp/forward.mjs';
import { assertCctpV2BurnMatches } from './cctp/messageV2.mjs';
import { createSafeLogger } from './safeLogger.mjs';

export function runtimeServerConfig(config) {
  const runtime = {
    relayerOrigin: config.publicOrigin,
    reporterEndpoint: config.reporter.url,
    reporterSchema: config.reporter.schema,
    reporterSecret: config.runtime.reporterSecret,
    proxyKey: config.runtime.proxyKey,
    sanitizeErrors: !config.runtime.debugErrors,
    publicRuntime: config.publicRuntime,
  };
  if (config.runtime.proxyKeyPrevious !== undefined) {
    runtime.proxyKeyPrevious = config.runtime.proxyKeyPrevious;
  }
  return runtime;
}

export async function verifyRelayerReadiness({ sqlite, reporter, baseCrossChainAvailable = true }) {
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
  if (requireBaseReadiness && local?.baseRecoveryWorkDurable !== true) {
    throw new Error('relayer SQLite Base recovery-work store is not durable');
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
    remote?.ready !== true ||
    remote?.schemaVersion !== 1 ||
    remote?.stores?.executionReceipts !== true ||
    (requireBaseReadiness &&
      (remote?.stores?.baseChildIntents !== true || remote?.stores?.baseRecoveryEvidence !== true))
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
  if (
    typeof reconcileCctpRelays !== 'function' ||
    typeof resumeUnwindJobs !== 'function' ||
    typeof schedule !== 'function' ||
    typeof cancel !== 'function' ||
    typeof onError !== 'function'
  ) {
    throw new Error('unwind recovery worker dependencies are invalid');
  }
  if (
    !Number.isSafeInteger(recoveryLimit) ||
    recoveryLimit < 1 ||
    recoveryLimit > 1_000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1_000 ||
    intervalMs > 300_000
  ) {
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
      try {
        onError(error);
      } catch {}
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

// Durable Base recovery must continue after the browser's one-shot /farm/recover enqueue. Keep
// this worker bounded and non-overlapping: a transient reporter/receipt failure leaves the local
// row held and the next tick gets a fresh owner-proven claim instead of requiring browser resend.
export function startBaseRecoveryWorker({
  resumeBaseRecovery,
  recoveryLimit = 100,
  intervalMs = 5_000,
  schedule = setInterval,
  cancel = clearInterval,
  onError = () => {},
}) {
  if (
    typeof resumeBaseRecovery !== 'function' ||
    typeof schedule !== 'function' ||
    typeof cancel !== 'function' ||
    typeof onError !== 'function'
  ) {
    throw new Error('Base recovery worker dependencies are invalid');
  }
  if (
    !Number.isSafeInteger(recoveryLimit) ||
    recoveryLimit < 1 ||
    recoveryLimit > 1_000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1_000 ||
    intervalMs > 300_000
  ) {
    throw new Error('Base recovery worker bounds are invalid');
  }
  let running = false;
  let stopped = false;
  async function tick() {
    if (stopped || running) return false;
    running = true;
    try {
      await resumeBaseRecovery({ limit: recoveryLimit });
      return true;
    } catch (error) {
      try {
        onError(error);
      } catch {}
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
  resumeBaseRecovery = async () => {},
  resumeFarmJobs,
  startUnwindRecoveryWorker: startUnwindWorker = null,
  startBaseRecoveryWorker: startBaseRecoveryWorkerFn = null,
  startBaseEvidenceWorker = null,
  startAssociationWorker = null,
  startWorker = null,
  openListener,
}) {
  await verifyReadiness();
  await resumeMandateActivations();
  await reconcileCctpRelays();
  await resumeUnwindJobs();
  await resumeBaseRecovery();
  await resumeFarmJobs();
  const workers = [];
  const stopWorkers = () => {
    for (const worker of [...workers].reverse()) worker?.stop?.();
  };
  try {
    if (startUnwindWorker) workers.push(startUnwindWorker());
    if (startBaseRecoveryWorkerFn) workers.push(startBaseRecoveryWorkerFn());
    if (startBaseEvidenceWorker) workers.push(startBaseEvidenceWorker());
    if (startAssociationWorker) workers.push(startAssociationWorker());
    else if (startWorker) workers.push(startWorker());
    const server = await openListener();
    return {
      worker: workers[workers.length - 1] ?? null,
      workers,
      stopWorkers,
      server,
    };
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

// Recovery projection uses the same lowercase EVM-address boundary as the active deployment
// facts, but it must remain usable in test/local composition where no unwind deployment exists.
function canonicalAddress(value, label) {
  try {
    const address = getAddress(value);
    if (/^0x0{40}$/i.test(address)) throw new Error('zero address');
    return address.toLowerCase();
  } catch {
    throw new Error(`${label} is invalid`);
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
  const entryPointAddress = lowerAddress(config?.base?.mandatePolicy?.entryPointAddress, 'EntryPoint');
  const baseExitSweeperAddress = lowerAddress(deployment?.baseExitSweeper?.address, 'BaseExitSweeper');
  const usdcAddress = lowerAddress(route?.usdcAddress, 'USDC');
  const tokenMessengerV2Address = lowerAddress(route?.tokenMessengerAddress, 'TokenMessengerV2');
  const messageTransmitterV2Address = lowerAddress(config?.base?.messageTransmitterAddress, 'MessageTransmitterV2');
  const stellarTokenMessenger = contractBytes32(config?.stellar?.tokenMessengerMinter, 'Stellar TokenMessenger');
  const cctpForwarder = contractBytes32(config?.stellar?.forwarderAddress, 'Stellar forwarder');
  if (
    deployment?.generation !== 'hardened-v2' ||
    deployment?.chainId !== 84532 ||
    config?.base?.chain?.id !== 84532 ||
    config?.base?.mandatePolicy?.entryPointVersion !== '0.7' ||
    entryPointAddress !== ENTRY_POINT_V07 ||
    lowerAddress(config.base.baseExitSweeperAddress, 'configured BaseExitSweeper') !== baseExitSweeperAddress ||
    lowerAddress(config.base.usdcAddress, 'configured USDC') !== usdcAddress ||
    lowerAddress(config.base.tokenMessengerV2Address, 'configured TokenMessengerV2') !== tokenMessengerV2Address ||
    messageTransmitterV2Address !== BASE_SEPOLIA.messageTransmitterV2.toLowerCase() ||
    usdcAddress !== BASE_SEPOLIA.usdc.toLowerCase() ||
    tokenMessengerV2Address !== BASE_SEPOLIA.tokenMessengerV2.toLowerCase() ||
    config?.domains?.base !== CCTP_DOMAIN.BASE ||
    config?.domains?.stellar !== CCTP_DOMAIN.STELLAR ||
    config?.stellar?.tokenMessengerMinter !== STELLAR_TESTNET.tokenMessengerMinter ||
    config?.stellar?.forwarderAddress !== STELLAR_TESTNET.cctpForwarder ||
    route?.stellarDomain !== CCTP_DOMAIN.STELLAR ||
    route?.finalityThreshold !== 1000 ||
    !BYTES32_RE.test(route?.mintRecipient) ||
    !BYTES32_RE.test(route?.destinationCaller) ||
    route.mintRecipient !== cctpForwarder ||
    route.destinationCaller !== cctpForwarder
  ) {
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

/** Shared-secret gate between the Cloudflare proxy and this relayer. Empty key = open only when
 * the caller has explicitly opted into non-production open mode in configuration. */
export function withProxyKeyAuth(handler, key, { compare = timingSafeEqual } = {}) {
  if (typeof compare !== 'function') throw new Error('proxy-key comparison seam is invalid');
  const current = typeof key === 'string' ? key : key?.current ?? key?.proxyKey ?? '';
  const previous = typeof key === 'string' ? '' : key?.previous ?? key?.proxyKeyPrevious ?? '';
  const candidates = [current, previous].filter((candidate) => typeof candidate === 'string' && candidate);
  return async function authed(req, res) {
    if (candidates.length > 0) {
      const got = typeof req.headers?.['x-vf-relayer-key'] === 'string'
        ? req.headers['x-vf-relayer-key'] : '';
      const actual = Buffer.from(got);
      let ok = false;
      for (const candidate of candidates) {
        const expected = Buffer.from(candidate);
        const width = Math.max(actual.length, expected.length);
        const actualPadded = Buffer.alloc(width);
        const expectedPadded = Buffer.alloc(width);
        actual.copy(actualPadded);
        expected.copy(expectedPadded);
        const compared = compare(actualPadded, expectedPadded);
        const sameLength = actual.length === expected.length;
        if (compared && sameLength) ok = true;
      }
      if (!ok) {
        const pathname = new URL(req.url, 'http://local').pathname;
        if (
          ['/unwind', '/unwind/attach', '/status'].some(
            (path) => pathname === path || pathname.endsWith(`/api/vf-cross${path}`),
          )
        ) {
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

function deriveActivePoolTargets(baseCrossChainAvailable, allowedPools, hardenedDeployment, catalog) {
  if (!baseCrossChainAvailable) return new Map();
  const recordedPools = hardenedDeployment?.pools?.enabled;
  if (
    !Array.isArray(recordedPools) ||
    !Array.isArray(allowedPools) ||
    recordedPools.length !== allowedPools.length ||
    recordedPools.some((pool, index) => pool !== allowedPools[index])
  ) {
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
    if (!checksum || checksum !== pool || pool === '0x0000000000000000000000000000000000000000') {
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
    if (
      typeof pool !== 'string' ||
      pool !== pool.toLowerCase() ||
      typeof protocol !== 'string' ||
      !protocol ||
      !approvedSet.has(pool)
    ) {
      throw new Error('active approved pool mapping disagrees with protocol catalog');
    }
    poolTargets.set(pool, protocol);
  }
  if (poolTargets.size !== approvedSet.size) {
    throw new Error('active approved pool mapping is incomplete');
  }
  return poolTargets;
}

const BASE_RECOVERY_CCTP_LEASE_MS = 30 * 60 * 1_000;
const BASE_RECOVERY_CCTP_POLL_MAX_ATTEMPTS = 300;
const BASE_RECOVERY_CCTP_POLL_INTERVAL_MS = 5_000;

function recoveryOperationResult(state, reasonCode, checkpointRef = null) {
  return { state, reasonCode, ...(checkpointRef ? { checkpointRef } : {}) };
}

function recoveryPhaseEvidence(bundle, phase) {
  const projected = Array.isArray(bundle?.phases)
    ? bundle.phases.find((entry) => entry?.phase === phase)
    : bundle?.phases?.[phase];
  if (projected?.evidence) return projected.evidence;
  return [...(bundle?.events ?? [])].reverse().find((entry) => entry?.phase === phase)?.evidence ?? null;
}

function recoveryPhaseState(bundle, phase) {
  const projected = Array.isArray(bundle?.phases)
    ? bundle.phases.find((entry) => entry?.phase === phase)
    : bundle?.phases?.[phase];
  return (
    projected?.state ?? [...(bundle?.events ?? [])].reverse().find((entry) => entry?.phase === phase)?.state ?? null
  );
}

function recoveryRelayForWork({ work, cctpRelays, farmIntents }) {
  if (!work?.identity || typeof cctpRelays?.get !== 'function') return null;
  const jobId = work.farmJobId ?? work.identity.childId;
  let farmIntent = null;
  try {
    farmIntent = farmIntents?.getByJob?.({ mandateId: work.mandateId, jobId }) ?? null;
  } catch {
    return null;
  }
  const execId = farmIntent?.relayExecId;
  if (!execId) return null;
  const relay = cctpRelays.get(execId);
  if (!relay) return null;
  const burn = recoveryPhaseEvidence(work.bundle ?? {}, 'cctp_burn');
  if (burn?.burnTxHash && relay.burnTxHash !== burn.burnTxHash) return null;
  if (burn?.expectationDigest && relay.expectationDigest !== burn.expectationDigest) return null;
  return { execId, relay };
}

function releaseCctpLease(cctpRelays, execId, claimed, now) {
  if (!['attestation_pending', 'attested', 'mint_submitted'].includes(claimed?.state)) return false;
  try {
    cctpRelays.release?.({ execId, leaseToken: claimed.leaseToken, now });
    return true;
  } catch {
    return false;
  }
}

function digestBytes(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('0x') ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(value.slice(2))
  ) {
    throw new Error('CCTP evidence bytes are not canonical');
  }
  return createHash('sha256')
    .update(Buffer.from(value.slice(2), 'hex'))
    .digest('hex');
}

function normalizedDigest(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : null;
}

function canonicalD1Digest(value, label, { requirePrefix = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} is not canonical`);
  if (requirePrefix) {
    if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is not canonical`);
    return value;
  }
  if (/^[0-9a-f]{64}$/.test(value)) return `0x${value}`;
  if (/^0x[0-9a-f]{64}$/.test(value)) return value;
  throw new Error(`${label} is not canonical`);
}

function validateMintSendEvidence(context, claimed) {
  let parsed;
  try {
    parsed = assertCctpV2BurnMatches(claimed.messageHex, claimed.expectation);
    if (typeof claimed.nonceHex !== 'string' || parsed.nonce.toLowerCase() !== claimed.nonceHex.toLowerCase()) {
      throw new Error('CCTP nonce disagrees with the persisted message');
    }
    if (
      digestBytes(claimed.messageHex) !== normalizedDigest(claimed.messageDigest) ||
      digestBytes(claimed.attestationHex) !== normalizedDigest(claimed.attestationDigest)
    ) {
      throw new Error('CCTP persisted message or attestation digest disagrees with raw bytes');
    }
  } catch (error) {
    const mismatch = new Error(error?.message || 'CCTP mint evidence is invalid');
    mismatch.code = 'CCTP_MINT_EVIDENCE_MISMATCH';
    throw mismatch;
  }
  const expected =
    recoveryPhaseEvidence(context.bundle, 'cctp_attestation') ?? recoveryPhaseEvidence(context.bundle, 'cctp_mint');
  const values = [
    ['burnTxHash', claimed.burnTxHash, expected?.burnTxHash],
    ['expectationDigest', claimed.expectationDigest, expected?.expectationDigest],
    ['messageDigest', claimed.messageDigest, expected?.messageDigest],
    ['attestationDigest', claimed.attestationDigest, expected?.attestationDigest],
  ];
  for (const [field, actual, projected] of values) {
    const same = ['messageDigest', 'attestationDigest'].includes(field)
      ? normalizedDigest(actual) === normalizedDigest(projected)
      : String(actual).toLowerCase() === String(projected).toLowerCase();
    if (projected != null && !same) {
      const mismatch = new Error(`CCTP ${field} disagrees with immutable recovery evidence`);
      mismatch.code = 'CCTP_MINT_EVIDENCE_MISMATCH';
      throw mismatch;
    }
  }
  const projectedNonce = expected?.nonce ?? expected?.nonceHex;
  if (projectedNonce != null && String(claimed.nonceHex).toLowerCase() !== String(projectedNonce).toLowerCase()) {
    const mismatch = new Error('CCTP nonce disagrees with immutable recovery evidence');
    mismatch.code = 'CCTP_MINT_EVIDENCE_MISMATCH';
    throw mismatch;
  }
  return parsed;
}

function cctpCheckpoint({ baseEvidenceOutbox, identity, phase, state, relay, now }) {
  if (typeof baseEvidenceOutbox?.enqueue !== 'function') return null;
  const publicReasonAllowed =
    state === 'failed' || state === 'blocked' || (phase === 'cctp_burn' && state === 'unknown');
  const publicEvidenceVersionAllowed =
    (phase === 'cctp_attestation' && state === 'confirmed') ||
    (phase === 'cctp_mint' && ['submitted', 'confirmed'].includes(state));
  const publicMintHashAllowed = phase === 'cctp_mint' && ['submitted', 'confirmed', 'unknown'].includes(state);
  const evidence = {
    ...(relay.burnTxHash != null ? { burnTxHash: relay.burnTxHash } : {}),
    ...(relay.expectationDigest != null ? { expectationDigest: relay.expectationDigest } : {}),
    ...(relay.messageDigest != null
      ? {
          messageDigest: canonicalD1Digest(relay.messageDigest, 'CCTP messageDigest'),
        }
      : {}),
    ...(relay.attestationDigest != null
      ? {
          attestationDigest: canonicalD1Digest(relay.attestationDigest, 'CCTP attestationDigest'),
        }
      : {}),
    ...(publicEvidenceVersionAllowed && relay.evidenceVersion != null
      ? { evidenceVersion: String(relay.evidenceVersion) }
      : {}),
    ...(relay.nonceHex ? { nonce: String(relay.nonceHex).toLowerCase() } : {}),
    ...(publicMintHashAllowed && relay.mintTxHash
      ? {
          mintTxHash: canonicalD1Digest(relay.mintTxHash, 'CCTP mintTxHash', {
            requirePrefix: true,
          }),
        }
      : {}),
    ...(publicReasonAllowed && relay.reasonCode ? { reasonCode: relay.reasonCode } : {}),
  };
  return baseEvidenceOutbox.enqueue({
    identity,
    phase,
    status: state,
    evidence,
    observedAt: now,
  });
}

// A send may crash after the Task 8/10 fence has been durably advanced but before D1 receives the
// corresponding event. Preserve the public phase order when the next read observes a confirmed
// mint: a cctp_mint submitting row must first become submitted with its known hash, then confirmed.
function cctpMintCheckpoint({ baseEvidenceOutbox, identity, state, relay, now, previousState = null }) {
  if (state === 'confirmed' && previousState === 'submitting') {
    cctpCheckpoint({
      baseEvidenceOutbox,
      identity,
      phase: 'cctp_mint',
      state: 'submitted',
      relay,
      now,
    });
  }
  return cctpCheckpoint({
    baseEvidenceOutbox,
    identity,
    phase: 'cctp_mint',
    state,
    relay,
    now,
  });
}

export function createConcreteBaseRecoveryOperations({
  config,
  watcher,
  cctpRelays,
  farmIntents,
  baseEvidenceOutbox,
  mandatesV3,
  buildMandateActivator,
  override = {},
}) {
  const now = () => Date.now();
  const baseExecutionAvailable = config?.base?.baseCrossChainAvailable === true;
  const baseExecutionUnavailable = async () => recoveryOperationResult('held', 'base-execution-unavailable');

  async function withCctpLease(context, action) {
    const found = recoveryRelayForWork({
      work: { ...context.work, bundle: context.bundle },
      cctpRelays,
      farmIntents,
    });
    if (!found) return recoveryOperationResult('blocked', 'cctp-recovery-work-missing');
    let claimed;
    try {
      claimed = cctpRelays.claim?.({
        execId: found.execId,
        now: now(),
        leaseMs: BASE_RECOVERY_CCTP_LEASE_MS,
      });
    } catch (error) {
      return recoveryOperationResult(
        'held',
        error?.code === 'RELAY_CAS_CONFLICT' ? 'cctp-recovery-fence-lost' : 'cctp-recovery-work-held',
      );
    }
    if (!claimed) return recoveryOperationResult('held', 'cctp-recovery-work-held');
    try {
      return await action(found.execId, claimed);
    } catch (error) {
      releaseCctpLease(cctpRelays, found.execId, claimed, now());
      return recoveryOperationResult(
        'held',
        error?.code === 'RELAY_CAS_CONFLICT' ? 'cctp-recovery-fence-lost' : 'cctp-recovery-operation-retryable',
      );
    }
  }

  async function pollAttestationOperation(context) {
    if (typeof watcher?.pollAttestation === 'function') {
      return watcher.pollAttestation(context);
    }
    return withCctpLease(context, async (execId, claimed) => {
      if (claimed.state === 'attested') {
        try {
          cctpCheckpoint({
            baseEvidenceOutbox,
            identity: context.identity,
            phase: 'cctp_attestation',
            state: 'confirmed',
            relay: claimed,
            now: now(),
          });
        } catch {
          releaseCctpLease(cctpRelays, execId, claimed, now());
          return recoveryOperationResult('held', 'cctp-attestation-projection-retryable');
        }
        cctpRelays.release?.({
          execId,
          leaseToken: claimed.leaseToken,
          now: now(),
        });
        return recoveryOperationResult('done', 'cctp-attestation-already-persisted');
      }
      if (claimed.state !== 'attestation_pending') {
        releaseCctpLease(cctpRelays, execId, claimed, now());
        return recoveryOperationResult('blocked', 'cctp-attestation-state-mismatch');
      }
      let match;
      try {
        match = await pollAttestation({
          irisUrl: config.irisUrl,
          sourceDomain: claimed.sourceDomain,
          txHash: claimed.burnTxHash,
          expectation: claimed.expectation,
          maxAttempts: BASE_RECOVERY_CCTP_POLL_MAX_ATTEMPTS,
          intervalMs: BASE_RECOVERY_CCTP_POLL_INTERVAL_MS,
        });
      } catch (error) {
        if (['CCTP_MESSAGE_AMBIGUOUS', 'CCTP_MESSAGE_MISMATCH'].includes(error?.code)) {
          let blocked;
          try {
            blocked = cctpRelays.finishBlocked({
              execId,
              leaseToken: claimed.leaseToken,
              reasonCode: 'message_mismatch',
              now: now(),
            });
          } catch {
            releaseCctpLease(cctpRelays, execId, claimed, now());
            return recoveryOperationResult('held', 'cctp-attestation-blocked-checkpoint-retryable');
          }
          if (blocked) {
            try {
              cctpCheckpoint({
                baseEvidenceOutbox,
                identity: context.identity,
                phase: 'cctp_attestation',
                state: 'blocked',
                relay: blocked,
                now: now(),
              });
            } catch {
              return recoveryOperationResult('held', 'cctp-attestation-projection-retryable');
            }
          }
          return recoveryOperationResult('blocked', 'cctp-attestation-evidence-mismatch');
        }
        releaseCctpLease(cctpRelays, execId, claimed, now());
        return recoveryOperationResult('held', 'cctp-attestation-pending');
      }
      const next = cctpRelays.recordAttested({
        execId,
        leaseToken: claimed.leaseToken,
        messageHex: match.message,
        nonceHex: match.parsed?.nonce,
        attestationHex: match.attestation,
        now: now(),
      });
      cctpCheckpoint({
        baseEvidenceOutbox,
        identity: context.identity,
        phase: 'cctp_attestation',
        state: 'confirmed',
        relay: next,
        now: now(),
      });
      cctpRelays.release?.({
        execId,
        leaseToken: claimed.leaseToken,
        now: now(),
      });
      return recoveryOperationResult('done', 'cctp-attestation-persisted', `cctp:${execId}:attested`);
    });
  }

  async function submitMintOperation(context) {
    if (typeof watcher?.submitMint === 'function') return watcher.submitMint(context);
    const found = recoveryRelayForWork({
      work: { ...context.work, bundle: context.bundle },
      cctpRelays,
      farmIntents,
    });
    if (!found) return recoveryOperationResult('blocked', 'cctp-recovery-work-missing');
    const replayState = {
      mint_submitting: 'submitting',
      mint_submitted: 'submitted',
      minted: 'confirmed',
      uncertain: 'unknown',
      blocked: 'blocked',
    }[found.relay.state];
    if (replayState) {
      try {
        cctpMintCheckpoint({
          baseEvidenceOutbox,
          identity: context.identity,
          state: replayState,
          relay: found.relay,
          previousState: recoveryPhaseState(context.bundle, 'cctp_mint'),
          now: now(),
        });
      } catch {
        return recoveryOperationResult('held', 'cctp-mint-projection-retryable');
      }
      if (replayState === 'submitting') {
        return recoveryOperationResult('held', 'cctp-mint-submit-in-flight');
      }
      if (replayState === 'submitted') {
        return recoveryOperationResult('done', 'cctp-mint-already-submitted', `cctp:${found.execId}:submitted`);
      }
      if (replayState === 'confirmed') {
        return recoveryOperationResult('done', 'cctp-mint-already-confirmed', `cctp:${found.execId}:minted`);
      }
      return recoveryOperationResult('blocked', 'cctp-mint-outcome-requires-owner');
    }
    return withCctpLease(context, async (execId, claimed) => {
      if (claimed.state !== 'attested') {
        releaseCctpLease(cctpRelays, execId, claimed, now());
        return recoveryOperationResult('blocked', 'cctp-mint-attestation-not-fenced');
      }
      try {
        validateMintSendEvidence(context, claimed);
      } catch (error) {
        let blocked = null;
        try {
          blocked = cctpRelays.finishBlocked?.({
            execId,
            leaseToken: claimed.leaseToken,
            reasonCode: 'message_mismatch',
            now: now(),
          });
        } catch {
          releaseCctpLease(cctpRelays, execId, claimed, now());
          return recoveryOperationResult('held', 'cctp-mint-blocked-checkpoint-retryable');
        }
        if (blocked) {
          try {
            cctpMintCheckpoint({
              baseEvidenceOutbox,
              identity: context.identity,
              state: 'blocked',
              relay: blocked,
              now: now(),
            });
          } catch {
            return recoveryOperationResult('held', 'cctp-mint-projection-retryable');
          }
        }
        return recoveryOperationResult('blocked', 'cctp-mint-evidence-mismatch');
      }
      const fenced = cctpRelays.markMintSubmitting({
        execId,
        leaseToken: claimed.leaseToken,
        now: now(),
      });
      try {
        await context.renewAuthority?.();
      } catch {
        let uncertain = null;
        try {
          uncertain = cctpRelays.finishUncertain({
            execId,
            leaseToken: claimed.leaseToken,
            reasonCode: 'submission_unknown',
            now: now(),
          });
        } catch {
          return recoveryOperationResult('held', 'cctp-mint-uncertain-checkpoint-retryable');
        }
        if (uncertain) {
          try {
            cctpMintCheckpoint({
              baseEvidenceOutbox,
              identity: context.identity,
              state: 'unknown',
              relay: uncertain,
              now: now(),
            });
          } catch {
            return recoveryOperationResult('held', 'cctp-mint-projection-retryable');
          }
        }
        return recoveryOperationResult('uncertain', 'cctp-mint-pre-send-fence-lost');
      }
      let mintTxHash;
      try {
        mintTxHash = await submitMintBase({
          walletClient: config.base?.walletClient,
          messageTransmitterAddress: config.base?.messageTransmitterAddress,
          message: fenced.messageHex,
          attestation: fenced.attestationHex,
        });
      } catch {
        let uncertain;
        try {
          uncertain = cctpRelays.finishUncertain({
            execId,
            leaseToken: claimed.leaseToken,
            reasonCode: 'submission_unknown',
            now: now(),
          });
        } catch {
          return recoveryOperationResult('held', 'cctp-mint-uncertain-checkpoint-retryable');
        }
        if (uncertain) {
          try {
            cctpMintCheckpoint({
              baseEvidenceOutbox,
              identity: context.identity,
              state: 'unknown',
              relay: uncertain,
              now: now(),
            });
          } catch {
            return recoveryOperationResult('held', 'cctp-mint-projection-retryable');
          }
        }
        return recoveryOperationResult('uncertain', 'cctp-mint-submission-unknown');
      }
      let submitted;
      try {
        submitted = cctpRelays.markMintSubmitted({
          execId,
          leaseToken: claimed.leaseToken,
          mintTxHash,
          now: now(),
        });
      } catch {
        let uncertain;
        try {
          uncertain = cctpRelays.finishUncertain({
            execId,
            leaseToken: claimed.leaseToken,
            mintTxHash,
            reasonCode: 'submitted_checkpoint_failed',
            now: now(),
          });
        } catch {
          return recoveryOperationResult('held', 'cctp-mint-uncertain-checkpoint-retryable');
        }
        if (uncertain) {
          try {
            cctpMintCheckpoint({
              baseEvidenceOutbox,
              identity: context.identity,
              state: 'unknown',
              relay: uncertain,
              now: now(),
            });
          } catch {
            return recoveryOperationResult('held', 'cctp-mint-projection-retryable');
          }
        }
        return recoveryOperationResult('uncertain', 'cctp-mint-checkpoint-unknown');
      }
      cctpMintCheckpoint({
        baseEvidenceOutbox,
        identity: context.identity,
        state: 'submitted',
        relay: submitted,
        now: now(),
      });
      releaseCctpLease(cctpRelays, execId, submitted, now());
      return recoveryOperationResult('done', 'cctp-mint-submitted', `cctp:${execId}:submitted`);
    });
  }

  async function pollMintOperation(context) {
    if (typeof watcher?.pollMint === 'function') return watcher.pollMint(context);
    const found = recoveryRelayForWork({
      work: { ...context.work, bundle: context.bundle },
      cctpRelays,
      farmIntents,
    });
    if (!found) return recoveryOperationResult('blocked', 'cctp-recovery-work-missing');
    let relay = found.relay;
    if (
      relay.state === 'mint_submitting' &&
      relay.leaseToken !== null &&
      Number.isSafeInteger(relay.leaseExpiresAt) &&
      relay.leaseExpiresAt <= now()
    ) {
      relay = cctpRelays.reconcileOne?.({ execId: found.execId, now: now() }) ?? relay;
    }
    const replayState = {
      mint_submitting: 'submitting',
      minted: 'confirmed',
      uncertain: 'unknown',
      blocked: 'blocked',
    }[relay.state];
    if (replayState) {
      try {
        cctpMintCheckpoint({
          baseEvidenceOutbox,
          identity: context.identity,
          state: replayState,
          relay,
          previousState: recoveryPhaseState(context.bundle, 'cctp_mint'),
          now: now(),
        });
      } catch {
        return recoveryOperationResult('held', 'cctp-mint-projection-retryable');
      }
      if (replayState === 'submitting') {
        return recoveryOperationResult('held', 'cctp-mint-submit-in-flight');
      }
      if (replayState === 'confirmed') {
        return recoveryOperationResult('done', 'cctp-mint-already-confirmed', `cctp:${found.execId}:minted`);
      }
      return recoveryOperationResult(
        replayState === 'unknown' ? 'uncertain' : 'blocked',
        replayState === 'unknown' ? 'cctp-mint-submit-fence-expired' : 'cctp-mint-outcome-requires-owner',
      );
    }
    if (relay.state !== 'mint_submitted') {
      return recoveryOperationResult('blocked', 'cctp-mint-reconcile-state-mismatch');
    }
    return withCctpLease(context, async (execId, claimed) => {
      if (claimed.state !== 'mint_submitted' || !claimed.mintTxHash) {
        releaseCctpLease(cctpRelays, execId, claimed, now());
        return recoveryOperationResult('blocked', 'cctp-mint-reconcile-hash-missing');
      }
      try {
        await confirmMintBase({
          publicClient: config.base?.publicClient,
          hash: claimed.mintTxHash,
        });
        const finished = cctpRelays.finishMinted({
          execId,
          leaseToken: claimed.leaseToken,
          mintTxHash: claimed.mintTxHash,
          now: now(),
        });
        cctpMintCheckpoint({
          baseEvidenceOutbox,
          identity: context.identity,
          state: 'confirmed',
          relay: finished,
          previousState: recoveryPhaseState(context.bundle, 'cctp_mint'),
          now: now(),
        });
        return recoveryOperationResult('done', 'cctp-mint-confirmed', `cctp:${execId}:minted`);
      } catch (error) {
        if (error?.code === 'CCTP_MINT_REVERTED') {
          let blocked;
          try {
            blocked = cctpRelays.finishBlocked({
              execId,
              leaseToken: claimed.leaseToken,
              reasonCode: 'destination_reverted',
              now: now(),
            });
          } catch {
            return recoveryOperationResult('held', 'cctp-mint-blocked-checkpoint-retryable');
          }
          if (blocked) {
            try {
              cctpMintCheckpoint({
                baseEvidenceOutbox,
                identity: context.identity,
                state: 'blocked',
                relay: blocked,
                now: now(),
              });
            } catch {
              return recoveryOperationResult('held', 'cctp-mint-projection-retryable');
            }
          }
          return recoveryOperationResult('blocked', 'cctp-mint-reverted');
        }
        releaseCctpLease(cctpRelays, execId, claimed, now());
        return recoveryOperationResult('held', 'cctp-mint-confirmation-pending');
      }
    });
  }

  async function baseAllocation(bundle, identity) {
    return {
      identity,
      caller: bundle.intent.kernelAddress,
      pool: bundle.intent.poolAddress,
      amount: BigInt(bundle.intent.units),
      minShares: BigInt(bundle.intent.minShares),
      allocationId: identity.allocationId,
      reportAmount: {
        token: bundle.intent.token,
        units: bundle.intent.units,
        decimals: bundle.intent.decimals,
      },
    };
  }

  async function projectBaseDepositOwnerAction(context) {
    if (typeof baseEvidenceOutbox?.enqueue !== 'function') {
      return recoveryOperationResult('held', 'base-deposit-owner-action-projection-retryable');
    }
    const previous = recoveryPhaseEvidence(context.bundle, 'base_deposit') ?? {};
    const userOpHash = /^0x[0-9a-f]{64}$/.test(previous.userOpHash || '') ? previous.userOpHash : null;
    const transactionHash = /^0x[0-9a-f]{64}$/.test(previous.transactionHash || '') ? previous.transactionHash : null;
    // A fresh mandate revoke can happen after CCTP mint confirmation but before Task 10's
    // submitting fence. The mint was directed to the immutable Kernel, so the public selector
    // must advance to owner-action without fabricating a deposit UserOperation/transaction hash.
    // If a prior Base attempt exists, retain its exact public hashes and use failed; otherwise
    // use the closed blocked/mandate_inactive shape that proves Kernel custody without hashes.
    const mintEvidence = recoveryPhaseEvidence(context.bundle, 'cctp_mint');
    const mintConfirmed =
      recoveryPhaseState(context.bundle, 'cctp_mint') === 'confirmed' &&
      /^0x[0-9a-f]{64}$/.test(mintEvidence?.mintTxHash || '');
    if (!mintConfirmed) {
      return recoveryOperationResult('held', 'base-deposit-owner-action-custody-unproven');
    }
    const status = userOpHash && transactionHash ? 'failed' : 'blocked';
    const reasonCode = status === 'failed' ? 'base-deposit-failed-kernel-custody' : 'mandate_inactive';
    try {
      baseEvidenceOutbox.enqueue({
        identity: context.identity,
        phase: 'base_deposit',
        status,
        evidence: {
          chainId: String(config.base.chain.id),
          yieldRouterAddress: canonicalAddress(config.base.yieldRouterAddress, 'YieldRouter address'),
          caller: canonicalAddress(context.bundle.intent.kernelAddress, 'Kernel caller'),
          poolAddress: canonicalAddress(context.bundle.intent.poolAddress, 'pool address'),
          assets: String(context.bundle.intent.units),
          minShares: String(context.bundle.intent.minShares),
          ...(userOpHash ? { userOpHash } : {}),
          ...(transactionHash ? { transactionHash } : {}),
          reasonCode,
          custodyLocation: 'base-kernel',
          kernelCustodyConfirmed: true,
          custody: { location: 'base-kernel', confirmed: true },
          ...(previous.reconcileHandle ? { reconcileHandle: previous.reconcileHandle } : {}),
        },
        observedAt: now(),
      });
      return recoveryOperationResult('owner_action_required', 'base-deposit-failed-kernel-custody', transactionHash);
    } catch {
      return recoveryOperationResult('held', 'base-deposit-owner-action-projection-retryable');
    }
  }

  async function submitBaseDepositOperation(context) {
    if (typeof watcher?.submitBaseDeposit === 'function') return watcher.submitBaseDeposit(context);
    if (typeof buildMandateActivator !== 'function' || typeof mandatesV3?.get !== 'function') {
      return recoveryOperationResult('blocked', 'base-deposit-authority-unavailable');
    }
    const authority = await mandatesV3.get({
      mandateId: context.work.mandateId,
      stellarOwner: context.bundle.owner,
      kernelAddress: context.bundle.intent.kernelAddress,
    });
    if (
      !authority ||
      authority.status !== 'active' ||
      typeof authority.sessionPrivateKey !== 'string' ||
      typeof authority.serializedApproval !== 'string'
    ) {
      const projected = await projectBaseDepositOwnerAction({
        ...context,
        reasonCode: 'mandate_inactive',
      });
      return projected?.state === 'held'
        ? projected
        : recoveryOperationResult('owner_action_required', 'mandate_inactive');
    }
    const orchestrator = buildMandateActivator(authority.sessionPrivateKey);
    if (typeof orchestrator?.dispatchDeposits !== 'function') {
      return recoveryOperationResult('blocked', 'base-deposit-submit-seam-unavailable');
    }
    const allocation = await baseAllocation(context.bundle, context.identity);
    let authoritySnapshot = {
      mandateId: authority.mandateId,
      stellarOwner: authority.stellarOwner,
      kernelAddress: authority.kernelAddress,
      status: authority.status,
      bindingId: authority.bindingId,
      bindingHash: authority.bindingHash,
      capabilityHash: authority.capabilityHash,
      relayerOrigin: authority.relayerOrigin ?? null,
      validUntilSeconds: authority.validUntilSeconds,
      updatedAt: authority.updatedAt,
    };
    const readFreshDepositAuthority = async () => {
      try {
        const identity = {
          mandateId: context.work.mandateId,
          stellarOwner: context.bundle.owner,
          kernelAddress: context.bundle.intent.kernelAddress,
        };
        const fresh = await mandatesV3.get(identity);
        const status = await mandatesV3.status(identity);
        if (
          !fresh ||
          fresh.status !== 'active' ||
          status?.status !== 'active' ||
          typeof fresh.sessionPrivateKey !== 'string' ||
          typeof fresh.serializedApproval !== 'string'
        ) {
          return { authorized: false };
        }
        const intent = farmIntents?.getByJob?.({
          mandateId: context.work.mandateId,
          jobId: context.work.farmJobId ?? context.identity.childId,
        });
        if (
          !intent ||
          intent.intentDigest !== context.work.farmIntentDigest ||
          !sameRecoveryFarmIntentFacts({
            intent,
            bundle: context.bundle,
            authority: fresh,
            identity: context.identity,
            mandateId: context.work.mandateId,
          })
        ) {
          return { authorized: false };
        }
        authoritySnapshot = {
          mandateId: fresh.mandateId,
          stellarOwner: fresh.stellarOwner,
          kernelAddress: fresh.kernelAddress,
          status: fresh.status,
          bindingId: fresh.bindingId,
          bindingHash: fresh.bindingHash,
          capabilityHash: fresh.capabilityHash,
          relayerOrigin: fresh.relayerOrigin ?? null,
          validUntilSeconds: fresh.validUntilSeconds,
          updatedAt: fresh.updatedAt,
        };
        return { authorized: true, authoritySnapshot };
      } catch {
        return { authorized: false };
      }
    };
    const onCheckpoint = (checkpoint, ownership) => {
      if (ownership?.ownerToken) {
        return baseEvidenceOutbox?.enqueueOwned?.(checkpoint, ownership);
      }
      return baseEvidenceOutbox?.enqueue?.(checkpoint);
    };
    const claimSubmission =
      typeof farmIntents?.claimAuthorizedSubmission === 'function'
        ? (checkpoint, claimContext = null) =>
            farmIntents.claimAuthorizedSubmission({
              checkpoint,
              authoritySnapshot: claimContext?.authoritySnapshot ?? authoritySnapshot,
              nowSeconds: Math.floor(now() / 1_000),
            })
        : typeof baseEvidenceOutbox?.claimSubmission === 'function'
          ? (checkpoint) => baseEvidenceOutbox.claimSubmission(checkpoint)
          : null;
    if (!claimSubmission) return recoveryOperationResult('blocked', 'base-deposit-submit-seam-unavailable');
    let submissionClaim = null;
    const onBeforeClaimSubmitting = async () => readFreshDepositAuthority();
    const onClaimSubmitting = async (checkpoint, claimContext) => {
      const claim = claimSubmission(checkpoint, claimContext);
      if (claim?.claimed === true && typeof claim.ownerToken === 'string') submissionClaim = { claim, checkpoint };
      return claim;
    };
    const onBeforeSend = async () => {
      try {
        const fresh = await readFreshDepositAuthority();
        if (fresh?.authorized !== true) throw new Error('deposit authority changed before send');
        await context.renewAuthority?.();
        return { allowed: true };
      } catch (reason) {
        // The submitting checkpoint is durable. Transition it to unknown with the owner token
        // so no orphaned Task 10 owner can keep a future send alive after the dual lease dies.
        let checkpointed = false;
        if (submissionClaim?.claim?.ownerToken) {
          try {
            onCheckpoint(
              {
                ...submissionClaim.checkpoint,
                status: 'unknown',
                evidence: {
                  ...submissionClaim.checkpoint.evidence,
                  reasonCode: 'pre-submit-lease-lost',
                },
                observedAt: now(),
              },
              { ownerToken: submissionClaim.claim.ownerToken },
            );
            checkpointed = true;
          } catch {
            /* the orchestrator will retain a held outcome */
          }
        }
        return { allowed: false, checkpointed, reason };
      }
    };
    const [result] = await orchestrator.dispatchDeposits(authority.serializedApproval, [allocation], {
      onCheckpoint,
      onBeforeClaimSubmitting,
      onClaimSubmitting,
      onBeforeSend,
    });
    if (result?.status === 'fulfilled') {
      return recoveryOperationResult('done', 'base-deposit-confirmed', result.transactionHash ?? result.txHash ?? null);
    }
    if (result?.status === 'owner_action_required') {
      return recoveryOperationResult(
        'owner_action_required',
        'base-deposit-failed-kernel-custody',
        result.transactionHash ?? result.txHash ?? null,
      );
    }
    if (result?.status === 'uncertain') {
      return recoveryOperationResult('uncertain', result.reasonCode ?? 'base-deposit-unknown');
    }
    return recoveryOperationResult('blocked', result?.reasonCode ?? 'base-deposit-not-confirmed');
  }

  async function pollBaseDepositOperation(context) {
    if (typeof watcher?.pollBaseDeposit === 'function') return watcher.pollBaseDeposit(context);
    if (typeof buildMandateActivator !== 'function') {
      return recoveryOperationResult('blocked', 'base-deposit-reconcile-seam-unavailable');
    }
    const evidence = recoveryPhaseEvidence(context.bundle, 'base_deposit');
    const handle = evidence?.reconcileHandle;
    if (!handle) return recoveryOperationResult('blocked', 'base-deposit-reconcile-handle-missing');
    const orchestrator = buildMandateActivator(undefined);
    if (typeof orchestrator?.reconcileBaseDeposit !== 'function') {
      return recoveryOperationResult('blocked', 'base-deposit-reconcile-seam-unavailable');
    }
    const allocation = await baseAllocation(context.bundle, context.identity);
    let result;
    try {
      result = await orchestrator.reconcileBaseDeposit({
        allocation,
        reconcileHandle: handle,
        userOpHash: evidence.userOpHash ?? null,
        onCheckpoint: (checkpoint) => baseEvidenceOutbox?.enqueue?.(checkpoint),
      });
    } catch (error) {
      return recoveryOperationResult('held', error?.reasonCode ?? 'base-deposit-reconcile-retryable');
    }
    if (result?.status === 'fulfilled') {
      return recoveryOperationResult('done', 'base-deposit-confirmed', result.transactionHash ?? result.txHash ?? null);
    }
    if (result?.status === 'owner_action_required') {
      return recoveryOperationResult(
        'owner_action_required',
        'base-deposit-failed-kernel-custody',
        result.transactionHash ?? result.txHash ?? null,
      );
    }
    return recoveryOperationResult('held', result?.reasonCode ?? 'base-deposit-reconcile-pending');
  }

  return {
    pollAttestation: override.pollAttestation ?? pollAttestationOperation,
    submitMint: baseExecutionAvailable ? (override.submitMint ?? submitMintOperation) : baseExecutionUnavailable,
    pollMint: override.pollMint ?? pollMintOperation,
    submitBaseDeposit: baseExecutionAvailable
      ? (override.submitBaseDeposit ?? submitBaseDepositOperation)
      : baseExecutionUnavailable,
    projectBaseDepositOwnerAction,
    pollBaseDeposit: override.pollBaseDeposit ?? pollBaseDepositOperation,
  };
}

/**
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 * @returns {{ handler: Function, listen: (port: number) => Promise<import('node:http').Server> }}
 */
export function createRelayerServer(
  config,
  {
    openSqlite = createSqliteStores,
    createWatcherFn = createWatcher,
    createRouter = createRelayerRouter,
    createReporter = createAgentIndexReporter,
    createHttpServer = createServer,
    createUnwindBundlerClient = ({ chain, rpcUrl }) =>
      createBundlerClient({
        chain,
        transport: http(rpcUrl),
      }),
    readUnwindEvidenceFn = readUnwindEvidence,
    startUnwindRecoveryWorkerFn = startUnwindRecoveryWorker,
    startBaseRecoveryWorkerFn = startBaseRecoveryWorker,
    startBaseEvidenceWorkerFn = startBaseEvidenceOutboxWorker,
    poolTargetCatalog = BASE_SEPOLIA_POOL_TARGETS,
    recoveryLimit = 100,
    recoveryConcurrency = 4,
    unwindRecoveryIntervalMs = 5_000,
    baseRecoveryIntervalMs = 5_000,
    baseRecoveryOperations = {},
    baseRecoveryMandateGate = null,
  } = {},
) {
  if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit < 1 || recoveryLimit > 1_000) {
    throw new Error('recoveryLimit must be between 1 and 1000');
  }
  if (!Number.isSafeInteger(recoveryConcurrency) || recoveryConcurrency < 1 || recoveryConcurrency > 32) {
    throw new Error('recoveryConcurrency must be between 1 and 32');
  }
  if (
    !Number.isSafeInteger(baseRecoveryIntervalMs) ||
    baseRecoveryIntervalMs < 1_000 ||
    baseRecoveryIntervalMs > 300_000
  ) {
    throw new Error('baseRecoveryIntervalMs must be between 1000 and 300000');
  }
  const privateBaseAvailability = config?.base?.baseCrossChainAvailable;
  const publicBaseAvailability = config?.publicRuntime?.baseCrossChainAvailable;
  if (typeof privateBaseAvailability !== 'boolean' || typeof publicBaseAvailability !== 'boolean') {
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
  if (config.dbPath && (typeof sessionKeyCipher?.seal !== 'function' || typeof sessionKeyCipher?.open !== 'function')) {
    throw new Error('session-key encryption cipher is required before relayer startup');
  }
  const runtimeConfig = runtimeServerConfig(config);
  const logger = createSafeLogger({
    mode: config.mode,
    debug: config.runtime.debugErrors,
  });
  // When RELAYER_DB_PATH is set, sqlite backs the idempotency store + jobs + mandates so a restart
  // loses nothing (session keys still die at their 1h TTL either way). Build BEFORE createWatcher so
  // the watcher gets the sqlite-backed relay-work store rather than the file store.
  // Task 8: the watcher's store is the checkpointed relay-work authority (cctp_relay_work via
  // `cctpRelays`), never the generic relay_records KV.
  const sqlite = config.dbPath ? openSqlite(config.dbPath, { sessionKeyCipher }) : null;
  if (sqlite) config = { ...config, store: sqlite.cctpRelays };
  try {
  let unwindPublicClient = null;
  let unwindBundlerClient = null;
  let unwindEvidenceFacts = null;
  if (baseCrossChainAvailable) {
    const durableAuthorityAvailable = Boolean(sqlite?.unwindJobs && sqlite?.cctpRelays);
    const receiptReadersAvailable =
      typeof config.base?.publicClient?.getChainId === 'function' &&
      typeof config.base?.publicClient?.getTransactionReceipt === 'function' &&
      typeof config.base?.bundlerRpcUrl === 'string' &&
      Boolean(config.base.bundlerRpcUrl);
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
      if (
        typeof unwindBundlerClient?.getUserOperation !== 'function' ||
        typeof unwindBundlerClient?.getUserOperationReceipt !== 'function'
      ) {
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
  const baseRecoveryWorks = sqlite?.baseRecoveryWorks ?? null;
  const localRecoveryGuard = async (bundle, work) => {
    if (typeof sqlite?.farmIntents?.getByJob !== 'function') return { valid: true };
    try {
      const intent = sqlite.farmIntents.getByJob({
        mandateId: work?.mandateId,
        jobId: work?.farmJobId ?? work?.identity?.childId,
      });
      const authority = mandatesV3?.authority?.(work?.mandateId);
      const valid =
        Boolean(intent) &&
        intent.intentDigest === work?.farmIntentDigest &&
        sameRecoveryFarmIntentFacts({
          intent,
          bundle,
          authority,
          identity: work?.identity,
          mandateId: work?.mandateId,
        });
      return { valid };
    } catch {
      return { valid: false };
    }
  };
  const resolvedBaseRecoveryOperations = baseRecoveryWorks
    ? createConcreteBaseRecoveryOperations({
        config,
        watcher,
        cctpRelays: sqlite?.cctpRelays ?? null,
        farmIntents: sqlite?.farmIntents ?? null,
        baseEvidenceOutbox: sqlite?.baseEvidenceOutbox ?? null,
        mandatesV3,
        buildMandateActivator,
        override: baseRecoveryOperations,
      })
    : baseRecoveryOperations;
  const baseRecoveryExecutor =
    baseRecoveryWorks && agentIndexReporter?.readBaseRecoveryClaim && agentIndexReporter?.renewBaseRecoveryClaim
      ? createBaseRecoveryExecutor({
          workStore: baseRecoveryWorks,
          reporter: agentIndexReporter,
          operations: resolvedBaseRecoveryOperations,
          localRecoveryGuard,
          freshActiveMandateGate:
            baseRecoveryMandateGate ??
            (async (bundle, work) => {
              try {
                const authority = mandatesV3?.authority(work.mandateId);
                if (!authority || authority.status !== 'active') return { active: false };
                if (
                  authority.bindingId !== bundle?.identity?.bindingId ||
                  authority.stellarOwner !== bundle?.owner ||
                  String(authority.kernelAddress || '').toLowerCase() !==
                    String(bundle?.intent?.kernelAddress || '').toLowerCase() ||
                  authority.bindingHash !== bundle?.intent?.bindingHash
                ) {
                  return { active: false };
                }
                const record = await mandatesV3.get({
                  mandateId: work.mandateId,
                  stellarOwner: authority.stellarOwner,
                  kernelAddress: authority.kernelAddress,
                });
                const current = await mandatesV3.status({
                  mandateId: work.mandateId,
                  stellarOwner: authority.stellarOwner,
                  kernelAddress: authority.kernelAddress,
                });
                return {
                  active: Boolean(record && current?.status === 'active'),
                };
              } catch {
                return { active: false };
              }
            }),
          now: () => Date.now(),
        })
      : null;
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
    baseRecoveryWorks,
    baseRecoveryOperations: resolvedBaseRecoveryOperations,
    baseRecoveryExecutor,
    cctpRelays: sqlite?.cctpRelays ?? null,
    relayForwardMint: (relayIntent) => watcher.relayMint(relayIntent),
    unwindJobs: !baseCrossChainAvailable || unwindEvidenceFacts ? (sqlite?.unwindJobs ?? null) : null,
    readUnwindEvidence: readUnwindEvidenceFn,
    relayReverseMint: (relayIntent) => watcher.relayMint(relayIntent),
    resumeExistingReverse: (execId) => watcher.resumeExisting(execId),
    unwindPublicClient,
    unwindBundlerClient,
    unwindEvidenceFacts,
    recoveryLimit,
    recoveryConcurrency,
    forwardFarmDeployment:
      baseCrossChainAvailable &&
      config.stellar?.tokenMessengerMinter &&
      config.stellar?.usdcSac &&
      config.base?.tokenMessengerV2Address &&
      config.domains?.stellar
        ? {
            networkId: 'stellar-testnet',
            sourceDomain: config.domains.stellar,
            destinationDomain: config.domains.base,
            tokenMessengerMinter: config.stellar.tokenMessengerMinter,
            baseTokenMessenger: config.base.tokenMessengerV2Address,
            stellarUsdcSac: config.stellar.usdcSac,
            poolTargets,
          }
        : null,
    publicRuntime: runtimeConfig.publicRuntime,
    logger,
  });
  const handler = withProxyKeyAuth(router, {
    current: runtimeConfig.proxyKey,
    previous: runtimeConfig.proxyKeyPrevious,
  });

  async function listen(port) {
    const reconcileCctpRelays = ({ limit = recoveryLimit } = {}) =>
      sqlite && baseCrossChainAvailable
        ? watcher.sweepStuck({ limit })
        : Promise.resolve({
            redriven: [],
            held: [],
            blocked: [],
            uncertain: [],
          });
    const resumeUnwindJobs = ({ limit = recoveryLimit } = {}) => router.resumeUnwindJobs({ limit });
    const started = await startVerifiedRelayer({
      verifyReadiness: production
        ? () =>
            verifyRelayerReadiness({
              sqlite,
              reporter: agentIndexReporter,
              baseCrossChainAvailable,
            })
        : async () => ({
            writable: Boolean(sqlite),
            reporterSchema: runtimeConfig.reporterSchema,
          }),
      resumeMandateActivations: () => router.resumeMandateActivations(),
      reconcileCctpRelays,
      resumeUnwindJobs,
      resumeFarmJobs: () => router.resumeFarmJobs(),
      resumeBaseRecovery: () =>
        typeof router.resumeBaseRecoveryJobs === 'function' ? router.resumeBaseRecoveryJobs() : undefined,
      startUnwindRecoveryWorker: sqlite
        ? () =>
            startUnwindRecoveryWorkerFn({
              reconcileCctpRelays,
              resumeUnwindJobs,
              recoveryLimit,
              intervalMs: unwindRecoveryIntervalMs,
            })
        : null,
      startBaseRecoveryWorker: sqlite?.baseRecoveryWorks && baseCrossChainAvailable
        ? () =>
            startBaseRecoveryWorkerFn({
              resumeBaseRecovery: (options) => router.resumeBaseRecoveryJobs(options),
              recoveryLimit,
              intervalMs: baseRecoveryIntervalMs,
            })
        : null,
      startBaseEvidenceWorker: () =>
        sqlite?.baseEvidenceOutbox
          ? startBaseEvidenceWorkerFn({
              outbox: sqlite.baseEvidenceOutbox,
              reporter: agentIndexReporter,
              onConflict: (leased) => {
                const authority = sqlite.farmIntents.evidenceConflictAuthority({
                  identity: leased.identity,
                });
                if (authority === 'v2') {
                  return sqlite.farmIntents.blockEvidenceConflict(
                    { identity: leased.identity },
                    { transaction: false },
                  );
                }
                if (authority === 'legacy') {
                  return sqlite.farmExecutions.blockEvidenceConflict(
                    { identity: leased.identity },
                    { transaction: false },
                  );
                }
                throw new Error('Base evidence conflict has no owning authority');
              },
            })
          : null,
      startAssociationWorker: () =>
        associationOutbox
          ? startAssociationOutboxWorker({
              outbox: associationOutbox,
              reporter: agentIndexReporter,
            })
          : null,
      openListener: () => {
        const server = createHttpServer(handler);
        if (typeof server.once !== 'function') {
          server.listen(port);
          return server;
        }
        return new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off?.('listening', onListening);
            try {
              server.close();
            } catch {}
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
    started.server.on('close', () => {
      started.stopWorkers();
      void router.stopMandateActivationQueue?.({ cancelPending: true });
    });
    return started.server;
  }

  const preflightDependencies = production && sqlite
    ? {
        localProbe: async () => {
          const local = await sqlite.probe();
          return {
            ...local,
            agentIndexSchema: true,
            evidenceStore: local.writable === true,
            leaseStore: local.writable === true,
          };
        },
        reporterProbe: () => agentIndexReporter.probe({ baseCrossChainAvailable }),
      }
    : undefined;
  let resourcesClosed = false;
  const close = () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    try { sqlite?.db?.close?.(); } catch {}
  };

  return { handler, listen, preflightDependencies, close };
  } catch (error) {
    try { sqlite?.db?.close?.(); } catch {}
    throw error;
  }
}
