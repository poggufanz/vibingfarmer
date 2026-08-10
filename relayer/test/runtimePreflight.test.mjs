import { describe, expect, it } from 'vitest';
import { runtimePreflight } from '../src/runtimePreflight.mjs';
import { runRelayer } from '../server-runner.mjs';

const KEY = 'a'.repeat(64);

function goodConfig(overrides = {}) {
  return {
    mode: 'production',
    dbPath: '/tmp/vf-task16-runtime.db',
    runtime: { proxyKey: KEY, proxyKeyPrevious: '', debugErrors: false },
    secrets: { sessionKeyEncryption: true, proxyAuth: true, reporterAuth: true },
    sessionKeyCipher: { seal() {}, open() {} },
    reporter: { url: 'https://index.example/api', schema: 1, hasSecret: true },
    readiness: { ready: true },
    facts: {
      stellar: { networkId: 'stellar-testnet' },
      base: {
        baseCrossChainAvailable: false,
        hardenedDeployment: null,
        unavailableReason: 'Hardened Base deployment is not active.',
      },
    },
    base: { baseCrossChainAvailable: false, hardenedDeployment: null },
    publicRuntime: { baseCrossChainAvailable: false },
    ...overrides,
  };
}

const goodDependencies = {
  localProbe: async () => ({
    writable: true,
    legacyMandateTables: [],
    mandateMigrationCleanupPending: false,
    agentIndexSchema: true,
    evidenceStore: true,
    leaseStore: true,
  }),
  reporterProbe: async () => ({
    ready: true,
    schemaVersion: 1,
    stores: {
      executionReceipts: true,
      baseChildIntents: true,
      baseRecoveryEvidence: true,
      leases: true,
    },
  }),
};

describe('runtimePreflight', () => {
  it('fails closed in production when durable readiness probes are not composed', async () => {
    await expect(runtimePreflight({ config: goodConfig() })).rejects.toMatchObject({
      code: 'RUNTIME_PREFLIGHT_FAILED',
      reasonCode: 'LOCAL_READINESS_MISSING',
    });
  });

  it('passes the closed-Base runtime without inventing a hardened deployment', async () => {
    const result = await runtimePreflight({ config: goodConfig(), dependencies: goodDependencies });

    expect(result.ok).toBe(true);
    expect(result.baseCrossChainAvailable).toBe(false);
  });

  it.each([
    ['missing encryption keyring', { sessionKeyCipher: null, secrets: { sessionKeyEncryption: false } }, /encryption/i],
    ['legacy mandate schema', {}, /legacy mandate/i],
    ['pending migration cleanup', {}, /cleanup/i],
    ['missing reporter stores', {}, /reporter|store/i],
    ['weak proxy key', { runtime: { proxyKey: 'weak', proxyKeyPrevious: '', debugErrors: false } }, /proxy/i],
    ['production debug mode', { runtime: { proxyKey: KEY, proxyKeyPrevious: '', debugErrors: true } }, /debug/i],
  ])('fails closed before worker/listener for %s', async (_label, overrides, reason) => {
    const sentinel = 'T16-PREFLIGHT-SECRET';
    const config = goodConfig(overrides);
    let localProbe = goodDependencies.localProbe;
    let reporterProbe = goodDependencies.reporterProbe;
    if (_label === 'legacy mandate schema') {
      localProbe = async () => ({ ...await goodDependencies.localProbe(), legacyMandateTables: ['mandates_v2'] });
    }
    if (_label === 'pending migration cleanup') {
      localProbe = async () => ({ ...await goodDependencies.localProbe(), mandateMigrationCleanupPending: true });
    }
    if (_label === 'missing reporter stores') {
      reporterProbe = async () => ({ ready: false, schemaVersion: 0, stores: {} });
    }

    await expect(runtimePreflight({
      config,
      dependencies: { localProbe, reporterProbe },
      worker: () => { throw new Error(sentinel); },
      listen: () => { throw new Error(sentinel); },
    })).rejects.toMatchObject({ code: 'RUNTIME_PREFLIGHT_FAILED' });
    try {
      await runtimePreflight({ config, dependencies: { localProbe, reporterProbe } });
    } catch (error) {
      expect(error.message).toMatch(reason);
      expect(error.message).not.toContain(sentinel);
    }
  });

  it('rejects Base activation when the approved hardened deployment is absent', async () => {
    const config = goodConfig({
      base: { baseCrossChainAvailable: true, hardenedDeployment: null },
      publicRuntime: { baseCrossChainAvailable: true },
      facts: { base: { baseCrossChainAvailable: true, hardenedDeployment: null } },
    });

    await expect(runtimePreflight({ config, dependencies: goodDependencies }))
      .rejects.toMatchObject({ code: 'RUNTIME_PREFLIGHT_FAILED' });
  });

  it('runs preflight before listener creation and maps a failed startup to nonzero status', async () => {
    const order = [];
    const processLike = { exitCode: 0 };
    const sink = [];
    const config = goodConfig({ mode: 'development', allowOpenProxy: false });
    const result = await runRelayer({
      env: { NODE_ENV: 'development', RELAYER_ALLOW_OPEN_PROXY: '0' },
      loadConfigFn: () => config,
      preflightFn: async () => { order.push('preflight'); throw new Error('T16 runner secret'); },
      createServerFn: () => {
        order.push('create-server');
        return { listen: async () => { order.push('listen'); } };
      },
      logger: { info() {}, error(code) { sink.push(code); } },
      processLike,
    });

    expect(result).toEqual({ ok: false, code: 'RELAYER_STARTUP_FAILED' });
    expect(order).toEqual(['preflight']);
    expect(processLike.exitCode).toBe(1);
    expect(sink).toEqual(['RELAYER_STARTUP_FAILED']);
  });
});
