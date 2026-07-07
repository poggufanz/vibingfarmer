import { describe, it, expect, vi } from 'vitest';
import { createFarmFlow } from '../../src/flows/farm.mjs';

describe('farm', () => {
  it('relays the mint before dispatching deposits, and returns both results', async () => {
    const callOrder = [];
    const watcher = { relayMint: vi.fn(async () => { callOrder.push('relayMint'); return { status: 'minted', mintTxHash: '0xmint' }; }) };
    const orchestrator = { dispatchDeposits: vi.fn(async () => { callOrder.push('dispatchDeposits'); return [{ status: 'fulfilled', pool: '0xPoolA' }]; }) };
    const { farm } = createFarmFlow({ watcher, orchestrator, domains: { stellar: 27, base: 6 } });

    const result = await farm({
      burnTxHash: 'burn-1', execId: 'exec-1', approval: 'approval-blob',
      allocations: [{ pool: '0xPoolA', amount: 100n, minShares: 90n }],
    });

    expect(callOrder).toEqual(['relayMint', 'dispatchDeposits']);
    expect(result.mintResult).toEqual({ status: 'minted', mintTxHash: '0xmint' });
    expect(result.depositResults).toEqual([{ status: 'fulfilled', pool: '0xPoolA' }]);
    expect(watcher.relayMint).toHaveBeenCalledWith({ sourceDomain: 27, burnTxHash: 'burn-1', execId: 'exec-1' });
  });
});
