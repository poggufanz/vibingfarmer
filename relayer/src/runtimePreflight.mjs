import { createSafeLogger } from './safeLogger.mjs';

const PROXY_KEY_RE = /^[0-9a-f]{64}$/;

export class RuntimePreflightError extends Error {
  constructor(reasonCode) {
    super(`runtime preflight failed: ${String(reasonCode).replaceAll('_', ' ').toLowerCase()}`);
    this.name = 'RuntimePreflightError';
    this.code = 'RUNTIME_PREFLIGHT_FAILED';
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new RuntimePreflightError(reasonCode);
}

function productionMode(mode) {
  return mode === 'production' || mode === 'staging';
}

function proxyKeys(config) {
  const runtime = config?.runtime ?? {};
  const current = runtime.proxyKey || '';
  const previous = runtime.proxyKeyPrevious || '';
  if (current && !PROXY_KEY_RE.test(current)) fail('PROXY_KEY_INVALID');
  if (previous && !PROXY_KEY_RE.test(previous)) fail('PROXY_KEY_PREVIOUS_INVALID');
  if (current && previous && current === previous) fail('PROXY_KEY_OVERLAP_INVALID');
  if (productionMode(config?.mode) && !current) fail('PROXY_KEY_MISSING');
  if (!current && !productionMode(config?.mode) && runtime.allowOpenProxy !== true
    && config?.allowOpenProxy !== true) {
    fail('PROXY_KEY_MISSING');
  }
  return { current, previous };
}

function checkStaticConfig(config, env) {
  const production = productionMode(config?.mode);
  if (!config || typeof config !== 'object') fail('CONFIG_INVALID');
  if (env?.RELAYER_OFFLINE_KEY_MIGRATION === '1') fail('OFFLINE_MIGRATION_FORBIDDEN');
  if (config?.runtime?.debugErrors && production) fail('DEBUG_MODE_FORBIDDEN');
  proxyKeys(config);
  if (config.dbPath) {
    if (typeof config.sessionKeyCipher?.seal !== 'function'
      || typeof config.sessionKeyCipher?.open !== 'function'
      || config.secrets?.sessionKeyEncryption !== true) {
      fail('ENCRYPTION_KEYRING_INVALID');
    }
  }
  if (config.reporter?.schema !== 1) fail('AGENT_INDEX_SCHEMA_INVALID');
  if (production && (!config.reporter?.url || config.reporter?.hasSecret !== true)) {
    fail('AGENT_INDEX_REPORTER_CONFIG_INVALID');
  }
  const privateBase = config.base?.baseCrossChainAvailable;
  const publicBase = config.publicRuntime?.baseCrossChainAvailable;
  if (typeof privateBase !== 'boolean' || typeof publicBase !== 'boolean' || privateBase !== publicBase) {
    fail('BASE_AVAILABILITY_INVALID');
  }
  const factsBase = config.facts?.base;
  if (privateBase === true) {
    if (config.base?.hardenedDeployment?.generation !== 'hardened-v2'
      || config.base?.hardenedDeployment?.chainId !== 84532
      || factsBase?.hardenedDeployment?.generation !== 'hardened-v2') {
      fail('BASE_DEPLOYMENT_UNAVAILABLE');
    }
  } else if (factsBase?.baseCrossChainAvailable === true) {
    fail('BASE_FACTS_DISAGREE');
  }
  if (factsBase?.hardenedDeployment && factsBase.hardenedDeployment.generation !== 'hardened-v2') {
    fail('DEPLOYMENT_GENERATION_INVALID');
  }
  return { production, baseCrossChainAvailable: privateBase };
}

function checkLocalProbe(local, { requireStores = false } = {}) {
  if (!local || typeof local !== 'object') fail('LOCAL_READINESS_MISSING');
  if (local.writable === false) fail('SQLITE_NOT_WRITABLE');
  if (Array.isArray(local.legacyMandateTables) && local.legacyMandateTables.length > 0) {
    fail('LEGACY_MANDATE_SCHEMA');
  }
  if (local.mandateMigrationCleanupPending === true) fail('MIGRATION_CLEANUP_PENDING');
  if (local.mandateMigrationCleanupPending !== undefined
    && local.mandateMigrationCleanupPending !== false) {
    fail('MIGRATION_CLEANUP_INVALID');
  }
  if (local.agentIndexSchema === false || (requireStores && local.agentIndexSchema !== true)) {
    fail('AGENT_INDEX_SCHEMA_MISSING');
  }
  if (local.evidenceStore === false || local.leaseStore === false
    || (requireStores && (local.evidenceStore !== true || local.leaseStore !== true))) {
    fail('AGENT_INDEX_STORE_MISSING');
  }
  return local;
}

function checkReporterProbe(remote, { requireStores = false } = {}) {
  if (!remote || typeof remote !== 'object') fail('AGENT_INDEX_READINESS_MISSING');
  if (remote.ready !== true || remote.schemaVersion !== 1) fail('AGENT_INDEX_REPORTER_NOT_READY');
  const stores = remote.stores ?? {};
  if (stores.executionReceipts === false || stores.baseChildIntents === false
    || stores.baseRecoveryEvidence === false || stores.leases === false
    || (requireStores && (stores.executionReceipts !== true || stores.leases !== true))) {
    fail('AGENT_INDEX_STORE_MISSING');
  }
  return remote;
}

/**
 * Offline, dependency-injectable startup gate.  Network/readiness probes are only called when
 * explicitly supplied by the composition layer; the pure default checks remain import-safe.
 */
export async function runtimePreflight({
  config,
  dependencies = {},
  env = process.env,
  logger = null,
  staticOnly = false,
} = {}) {
  try {
    const result = checkStaticConfig(config, env);
    if (staticOnly) {
      return { ok: true, baseCrossChainAvailable: result.baseCrossChainAvailable };
    }
    const localProbe = dependencies.localProbe ?? dependencies.probeLocal ?? dependencies.sqlite?.probe;
    const reporterProbe = dependencies.reporterProbe ?? dependencies.probeReporter;
    if (result.production && !localProbe) fail('LOCAL_READINESS_MISSING');
    if (result.production && !reporterProbe) fail('AGENT_INDEX_READINESS_MISSING');
    const local = localProbe
      ? await localProbe()
      : {
          writable: true,
          legacyMandateTables: [],
          mandateMigrationCleanupPending: false,
          agentIndexSchema: config?.agentIndex?.ready !== false,
          evidenceStore: true,
          leaseStore: true,
        };
    checkLocalProbe(local, { requireStores: Boolean(localProbe) });
    const remote = reporterProbe
      ? await reporterProbe()
      : {
          ready: config?.reporter?.schema === 1,
          schemaVersion: config?.reporter?.schema,
          stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
        };
    checkReporterProbe(remote, { requireStores: Boolean(reporterProbe) });
    return {
      ok: true,
      baseCrossChainAvailable: result.baseCrossChainAvailable,
      local,
      reporter: remote,
    };
  } catch (error) {
    const safeError = error instanceof RuntimePreflightError
      ? error
      : new RuntimePreflightError('PREFLIGHT_CHECK_FAILED');
    try { logger?.error?.(safeError.reasonCode, {}); } catch {}
    throw safeError;
  }
}

export const assertRuntimePreflight = runtimePreflight;
