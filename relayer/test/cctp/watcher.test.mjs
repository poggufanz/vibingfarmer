import { describe, it, expect, vi } from 'vitest';
import { createWatcher } from '../../src/cctp/watcher.mjs';
import { createMemoryStore } from '../../src/store.mjs';

const DOMAINS = { stellar: 27, base: 6 };

function buildConfig(overrides = {}) {
  const store = createMemoryStore();
  const pollAttestationFn = vi.fn().mockResolvedValue({ message: '0xmsg', attestation: '0xatt' });
  const mintBaseFn = vi.fn().mockResolvedValue({ hash: '0xminted', status: 'success' });
  const mintAndForwardStellarFn = vi.fn().mockResolvedValue('stellar-mint-hash');
  return {
    store, irisUrl: 'https://iris.example', domains: DOMAINS,
    base: { publicClient: {}, walletClient: {}, messageTransmitterAddress: '0xMTV2' },
    stellar: { server: {}, kp: {}, sourcePub: 'GAAA', passphrase: 'Test', forwarderAddress: 'CFORWARDER' },
    pollAttestationFn, mintBaseFn, mintAndForwardStellarFn,
    ...overrides,
  };
}

describe('relayMint — forward leg (sourceDomain = stellar)', () => {
  it('submits the mint exactly once across two calls for the same execId (idempotent)', async () => {
    const config = buildConfig();
    const watcher = createWatcher(config);

    const first = await watcher.relayMint({ sourceDomain: DOMAINS.stellar, burnTxHash: 'burn-1', execId: 'exec-1' });
    const second = await watcher.relayMint({ sourceDomain: DOMAINS.stellar, burnTxHash: 'burn-1', execId: 'exec-1' });

    expect(first).toEqual({ status: 'minted', mintTxHash: '0xminted' });
    expect(second).toEqual({ status: 'already-minted', mintTxHash: '0xminted' });
    expect(config.mintBaseFn).toHaveBeenCalledTimes(1);
    expect(config.pollAttestationFn).toHaveBeenCalledTimes(1);
  });
});

describe('relayMint — reverse leg (sourceDomain = base)', () => {
  it('calls mintAndForwardStellar, not mintBase', async () => {
    const config = buildConfig();
    const watcher = createWatcher(config);

    const result = await watcher.relayMint({ sourceDomain: DOMAINS.base, burnTxHash: 'base-burn-1', execId: 'exec-2' });

    expect(result).toEqual({ status: 'minted', mintTxHash: 'stellar-mint-hash' });
    expect(config.mintAndForwardStellarFn).toHaveBeenCalledTimes(1);
    expect(config.mintBaseFn).not.toHaveBeenCalled();
  });
});

describe('sweepStuck', () => {
  it('redrives records left pending (e.g. the process restarted mid-poll)', async () => {
    const config = buildConfig();
    const watcher = createWatcher(config);
    config.store.set('exec-stuck', { status: 'pending', sourceDomain: DOMAINS.stellar, burnTxHash: 'burn-stuck' });

    const { redriven } = await watcher.sweepStuck();

    expect(redriven).toEqual(['exec-stuck']);
    expect(config.store.get('exec-stuck').status).toBe('minted');
    expect(config.mintBaseFn).toHaveBeenCalledTimes(1);
  });

  it('does not re-drive records already minted', async () => {
    const config = buildConfig();
    const watcher = createWatcher(config);
    config.store.set('exec-done', { status: 'minted', mintTxHash: '0xdone' });

    const { redriven } = await watcher.sweepStuck();

    expect(redriven).toEqual([]);
    expect(config.mintBaseFn).not.toHaveBeenCalled();
  });
});
