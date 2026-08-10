import { rpc, Keypair, StrKey } from '@stellar/stellar-sdk';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { CCTP_DOMAIN, STELLAR_TESTNET, BASE_SEPOLIA } from './cctp/constants.mjs';
import { createFileStore } from './store.mjs';
import { loadDeploymentFacts } from './deploymentFacts.mjs';
import { createAgentIndexConfig } from './agentIndexConfig.mjs';
import { createSecretEnvelope, parseSecretKeyring } from './secretEnvelope.mjs';

function need(env, key) {
  const value = env[key];
  if (!value || /FILL_ME/.test(value)) throw new Error(`env ${key} missing/unfilled`);
  return value;
}

function optional(env, key) {
  const value = env[key];
  return value && !/FILL_ME/.test(value) ? value : '';
}

const PROXY_KEY_RE = /^[0-9a-f]{64}$/;

function proxyKeyValue(env, key, { production, required = false } = {}) {
  const value = optional(env, key);
  if (!value) {
    if (required) throw new Error(`env ${key} missing/unfilled`);
    return '';
  }
  if (!PROXY_KEY_RE.test(value)) throw new Error(`env ${key} must be 64 lowercase hexadecimal characters`);
  return value;
}

function parseUrl(raw, key, { production, originOnly = false, required = true } = {}) {
  if (!raw) {
    if (required) throw new Error(`env ${key} missing/unfilled`);
    return '';
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`env ${key} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`env ${key} must use HTTP(S)`);
  if (production && url.protocol !== 'https:') throw new Error(`env ${key} must use HTTPS`);
  if (url.username || url.password) throw new Error(`env ${key} must not contain credentials`);
  if (url.search) throw new Error(`env ${key} must not contain a query`);
  if (url.hash) throw new Error(`env ${key} must not contain a fragment`);
  if (originOnly && url.pathname !== '/') throw new Error(`env ${key} must be an origin without a path`);
  return originOnly ? url.origin : url.toString().replace(/\/$/, '');
}

function stellarAccount(value, key) {
  if (!StrKey.isValidEd25519PublicKey(String(value || ''))) {
    throw new Error(`env ${key} must be a Stellar G address`);
  }
  return value;
}

function immutableValue(env, key, canonical, { production, validate = (value) => value, equal = (a, b) => a === b }) {
  const configured = optional(env, key);
  if (!configured) return canonical;
  const value = validate(configured, key);
  if (production && !equal(value, canonical)) throw new Error(`env ${key} disagrees with tracked deployment facts`);
  return value;
}

function nonEnumerable(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false });
}

function activeImmutableAddress(env, key, canonical, baseCrossChainAvailable) {
  if (!baseCrossChainAvailable) return canonical;
  const configured = optional(env, key);
  if (!configured) return canonical;
  let checked;
  try {
    checked = getAddress(configured);
  } catch {
    throw new Error(`env ${key} must be a checksummed EVM address`);
  }
  if (checked !== configured) throw new Error(`env ${key} must be a checksummed EVM address`);
  if (checked !== canonical) throw new Error(`env ${key} disagrees with approved deployment facts`);
  return canonical;
}

export function loadConfig(
  env = process.env,
  { loadDeploymentFactsFn = loadDeploymentFacts } = {},
) {
  const facts = loadDeploymentFactsFn();
  const mode = env.NODE_ENV || 'development';
  const production = mode === 'production' || mode === 'staging';
  const baseCrossChainAvailable = facts.base.baseCrossChainAvailable === true;

  const sorobanRpcUrl = immutableValue(env, 'SOROBAN_RPC_URL', facts.stellar.rpcUrl, {
    production,
    validate: (value, key) => parseUrl(value, key, { production }),
    equal: (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, ''),
  });
  const passphrase = immutableValue(env, 'STELLAR_NETWORK_PASSPHRASE', facts.stellar.passphrase, { production });
  const relayerStellarPublic = immutableValue(env, 'RELAYER_STELLAR_PUBLIC', facts.stellar.relayerPublic, {
    production,
    validate: stellarAccount,
  });
  // Deployment records are the only Base execution authority. Environment values may configure
  // connectivity after an approved record is active, but can never select a router or generation.
  const yieldRouterAddress = activeImmutableAddress(
    env,
    'YIELD_ROUTER_ADDRESS',
    facts.base.yieldRouterAddress,
    baseCrossChainAvailable,
  );
  const baseExitSweeperAddress = activeImmutableAddress(
    env,
    'BASE_EXIT_SWEEPER_ADDRESS',
    facts.base.baseExitSweeperAddress,
    baseCrossChainAvailable,
  );
  const baseRpcUrl = baseCrossChainAvailable
    ? parseUrl(env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org', 'BASE_SEPOLIA_RPC_URL', { production })
    : null;
  const irisUrl = parseUrl(need(env, 'IRIS_URL'), 'IRIS_URL', { production });
  const publicOrigin = parseUrl(optional(env, 'RELAYER_PUBLIC_ORIGIN'), 'RELAYER_PUBLIC_ORIGIN', {
    production,
    originOnly: true,
    required: production,
  });
  const reporterUrl = parseUrl(optional(env, 'AGENT_INDEX_REPORTER_URL'), 'AGENT_INDEX_REPORTER_URL', {
    production,
    required: production,
  });
  const reporterSchemaRaw = production ? need(env, 'AGENT_INDEX_REPORTER_SCHEMA') : optional(env, 'AGENT_INDEX_REPORTER_SCHEMA') || '1';
  if (reporterSchemaRaw !== '1') throw new Error('env AGENT_INDEX_REPORTER_SCHEMA must equal 1');
  const reporterSchema = 1;

  const relayerStellarSecret = need(env, 'RELAYER_STELLAR_SECRET');
  const relayerBasePrivkey = baseCrossChainAvailable
    ? need(env, 'RELAYER_BASE_PRIVKEY') : optional(env, 'RELAYER_BASE_PRIVKEY');
  const zerodevProjectId = baseCrossChainAvailable
    ? need(env, 'ZERODEV_PROJECT_ID') : optional(env, 'ZERODEV_PROJECT_ID');
  const allowOpenProxy = !production && env.RELAYER_ALLOW_OPEN_PROXY === '1';
  const proxyKey = proxyKeyValue(env, 'RELAYER_PROXY_KEY', {
    production,
    required: production || !allowOpenProxy,
  });
  const proxyKeyPrevious = proxyKeyValue(env, 'RELAYER_PROXY_KEY_PREVIOUS');
  if (proxyKey && proxyKeyPrevious && proxyKey === proxyKeyPrevious) {
    throw new Error('env RELAYER_PROXY_KEY_PREVIOUS must differ from RELAYER_PROXY_KEY');
  }
  const reporterSecret = production ? need(env, 'AGENT_INDEX_REPORTER_SECRET') : optional(env, 'AGENT_INDEX_REPORTER_SECRET');
  const storePath = env.RELAYER_STORE_PATH || './.relayer-store.dev.json';
  const dbPath = production ? need(env, 'RELAYER_DB_PATH') : optional(env, 'RELAYER_DB_PATH');
  const sessionKeyringRaw = optional(env, 'RELAYER_SESSION_KEY_ENCRYPTION_KEYS');
  if (dbPath && !sessionKeyringRaw) {
    throw new Error('env RELAYER_SESSION_KEY_ENCRYPTION_KEYS missing/unfilled');
  }
  const sessionKeyCipher = sessionKeyringRaw
    ? createSecretEnvelope(parseSecretKeyring(sessionKeyringRaw))
    : undefined;
  const agentIndex = createAgentIndexConfig({
    endpoint: reporterUrl,
    secret: reporterSecret,
    schemaVersion: reporterSchema,
    dbPath,
    relayerOrigin: publicOrigin,
    production,
  });

  const server = new rpc.Server(sorobanRpcUrl);
  const kp = Keypair.fromSecret(relayerStellarSecret);
  if (kp.publicKey() !== relayerStellarPublic) {
    throw new Error('env RELAYER_STELLAR_SECRET does not match RELAYER_STELLAR_PUBLIC');
  }
  const account = baseCrossChainAvailable
    ? privateKeyToAccount(relayerBasePrivkey.startsWith('0x') ? relayerBasePrivkey : `0x${relayerBasePrivkey}`)
    : null;
  const publicClient = baseCrossChainAvailable
    ? createPublicClient({ chain: baseSepolia, transport: http(baseRpcUrl) }) : undefined;
  const walletClient = baseCrossChainAvailable
    ? createWalletClient({ account, chain: baseSepolia, transport: http(baseRpcUrl) }) : undefined;
  const bundlerRpcUrl = baseCrossChainAvailable
    ? `https://rpc.zerodev.app/api/v3/${zerodevProjectId}/chain/${baseSepolia.id}` : null;

  const secrets = Object.freeze({
    stellarRelayer: Boolean(relayerStellarSecret),
    baseRelayer: Boolean(relayerBasePrivkey),
    zeroDevProject: Boolean(zerodevProjectId),
    proxyAuth: Boolean(proxyKey),
    reporterAuth: Boolean(reporterSecret),
    sessionKeyEncryption: Boolean(sessionKeyCipher),
  });
  const baseRelay = baseCrossChainAvailable && secrets.baseRelayer && secrets.zeroDevProject;
  const readiness = Object.freeze({
    stellarRelay: secrets.stellarRelayer,
    baseRelay,
    proxyAuth: secrets.proxyAuth,
    reporter: Boolean(reporterUrl) && secrets.reporterAuth,
    ready: secrets.stellarRelayer
      && (!production || (agentIndex.ready && secrets.proxyAuth))
      && (!baseCrossChainAvailable || baseRelay),
  });
  const reporter = Object.freeze({ url: reporterUrl, schema: reporterSchema, hasSecret: secrets.reporterAuth });
  const base = {
    chain: baseSepolia,
    rpcUrl: baseRpcUrl,
    bundlerRpcUrl,
    messageTransmitterAddress: BASE_SEPOLIA.messageTransmitterV2,
    tokenMessengerV2Address: BASE_SEPOLIA.tokenMessengerV2,
    usdcAddress: facts.base.usdcAddress,
    yieldRouterAddress,
    baseExitSweeperAddress,
    allowedPools: facts.base.allowedPools,
    mandatePolicy: facts.base.mandatePolicy,
    baseCrossChainAvailable,
    unavailableReason: facts.base.unavailableReason,
    hardenedDeployment: facts.base.hardenedDeployment,
  };
  nonEnumerable(base, 'publicClient', publicClient);
  nonEnumerable(base, 'walletClient', walletClient);
  const publicRuntime = {
    version: 1,
    networkId: facts.stellar.networkId,
    publicOrigin: publicOrigin || null,
    baseCrossChainAvailable,
    unavailableReason: facts.base.unavailableReason,
    reporter,
    secrets,
    readiness,
    digests: facts.digests,
  };
  // The HTTP router receives only publicRuntime from server.mjs. Keep the evidence evaluator's
  // canonical config available through that existing seam without serializing RPC URLs, clients,
  // or any other private runtime value through GET /config.
  nonEnumerable(publicRuntime, 'mandateStatusConfig', Object.freeze({
    publicOrigin: publicOrigin || null,
    digests: facts.digests,
    base,
  }));
  Object.freeze(publicRuntime);
  const stellar = {
    sourcePub: relayerStellarPublic,
    passphrase,
    rpcUrl: sorobanRpcUrl,
    forwarderAddress: STELLAR_TESTNET.cctpForwarder,
    tokenMessengerMinter: STELLAR_TESTNET.tokenMessengerMinter,
    usdcSac: STELLAR_TESTNET.usdcSac,
    routerAddresses: facts.stellar.routerAddresses,
    agentWasmHashes: facts.stellar.agentWasmHashes,
    exitRouterAddress: facts.stellar.exitRouterAddress,
    vaultAddress: facts.stellar.vaultAddress,
    tokenAddress: facts.stellar.tokenAddress,
  };
  nonEnumerable(stellar, 'server', server);
  nonEnumerable(stellar, 'kp', kp);

  const config = {
    mode,
    domains: Object.freeze({ stellar: CCTP_DOMAIN.STELLAR, base: CCTP_DOMAIN.BASE }),
    irisUrl,
    dbPath,
    publicOrigin: publicOrigin || null,
    facts: Object.freeze({ stellar: facts.stellar, base: facts.base }),
    reporter,
    secrets,
    readiness,
    digests: facts.digests,
    publicRuntime,
    base,
    stellar,
  };
  nonEnumerable(config, 'store', createFileStore(storePath));
  nonEnumerable(config, 'agentIndex', agentIndex);
  nonEnumerable(config, 'sessionKeyCipher', sessionKeyCipher);
  nonEnumerable(config, 'runtime', Object.freeze({
    proxyKey,
    proxyKeyPrevious,
    reporterSecret,
    allowOpenProxy,
    debugErrors: env.RELAYER_DEBUG_ERRORS === '1',
  }));
  nonEnumerable(config, 'toJSON', () => publicRuntime);
  return Object.freeze(config);
}
