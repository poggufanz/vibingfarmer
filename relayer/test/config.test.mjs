import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.mjs';
import { loadDeploymentFacts, validateDeploymentFacts } from '../src/deploymentFacts.mjs';

const STELLAR_PASSPHRASE = 'Test SDF Network ; September 2015';
const STELLAR_RPC = 'https://soroban-testnet.stellar.org';
const STELLAR_RELAYER = 'GBVJ34MT4GDKZJGILI6DRYGD75ZNUBJGGZIDUV7IPFNVVDWGE5GBLV3X';
const YIELD_ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';

function buildValidEnv(overrides = {}) {
  const kp = Keypair.random();
  return {
    NODE_ENV: 'development',
    SOROBAN_RPC_URL: STELLAR_RPC,
    STELLAR_NETWORK_PASSPHRASE: STELLAR_PASSPHRASE,
    RELAYER_STELLAR_SECRET: kp.secret(),
    RELAYER_STELLAR_PUBLIC: STELLAR_RELAYER,
    BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
    RELAYER_BASE_PRIVKEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ZERODEV_PROJECT_ID: 'proj-123',
    YIELD_ROUTER_ADDRESS: YIELD_ROUTER,
    IRIS_URL: 'https://iris-api-sandbox.circle.com',
    RELAYER_PUBLIC_ORIGIN: 'http://localhost:8788/',
    AGENT_INDEX_REPORTER_URL: 'http://localhost:5173/api/agent-index',
    AGENT_INDEX_REPORTER_SCHEMA: '1',
    AGENT_INDEX_REPORTER_SECRET: 'reporter-secret',
    RELAYER_PROXY_KEY: 'proxy-secret',
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  it('derives immutable addresses and network facts from deployment JSON', () => {
    const config = loadConfig(buildValidEnv());
    expect(config.domains).toEqual({ stellar: 27, base: 6 });
    expect(config.base.yieldRouterAddress).toBe(YIELD_ROUTER);
    expect(config.stellar.passphrase).toBe(STELLAR_PASSPHRASE);
    expect(config.stellar.sourcePub).toBe(STELLAR_RELAYER);
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
      'RELAYER_BASE_PRIVKEY',
      'ZERODEV_PROJECT_ID',
      'RELAYER_PUBLIC_ORIGIN',
      'AGENT_INDEX_REPORTER_URL',
      'AGENT_INDEX_REPORTER_SCHEMA',
      'AGENT_INDEX_REPORTER_SECRET',
      'RELAYER_PROXY_KEY',
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
    ['YIELD_ROUTER_ADDRESS', '0x00000000000000000000000000000000000000aa'],
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
    expect(() => loadConfig(buildValidEnv({ YIELD_ROUTER_ADDRESS: 'not-an-address' }))).toThrow(
      /YIELD_ROUTER_ADDRESS/
    );
    expect(() => loadConfig(buildValidEnv({ SOROBAN_RPC_URL: 'file:///tmp/rpc' }))).toThrow(
      /SOROBAN_RPC_URL/
    );
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
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(config.secrets).toEqual({
      stellarRelayer: true,
      baseRelayer: true,
      zeroDevProject: true,
      proxyAuth: true,
      reporterAuth: true,
    });
    expect(config.digests.deployments).toMatch(/^[a-f0-9]{64}$/);
    expect(config.digests.baseMandatePolicy).toMatch(/^[a-f0-9]{64}$/);
  });
});
