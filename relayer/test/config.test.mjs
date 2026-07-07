import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.mjs';

function buildValidEnv() {
  const kp = Keypair.random();
  return {
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    RELAYER_STELLAR_SECRET: kp.secret(),
    RELAYER_STELLAR_PUBLIC: kp.publicKey(),
    RELAYER_BASE_PRIVKEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ZERODEV_PROJECT_ID: 'proj-123',
    YIELD_ROUTER_ADDRESS: '0x000000000000000000000000000000000000aa',
  };
}

describe('loadConfig', () => {
  it('builds a full config object when all required env vars are present', () => {
    const config = loadConfig(buildValidEnv());
    expect(config.domains.stellar).toBe(27);
    expect(config.domains.base).toBe(6);
    expect(config.base.yieldRouterAddress).toBe('0x000000000000000000000000000000000000aa');
    expect(config.stellar.sourcePub).toMatch(/^G/);
    expect(config.base.bundlerRpcUrl).toBe('https://rpc.zerodev.app/api/v3/proj-123/chain/84532');
  });

  it('throws a clear error when a required env var is missing', () => {
    const env = buildValidEnv();
    delete env.YIELD_ROUTER_ADDRESS;
    expect(() => loadConfig(env)).toThrow(/YIELD_ROUTER_ADDRESS/);
  });

  it('throws when a required env var is still the FILL_ME placeholder', () => {
    const env = buildValidEnv();
    env.ZERODEV_PROJECT_ID = 'FILL_ME';
    expect(() => loadConfig(env)).toThrow(/ZERODEV_PROJECT_ID/);
  });
});
