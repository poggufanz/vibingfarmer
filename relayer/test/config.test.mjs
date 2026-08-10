import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.mjs';
import { loadDeploymentFacts, validateDeploymentFacts } from '../src/deploymentFacts.mjs';
import { createRelayerServer } from '../src/server.mjs';

const STELLAR_PASSPHRASE = 'Test SDF Network ; September 2015';
const STELLAR_RPC = 'https://soroban-testnet.stellar.org';
const STELLAR_RELAYER = 'GBVJ34MT4GDKZJGILI6DRYGD75ZNUBJGGZIDUV7IPFNVVDWGE5GBLV3X';
const YIELD_ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';
const HARDENED_ROUTER = '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD';
const HARDENED_SWEEPER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
const ACTIVE_POOLS = [
  '0x389250872044368759D3db5C09b2706A6628d4e0',
  '0x5E843A639F0555E2A6669601621befC887Bdb479',
  '0xadD3c1A75c7Cef2516b51750959BD829a4AD4761',
];
const ACTIVE_POOL_TARGETS = new Map([
  [ACTIVE_POOLS[0].toLowerCase(), 'aave-v3'],
  [ACTIVE_POOLS[1].toLowerCase(), 'morpho-blue'],
  [ACTIVE_POOLS[2].toLowerCase(), 'moonwell'],
]);
const SESSION_KEYRING = `2026-08:${Buffer.alloc(32, 0x33).toString('base64')}`;

function buildValidEnv(overrides = {}) {
  const kp = Keypair.random();
  return {
    NODE_ENV: 'development',
    SOROBAN_RPC_URL: STELLAR_RPC,
    STELLAR_NETWORK_PASSPHRASE: STELLAR_PASSPHRASE,
    RELAYER_STELLAR_SECRET: kp.secret(),
    RELAYER_STELLAR_PUBLIC:
      overrides.NODE_ENV === 'production' || overrides.NODE_ENV === 'staging'
        ? STELLAR_RELAYER
        : kp.publicKey(),
    BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
    RELAYER_BASE_PRIVKEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ZERODEV_PROJECT_ID: 'proj-123',
    YIELD_ROUTER_ADDRESS: YIELD_ROUTER,
    IRIS_URL: 'https://iris-api-sandbox.circle.com',
    RELAYER_PUBLIC_ORIGIN: 'http://localhost:8788/',
    AGENT_INDEX_REPORTER_URL: 'http://localhost:5173/api/agent-index',
    AGENT_INDEX_REPORTER_SCHEMA: '1',
    AGENT_INDEX_REPORTER_SECRET: 'reporter-secret',
    RELAYER_PROXY_KEY: 'a'.repeat(64),
    RELAYER_DB_PATH: './.relayer-test.db',
    RELAYER_SESSION_KEY_ENCRYPTION_KEYS: SESSION_KEYRING,
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildActiveFacts(relayerPublic) {
  const loaded = loadDeploymentFacts();
  const stellar = clone(loaded.raw.stellar);
  const base = clone(loaded.raw.base);
  stellar.relayer = relayerPublic;
  const approvedHardenedDeployment = {
    generation: 'hardened-v2',
    chainId: 84532,
    adminSafe: {
      address: '0x1234567890AbcdEF1234567890aBcdef12345678',
      proxyImplementation: '0xCafEBAbECAFEbAbEcaFEbabECAfebAbEcAFEBaBe',
      runtimeCodeHash: `0x${'11'.repeat(32)}`,
      threshold: 2,
      owners: ACTIVE_POOLS.slice(0, 2),
    },
    yieldRouter: {
      address: HARDENED_ROUTER,
      deployTxHash: `0x${'21'.repeat(32)}`,
      deployBlockNumber: '21000123',
      deployBlockHash: `0x${'22'.repeat(32)}`,
      rawRuntimeCodeHash: `0x${'23'.repeat(32)}`,
      normalizedRuntimeCodeHash: `0x${'24'.repeat(32)}`,
    },
    baseExitSweeper: {
      address: HARDENED_SWEEPER,
      deployTxHash: `0x${'31'.repeat(32)}`,
      deployBlockNumber: '21000129',
      deployBlockHash: `0x${'32'.repeat(32)}`,
      rawRuntimeCodeHash: `0x${'33'.repeat(32)}`,
      normalizedRuntimeCodeHash: `0x${'34'.repeat(32)}`,
    },
    route: {
      usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarDomain: 27,
      mintRecipient: `0x${'41'.repeat(32)}`,
      destinationCaller: `0x${'42'.repeat(32)}`,
      finalityThreshold: 1000,
    },
    selectors: {
      exitAllAndBurn: '0x4c9d247b',
      absent: ['0x0d390c9e', '0x9abaf267'],
    },
    pools: { enabled: [...ACTIVE_POOLS], known: [...ACTIVE_POOLS] },
    verification: { blockNumber: '21000150', blockHash: `0x${'51'.repeat(32)}` },
  };
  base.hardenedDeployment = clone(approvedHardenedDeployment);
  return validateDeploymentFacts(
    { stellar, base },
    { approvedHardenedDeployment },
  );
}

describe('loadDeploymentFacts', () => {
  it('loads and freezes the tracked Stellar/Base immutable facts', () => {
    const facts = loadDeploymentFacts();
    expect(facts.stellar.passphrase).toBe(STELLAR_PASSPHRASE);
    expect(facts.stellar.rpcUrl).toBe(STELLAR_RPC);
    expect(facts.base.yieldRouterAddress).toBe(YIELD_ROUTER);
    expect(facts.base.mandatePolicy.executionHorizonSeconds).toBe(2700);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.base.mandatePolicy)).toBe(true);
  });

  it('rejects a tracked Base deployment missing any generic mandate policy fact', () => {
    const loaded = loadDeploymentFacts();
    const stellar = clone(loaded.raw.stellar);
    const base = clone(loaded.raw.base);
    delete base.baseMandatePolicy.timestampPolicyAddress;
    expect(() => validateDeploymentFacts({ stellar, base })).toThrow(/timestampPolicyAddress/);
  });

  it('rejects user-specific kernel/session/permission/binding facts in tracked policy JSON', () => {
    const loaded = loadDeploymentFacts();
    const stellar = clone(loaded.raw.stellar);
    const base = clone(loaded.raw.base);
    for (const forbidden of ['kernelAddress', 'sessionKey', 'permission', 'bindingHash']) {
      base.baseMandatePolicy[forbidden] = 'user-specific';
      expect(() => validateDeploymentFacts({ stellar, base }), forbidden).toThrow(/user-specific/);
      delete base.baseMandatePolicy[forbidden];
    }
  });
});

describe('loadConfig', () => {
  it('accepts one previous exact-length lowercase proxy key only for overlap', () => {
    const config = loadConfig(buildValidEnv({ RELAYER_PROXY_KEY_PREVIOUS: 'b'.repeat(64) }));

    expect(config.runtime.proxyKey).toBe('a'.repeat(64));
    expect(config.runtime.proxyKeyPrevious).toBe('b'.repeat(64));
  });

  it.each([
    ['', 'missing current key in production'],
    ['A'.repeat(64), 'uppercase key'],
    ['a'.repeat(63), 'short key'],
    ['g'.repeat(64), 'non-hex key'],
  ])('rejects weak or noncanonical configured proxy key: %s', (value, label) => {
    const env = buildValidEnv({ [label.includes('current') ? 'RELAYER_PROXY_KEY' : 'RELAYER_PROXY_KEY_PREVIOUS']: value });
    if (label.includes('current')) {
      env.NODE_ENV = 'production';
      env.RELAYER_STELLAR_PUBLIC = STELLAR_RELAYER;
      env.RELAYER_PUBLIC_ORIGIN = 'https://relay.example';
      env.AGENT_INDEX_REPORTER_URL = 'https://app.example/api/agent-index';
    }
    expect(() => loadConfig(env)).toThrow(/RELAYER_PROXY_KEY/);
  });

  it('rejects overlapping current and previous proxy keys', () => {
    expect(() => loadConfig(buildValidEnv({ RELAYER_PROXY_KEY_PREVIOUS: 'a'.repeat(64) })))
      .toThrow(/previous|differ|proxy/i);
  });
  it('keeps Stellar/global readiness available without Base secrets or Base clients for a legacy deployment', () => {
    const env = buildValidEnv({
      RELAYER_BASE_PRIVKEY: '',
      ZERODEV_PROJECT_ID: '',
      BASE_DEPLOYMENT_GENERATION: 'hardened-v2',
      YIELD_ROUTER_ADDRESS: '0x00000000000000000000000000000000000000aa',
      BASE_EXIT_SWEEPER_ADDRESS: 'not-an-address',
    });

    const config = loadConfig(env);

    expect(config.base.baseCrossChainAvailable).toBe(false);
    expect(config.base.unavailableReason).toBe('Hardened Base deployment is not active.');
    expect(config.base.yieldRouterAddress).toBe(YIELD_ROUTER);
    expect(config.base.publicClient).toBeUndefined();
    expect(config.base.walletClient).toBeUndefined();
    expect(config.secrets.baseRelayer).toBe(false);
    expect(config.secrets.zeroDevProject).toBe(false);
    expect(config.readiness.stellarRelay).toBe(true);
    expect(config.readiness.ready).toBe(true);
  });

  it('loads an active verified record through the deployment-facts seam without env authority', () => {
    const env = buildValidEnv({
      YIELD_ROUTER_ADDRESS: HARDENED_ROUTER,
      BASE_EXIT_SWEEPER_ADDRESS: HARDENED_SWEEPER,
      RELAYER_DB_PATH: '',
    });
    const facts = buildActiveFacts(env.RELAYER_STELLAR_PUBLIC);
    const config = loadConfig(env, { loadDeploymentFactsFn: () => facts });
    let routerDeps;
    createRelayerServer(config, {
      createRouter(deps) {
        routerDeps = deps;
        return async () => {};
      },
    });

    expect(config.base.baseCrossChainAvailable).toBe(true);
    expect(config.base.yieldRouterAddress).toBe(HARDENED_ROUTER);
    expect(config.base.baseExitSweeperAddress).toBe(HARDENED_SWEEPER);
    expect(config.base.allowedPools).toEqual(ACTIVE_POOLS);
    expect(config.readiness.ready).toBe(true);
    expect(routerDeps.poolTargets).toEqual(ACTIVE_POOL_TARGETS);
    expect(routerDeps.forwardFarmDeployment.poolTargets).toBe(routerDeps.poolTargets);
  });

  it.each([
    ['YIELD_ROUTER_ADDRESS malformed', 'YIELD_ROUTER_ADDRESS', 'not-an-address'],
    ['YIELD_ROUTER_ADDRESS mismatch', 'YIELD_ROUTER_ADDRESS', '0x00000000000000000000000000000000000000AA'],
    ['BASE_EXIT_SWEEPER_ADDRESS malformed', 'BASE_EXIT_SWEEPER_ADDRESS', 'not-an-address'],
    ['BASE_EXIT_SWEEPER_ADDRESS mismatch', 'BASE_EXIT_SWEEPER_ADDRESS', '0x00000000000000000000000000000000000000bb'],
  ])('rejects active deployment env disagreement: %s', (_label, key, value) => {
    const env = buildValidEnv({
      YIELD_ROUTER_ADDRESS: HARDENED_ROUTER,
      BASE_EXIT_SWEEPER_ADDRESS: HARDENED_SWEEPER,
      [key]: value,
    });
    const facts = buildActiveFacts(env.RELAYER_STELLAR_PUBLIC);

    expect(() => loadConfig(env, { loadDeploymentFactsFn: () => facts }))
      .toThrow(new RegExp(key));
  });

  it('derives immutable addresses and network facts from deployment JSON', () => {
    const env = buildValidEnv();
    const config = loadConfig(env);
    expect(config.domains).toEqual({ stellar: 27, base: 6 });
    expect(config.base.yieldRouterAddress).toBe(YIELD_ROUTER);
    expect(config.stellar.passphrase).toBe(STELLAR_PASSPHRASE);
    expect(config.stellar.sourcePub).toBe(env.RELAYER_STELLAR_PUBLIC);
    expect(config.publicOrigin).toBe('http://localhost:8788');
    expect(config.reporter).toEqual({
      url: 'http://localhost:5173/api/agent-index',
      schema: 1,
      hasSecret: true,
    });
    expect(config.readiness.ready).toBe(true);
  });

  it('rejects a production runtime missing required public and secret configuration', () => {
    const required = [
      'RELAYER_STELLAR_SECRET',
      'RELAYER_PUBLIC_ORIGIN',
      'AGENT_INDEX_REPORTER_URL',
      'AGENT_INDEX_REPORTER_SCHEMA',
      'AGENT_INDEX_REPORTER_SECRET',
      'RELAYER_PROXY_KEY',
      'RELAYER_DB_PATH',
      'RELAYER_SESSION_KEY_ENCRYPTION_KEYS',
    ];
    for (const key of required) {
      const env = buildValidEnv({
        NODE_ENV: 'production',
        RELAYER_PUBLIC_ORIGIN: 'https://relay.example',
        AGENT_INDEX_REPORTER_URL: 'https://app.example/api/agent-index',
      });
      delete env[key];
      expect(() => loadConfig(env), key).toThrow(new RegExp(key));
    }
  });

  it.each([
    ['HTTP', 'http://relay.example'],
    ['credentials', 'https://user:pass@relay.example'],
    ['path', 'https://relay.example/private'],
    ['query', 'https://relay.example?debug=1'],
    ['fragment', 'https://relay.example/#debug'],
  ])('rejects a production public origin containing %s', (_label, publicOrigin) => {
    expect(() =>
      loadConfig(
        buildValidEnv({
          NODE_ENV: 'production',
          RELAYER_PUBLIC_ORIGIN: publicOrigin,
          AGENT_INDEX_REPORTER_URL: 'https://app.example/api/agent-index',
        })
      )
    ).toThrow(/RELAYER_PUBLIC_ORIGIN/);
  });

  it.each([
    ['HTTP', 'http://app.example/api/agent-index'],
    ['credentials', 'https://user:pass@app.example/api/agent-index'],
    ['query', 'https://app.example/api/agent-index?debug=1'],
    ['fragment', 'https://app.example/api/agent-index#debug'],
  ])('rejects a production reporter URL containing %s', (_label, reporterUrl) => {
    expect(() =>
      loadConfig(
        buildValidEnv({
          NODE_ENV: 'production',
          RELAYER_PUBLIC_ORIGIN: 'https://relay.example',
          AGENT_INDEX_REPORTER_URL: reporterUrl,
        })
      )
    ).toThrow(/AGENT_INDEX_REPORTER_URL/);
  });

  it.each([
    ['SOROBAN_RPC_URL', 'https://rpc.example'],
    ['STELLAR_NETWORK_PASSPHRASE', 'wrong network'],
    ['RELAYER_STELLAR_PUBLIC', Keypair.random().publicKey()],
  ])('rejects production env/JSON disagreement for %s', (key, value) => {
    expect(() =>
      loadConfig(
        buildValidEnv({
          NODE_ENV: 'production',
          RELAYER_PUBLIC_ORIGIN: 'https://relay.example',
          AGENT_INDEX_REPORTER_URL: 'https://app.example/api/agent-index',
          [key]: value,
        })
      )
    ).toThrow(new RegExp(key));
  });

  it('strictly validates development overrides instead of accepting arbitrary values', () => {
    expect(loadConfig(buildValidEnv({ YIELD_ROUTER_ADDRESS: 'not-an-address' })).base.yieldRouterAddress)
      .toBe(YIELD_ROUTER);
    expect(() => loadConfig(buildValidEnv({ SOROBAN_RPC_URL: 'file:///tmp/rpc' }))).toThrow(
      /SOROBAN_RPC_URL/
    );
    expect(() => loadConfig(buildValidEnv({ RELAYER_STELLAR_PUBLIC: 'not-a-g-address' }))).toThrow(
      /RELAYER_STELLAR_PUBLIC/
    );
  });

  it('rejects a relayer secret/public mismatch before claiming Stellar readiness', () => {
    expect(() =>
      loadConfig(buildValidEnv({ RELAYER_STELLAR_PUBLIC: Keypair.random().publicKey() }))
    ).toThrow(/RELAYER_STELLAR_(SECRET|PUBLIC).*match|match.*RELAYER_STELLAR/i);
  });

  it('never serializes secrets and exposes only presence/readiness booleans and digests', () => {
    const env = buildValidEnv();
    const config = loadConfig(env);
    const serialized = JSON.stringify(config);
    for (const secret of [
      env.RELAYER_STELLAR_SECRET,
      env.RELAYER_BASE_PRIVKEY,
      env.ZERODEV_PROJECT_ID,
      env.AGENT_INDEX_REPORTER_SECRET,
      env.RELAYER_PROXY_KEY,
      env.RELAYER_SESSION_KEY_ENCRYPTION_KEYS,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(config.secrets).toEqual({
      stellarRelayer: true,
      baseRelayer: true,
      zeroDevProject: true,
      proxyAuth: true,
      reporterAuth: true,
      sessionKeyEncryption: true,
    });
    expect(config.digests.deployments).toMatch(/^[a-f0-9]{64}$/);
    expect(config.digests.baseMandatePolicy).toMatch(/^[a-f0-9]{64}$/);
  });

  it('publishes only the safe Base availability boolean and allowlisted reason, not deployment or RPC details', () => {
    const config = loadConfig(buildValidEnv());
    const publicRuntime = JSON.parse(JSON.stringify(config.publicRuntime));

    expect(publicRuntime.baseCrossChainAvailable).toBe(false);
    expect(publicRuntime.unavailableReason).toBe('Hardened Base deployment is not active.');
    expect(publicRuntime).not.toHaveProperty('facts');
    expect(JSON.stringify(publicRuntime)).not.toMatch(/rpc|verif|runtimecode|adminsafe|selector/i);
  });

  it('requires a session-key encryption keyring for every durable store', () => {
    expect(() =>
      loadConfig(buildValidEnv({ RELAYER_SESSION_KEY_ENCRYPTION_KEYS: '' }))
    ).toThrow(/RELAYER_SESSION_KEY_ENCRYPTION_KEYS/);
  });

  it('permits memory-only development without a session-key encryption keyring', () => {
    const config = loadConfig(buildValidEnv({
      RELAYER_DB_PATH: '',
      RELAYER_SESSION_KEY_ENCRYPTION_KEYS: '',
    }));

    expect(config.secrets.sessionKeyEncryption).toBe(false);
    expect(config.sessionKeyCipher).toBeUndefined();
  });

  it('keeps the session cipher and its raw keyring out of enumerable runtime configuration', () => {
    const env = buildValidEnv();
    const config = loadConfig(env);
    const serialized = JSON.stringify(config);

    expect(Object.getOwnPropertyDescriptor(config, 'sessionKeyCipher')).toMatchObject({ enumerable: false });
    expect(config.sessionKeyCipher.open(config.sessionKeyCipher.seal('private session key', 'record:1'), 'record:1'))
      .toEqual({ plaintext: 'private session key', needsRotation: false });
    expect(serialized).not.toContain(env.RELAYER_SESSION_KEY_ENCRYPTION_KEYS);
    expect(serialized).not.toContain('2026-08');
    expect(JSON.stringify(config.publicRuntime)).not.toContain('2026-08');
  });

  it('does not echo a malformed session-key encryption value in configuration errors', () => {
    const raw = 'sensitive-key-id:not-a-base64-key';

    try {
      loadConfig(buildValidEnv({ RELAYER_SESSION_KEY_ENCRYPTION_KEYS: raw }));
      throw new Error('expected configuration loading to fail');
    } catch (error) {
      expect(error.message).toMatch(/RELAYER_SESSION_KEY_ENCRYPTION_KEYS/);
      expect(error.message).not.toContain(raw);
    }
  });
});
