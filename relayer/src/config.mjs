import { rpc, Keypair, StrKey } from '@stellar/stellar-sdk';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { CCTP_DOMAIN, STELLAR_TESTNET, BASE_SEPOLIA } from './cctp/constants.mjs';
import { createFileStore } from './store.mjs';
import { loadDeploymentFacts } from './deploymentFacts.mjs';

function need(env, key) {
  const value = env[key];
  if (!value || /FILL_ME/.test(value)) throw new Error(`env ${key} missing/unfilled`);
  return value;
}

function optional(env, key) {
  const value = env[key];
  return value && !/FILL_ME/.test(value) ? value : '';
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

function evmAddress(value, key) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(value || ''))) throw new Error(`env ${key} must be an EVM address`);
  return value;
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

export function loadConfig(env = process.env) {
  const facts = loadDeploymentFacts();
  const mode = env.NODE_ENV || 'development';
  const production = mode === 'production' || mode === 'staging';

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
  const yieldRouterAddress = immutableValue(env, 'YIELD_ROUTER_ADDRESS', facts.base.yieldRouterAddress, {
    production,
    validate: evmAddress,
    equal: (a, b) => a.toLowerCase() === b.toLowerCase(),
  });
  const baseRpcUrl = parseUrl(env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org', 'BASE_SEPOLIA_RPC_URL', { production });
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
  const relayerBasePrivkey = need(env, 'RELAYER_BASE_PRIVKEY');
  const zerodevProjectId = need(env, 'ZERODEV_PROJECT_ID');
  const proxyKey = production ? need(env, 'RELAYER_PROXY_KEY') : optional(env, 'RELAYER_PROXY_KEY');
  const reporterSecret = production ? need(env, 'AGENT_INDEX_REPORTER_SECRET') : optional(env, 'AGENT_INDEX_REPORTER_SECRET');
  const storePath = env.RELAYER_STORE_PATH || './.relayer-store.dev.json';
  const dbPath = env.RELAYER_DB_PATH || '';

  const server = new rpc.Server(sorobanRpcUrl);
  const kp = Keypair.fromSecret(relayerStellarSecret);
  if (kp.publicKey() !== relayerStellarPublic) {
    throw new Error('env RELAYER_STELLAR_SECRET does not match RELAYER_STELLAR_PUBLIC');
  }
  const account = privateKeyToAccount(relayerBasePrivkey.startsWith('0x') ? relayerBasePrivkey : `0x${relayerBasePrivkey}`);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(baseRpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(baseRpcUrl) });
  const bundlerRpcUrl = `https://rpc.zerodev.app/api/v3/${zerodevProjectId}/chain/${baseSepolia.id}`;

  const secrets = Object.freeze({
    stellarRelayer: Boolean(relayerStellarSecret),
    baseRelayer: Boolean(relayerBasePrivkey),
    zeroDevProject: Boolean(zerodevProjectId),
    proxyAuth: Boolean(proxyKey),
    reporterAuth: Boolean(reporterSecret),
  });
  const readiness = Object.freeze({
    stellarRelay: secrets.stellarRelayer,
    baseRelay: secrets.baseRelayer && secrets.zeroDevProject,
    proxyAuth: secrets.proxyAuth,
    reporter: Boolean(reporterUrl) && secrets.reporterAuth,
    ready: secrets.stellarRelayer && secrets.baseRelayer && secrets.zeroDevProject && (!production || (Boolean(publicOrigin) && secrets.proxyAuth && Boolean(reporterUrl) && secrets.reporterAuth)),
  });
  const reporter = Object.freeze({ url: reporterUrl, schema: reporterSchema, hasSecret: secrets.reporterAuth });
  const publicRuntime = Object.freeze({
    version: 1,
    networkId: facts.stellar.networkId,
    publicOrigin: publicOrigin || null,
    facts: Object.freeze({ stellar: facts.stellar, base: facts.base }),
    reporter,
    secrets,
    readiness,
    digests: facts.digests,
  });

  const base = {
    chain: baseSepolia,
    rpcUrl: baseRpcUrl,
    bundlerRpcUrl,
    messageTransmitterAddress: BASE_SEPOLIA.messageTransmitterV2,
    tokenMessengerV2Address: BASE_SEPOLIA.tokenMessengerV2,
    usdcAddress: facts.base.usdcAddress,
    yieldRouterAddress,
    allowedPools: facts.base.allowedPools,
    mandatePolicy: facts.base.mandatePolicy,
  };
  nonEnumerable(base, 'publicClient', publicClient);
  nonEnumerable(base, 'walletClient', walletClient);
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
    facts: publicRuntime.facts,
    reporter,
    secrets,
    readiness,
    digests: facts.digests,
    publicRuntime,
    base,
    stellar,
  };
  nonEnumerable(config, 'store', createFileStore(storePath));
  nonEnumerable(config, 'runtime', Object.freeze({ proxyKey, reporterSecret, debugErrors: env.RELAYER_DEBUG_ERRORS === '1' }));
  nonEnumerable(config, 'toJSON', () => publicRuntime);
  return Object.freeze(config);
}
